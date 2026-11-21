#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B4 影子判定（1.0.3.2 T5）：对每条新消息调本地 L0 模型，只记录、绝不改选模。

边界（用户 20 23:17 + 1.0.3.1 审核单 §四 B4）：
- 默认关（config/shadow_judge.json → enabled=false；env ROUTER_B4_SHADOW=1/0 覆盖）；
- 只记录，不改 candidates/chosen；失败即丢弃（不重试、不阻塞请求——后台线程 + 超时）；
- 记录写 `数据/shadow.jsonl`（沿用既有影子文件，source=b4_shadow_judge 区分）；
- `/v1/route/shadow` 只读汇总；`/health.shadow` 仅在开启时出现。
"""

from __future__ import annotations

import json
import os
import statistics
import threading
import time
from pathlib import Path

import router_deciders

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config" / "shadow_judge.json"
SHADOW_LOG = BASE_DIR / "数据" / "shadow.jsonl"
SOURCE = "b4_shadow_judge"
ENV = "ROUTER_B4_SHADOW"

_DEFAULTS = {"enabled": False, "decider": "decider_c", "deciders": None, "timeout_s": 8,
             "max_input_tokens": 16000, "sample_rate": 1.0}
_CACHE = {"mtime": None, "doc": None}
_LOCK = threading.Lock()
_INFLIGHT = {"count": 0}

# [2026-11-21 用户令「接吧，同时对照跑 8 小时」] 支持多 decider 同时判定同一条流量：
# 配置写 `deciders: ["decider_b","decider_a"]` 即在同一条消息上并行跑多个判定、
# 各写一行（行里带 decider 字段）；只写 `decider: "x"` 时行为与改前一致（单判定）。
def decider_names(cfg: dict | None = None) -> list:
    cfg = cfg or _load()
    many = cfg.get("deciders")
    if isinstance(many, list) and many:
        return [str(x) for x in many if str(x).strip()]
    return [str(cfg.get("decider") or "decider_c")]

_INSTRUCTION = ("你是路由判定影子模型。只看给定的请求特征，判断这条新消息的复杂度档位。"
                "只输出一个 JSON 对象：{\"simple_prob\":0~1,\"suggested_group\":\"L1|L2|L3\","
                "\"score\":0~100}。不要输出任何解释。")


def _load() -> dict:
    try:
        mtime = CONFIG_PATH.stat().st_mtime
    except OSError:
        return dict(_DEFAULTS)
    with _LOCK:
        if _CACHE.get("mtime") == mtime and _CACHE.get("doc"):
            return dict(_CACHE["doc"])
        try:
            doc = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            doc = {}
        if not isinstance(doc, dict):
            doc = {}
        merged = dict(_DEFAULTS)
        merged.update({k: v for k, v in doc.items() if k in _DEFAULTS})
        _CACHE.update(mtime=mtime, doc=merged)
        return dict(merged)


def enabled() -> bool:
    raw = (os.environ.get(ENV) or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return bool(_load().get("enabled"))


def _record(row: dict) -> None:
    try:
        SHADOW_LOG.parent.mkdir(parents=True, exist_ok=True)
        with SHADOW_LOG.open("a", encoding="utf-8") as fp:
            fp.write(json.dumps(row, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _parse_judgement(text: str) -> dict | None:
    if not isinstance(text, str) or not text.strip():
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
    group = str(obj.get("suggested_group") or obj.get("group") or "").strip().upper()
    if group not in ("L1", "L2", "L3"):
        return None
    try:
        simple_prob = max(0.0, min(1.0, float(obj.get("simple_prob", 0))))
    except Exception:
        simple_prob = 0.0
    try:
        score = max(0.0, min(100.0, float(obj.get("score", 0))))
    except Exception:
        score = 0.0
    return {"simple_prob": round(simple_prob, 3), "suggested_group": group,
            "score": round(score, 1)}


def _prompt(features: dict, stage: str, period: str, est_tokens: int) -> str:
    """影子提示词。

    [2026-11-21 20:2x 泄漏修复] 原实现把 `current_stage` 一并喂给模型——而影子要预测的正是
    档位（stage_actual）⇒ **等于把答案给了模型**，一致率必然虚高（8 小时窗口里"两侧 8/8
    全对"就是这个假象）。此处只保留请求结构特征；档位仅用于事后对比，绝不入提示词。
    `period`（峰谷）不是标签，保留。也**不喂正文**（与生产 `Features` 口径一致）。
    """
    return json.dumps({
        "est_input_tokens": est_tokens,
        "chars": features.get("chars"),
        "message_count": features.get("message_count"),
        "has_tools": features.get("has_tools"),
        "has_image": features.get("has_image"),
        "max_tokens": features.get("max_tokens"),
        "period": period,
    }, ensure_ascii=False) + "\n请判断这条消息的复杂度档位。"


def _judge_and_record(row_base: dict, features: dict, stage: str, period: str,
                      est_tokens: int, cfg: dict) -> None:
    name = str(row_base.get("decider") or cfg.get("decider") or "decider_c")
    spec = router_deciders.decider_spec(name) or {}
    started = time.time()
    timeout_s = float(cfg.get("timeout_s") or 8)
    try:
        if str(spec.get("kind") or "").lower() == "decider_a":
            # [2026-11-21 用户令「接吧」] 本地打分模型 是打分模型（不做 generate），
            # 无 chat 语义 ⇒ 走 intern_decision_client，一次决策 = 1 个字段 1 次请求。
            import intern_decision_client as idc  # noqa: PLC0415
            got = idc.judge(spec, _prompt(features, stage, period, est_tokens), timeout=timeout_s)
            latency_ms = int((time.time() - started) * 1000)
            row = dict(row_base, model=spec.get("model"), latency_ms=latency_ms,
                       status="ok" if got else "bad_output")
            if got:
                row.update({k: v for k, v in got.items() if k != "latency_ms"})
            else:
                row["error"] = "intern_decision_failed"
            _record(row)
            return
        # [2026-11-21 10:5x 修复] 传本模块自己的 system 指令：原先缺省会用
        # router_deciders._INSTRUCTION（decider 契约），模型回 function/level/... 而本模块
        # 要 simple_prob/suggested_group/score ⇒ 影子期全天 bad_output（已实测复现）。
        text = router_deciders._post_chat(spec, _prompt(features, stage, period, est_tokens),
                                          timeout_s, _INSTRUCTION)
        latency_ms = int((time.time() - started) * 1000)
        parsed = _parse_judgement(text)
        row = dict(row_base, model=spec.get("model"), latency_ms=latency_ms,
                   status="ok" if parsed else "bad_output")
        if parsed:
            row.update(parsed)
        else:
            row["error"] = "invalid_judgement_json"
        _record(row)
    except Exception as exc:  # 失败即丢弃，不影响主链路
        _record(dict(row_base, model=spec.get("model"),
                     latency_ms=int((time.time() - started) * 1000),
                     status="error", error=f"{type(exc).__name__}: {str(exc)[:160]}"))
    finally:
        with _LOCK:
            _INFLIGHT["count"] = max(0, _INFLIGHT["count"] - 1)


def submit(req_id: str, features: dict, stage: str, period: str, est_tokens: int) -> bool:
    """异步提交一次影子判定；返回是否真的派发（关/超限/sample 未中 ⇒ False）。"""
    if not enabled():
        return False
    cfg = _load()
    try:
        if est_tokens and est_tokens > int(cfg.get("max_input_tokens") or 16000):
            _record({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "source": SOURCE,
                     "req_id": req_id, "stage_actual": stage, "period": period,
                     "est_input_tokens": int(est_tokens), "status": "too_large"})
            return False
        rate = float(cfg.get("sample_rate") or 1.0)
        if rate < 1.0 and (hash(req_id) % 1000) / 1000.0 >= rate:
            return False
    except Exception:
        return False
    base = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "source": SOURCE,
            "req_id": req_id, "stage_actual": stage, "period": period,
            "est_input_tokens": int(est_tokens or 0)}
    # 多 decider 对照：同一条流量并行跑 N 个判定，各写一行（行内 decider 可区分）
    for name in decider_names(cfg):
        row_base = dict(base, decider=name)
        with _LOCK:
            _INFLIGHT["count"] += 1
        threading.Thread(target=_judge_and_record, daemon=True,
                         args=(row_base, dict(features), stage, period, int(est_tokens or 0), cfg),
                         name="b4-shadow-judge").start()
    return True


def _read_rows(days: int = 7) -> list[dict]:
    if not SHADOW_LOG.exists():
        return []
    cutoff = time.time() - days * 86400
    rows = []
    try:
        for line in SHADOW_LOG.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if not isinstance(row, dict) or row.get("source") != SOURCE:
                continue
            try:
                epoch = time.mktime(time.strptime(str(row.get("ts") or ""), "%Y-%m-%dT%H:%M:%S%z"))
            except Exception:
                continue
            if epoch < cutoff:
                continue
            rows.append(row)
    except OSError:
        return []
    return rows


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((pct / 100.0) * (len(ordered) - 1)))))
    return ordered[index]


def summary(range_key: str = "7d") -> dict:
    days = {"today": 1, "1d": 1, "7d": 7, "30d": 30}.get(str(range_key or "7d").lower(), 7)
    rows = _read_rows(days)
    ok = [r for r in rows if r.get("status") == "ok"]
    latencies = [float(r.get("latency_ms") or 0) for r in ok]
    agree = [r for r in ok if r.get("suggested_group") == str(r.get("stage_actual") or "").upper()]
    simple = [float(r.get("simple_prob") or 0) for r in ok]
    now = time.time()
    last24 = 0
    for row in rows:
        try:
            epoch = time.mktime(time.strptime(str(row.get("ts") or ""), "%Y-%m-%dT%H:%M:%S%z"))
        except Exception:
            continue
        if now - epoch <= 86400:
            last24 += 1
    return {
        "ok": True, "mode": "read_only", "source": SOURCE, "range": range_key, "days": days,
        "enabled": enabled(), "model": "+".join(decider_names()),
        "calls": len(rows), "ok_calls": len(ok),
        "errors": len([r for r in rows if r.get("status") == "error"]),
        "bad_output": len([r for r in rows if r.get("status") == "bad_output"]),
        "too_large": len([r for r in rows if r.get("status") == "too_large"]),
        "inflight": _INFLIGHT["count"],
        "latency_ms": {"p50": _percentile(latencies, 50), "p95": _percentile(latencies, 95)},
        "simple_prob": {"p50": _percentile(simple, 50), "p95": _percentile(simple, 95)},
        "agreement": {"count": len(agree),
                      "rate": round(len(agree) / len(ok), 3) if ok else None},
        "last_24h_calls": last24,
        "note": "影子只记录，不改任何选模结果；失败即丢弃",
    }


def status() -> dict:
    rows = _read_rows(1)
    return {"enabled": enabled(), "model": "+".join(decider_names()),
            "last_24h_calls": len(rows), "inflight": _INFLIGHT["count"]}
