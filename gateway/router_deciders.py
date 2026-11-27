#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""router_deciders.py —— 每条策略的可替换「决策模型」层（2026-11-20 用户令）

用户原话：「我们路由策略里，"功能"这个策略里预留了决策模型，现在可以考虑在每条策略里都加一个
决策模型的选项，这样让路由策略在执行任务时，先由决策模型判断，再由下面的模型执行」。

设计要点：
1. **可替换**：决策模型全部登记在 `config/deciders.json` 的 `registry`，每条策略在 `by_strategy`
   里只写"用哪个 decider + 什么模式"，换模型改配置即可，代码零改动。
2. **三档模式**（默认 off）：
   - `off`     ：完全不介入（等于现状，golden diff 逐字节一致）。
   - `shadow`  ：调决策模型但**只记账**，不改任何选模结果。
   - `active`  ：采用判定结果（function / 档位 / 是否强模型），再交下游模型执行。
3. **绝不阻塞主链路**：超时、异常、解析失败、熔断一律返回 None，由调用方按原规则走。
4. **判定输入是摘要**：只喂 ≤2k tokens 的摘要，不喂全上下文（省时省钱，也避免本地小模型装不下）。

输出契约（强制 JSON，枚举受限）：
  {"function": "coding|writing|decision|tools|long_context|...", "level": "L1|L2|L3",
   "group": "local|cheap|strong", "needs_tools": true, "confidence": 0.0~1.0,
   "reason_code": "short_qa_no_tools"}
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request

CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", "deciders.json")
SHADOW_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "数据", "shadow.jsonl")

_MODES = ("off", "shadow", "active")
_FUNCS = {"coding", "code_testing", "writing", "decision", "tools", "long_context", "vision",
          "memory", "system_control"}
_GROUPS = {"local", "cheap", "strong"}
_LEVELS = {"L1", "L2", "L3"}

_STATE = {"doc": None, "loaded_at": 0.0, "fail_streak": {}, "open_until": {}}
_CACHE_TTL = 5.0
# 1.0.3.10 #12：凭据路径按当前工作副本定位，可用环境变量覆盖（原写死 /opt/wb-router）。
_CRED_FILE = os.environ.get(
    "ROUTER_CREDENTIALS_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".credentials.yaml"),
)
_intern_client = None  # 懒加载 intern_decision_client（None=未试，False=不可用）


def _cred(ref: str) -> str:
    """凭据取值：环境变量优先，其次主 credentials.yaml 的 refs 段；只在内存使用，不落日志。"""
    if not ref:
        return ""
    val = os.environ.get(ref)
    if val:
        return val
    try:
        with open(_CRED_FILE, encoding="utf-8") as fh:
            txt = fh.read()
        m = re.search(r"^\s*%s:\s*(\S+)" % re.escape(ref), txt, re.M)
        return m.group(1).strip() if m else ""
    except Exception:
        return ""


def _load(force: bool = False) -> dict:
    now = time.time()
    if _STATE["doc"] is not None and not force and now - _STATE["loaded_at"] < _CACHE_TTL:
        return _STATE["doc"]
    try:
        with open(CONFIG, encoding="utf-8") as f:
            doc = json.load(f)
        if not isinstance(doc, dict):
            doc = {}
        _STATE["doc"] = doc
        _STATE["loaded_at"] = now
    except Exception:
        if _STATE["doc"] is None:
            _STATE["doc"] = {}
    return _STATE["doc"]


def strategy_config(strategy: str) -> dict:
    """取某条策略的决策模型配置；没有或形状不对一律返回 {'mode': 'off'}。"""
    doc = _load()
    cfg = ((doc.get("by_strategy") or {}).get(strategy)) or {}
    if not isinstance(cfg, dict):
        return {"mode": "off"}
    mode = str(cfg.get("mode") or "off").lower()
    if mode not in _MODES:
        mode = "off"
    return {"mode": mode, "decider": cfg.get("decider"), "min_confidence": float(cfg.get("min_confidence", 0.0)),
            "timeout_ms": int(cfg.get("timeout_ms", 8000))}


