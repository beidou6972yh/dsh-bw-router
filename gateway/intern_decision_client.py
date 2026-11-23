#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""intern_decision_client.py —— 本地打分模型（decision scorer）最小客户端

为什么单独一个模块：该模型是**结构化打分模型**，不做 generate()、没有 chat 语义
（模型说明原文：does not call generate() or sample free-form text）。它读
`<decision>` 占位符前一位的 logits，对候选符号 softmax，再按冻结温度校准。
所以本模块：
  1) 按模型说明与 chat 模板手工渲染骨架 prompt；
  2) 每个字段发一次 `/v1/completions`（max_tokens=1, logprobs=N, 采样全关）；
  3) 候选内归一化 → 温度校准 → argmax 映射回选项值。

与 `router_deciders.py` 的分工：本模块只负责"跟模型说话"，契约与记账留在调用方。
服务入口：一个只做打分、不做 generate 的本地推理端点（OpenAI 兼容 completions），
**不是** chat/completions 语义。实测：四字段一次决策约 0.63 s。

依据：本机探针复核（读位对齐 marker_pos-1、明显样例方向正确、梯度严格单调、
固定温度下 argmax 稳定）。
"""
from __future__ import annotations

import json
import math
import time
import urllib.error
import urllib.request

OFFICIAL_TEMPERATURE = 2.747760550703  # inference.py::DEFAULT_TEMPERATURE（0.8B 冻结值）
DECISION_TOKEN = "<decision>"
ANSWER_SYMBOLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
SYSTEM_PROMPT = (
    "You are a careful decision assistant. Use the state and decision schema in the user message "
    "to make the requested decisions. For every field, choose exactly one answer symbol (e.g. A, B, C, "
    "...) from its listed options and return one valid JSON object mapping each field name to its "
    "chosen symbol. Use the field names and symbols exactly as given. Do not include explanations, "
    "Markdown, or extra text."
)

# 我们的 decider 契约（与 router_deciders._INSTRUCTION 的枚举逐字一致）
FIELDS = [
    ("function", {
        "type": "choice",
        "instructions": "这次请求的主功能类别（按任务实质判断，不按措辞）",
        "criteria": {
            "coding": "写代码、改代码、重构、实现功能",
            "code_testing": "跑测试、验证代码正确性、代码审查",
            "writing": "写作、文案、润色、翻译、改写",
            "decision": "要我做判断、比较、给方案或拍板",
            "tools": "必须查外部信息或调用工具才能完成",
            "long_context": "必须通读或引用很长的上下文",
            "vision": "主要处理图片、截图、扫描件",
            "memory": "读写长期记忆、档案、历史口径",
            "system_control": "操作系统、服务、进程、文件、环境",
        },
    }),
    ("level", {
        "type": "choice",
        "instructions": "任务复杂度档位：L1 简单一步；L2 中等，几步内可完成；L3 复杂，需长上下文或多步推理",
        "criteria": {"L1": "简单直接，一次答复即可", "L2": "中等，需要几步处理",
                     "L3": "复杂，需要长上下文或多步推理"},
    }),
    ("group", {
        "type": "choice",
        "instructions": "该交给哪一档模型执行",
        "criteria": {"local": "本地小模型即可", "cheap": "便宜云模型", "strong": "需要强模型"},
    }),
    ("needs_tools", {
        "type": "noul",
        "instructions": "完成该请求是否需要调用工具、跑代码或检索外部信息",
        "criteria": {"no": "不需要工具，直接作答", "yes": "需要工具、跑代码或检索"},
    }),
]

# 影子判定用的单问（router_shadow 的契约：suggested_group ∈ L1/L2/L3 + simple_prob + score）
SHADOW_FIELD = ("level", {
    "type": "choice",
    "instructions": "这条请求的处理复杂度档位",
    "criteria": {"L1": "简单直接，一次答复即可", "L2": "中等，需要几步处理",
                 "L3": "复杂，需要长上下文或多步推理"},
})


def _options(question: dict) -> list[tuple[str, str]]:
    kind = question.get("type")
    criteria = question.get("criteria")
    if kind == "choice":
        return [(str(k), str(v)) for k, v in criteria.items()]
    if kind == "noul":
        d = criteria if isinstance(criteria, dict) else {}
        yes = next((str(d[k]) for k in d if str(k).lower() in {"yes", "true", "1"}), "The answer is yes.")
        no = next((str(d[k]) for k in d if str(k).lower() in {"no", "false", "0"}), "The answer is no.")
        return [("no", no), ("yes", yes)]
    raise ValueError("unsupported question type: %r" % kind)


def _compile(state_text: str, fields: list) -> dict:
    names, symbols, lines = [], {}, []
    for name, question in fields:
        opts = _options(question)
        names.append(name)
        symbols[name] = tuple(ANSWER_SYMBOLS[:len(opts)])
        lines.append("%s: %s" % (name, question.get("instructions", "")))
        for sym, (value, desc) in zip(symbols[name], opts):
            lines.append("    %s = %s: %s" % (sym, value, desc))
    if DECISION_TOKEN in state_text:
        raise ValueError("reserved decision marker in state")
    user_text = ("Return one answer for every field using the supplied answer symbols.\n\n"
                 "## State\n%s\n## Decision schema\n" % state_text + "\n".join(lines))
    skeleton = json.dumps(dict.fromkeys(names, DECISION_TOKEN), ensure_ascii=False, indent=4)
    full = ("<|im_start|>system\n" + SYSTEM_PROMPT.strip() + "<|im_end|>\n"
            "<|im_start|>user\n" + user_text.strip() + "<|im_end|>\n"
            "<|im_start|>assistant\n<think>\n\n</think>\n\n" + skeleton + "<|im_end|>\n")
    prefixes = [DECISION_TOKEN.join(full.split(DECISION_TOKEN)[:k + 1]) for k in range(len(names))]
    return {"names": names, "symbols": symbols, "prefixes": prefixes, "full_text": full}


def _post(url: str, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _lookup(lp_map: dict, sym: str):
    for cand in (sym, " " + sym):
        if cand in lp_map:
            return lp_map[cand]
    for k, v in lp_map.items():
        if k.strip() == sym:
            return v
    return None


def _score_field(base_url: str, model: str, prompt: str, symbols: tuple,
                 logprobs: int, timeout: float) -> dict:
    body = {"model": model, "prompt": prompt, "max_tokens": 1, "echo": False, "stream": False,
            "temperature": 1.0, "top_k": 0, "top_p": 1.0, "min_p": 0.0, "repeat_penalty": 1.0,
            "seed": 42, "logprobs": logprobs, "cache_prompt": False}
    t0 = time.time()
    resp = _post(base_url.rstrip("/") + "/completions", body, timeout)
    entries = []
    try:
        content = ((resp.get("choices") or [{}])[0].get("logprobs") or {}).get("content") or []
        for e in (content[0].get("top_logprobs") or []) if content else []:
            entries.append((e.get("token"), float(e.get("logprob"))))
    except Exception:  # noqa: BLE001
        entries = []
    lp_map = {tok: lp for tok, lp in entries}
    missing = [s for s in symbols if _lookup(lp_map, s) is None]
    if missing:  # 候选落长尾：按 phase2 结论把 logprobs 调大重取一次
        resp = _post(base_url.rstrip("/") + "/completions", dict(body, logprobs=max(2000, logprobs * 100)), timeout)
        try:
            content = ((resp.get("choices") or [{}])[0].get("logprobs") or {}).get("content") or []
            entries = [(e.get("token"), float(e.get("logprob"))) for e in (content[0].get("top_logprobs") or [])]
        except Exception:  # noqa: BLE001
            pass
        lp_map = {tok: lp for tok, lp in entries}
        missing = [s for s in symbols if _lookup(lp_map, s) is None]
    raw = [_lookup(lp_map, s) for s in symbols]
    seen = [v for v in raw if v is not None]
    floor = (min(seen) - 8.0) if seen else -20.0
    logits = [v if v is not None else floor for v in raw]
    mx = max(logits)
    exps = [math.exp(v - mx) for v in logits]
    tot = sum(exps)
    probs = {s: e / tot for s, e in zip(symbols, exps)}
    logs = {s: (math.log(p) if p > 0 else -math.inf) for s, p in probs.items()}
    mx2 = max(logs.values())
    w = {s: math.exp((v - mx2) / OFFICIAL_TEMPERATURE) for s, v in logs.items()}
    tw = sum(w.values())
    cal = {s: v / tw for s, v in w.items()}
    am = min(cal, key=lambda s: (-cal[s], s))
    return {"probs": cal, "argmax": am, "top": max(cal.values()),
            "latency_ms": int((time.time() - t0) * 1000), "missing": missing}


def _run(base_url: str, model: str, state_text: str, fields: list,
         logprobs: int = 20, timeout: float = 12.0) -> dict:
    row = _compile(state_text, fields)
    out = {}
    for k, (name, question) in enumerate(fields):
        r = _score_field(base_url, model, row["prefixes"][k], row["symbols"][name], logprobs, timeout)
        vals = [v for v, _ in _options(question)]
        best = vals[list(row["symbols"][name]).index(r["argmax"])]
        out[name] = {"chosen": best, "p": r["top"], "latency_ms": r["latency_ms"],
                     "missing": r["missing"],
                     "probs": {v: r["probs"][s] for v, s in zip(vals, row["symbols"][name])}}
    return out


def decide(spec: dict, meta: dict, timeout: float = 12.0) -> dict | None:
    """decider 契约：function/level/group/needs_tools + confidence（各字段最小）+ reason_code。"""
    state = json.dumps({
        "任务类型": str(meta.get("kind") or "unknown"),
        "输入规模": "约 %s tokens" % meta.get("input_tokens", 0),
        "是否带工具": "是" if meta.get("has_tools") else "否",
        "是否含图": "是" if meta.get("has_image") else "否",
        "首条用户消息": str(meta.get("first_message", ""))[:600],
    }, ensure_ascii=False, indent=2)
    try:
        got = _run(spec.get("base_url") or "", spec.get("model") or "", state, FIELDS,
                   logprobs=int(spec.get("logprobs", 20)), timeout=timeout)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError, KeyError):
        return None
    return {
        "function": got["function"]["chosen"],
        "level": got["level"]["chosen"],
        "group": got["group"]["chosen"],
        "needs_tools": got["needs_tools"]["chosen"] == "yes",
        "confidence": round(min(v["p"] for v in got.values()), 4),
        "reason_code": "%s_%s_%s" % (got["function"]["chosen"],
                                     "tools" if got["needs_tools"]["chosen"] == "yes" else "no_tools",
                                     str(got["level"]["chosen"]).lower()),
        "_detail": got,
    }


def judge(spec: dict, state_text: str, timeout: float = 8.0) -> dict | None:
    """影子判定契约（router_shadow）：suggested_group(L1/L2/L3) + simple_prob + score(0~100)。"""
    try:
        got = _run(spec.get("base_url") or "", spec.get("model") or "", state_text, [SHADOW_FIELD],
                   logprobs=int(spec.get("logprobs", 20)), timeout=timeout)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, ValueError, KeyError):
        return None
    d = got["level"]
    probs = d["probs"]
    score = 0.0 * probs.get("L1", 0.0) + 50.0 * probs.get("L2", 0.0) + 100.0 * probs.get("L3", 0.0)
    return {"simple_prob": round(probs.get("L1", 0.0), 4), "suggested_group": d["chosen"],
            "score": round(score, 1), "latency_ms": d["latency_ms"]}