def decider_spec(name: str) -> dict | None:
    doc = _load()
    spec = ((doc.get("registry") or {}).get(name)) or None
    return spec if isinstance(spec, dict) else None


def _circuit_open(name: str) -> bool:
    return time.time() < _STATE["open_until"].get(name, 0.0)


def _note_failure(name: str) -> None:
    n = _STATE["fail_streak"].get(name, 0) + 1
    _STATE["fail_streak"][name] = n
    if n >= 3:  # 连续 3 次失败 → 熔断 60 秒
        _STATE["open_until"][name] = time.time() + 60


def _note_success(name: str) -> None:
    _STATE["fail_streak"][name] = 0


def _digest(payload_meta: dict) -> str:
    """把请求元信息压成 ≤2k tokens 的判定摘要（不喂全上下文）。"""
    parts = [
        "任务类型：%s" % payload_meta.get("kind", "unknown"),
        "输入规模：约 %s tokens" % payload_meta.get("input_tokens", 0),
        "是否带工具：%s" % ("是" if payload_meta.get("has_tools") else "否"),
        "是否含图：%s" % ("是" if payload_meta.get("has_image") else "否"),
        "首条用户消息：%s" % str(payload_meta.get("first_message", ""))[:600],
    ]
    return "\n".join(parts)


_INSTRUCTION = (
    "你是路由决策器。看下面的请求摘要，只输出一个 JSON 对象，不要多余文字："
    '{"function":"<coding|code_testing|writing|decision|tools|long_context|vision|memory|system_control>",'
    '"level":"<L1|L2|L3>","group":"<local|cheap|strong>","needs_tools":<true|false>,'
    '"confidence":<0~1>,"reason_code":"<snake_case 短标记>"}'
)


def _POST_INTERN(spec: dict, meta: dict, timeout_s: float) -> dict | None:
    """本地打分模型后端（懒加载；导入失败即当不可用，绝不影响主链路）。"""
    global _intern_client
    if _intern_client is None:
        try:
            import intern_decision_client as mod  # noqa: PLC0415
            _intern_client = mod
        except Exception:  # noqa: BLE001
            _intern_client = False
    if not _intern_client:
        return None
    return _intern_client.decide(spec, meta, timeout=timeout_s)


def _post_chat(spec: dict, prompt: str, timeout_s: float, system: str | None = None) -> str:
    """system 缺省＝本模块的 decider 契约指令；调用方（如 router_shadow）可传自己的指令。

    [2026-11-21 10:5x 修复] 原实现把 system 写死成 _INSTRUCTION，导致 router_shadow
    的影子提示词带的是 decider 契约、模型回 function/level/... 而影子解析器要
    simple_prob/suggested_group/score ⇒ 影子期全天 bad_output。加可选参数，缺省行为不变。
    """
    payload = {
        "model": spec.get("model") or "llama-current",
        "messages": [{"role": "system", "content": system or _INSTRUCTION},
                     {"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": int(spec.get("max_tokens", 160)),
        "stream": False,
    }
    # [2026-11-21 默认档修复] 可选的 per-decider 附加请求字段（如
    # {"chat_template_kwargs": {"enable_thinking": false}}）。推理档默认把 token
    # 预算吃在 reasoning_content 上、content 恒空 ⇒ 契约 JSON 拿不到；llama.cpp
    # b12242 支持按请求关思考（2026-11-21 实测 9B/27B 关思考后均能产出合法 JSON）。
    # 未配置 extra_body 时行为与改前逐字节一致。
    extra = spec.get("extra_body")
    if isinstance(extra, dict):
        payload.update(extra)
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        (spec.get("base_url") or "").rstrip("/") + "/chat/completions",
        data=body, method="POST",
        headers={"Content-Type": "application/json",
                 **({"Authorization": "Bearer " + (spec.get("api_key") or _cred(spec.get("api_key_ref") or ""))}
                    if (spec.get("api_key") or spec.get("api_key_ref")) else {})})
    with urllib.request.urlopen(req, timeout=timeout_s) as r:
        raw = r.read().decode("utf-8", "replace")
    data = json.loads(raw)
    return (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""


def _parse_decision(text: str) -> dict | None:
    if not text:
        return None
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(text[start:end + 1])
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    out = {}
    if str(obj.get("function")) in _FUNCS:
        out["function"] = str(obj["function"])
    if str(obj.get("level")) in _LEVELS:
        out["level"] = str(obj["level"])
    if str(obj.get("group")) in _GROUPS:
        out["group"] = str(obj["group"])
    if isinstance(obj.get("needs_tools"), bool):
        out["needs_tools"] = obj["needs_tools"]
    try:
        out["confidence"] = max(0.0, min(1.0, float(obj.get("confidence", 0))))
    except Exception:
        out["confidence"] = 0.0
    out["reason_code"] = str(obj.get("reason_code") or "")[:48]
    return out if ("function" in out or "level" in out or "group" in out) else None


def _record_shadow(row: dict) -> None:
    try:
        os.makedirs(os.path.dirname(SHADOW_LOG), exist_ok=True)
        with open(SHADOW_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        pass


def decide(strategy: str, payload_meta: dict, actual: dict | None = None,
           override: str | None = None) -> dict | None:
    """返回判定结果（active 模式）或 None（off/失败/低于置信度）。

    shadow 模式下照常调用并把结果写 `数据/shadow.jsonl`，但**始终返回 None**，
    调用方行为完全不变（这是 golden diff 逐字节一致的前提）。
    """
    cfg = strategy_config(strategy)
    # 用户 2026-11-20 23:3x：开关权给用户 —— 每请求可用 X-WB-Decider: off|shadow|active 覆盖策略默认值；
    # 不认的值（含 auto/空）一律回落策略配置。
    mode = (override or "").strip().lower()
    if mode not in _MODES:
        mode = cfg["mode"]
    if mode == "off":
        return None
    spec = decider_spec(cfg.get("decider") or "")
    if not spec:
        return None
    name = cfg.get("decider")
    if _circuit_open(name):
        _record_shadow({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "strategy": strategy,
                        "decider": name, "status": "circuit_open"})
        return None
    t0 = time.time()
    try:
        # [2026-11-21 用户令「接吧」] 两种 decider 后端：
        #   openai-compatible（默认）＝chat/completions + 文本 JSON 解析；
        #   decider_a＝结构化打分模型（读 logprobs，不做 generate），见 intern_decision_client。
        if str(spec.get("kind") or "").lower() == "decider_a":
            parsed = _POST_INTERN(spec, payload_meta, cfg["timeout_ms"] / 1000.0)
            if parsed:
                parsed.pop("_detail", None)
        else:
            text = _post_chat(spec, _digest(payload_meta), cfg["timeout_ms"] / 1000.0)
            parsed = _parse_decision(text)
    except Exception as e:  # noqa: BLE001 —— 任何异常都不许影响主链路
        _note_failure(name)
        _record_shadow({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "strategy": strategy,
                        "decider": name, "status": "error", "error": str(e)[:120],
                        "latency_ms": int((time.time() - t0) * 1000)})
        return None
    latency = int((time.time() - t0) * 1000)
    if parsed is None:
        _note_failure(name)
        _record_shadow({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "strategy": strategy,
                        "decider": name, "status": "parse_error", "latency_ms": latency})
        return None
    _note_success(name)
    if actual is not None:
        parsed["actual"] = actual
    _record_shadow({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "strategy": strategy,
                    "decider": name, "status": "ok", "latency_ms": latency,
                    "decision": parsed, "actual": actual or {}})
    if mode == "shadow":
        return None
    if parsed.get("confidence", 0.0) < cfg["min_confidence"]:
        return None
    return parsed


def status() -> dict:
    """给 /health 用的只读摘要：只报模式与最近调用计数，不含金额、不含内容。"""
    doc = _load(force=True)
    by = doc.get("by_strategy") or {}
    return {"enabled": {k: (v or {}).get("mode", "off") for k, v in by.items()},
            "registry": sorted((doc.get("registry") or {}).keys())}
