"""WB 网关 · 计划 API / 标注 API / 自动学习（P1）。

契约来自《261116.DSH.WB路由产品设计.v1.0.0》：
  - POST /v1/route/plan       无状态、只出计划；
  - POST /v1/route/annotation 关联 plan/stage/model/usage，并驱动 learnedOverrides；
  - learnedOverrides 是“策略 + 能力/角色 → 模型”的隔离层，不改 L1/L2/L3 主链；
  - auto 策略不参与自动学习；cost/capability/function 才学；
  - 三次“同一用户 + 同策略 + 同节点 + 同模型”的已确认任务才自动写。

本模块只读写 config/learned-state.json、annotations.jsonl、数据/auto-learn-audit.jsonl，
策略写回经 router_strategies.upsert_learned_override()。
"""

from __future__ import annotations

import heapq
import json
import os
import re
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import price_resolver
import price_state  # 1.0.3.10 #5：价格三态单一真源

_GATEWAY = None
_LOCK = threading.Lock()

# ── Q1-5（2026-11-18）：plan 允许的顶层键（其余回显到 ignored_keys，不再静默丢弃）──
ALLOWED_PLAN_KEYS = {"task", "strategy", "function", "context", "constraints",
                     "max_stages", "client", "request_id", "ignore_learned_override",
                     "automation_level", "stage_models"}
MAX_STAGES_MIN, MAX_STAGES_MAX, MAX_STAGES_DEFAULT = 1, 6, 3


def _max_stages_int(v):
    """把 max_stages 归一成 int；不合法返回 None（bool 不算整数）。"""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        return int(v) if v.is_integer() else None
    if isinstance(v, str):
        t = v.strip()
        if t[:1] in "+-" and t[1:].isdigit():
            return int(t)
        return int(t) if t.isdigit() else None
    return None


# ── Q1-2（2026-11-18）：plan 短期状态（内存 TTL 24h，不落盘）──────────────────────
# 目的：annotation 必须能校验 plan/stage/model 是否真实存在、是否同一 principal，
#       否则任何持有 plan scope 的 key 连发 3 条伪造 annotation，就能把某个能力的
#       路由永久写到一个自选模型（learnedOverride 是全局的）——即"学习管道被投毒"。
# 不落盘：从设计上避开"数据文件写操作须用户下令"这条红线；代价＝网关重启后未执行完
#       的 plan 失效（MCP 侧会收到 404 plan_unknown，提示重新 plan 即可）。
# 退化开关：ROUTER_PLAN_STATE=warn ⇒ 只标状态、不拒绝（用于灰度观察，一行 env 即回退）。
PLAN_TTL_S = 24 * 3600
PLAN_MAX_ENTRIES = 5000
PLAN_STATE_MODE = (os.environ.get("ROUTER_PLAN_STATE") or "strict").strip().lower()
_PLAN_STATE: dict[str, dict] = {}
_PLAN_STATE_LOCK = threading.Lock()


def _plan_prune_locked(now: float) -> None:
    for pid in [k for k, v in _PLAN_STATE.items()
                if now - float(v.get("created") or 0) > PLAN_TTL_S]:
        _PLAN_STATE.pop(pid, None)
    overflow = len(_PLAN_STATE) - PLAN_MAX_ENTRIES
    if overflow > 0:
        for pid, _ in heapq.nsmallest(overflow, _PLAN_STATE.items(),
                                      key=lambda kv: kv[1].get("created") or 0):
            _PLAN_STATE.pop(pid, None)


def _plan_store(plan: dict, principal: dict | None) -> None:
    stages = {}
    for st in plan.get("stages") or []:
        stages[str(st.get("stage_id"))] = {
            "model_key": (st.get("model") or {}).get("key"),
            "capability": st.get("capability"),
            "tier": (st.get("model") or {}).get("tier"),
            # Q3-11：把计划时的估价快照存下来，annotation 才能算「预估 vs 实付」差额
            "estimate": dict(st.get("estimate") or {}),
        }
    first = (plan.get("stages") or [{}])[0] if plan.get("stages") else {}
    rec = {"created": time.time(),
           "principal": _principal(principal).get("id"),
           "stages": stages,
           "strategy": plan.get("resolved_strategy"),
           "stage_key": plan.get("stage_key"),
           "capability": first.get("capability"),
           "function": plan.get("function"),
           "period": plan.get("period")}
    with _PLAN_STATE_LOCK:
        _plan_prune_locked(rec["created"])
        _PLAN_STATE[str(plan.get("plan_id"))] = rec


def _plan_get(plan_id: str) -> dict | None:
    now = time.time()
    with _PLAN_STATE_LOCK:
        _plan_prune_locked(now)
        rec = _PLAN_STATE.get(plan_id)
        return dict(rec) if rec else None

# ---------------------------------------------------------------------------
# B1 边界纪律（1.0.3.2 T2，2026-11-21）：同轮工具调用不换模型
#
# 口径：只在新消息 / 上下文重建处允许换模；同轮工具轮次内换模 ⇒ 记 discipline_violation
#       （只记账，不阻断）。plan 每段附只读 boundary_policy；开关关 ⇒ 不输出任何新字段。
# ---------------------------------------------------------------------------
B1_ENV = "ROUTER_B1_DISCIPLINE"
B1_SWITCH_ON = ("new_user_message", "context_rebuild")
B1_RULE = "same_turn_model_frozen"
# 网关侧因治理/守门/上游降级而换模时，允许上报豁免原因；判据只盯"非豁免"计数。
B1_EXEMPT_REASONS = ("context_governor", "guard", "fallback")
_TURN_TTL_S = 6 * 3600
_TURN_MAX_ENTRIES = 5000
_TURN_STATE: dict[str, dict] = {}
_TURN_LOCK = threading.Lock()


def b1_enabled() -> bool:
    raw = (os.environ.get(B1_ENV) or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def boundary_policy() -> dict:
    """plan 每段的只读边界策略（B1）；是否输出由调用方按 b1_enabled() 决定。"""
    return {"switch_on": list(B1_SWITCH_ON), "tool_turns_frozen": True}


def _turn_prune_locked(now: float) -> None:
    for key in [k for k, v in _TURN_STATE.items()
                if now - float(v.get("updated") or 0) > _TURN_TTL_S]:
        _TURN_STATE.pop(key, None)
    overflow = len(_TURN_STATE) - _TURN_MAX_ENTRIES
    if overflow > 0:
        for key, _ in heapq.nsmallest(overflow, _TURN_STATE.items(),
                                      key=lambda kv: kv[1].get("updated") or 0):
            _TURN_STATE.pop(key, None)


def _clean_turn_ctx(turn_ctx: dict | None) -> dict | None:
    """校验 annotation 里的 turn_ctx（只收白名单字段，缺 turn_id ⇒ 视为未上报）。"""
    if not isinstance(turn_ctx, dict):
        return None
    turn_id = str(turn_ctx.get("turn_id") or "").strip()[:128]
    if not turn_id:
        return None
    exempt = str(turn_ctx.get("exempt") or "").strip().lower()[:32]
    return {"turn_id": turn_id,
            "tool_turn": turn_ctx.get("tool_turn") is True,
            "context_rebuilt": turn_ctx.get("context_rebuilt") is True,
            "exempt": exempt if exempt in B1_EXEMPT_REASONS else ""}


def _discipline_check(turn_ctx: dict | None, model_key: str,
                      plan_id: str, stage_id: str) -> dict | None:
    """判「同一 turn 的工具轮次内换模」；返回违规记录（不阻断调用）。"""
    ctx = _clean_turn_ctx(turn_ctx)
    if ctx is None or not b1_enabled():
        return None
    now = time.time()
    turn_id = ctx["turn_id"]
    with _TURN_LOCK:
        _turn_prune_locked(now)
        prev = _TURN_STATE.get(turn_id)
        violation = None
        if ctx["context_rebuilt"]:
            _TURN_STATE[turn_id] = {"model": model_key, "updated": now,
                                    "first_at": (prev or {}).get("first_at") or now}
            return None
        if ctx["tool_turn"] and prev and prev.get("model") and prev["model"] != model_key:
            violation = {"turn_id": turn_id, "rule": B1_RULE,
                         "prev_model": prev["model"], "model": model_key,
                         "plan_id": plan_id, "stage_id": stage_id,
                         "exempt": ctx.get("exempt") or None,
                         "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
        _TURN_STATE[turn_id] = {"model": model_key, "updated": now,
                                "first_at": (prev or {}).get("first_at") or now}
        return violation


def discipline_report(range_key: str = "7d") -> dict:
    """只读聚合 `annotations.jsonl` 里带 discipline_violation 的行（B1 违约台账）。"""
    days = {"today": 1, "1d": 1, "7d": 7, "30d": 30}.get(str(range_key or "7d"), 7)
    cutoff = time.time() - days * 86400
    path = annotations_path()
    total = 0
    violations: list[dict] = []
    parse_failed = 0
    if path.exists():
        try:
            with path.open("r", encoding="utf-8") as fp:
                for line in fp:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except Exception:
                        parse_failed += 1
                        continue
                    at = str(row.get("at") or "")
                    try:
                        epoch = datetime.strptime(at, "%Y-%m-%dT%H:%M:%S%z").timestamp()
                    except Exception:
                        parse_failed += 1
                        continue
                    if epoch < cutoff:
                        continue
                    total += 1
                    dv = row.get("discipline_violation")
                    if isinstance(dv, dict):
                        violations.append({"at": at, "turn_id": dv.get("turn_id"),
                                           "prev_model": dv.get("prev_model"),
                                           "model": dv.get("model"),
                                           "plan_id": dv.get("plan_id"),
                                           "stage_id": dv.get("stage_id"),
                                           "exempt": dv.get("exempt")})
        except OSError:
            return {"ok": False, "code": "annotations_unreadable",
                    "error": f"读取台账失败：{path}", "range": range_key}
    violations.sort(key=lambda item: item.get("at") or "")
    exempt = [item for item in violations if item.get("exempt")]
    non_exempt = [item for item in violations if not item.get("exempt")]
    return {"ok": True, "range": range_key, "days": days, "enabled": b1_enabled(),
            "rule": B1_RULE, "annotations": total,
            "violations": len(violations),
            "exempt_violations": len(exempt),
            "non_exempt_violations": len(non_exempt),
            "exempt_reasons": sorted(B1_EXEMPT_REASONS),
            "items": violations[-200:],
            "parse_failed": parse_failed, "policy": boundary_policy()}


# ---------------------------------------------------------------------------
# B3 自动化档位（1.0.3.2 T3，2026-11-21）：L1 严格（默认）/ L2 知会 / L3 草稿
# 只做映射层，不改原策略键；默认 L1 时 plan 输出一个字节都不变（插件也不带该参数）。
# ---------------------------------------------------------------------------
B3_ENV = "ROUTER_B3_AUTOMATION"
AUTOMATION_LEVELS = {
    "L1": {"label": "严格", "confirm_required": True, "auto_execute": False, "draft": False,
           "note": "现状：每段确认，确认前可改模型/策略"},
    "L2": {"label": "知会", "confirm_required": False, "auto_execute": True, "draft": False,
           "note": "按已审计划自动执行，段末推送已执行/已花"},
    "L3": {"label": "草稿", "confirm_required": False, "auto_execute": True, "draft": True,
           "note": "自动执行但结果进草稿，需人放行才发出"},
}
_AUTOMATION_ALIASES = {"l1": "L1", "l2": "L2", "l3": "L3",
                       "严格": "L1", "知会": "L2", "草稿": "L3",
                       "level1": "L1", "level2": "L2", "level3": "L3"}


def b3_enabled() -> bool:
    raw = (os.environ.get(B3_ENV) or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def automation_levels() -> dict:
    """档位↔语义映射（文档/插件/测试的单一真源）。"""
    return {"default": "L1", "advanced_entry": "strategy",
            "levels": [{"level": key, **AUTOMATION_LEVELS[key]}
                       for key in ("L1", "L2", "L3")],
            "note": "档位只改确认节奏，不改选模结果"}


def _normalize_automation_level(raw) -> str | None:
    if isinstance(raw, bool) or raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    upper = text.upper()
    if upper in AUTOMATION_LEVELS:
        return upper
    return _AUTOMATION_ALIASES.get(text.lower())


# ---------------------------------------------------------------------------
# B2 复盘报告 + 回放（1.0.3.2 T4，2026-11-21）
#
# 报告：只读聚合 annotations.jsonl（预估 vs 实付）与 数据/ledger.jsonl（请求级实账），
#       按 model / stage 分组；ledger 只读尾部 1MB ⇒ 报告明确标 partial，不补造。
# 回放：只读复算历史 plan（内存 TTL 24h 内的计划）；改策略假设后返回"当时会怎么选"，
#       不执行、不写账、不调上游；计划状态过期 ⇒ 404（或按 annotations 给 partial 原值），不编造。
# ---------------------------------------------------------------------------
B2_REPORT_RANGES = {"today": 1, "1d": 1, "7d": 7, "30d": 30}
_LEDGER_TAIL_BYTES = 1024 * 1024


def _epoch_of_at(at) -> float | None:
    try:
        return datetime.strptime(str(at or ""), "%Y-%m-%dT%H:%M:%S%z").timestamp()
    except Exception:
        return None


def _iter_jsonl_rows(path: Path, since: float | None = None,
                     tail_bytes: int | None = None) -> tuple[list[dict], bool]:
    """只读 JSONL；返回 (rows, truncated)。tail_bytes 只读尾部（用于大账本）。"""
    if not path.exists():
        return [], False
    truncated = False
    try:
        if tail_bytes:
            size = path.stat().st_size
            block = min(size, tail_bytes)
            with path.open("rb") as fp:
                fp.seek(size - block)
                lines = fp.read().decode("utf-8", "replace").splitlines()
            if block < size and lines:
                lines = lines[1:]
            truncated = block < size
        else:
            lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return [], True
    rows: list[dict] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if not isinstance(row, dict):
            continue
        if since is not None:
            epoch = _epoch_of_at(row.get("at") or row.get("ts"))
            if epoch is None or epoch < since:
                continue
        rows.append(row)
    return rows, truncated


def _num(v) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if f == f else 0.0


def report(range_key: str = "7d", group: str = "model") -> dict:
    """只读复盘报告：预估 vs 实付（annotations）＋ 请求实账（ledger 尾部）。"""
    key = str(range_key or "7d").strip().lower()
    days = B2_REPORT_RANGES.get(key, 7)
    group = "stage" if str(group or "model").strip().lower() == "stage" else "model"
    since = time.time() - days * 86400
    annotations, _ = _iter_jsonl_rows(annotations_path(), since=since)
    ledger_rows, ledger_truncated = _iter_jsonl_rows(
        Path(_gw().LEDGER_PATH), since=since, tail_bytes=_LEDGER_TAIL_BYTES)

    ann_totals = {"stages": 0, "with_usage": 0, "unknown_pricing": 0,
                  "planned_input_tokens": 0, "actual_input_tokens": 0,
                  "planned_output_tokens": 0, "actual_output_tokens": 0,
                  "planned_cost": 0.0, "actual_cost": 0.0, "cost_delta": 0.0,
                  "currency": "CNY", "unpriced_rows": 0, "foreign_currency_rows": 0}
    ann_groups: dict[str, dict] = {}

    def _ann_bucket(name: str) -> dict:
        return ann_groups.setdefault(name, {"stages": 0, "with_usage": 0,
                                            "planned_input_tokens": 0, "actual_input_tokens": 0,
                                            "planned_cost": 0.0, "actual_cost": 0.0,
                                            "cost_delta": 0.0, "unknown_pricing": 0,
                                            "currency": "CNY"})

    for row in annotations:
        est = row.get("estimate") if isinstance(row.get("estimate"), dict) else {}
        delta = row.get("estimate_delta") if isinstance(row.get("estimate_delta"), dict) else {}
        est_in = int(_num(est.get("input_tokens")))
        est_out = int(_num(est.get("output_tokens")))
        planned_cost = _num(est.get("cost_micro") if est.get("cost_micro") is not None
                            else est.get("cost_known"))
        unknown = bool(est.get("unknown_pricing"))
        usage = row.get("usage") if isinstance(row.get("usage"), dict) else {}
        actual_in = int(_num(delta.get("actual_input_tokens") or usage.get("prompt_tokens")
                             or usage.get("input_tokens")))
        actual_out = int(_num(delta.get("actual_output_tokens") or usage.get("completion_tokens")
                              or usage.get("output_tokens")))
        has_usage = bool(delta.get("actual_cost") is not None or actual_in or actual_out)
        actual_cost = _num(delta.get("actual_cost"))
        name = (str(row.get("model_key") or "?") if group == "model"
                else str(row.get("capability") or row.get("stage_key") or "?"))
        buckets = (ann_totals, _ann_bucket(name))
        for bucket in buckets:
            bucket["stages"] += 1
            if has_usage:
                bucket["with_usage"] += 1
            if unknown:
                bucket["unknown_pricing"] += 1
                if "unpriced_rows" in bucket:
                    bucket["unpriced_rows"] += 1
            if "foreign_currency_rows" in bucket and str(est.get("currency") or "CNY").upper() != "CNY":
                bucket["foreign_currency_rows"] += 1
            bucket["planned_input_tokens"] += est_in
            bucket["actual_input_tokens"] += actual_in
            bucket["planned_cost"] += planned_cost
            bucket["actual_cost"] += actual_cost
        ann_totals["planned_output_tokens"] += est_out
        ann_totals["actual_output_tokens"] += actual_out
    for bucket in [ann_totals, *ann_groups.values()]:
        bucket["cost_delta"] = round(bucket["actual_cost"] - bucket["planned_cost"], 6)
        bucket["planned_cost"] = round(bucket["planned_cost"], 6)
        bucket["actual_cost"] = round(bucket["actual_cost"], 6)
        bucket["input_ratio"] = (round(bucket["actual_input_tokens"] / bucket["planned_input_tokens"], 3)
                                 if bucket["planned_input_tokens"] else None)

    led_totals = {"requests": 0, "ok": 0, "failed": 0,
                  "est_input_tokens": 0, "prompt_tokens": 0, "completion_tokens": 0}
    led_groups: dict[str, dict] = {}
    for row in ledger_rows:
        usage = row.get("usage") if isinstance(row.get("usage"), dict) else {}
        features = row.get("features") if isinstance(row.get("features"), dict) else {}
        status = str(row.get("final_status") or "")
        ok = status.startswith("ok")
        name = (str(row.get("chosen") or row.get("model_chosen") or "?") if group == "model"
                else str(row.get("stage") or "?"))
        bucket = led_groups.setdefault(name, {"requests": 0, "ok": 0, "failed": 0,
                                              "est_input_tokens": 0, "prompt_tokens": 0,
                                              "completion_tokens": 0})
        for target in (led_totals, bucket):
            target["requests"] += 1
            target["ok" if ok else "failed"] += 1
            target["est_input_tokens"] += int(_num(features.get("est_input_tokens")))
            target["prompt_tokens"] += int(_num(usage.get("prompt_tokens")))
            target["completion_tokens"] += int(_num(usage.get("completion_tokens")))
    for bucket in [led_totals, *led_groups.values()]:
        bucket["token_ratio"] = (round(bucket["prompt_tokens"] / bucket["est_input_tokens"], 3)
                                 if bucket["est_input_tokens"] else None)

    notes = ["报告只读：不执行、不写账、不调上游",
             "annotations 只含已回执的阶段；未回执的 plan 段不在报告内",
             "ledger 只读尾部 1MB，超出部分不进本报告（partial=true 时请看原始账本）"]
    if ledger_truncated:
        notes.append("ledger 尾部 1MB 截断：统计不完整（partial）")
    ledger_epochs = [e for e in (_epoch_of_at(r.get("ts")) for r in ledger_rows) if e]
    return {
        "ok": True,
        "mode": "read_only",
        "range": key if key in B2_REPORT_RANGES else "7d",
        "days": days,
        "group": group,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "annotations": {
            "totals": ann_totals,
            "groups": dict(sorted(ann_groups.items())),
        },
        "ledger": {
            "totals": led_totals,
            "groups": dict(sorted(led_groups.items())),
            "first_ts": (datetime.fromtimestamp(min(ledger_epochs)).strftime(
                "%Y-%m-%dT%H:%M:%S%z") if ledger_epochs else None),
            "last_ts": (datetime.fromtimestamp(max(ledger_epochs)).strftime(
                "%Y-%m-%dT%H:%M:%S%z") if ledger_epochs else None),
            "truncated": ledger_truncated,
        },
        "partial": bool(ledger_truncated),
        "notes": notes,
    }


def replay(payload: dict) -> tuple[dict, int]:
    """只读复算历史 plan：改策略假设 → 返回"当时会怎么选"；0 执行 0 写账 0 调上游。"""
    if not isinstance(payload, dict):
        return {"ok": False, "code": "bad_payload", "error": "body 必须是 JSON 对象"}, 400
    plan_id = _clean(payload.get("plan_id"), 128)
    if not plan_id:
        return {"ok": False, "code": "missing_plan_id", "error": "plan_id 必填"}, 400
    settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
    strategy_req = str(settings.get("strategy") or "").strip().lower()
    if strategy_req and strategy_req not in VALID_STRATEGIES:
        return {"ok": False, "code": "bad_strategy",
                "error": f"settings.strategy 必须是 {', '.join(VALID_STRATEGIES)}"}, 400
    automation_req = settings.get("automation_level")
    automation_level = None
    if automation_req is not None and str(automation_req).strip():
        automation_level = _normalize_automation_level(automation_req)
        if automation_level is None:
            return {"ok": False, "code": "bad_automation_level",
                    "error": "settings.automation_level 必须是 L1/L2/L3"}, 400
    base = {"ok": True, "plan_id": plan_id, "mode": "read_only",
            "executed": False, "writes": 0, "upstream_calls": 0,
            "settings": {"strategy": strategy_req or None,
                         "automation_level": automation_level},
            "limits": ["plan 状态只在内存 TTL 24h；网关重启后不可复算",
                       "回放只按策略假设复算，不复算 learnedOverride 时间旅行的中间态"]}
    plan_state = _plan_get(plan_id)
    if plan_state is None:
        ann_rows, _ = _iter_jsonl_rows(annotations_path())
        rows = [r for r in ann_rows if r.get("plan_id") == plan_id]
        if not rows:
            base.update({"ok": False, "code": "plan_state_expired",
                         "error": (f"计划 {plan_id} 状态已过期（内存 TTL 24h 或网关重启），"
                                   "annotations 里也没有该 plan 的回执，无法只读复算"),
                         "hint": "请在 plan 后 24h 内复算，或重新 POST /v1/route/plan"})
            return base, 404
        stages = []
        for row in rows:
            stages.append({"stage_id": row.get("stage_id"),
                           "capability": row.get("capability"),
                           "original_model": row.get("model_key"),
                           "replayed_model": None,
                           "changed": None})
        base.update({"partial": True, "stages": stages, "changed": 0,
                     "notice": ("计划状态已过期：只回放 annotations 里的原始模型，"
                                "不做假设复算（partial）")})
        return base, 200
    strategy = strategy_req or str(plan_state.get("strategy") or "")
    stage_key = str(plan_state.get("stage_key") or "")
    function = str(plan_state.get("function") or "")
    period = str(plan_state.get("period") or _period())
    stages_out = []
    changed = 0
    for sid in sorted((plan_state.get("stages") or {})):
        rec = plan_state["stages"][sid] or {}
        original = rec.get("model_key")
        chain = _chain_for(strategy, stage_key, period, function, "", "")
        replayed = chain[0] if chain else original
        is_changed = bool(replayed and original and replayed != original)
        changed += 1 if is_changed else 0
        stages_out.append({"stage_id": sid,
                           "capability": rec.get("capability"),
                           "original_model": original,
                           "replayed_model": replayed,
                           "changed": is_changed})
    base.update({"partial": False,
                 "original_strategy": plan_state.get("strategy"),
                 "replay_strategy": strategy,
                 "period": period,
                 "stages": stages_out,
                 "changed": changed,
                 "notice": "只读复算：未执行、未写账、未调上游；仅按策略假设重算链头模型"})
    return base, 200


VALID_STRATEGIES = ("auto", "cost", "capability", "function", "recommend")
CHAT_FUNCTION_KEYS = {"vision", "tools", "long_context", "decision", "writing",
                      "system_control", "coding", "code_testing", "memory"}
COMPLEX_WORDS = ("架构", "设计", "推理", "多步", "复杂", "创意", "权衡", "根因", "方案对比",
                 "重构", "安全", "审计", "规划", "为什么", "证明")
CODING_WORDS = ("代码", "函数", "脚本", "python", "javascript", "typescript", "java", "sql",
                "bug", "测试", "接口", "实现", "重构", "编译", "报错", "pytest")
VISION_WORDS = ("图片", "图像", "截图", "视觉", "识别这张", "看图", "照片", "图表")
WRITING_WORDS = ("写", "文案", "报告", "总结", "摘要", "润色", "改写", "邮件", "文章", "PPT")
LONG_WORDS = ("长文", "全文", "整份", "超长", "合同", "论文", "资料", "文档")


def set_gateway(module) -> None:
    global _GATEWAY
    _GATEWAY = module


def _gw():
    if _GATEWAY is None:
        raise RuntimeError("router_plan 未初始化")
    return _GATEWAY


def _base() -> Path:
    return Path(_gw().BASE_DIR)


def settings_path() -> Path:
    return _base() / "config" / "wb-router-settings.json"


def learned_state_path() -> Path:
    return _base() / "config" / "learned-state.json"


def annotations_path() -> Path:
    return _base() / "数据" / "annotations.jsonl"


def audit_path() -> Path:
    return _base() / "数据" / "auto-learn-audit.jsonl"


def _atomic_json(path: Path, doc: dict, mode: int | None = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            fp.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
            fp.flush()
            os.fsync(fp.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(row, ensure_ascii=False) + "\n")
        fp.flush()
        os.fsync(fp.fileno())


def settings() -> dict:
    p = settings_path()
    try:
        with p.open("r", encoding="utf-8") as fp:
            doc = json.load(fp)
        if isinstance(doc, dict):
            doc.setdefault("auto_learn", True)
            return doc
    except Exception:
        pass
    return {"version": 1, "auto_learn": True}


def auto_learn_enabled() -> bool:
    return bool(settings().get("auto_learn", True))


def _empty_learned_state() -> dict:
    return {"version": 1, "counters": {}, "updated_at": None}


def load_learned_state() -> dict:
    p = learned_state_path()
    try:
        with p.open("r", encoding="utf-8") as fp:
            doc = json.load(fp)
        if isinstance(doc, dict) and isinstance(doc.get("counters"), dict):
            return doc
    except Exception:
        pass
    return _empty_learned_state()


def save_learned_state(doc: dict) -> None:
    doc["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    _atomic_json(learned_state_path(), doc)


def _clean(text: Any, limit: int = 200_000) -> str:
    return str(text or "").strip()[:limit]


def _tokens(text: str) -> int:
    # 中文按 ~1.8 字符/token 粗估；够计划估算用，不冒充精确计费。
    #
    # R8（2026-11-20）口径注释：这里的除数 **硬编码 1.8**，是**第二/第三估算器**的口径，
    # 与 main.py 的 `CHARS_PER_TOKEN = 2.2`（routing.json → token_estimate.chars_per_token，
    # 用于分类/成本闸门的 est_input_tokens）**不一致**——同一个 task+context 会被两处
    # 估成不同的 token 数。这是**已知欠账**，本模块不再各写一套，将统一到 context_governor M1
    # 保守估算器（另行排期）。本次只标注，**不改任何计算行为**（改除数会动到
    # :602-604 → :536-538 的 learnedOverride 长上下文守卫判定）。
    return max(1, int(len(text) / 1.8)) if text else 1


def _features(task: str, context: str):
    gw = _gw()
    payload = {"messages": [{"role": "user", "content": (task + "\n" + context).strip()}]}
    try:
        return gw.extract_features(payload)
    except Exception:
        return None


def _period() -> str:
    try:
        return _gw().current_period()
    except Exception:
        return "offpeak"


def _route_stage(task: str, context: str) -> str:
    gw = _gw()
    feats = _features(task, context)
    if feats is None:
        return "L2"
    try:
        return gw.classify(feats)
    except Exception:
        return "L2"


def _route_key(stage: str, task: str, context: str) -> str:
    gw = _gw()
    feats = _features(task, context)
    if feats is None:
        return stage
    try:
        return gw.route_key(stage, feats)
    except Exception:
        return stage


def _function_for_task(task: str) -> str:
    text = task.lower()
    if any(w in text for w in VISION_WORDS):
        return "vision"
    if any(w in text for w in CODING_WORDS):
        return "coding"
    if any(w in text for w in LONG_WORDS):
        return "long_context"
    if any(w in text for w in WRITING_WORDS):
        return "writing"
    return ""


def _resolve_strategy(requested: str, function: str, task: str) -> tuple[str, str]:
    """返回 (resolved_strategy, function)。auto 不落库；这里只做本次计划解析。"""
    req = (requested or "auto").strip().lower()
    if req in ("cost", "capability", "recommend"):
        return req, ""
    if req == "function":
        return "function", (function or "").strip().lower()
    # auto：有明确功能线索走 function；复杂任务走 capability；其余 cost
    fn = (function or "").strip().lower() or _function_for_task(task)
    if fn:
        return "function", fn
    if any(w in task for w in COMPLEX_WORDS) or len(task) > 800:
        return "capability", ""
    return "cost", ""


def _stage_specs(task: str, max_stages: int) -> list[dict]:
    text = task.lower()
    if any(w in text for w in CODING_WORDS):
        rows = [
            {"title": "分析需求", "capability": "reasoning", "goal": "拆清目标、约束与验收标准"},
            {"title": "实现", "capability": "coding", "goal": "产出可运行的实现/修改"},
            {"title": "测试验收", "capability": "code_testing", "goal": "用测试或复现验证结果"},
        ]
    elif any(w in text for w in VISION_WORDS):
        rows = [
            {"title": "识别输入", "capability": "vision", "goal": "提取图像/截图中的事实"},
            {"title": "分析判断", "capability": "reasoning", "goal": "结合任务形成判断"},
            {"title": "输出结论", "capability": "writing", "goal": "给出可执行结论"},
        ]
    elif any(w in text for w in WRITING_WORDS):
        rows = [
            {"title": "梳理提纲", "capability": "reasoning", "goal": "确定结构、受众与要点"},
            {"title": "撰写正文", "capability": "writing", "goal": "按提纲产出正文"},
            {"title": "校对收束", "capability": "reasoning", "goal": "核对事实、语气与完整性"},
        ]
    else:
        rows = [
            {"title": "分析任务", "capability": "reasoning", "goal": "明确目标、约束与完成判据"},
            {"title": "执行", "capability": "coding", "goal": "产出任务要求的实际结果"},
            {"title": "验收", "capability": "reasoning", "goal": "对照判据检查并收束"},
        ]
    n = max(1, min(int(max_stages or 3), 6, len(rows)))
    return rows[:n]


def _model_entry(candidate: str) -> dict:
    gw = _gw()
    try:
        info = gw.capability_model_entry(candidate)
    except Exception:
        info = {"id": candidate, "provider": None, "tier": None,
                "context_window": None, "max_tokens": None, "modality": None, "price": None}
    up_id, model_id = gw.split_candidate(candidate)
    upstream = gw.UPSTREAM_MAP.get(up_id)
    spec = upstream.model_spec(model_id) if upstream is not None else {}
    label = spec.get("label") or model_id
    info = dict(info)
    info["label"] = label
    info["model_id"] = model_id
    info["upstream"] = up_id
    return info


def _chain_for(strategy: str, stage_key: str, period: str, function: str, task: str, context: str) -> list[str]:
    gw = _gw()
    try:
        chain = gw.rstrat.chain(strategy, stage_key, period, function)
    except Exception:
        chain = []
    if not chain:
        # 回落：用 build_candidates 的现网/默认链
        try:
            virtual = {"cost": "auto-cost", "capability": "auto-capability",
                       "function": f"auto-fn-{function}"}.get(strategy, "auto")
            chain = gw.build_candidates(virtual, stage_key, period, _features(task, context),
                                        function_name=function or None)
        except Exception:
            chain = []
    # 去重并只留已配置模型
    out = []
    allowed = set()
    for up in gw.UPSTREAMS:
        for mid in up.models:
            allowed.add(f"{up.id}/{mid}")
    for c in chain:
        if c in allowed and c not in out:
            out.append(c)
    return out


def _strategy_model(strategy: str, function: str) -> str:
    if strategy == "cost":
        return "auto-cost"
    if strategy == "capability":
        return "auto-capability"
    if strategy == "recommend":
        return "auto-recommend"
    return f"auto-fn-{function}" if function else "auto-function"


def _cache_rate() -> float:
    """输入缓存命中率（估算用）：ROUTER_CACHE_RATE 环境变量，缺省 0（与旧口径一致）。"""
    raw = (os.environ.get("ROUTER_CACHE_RATE") or "").strip()
    try:
        rate = float(raw)
    except ValueError:
        return 0.0
    return max(0.0, min(1.0, rate))


def _num_or_zero(v) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if f == f else 0.0          # 挡 NaN


def _cost_micro(prices: dict, tokens_in: int, tokens_out: int, cache_rate: float = 0.0) -> float:
    """N5（2026-11-19）：与 price_resolver.estimate_cost 同一公式，但保留 6 位小数。

    为什么不直接改 estimate_cost：用户 2026-11-17 令「金额 3 位小数封顶」，
    r4 测试套件（tests/test_fx.py、tests/test_price_resolver.py）把它锁成判据，
    改它=改锁定基线。所以这里只**另算一份高精度值**给差额行用，既有口径一个字节不动。
    """
    # 单位/语义（2026-11-19 P0 补注）：返回的是**元**，保留 6 位小数；
    #   例：0.002812 元 = 2.812 厘，**不是整数微元 2812**。下游若按"整数微元"解析会差 1e6 倍。
    rate = max(0.0, min(1.0, float(cache_rate or 0.0)))
    p_in = _num_or_zero(prices.get("input", 0.0))
    p_cache = _num_or_zero(prices.get("cache_hit", prices.get("input", 0.0)))
    p_out = _num_or_zero(prices.get("output", 0.0))
    miss = tokens_in / 1_000_000.0 * (1.0 - rate) * p_in
    hit = tokens_in / 1_000_000.0 * rate * p_cache
    return round(miss + hit + tokens_out / 1_000_000.0 * p_out, 6)


def _price_state_for(info: dict) -> str:
    """价格三态：委托单一真源 price_state.py（1.0.3.10 #5）。

    原实现只认 provider_b 与两段价，和 /v1/route/prices 的 main.price_state_of
    口径不一致；统一后两处调用同一函数，杜绝口径漂移。
    """
    return price_state.state_of(info.get("id"), info.get("provider"),
                                info.get("price") if isinstance(info.get("price"), dict) else {})


def _price_for(info: dict, est_in: int, est_out: int, period: str,
               cache_rate: float | None = None, group: str | None = None) -> dict:
    """成本估算：优先 pricebook（有效价，含峰谷/活动/分组）；无则回落 capability_meta。

    Q2-7（2026-11-18）：返回值一律带 state（priced/local/unpriced）与 1.0.2 口径的 notice；
    本地模型 cost=0 且 known=True；未填价模型 cost 记 0 但 known=False（不当作免费）。
    """
    offer = None
    try:
        offer = _gw().pricebook_offer(str(info.get("id") or ""))
    except Exception:
        offer = None
    if isinstance(offer, dict) and offer.get("price"):
        try:
            priced = price_resolver.effective_price(offer, group=group)
        except Exception:
            priced = None
        prices = (priced or {}).get("prices") or {}
        if prices.get("input") is not None and prices.get("output") is not None:
            rate = _cache_rate() if cache_rate is None else cache_rate
            cost = price_resolver.estimate_cost(prices, est_in, est_out, rate)
            p_state = _price_state_for(info)
            # 1.0.3.6 币种支持：pricebook 报价可自带币种（CNY 默认）；非 CNY 一律折 CNY，
            # 缺汇率 ⇒ 价未知（不猜价），口径与 capability_meta 分支一致。
            src_cur = price_resolver.offer_currency(offer)
            if src_cur not in ("CNY", "RMB"):
                converted = price_resolver.convert_to_cny(cost, src_cur)
                micro_raw = _cost_micro(prices, est_in, est_out, rate)
                converted_micro = price_resolver.convert_to_cny(micro_raw, src_cur)
                if converted is None or converted_micro is None:
                    return {"currency": src_cur, "cost": None, "known": False,
                            "state": "unpriced",
                            "notice": f"非 CNY 报价（{src_cur}）缺汇率，不换算不猜价",
                            "unconverted_currency": src_cur, "source": "pricebook",
                            "prices": prices, "period": (priced or {}).get("period")}
                return {"currency": "CNY", "cost": round(converted, 3), "known": True,
                        "cost_micro": round(converted_micro, 6),
                        "notice": ("0（本地）" if p_state == "local"
                                   else "按 pricebook 有效价估算")
                                  + f"；已按 {src_cur}→CNY 汇率换算",
                        "state": p_state, "source": "pricebook",
                        "prices": prices, "period": (priced or {}).get("period"),
                        "source_currency": src_cur}
            return {"currency": "CNY", "cost": round(cost, 3), "known": True,
                    # N5（2026-11-19）：estimate_cost 内部已 round(...,3)，
                    # 对它再取 6 位是无效的 ⇒ 这里用同一公式的 6 位版本另算一份。
                    "cost_micro": _cost_micro(prices, est_in, est_out, rate),
                    "notice": ("0（本地）" if p_state == "local" else "按 pricebook 有效价估算"),
                    "state": p_state, "source": "pricebook",
                    "prices": prices, "period": (priced or {}).get("period")}
    price = info.get("price") if isinstance(info.get("price"), dict) else None
    currency = (price or {}).get("currency") or "CNY"
    def val(key):
        block = (price or {}).get(key)
        if isinstance(block, dict):
            v = block.get(period)
            return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
        return None
    inp = val("input_per_mtok")
    out = val("output_per_mtok")
    if inp is None and out is None:
        p_state = _price_state_for(info)
        return {"currency": currency, "cost": None, "known": False, "state": p_state,
                "notice": ("0（本地）·本地模型不计费" if p_state == "local"
                           else "0（待用户录入）·未定价（只记 token，不当作免费）")}
    cost = 0.0
    if inp is not None:
        cost += est_in / 1_000_000.0 * float(inp)
    if out is not None:
        cost += est_out / 1_000_000.0 * float(out)
    missing = []
    if inp is None:
        missing.append("input_per_mtok")
    if out is None:
        missing.append("output_per_mtok")
    notice = "部分单价缺失，按已知部分计" if missing else "按已填单价估算"
    cur_norm = str(currency).strip().upper()
    if cur_norm not in ("CNY", "RMB"):
        # 非 CNY 报价：一律折成人民币；缺汇率 ⇒ 视为价未知（垫底，不猜价）。
        converted = price_resolver.convert_to_cny(cost, cur_norm)
        if converted is None:
            return {"currency": currency, "cost": None, "known": False, "state": "unpriced",
                    "notice": f"非 CNY 报价（{cur_norm}）缺汇率，不换算不猜价",
                    "missing": missing, "unconverted_currency": cur_norm}
        return {"currency": "CNY", "cost": round(converted, 3), "known": not missing,
                "cost_micro": round(converted, 6),   # N5：差额行用（见上）
                "state": _price_state_for(info),
                "notice": notice + f"；已按 {cur_norm}→CNY 汇率换算",
                "missing": missing, "source_currency": cur_norm}
    return {"currency": currency, "cost": round(cost, 3), "known": not missing,
            "cost_micro": round(cost, 6),            # N5：差额行用（见上）
            "state": _price_state_for(info), "notice": notice, "missing": missing}


def learned_override_enabled() -> bool:
    """Q2-3 全局回退开关：ROUTER_LEARNED_OVERRIDE=0 时本次进程完全忽略 learnedOverride。

    与请求级 ignore_learned_override 的区别：本开关是运维级 kill switch，所有请求一律不看
    override（学习计数也停），出问题无需改代码，改 env + 下次重启/或 supervisor 环境即恢复。
    """
    raw = (os.environ.get("ROUTER_LEARNED_OVERRIDE") or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _learned_override(strategy: str, capability: str, function: str,
                      stage_key: str = "") -> dict | None:
    if not learned_override_enabled():
        return None
    try:
        return _gw().rstrat.get_learned_override(strategy, capability, function, stage_key=stage_key)
    except Exception:
        return None


def _override_guard(info: dict, capability: str, per_in: int, override: dict,
                    stage_key: str, chain_tier: str = "") -> str | None:
    """Q2-3：override 也要过能力/档位守卫；不满足就跳过（不再静默抹平专业模型）。"""
    if not isinstance(override, dict):
        return None
    # 能力守卫：vision 必须模型真支持图像；长上下文不能超过模型窗口
    if capability == "vision":
        modality = info.get("modality") or []
        if isinstance(modality, str):
            modality = [modality]
        if "vision" not in modality:
            return "capability_unmet"
    ctx = info.get("context_window")
    if isinstance(ctx, int) and ctx > 0 and per_in > ctx:
        return "capability_unmet"
    # 档位守卫：老行（legacy）没有 stage_key，若它把 strong 档链降到 cheap 档模型 ⇒ 跳过
    ov_tier = str(override.get("tier") or info.get("tier") or "").strip().lower()
    if override.get("legacy") and str(chain_tier or "").strip().lower() == "strong" and ov_tier == "cheap":
        return "tier_mismatch"
    return None


def build_plan(payload: dict, principal: dict | None = None) -> tuple[dict, int]:
    task = _clean(payload.get("task"))
    if not task:
        return {"ok": False, "code": "missing_task", "error": "task 不能为空"}, 400
    strategy_req = str(payload.get("strategy") or "auto").strip().lower()
    if strategy_req not in VALID_STRATEGIES:
        return {"ok": False, "code": "bad_strategy",
                "error": f"strategy 必须是 {', '.join(VALID_STRATEGIES)}"}, 400
    function = str(payload.get("function") or "").strip().lower()
    if strategy_req == "function":
        if not function:
            return {"ok": False, "code": "function_required",
                    "error": "strategy=function 需要 function key"}, 400
        if function not in CHAT_FUNCTION_KEYS:
            return {"ok": False, "code": "function_not_executable",
                    "error": f"function 不是当前 chat 可执行子集：{function}"}, 400
    context = _clean(payload.get("context"), 120_000)
    constraints = payload.get("constraints") if isinstance(payload.get("constraints"), dict) else {}
    # ── Q1-5（2026-11-18）：max_stages 不再静默夹取 ────────────────────────────
    # 旧版 `max(1, min(x, 6))`：传 9 也是 200 且按 3 段跑，顶层同名被完全忽略、无任何告警。
    # 新版：① 顶层 max_stages 当别名接受；② 两处同时给且不一致 ⇒ 400；
    #       ③ 非整数/越界 ⇒ 400（带 allowed 与 received）；④ 未识别顶层键回显 ignored_keys。
    ignored_keys = sorted(k for k in payload.keys() if k not in ALLOWED_PLAN_KEYS)
    top_ms = payload.get("max_stages")
    nest_ms = constraints.get("max_stages")
    if top_ms is not None and nest_ms is not None:
        top_i, nest_i = _max_stages_int(top_ms), _max_stages_int(nest_ms)
        if top_i is None or nest_i is None or top_i != nest_i:
            return {"ok": False, "code": "conflicting_max_stages",
                    "error": "max_stages 同时写在顶层与 constraints 且不一致；请只保留一处",
                    "top_level": top_ms, "constraints": nest_ms}, 400
    raw_ms = nest_ms if nest_ms is not None else top_ms
    if raw_ms is None:
        max_stages = MAX_STAGES_DEFAULT
    else:
        max_stages = _max_stages_int(raw_ms)
        if max_stages is None:
            return {"ok": False, "code": "invalid_max_stages",
                    "error": f"max_stages 必须是 {MAX_STAGES_MIN}-{MAX_STAGES_MAX} 的整数，收到 {raw_ms!r}",
                    "allowed": f"{MAX_STAGES_MIN}-{MAX_STAGES_MAX}", "received": raw_ms}, 400
        if not (MAX_STAGES_MIN <= max_stages <= MAX_STAGES_MAX):
            return {"ok": False, "code": "invalid_max_stages",
                    "error": (f"max_stages 越界：{max_stages}（只允许 {MAX_STAGES_MIN}-{MAX_STAGES_MAX}，"
                              f"不再静默夹取；默认 {MAX_STAGES_DEFAULT}）"),
                    "allowed": f"{MAX_STAGES_MIN}-{MAX_STAGES_MAX}", "received": max_stages}, 400

    ignore_override = bool(payload.get("ignore_learned_override") is True)
    # ── 2026-11-24 钉选覆写：请求级 stage_models（会话内三路模型钉选）──────────
    # 形如 {"s1": "<upstream>/<model>", "s2": "...", "s3": "..."}；
    # 也接受 1-based 数字键 "1"/"2"/"3"。只认本网关已注册模型（upstream/model），
    # 非法值记入 stage_models_skipped 且**不阻断**计划（fail-open，缺省时零差异）。
    # 与 learnedOverride 不同：这是「本次请求显式钉选」，不写盘、不影响其他会话/请求。
    raw_stage_models = payload.get("stage_models")
    stage_models: dict[str, str] = {}
    stage_models_skipped: list[dict] = []
    if isinstance(raw_stage_models, dict):
        for k, v in raw_stage_models.items():
            key_norm = str(k).strip().lower()
            if key_norm.isdigit():
                n = int(key_norm)
                key_norm = f"s{n}" if 1 <= n <= 6 else ""
            if not (key_norm.startswith("s") and key_norm[1:].isdigit()):
                stage_models_skipped.append({"key": str(k), "model": str(v), "reason": "bad_stage_id"})
                continue
            model_norm = str(v or "").strip()
            if not model_norm:
                continue
            up_id, mid = _gw().split_candidate(model_norm)
            if up_id not in _gw().UPSTREAM_MAP or not mid:
                stage_models_skipped.append({"key": str(k), "model": model_norm, "reason": "model_unregistered"})
                continue
            stage_models[key_norm] = model_norm
    elif raw_stage_models is not None:
        stage_models_skipped.append({"key": "*", "model": "", "reason": "bad_shape"})
    automation_level = None
    automation_raw = payload.get("automation_level")
    if automation_raw is not None and str(automation_raw).strip():
        if b3_enabled():
            automation_level = _normalize_automation_level(automation_raw)
            if automation_level is None:
                return {"ok": False, "code": "bad_automation_level",
                        "error": (f"automation_level 必须是 L1/L2/L3（收到了 {automation_raw!r}）；"
                                  "不传＝默认 L1"),
                        "allowed": ["L1", "L2", "L3"]}, 400
    resolved, function = _resolve_strategy(strategy_req, function, task)
    if resolved == "function" and function not in CHAT_FUNCTION_KEYS:
        return {"ok": False, "code": "function_not_executable",
                "error": f"function 不是当前 chat 可执行子集：{function}"}, 400

    stage_key = _route_stage(task, context)
    key = _route_key(stage_key, task, context)
    period = _period()
    specs = _stage_specs(task, max_stages)
    total_in = _tokens(task + "\n" + context)
    # 每段都要看任务+简报；按完整 input 估，不把上下文除以段数（会严重低估）
    per_in = max(1, total_in)
    stages: list[dict] = []
    total_out = 0
    any_unknown = False
    any_known = False
    priced_models: set[str] = set()
    local_models: set[str] = set()
    unpriced_models: set[str] = set()
    override_stages: list[dict] = []
    for idx, spec in enumerate(specs, start=1):
        capability = spec["capability"]
        strategy_model = _strategy_model(resolved, function)
        override = None if ignore_override else _learned_override(resolved, capability, function, key)
        override_model = str((override or {}).get("model") or "") if override else ""
        override_skip = None
        chain = _chain_for(resolved, key, period, function, task, context)
        if resolved == "function":
            # 功能链：优先按 function key 取
            chain = _chain_for("function", key, period, function, task, context) or chain
        if override_model:
            _info = _model_entry(override_model)
            _chain_head = _model_entry(chain[0]) if chain else {}
            override_skip = _override_guard(_info, capability, per_in, override, key,
                                            str((_chain_head or {}).get("tier") or ""))
            if override_skip:
                override_model = ""
        # 钉选（stage_models）优先级高于 learnedOverride：用户本次显式选择说了算。
        pinned_model = stage_models.get(f"s{idx}", "")
        pin_applied = False
        if pinned_model:
            override_model = pinned_model
            override_skip = None
            pin_applied = True
        model = override_model if override_model else (chain[0] if chain else "")
        if not model:
            return {"ok": False, "code": "no_model",
                    "error": f"策略 {resolved} 在 {key} 没有可用模型"}, 503
        info = _model_entry(model)
        est_out = 500 if capability in ("coding", "code_testing") else 350
        if capability == "vision":
            est_out = 300
        total_out += est_out
        price = _price_for(info, per_in, est_out, period)
        p_state = str(price.get("state") or "unpriced")
        if p_state == "local":
            local_models.add(model)
        elif price.get("known"):
            priced_models.add(model)
        else:
            unpriced_models.add(model)
        if price.get("known"):
            any_known = True
        else:
            any_unknown = True
        stages.append({
            "stage_id": f"s{idx}",
            "index": idx,
            "title": spec["title"],
            "goal": spec["goal"],
            "capability": capability,
            "model": {
                "kind": "explicit",
                "key": model,
                "label": info.get("label") or model,
                "context_window": info.get("context_window"),
                "strategy_model": strategy_model,
                "provider": info.get("provider"),
                "tier": info.get("tier"),
            },
            "estimate": {
                "input_tokens": per_in,
                "output_tokens": est_out,
                "cost_known": price.get("cost"),
                # N5（2026-11-19）：3 位小数会把毫厘级实付清零，差额行改用这个 6 位值。
                "cost_micro": price.get("cost_micro"),
                "currency": price.get("currency"),
                "unknown_pricing": not price.get("known"),
                "price_state": p_state,
                "price_label": ("0（本地）" if p_state == "local"
                                else ("0（待用户录入）" if p_state == "unpriced"
                                      else "按已填单价")),
                "notice": price.get("notice"),
                "missing": price.get("missing") or [],
            },
            "rationale": (f"{capability} → {model}"
                          + (f"（会话钉选）" if pin_applied else
                             (f"（learnedOverride，源={(override or {}).get('source')}）" if override_model else ""))
                          + f"；策略={resolved}，档位={key}"),
            "learned_override": bool(override_model) and not pin_applied,
            "pinned": pin_applied,
            "override_skipped": override_skip,
        })
        if b1_enabled():
            stages[-1]["boundary_policy"] = boundary_policy()
        override_stages.append({
            "stage_id": f"s{idx}", "capability": capability,
            "applied": bool(override_model),
            "model": override_model or None,
            "source": "session_pin" if pin_applied else ((override or {}).get("source") if override else None),
            "learned_at": (override or {}).get("learned_at") if override else None,
            "evidence_count": (((override or {}).get("evidence") or {}).get("count")
                               if isinstance((override or {}).get("evidence"), dict) else None),
            "stage_key": (override or {}).get("stage_key") or None,
            "legacy": bool((override or {}).get("legacy")),
            "skipped_reason": override_skip,
        })
    pricing_status = "known" if any_known and not any_unknown else ("partial" if any_known else "unavailable")
    plan = {
        "ok": True,
        "plan_id": "plan-" + uuid.uuid4().hex[:16],
        "strategy": strategy_req,
        "resolved_strategy": resolved,
        "function": function or None,
        "stage_key": key,
        "period": period,
        "stages": stages,
        "totals": {
            "input_tokens": per_in * len(stages),
            "output_tokens": total_out,
            "currency": stages[0]["estimate"].get("currency") if stages else None,
            "cost_known": (round(sum(s["estimate"]["cost_known"] or 0 for s in stages), 3)
                           if any_known else None),
            "cost_unknown": any_unknown,
            "priced_models": sorted(priced_models),
            "local_models": sorted(local_models),
            "unpriced_models": sorted(unpriced_models),
            "unpriced_count": len(unpriced_models),
        },
        "pricing": {
            "status": pricing_status,
            "policy": {
                "local": "0（本地）",
                "unpriced": "0（待用户录入）·未定价（不当作免费）",
                "priced": "按已填单价估算",
            },
            "notice": ("部分模型未填单价：已知部分计金额，未知部分按 0 计（不代表免费）"
                       if pricing_status == "partial" else
                       ("预估不可用：未填单价，只记 token" if pricing_status == "unavailable"
                        else "按已填单价估算")),
        },
        # ── Q3-11（2026-11-18）：估价口径显式化（实付差额在 annotation.estimate_delta）──
        # R8（2026-11-20）：说明必须与代码一致。旧文案写「÷ chars_per_token」，但代码
        # （`_tokens`，本文件 :221-232）从来不读 chars_per_token，实际是 **len/1.8**。
        # 现按代码口径写明，并标注与 main.py 的 CHARS_PER_TOKEN=2.2 的已知偏差。
        "estimate_basis": {
            "input_tokens": ("task+context 字符数 ÷ 1.8（_tokens 硬编码，非 chars_per_token）；"
                             "每段按完整输入估，不按段均分。⚠️ 与 main.py 的 CHARS_PER_TOKEN=2.2 "
                             "口径不一致，属已知欠账，由 context_governor M1 统一（另行排期）"),
            "output_tokens": "按能力固定：coding/code_testing=500、vision=300、其他=350；每段独立，不是总预算",
            "includes_system_prompt": False,
            "includes_history": False,
            "confidence": "low" if any_unknown else "medium",
            "note": "估价是上限近似，不含 system prompt/历史消息；实付以 annotation.usage 为准，差额见 estimate_delta",
        },
        "estimate_confidence": "low" if any_unknown else "medium",
        # ── Q2-3（2026-11-18）：override 不再静默 —— 顶层给来源/次数/是否忽略 ──
        "learned_override": {
            "applied": any(x.get("applied") for x in override_stages),
            "ignored": ignore_override,
            "ignore_param": "ignore_learned_override",
            "stages": override_stages,
            "notice": ("本次忽略 learnedOverride（ignore_learned_override=true）"
                       if ignore_override else
                       ("有段命中 learnedOverride，理由/来源见 stages"
                        if any(x.get("applied") for x in override_stages)
                        else "本次没有命中 learnedOverride")),
        },
        "client": str(payload.get("client") or "")[:32] or None,
        "request_id": str(payload.get("request_id") or "")[:64] or None,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        # Q1-5：回显生效值与被忽略的顶层键（对外可自证"到底按几段跑"）
        "max_stages": max_stages,
        "ignored_keys": ignored_keys,
        # 2026-11-24：本次请求的会话钉选（请求级，不写盘；回显便于自证）
        "stage_models": stage_models,
        "stage_models_skipped": stage_models_skipped,
        # Q1-2：plan 现在真的落了一小段短期状态（内存 TTL 24h）
        "has_plan_state": True,
        "plan_ttl_s": PLAN_TTL_S,
    }
    if automation_level:
        level_def = dict(AUTOMATION_LEVELS[automation_level])
        plan["automation"] = {"level": automation_level, **level_def,
                              "advanced_entry": "strategy",
                              "levels": automation_levels()["levels"]}
    _plan_store(plan, principal)
    return plan, 200


def _principal(principal: dict | None) -> dict:
    if isinstance(principal, dict) and principal.get("id"):
        return principal
    return {"id": "local", "name": "local", "scopes": ["plan", "chat"]}


def _counter_key(strategy: str, stage_key: str, capability: str, function: str) -> str:
    # Q2-3：计数也按档位隔离，避免 cheap 档的计数把 strong 档一起推过阈值。
    return "|".join([strategy, stage_key or "", capability, function or ""])


def _maybe_learn(principal: dict, ann: dict) -> dict | None:
    """三次同策略/同节点/同模型（同用户、已确认执行）→ 写 learnedOverride。"""
    if not learned_override_enabled():
        return None  # 全局 kill switch：连学习也停
    if not auto_learn_enabled():
        return None
    if not bool(ann.get("confirmed")):
        return None
    if str(ann.get("outcome") or "ok") != "ok":
        return None
    # Q2-3：优先用计划解析后的 resolved_strategy（auto 在 plan 里已解析为 cost/function/…），
    # 不再因为调用方传的是 auto 就整条学习链失效。
    strategy = str(ann.get("resolved_strategy") or ann.get("strategy") or "").strip().lower()
    if strategy not in ("cost", "capability", "function", "recommend"):
        return None  # 未解析的 auto / 空策略不学习
    capability = str(ann.get("capability") or "").strip().lower()
    model = str(ann.get("model_key") or "").strip()
    function = str(ann.get("function") or "").strip().lower()
    stage_key = str(ann.get("stage_key") or "").strip().lower()
    tier = str(ann.get("tier") or "").strip().lower()
    if not capability or not model:
        return None
    if model not in _gw().rstrat._allowed_models():
        return None
    if strategy == "function" and not function:
        return None
    pid = str(principal.get("id") or "local")
    key = _counter_key(strategy, stage_key, capability, function)
    with _LOCK:
        state = load_learned_state()
        users = state.setdefault("counters", {})
        table = users.setdefault(pid, {})
        rec = table.get(key)
        if isinstance(rec, dict) and rec.get("model") == model:
            count = int(rec.get("count") or 0) + 1
        else:
            count = 1
        rec = {"model": model, "count": count,
               "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
        table[key] = rec
        learned = None
        if count >= 3:
            evidence = {"count": count, "principal": pid, "strategy": strategy,
                        "capability": capability, "function": function or None,
                        "stage_key": stage_key or None, "tier": tier or None,
                        "model": model, "last_plan_id": ann.get("plan_id"),
                        "last_stage_id": ann.get("stage_id")}
            try:
                row = _gw().rstrat.upsert_learned_override(
                    strategy, capability, model, function=function, source="auto",
                    evidence=evidence, stage_key=stage_key, tier=tier, principal=pid)
                learned = {"strategy": strategy, "capability": capability,
                           "function": function or None, "stage_key": stage_key or None,
                           "model": model, "override": row, "evidence": evidence}
                rec["count"] = 0  # 已落 override，重新计数
                table[key] = rec
                _append_jsonl(audit_path(), {
                    "event": "learned_override", "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                    "principal": pid, "strategy": strategy, "capability": capability,
                    "function": function or None, "model": model, "evidence": evidence,
                    "source": "annotation",
                })
            except Exception as exc:
                learned = None
                rec["last_error"] = f"{type(exc).__name__}: {exc}"
                table[key] = rec
        save_learned_state(state)
    return learned


def annotate(payload: dict, principal: dict | None = None) -> tuple[dict, int]:
    plan_id = _clean(payload.get("plan_id"), 128)
    stage_id = _clean(payload.get("stage_id"), 64)
    model_key = _clean(payload.get("model_key"), 256)
    if not plan_id or not stage_id or not model_key:
        return {"ok": False, "code": "bad_annotation",
                "error": "plan_id/stage_id/model_key 必填"}, 400
    confirmed = payload.get("confirmed")
    if not isinstance(confirmed, bool):
        return {"ok": False, "code": "bad_confirmed",
                "error": "confirmed 必须是 true/false"}, 400
    outcome = str(payload.get("outcome") or "ok").strip().lower()
    if outcome not in ("ok", "fallback", "failed"):
        return {"ok": False, "code": "bad_outcome",
                "error": "outcome 必须是 ok/fallback/failed"}, 400
    # ── Q1-2（2026-11-18）：校验 plan / stage / 模型 / principal ───────────────
    # 旧版只查"必填"，于是 plan_id="plan-notexist" 也 200 recorded:true，脏数据可写入
    # 学习管道；learnedOverride 是全局的 ⇒ 3 条伪造即可改掉某能力的路由。
    # strict（默认）：假 plan ⇒ 404；跨 principal ⇒ 403；stage 不在册 ⇒ 404；
    #                 模型与计划不符 ⇒ 400（outcome=fallback 例外，允许换模型）。
    # warn：只记录 plan_state，不拒绝（灰度/回退用，ROUTER_PLAN_STATE=warn）。
    strict = PLAN_STATE_MODE != "warn"
    pid = _principal(principal).get("id")
    plan_state = _plan_get(plan_id)
    plan_flag = "ok"
    planned_model = None
    stage_rec = None
    if plan_state is None:
        plan_flag = "unknown"
        if strict:
            return {"ok": False, "code": "plan_unknown",
                    "error": (f"计划 {plan_id} 不存在或已过期（plan 状态内存 TTL "
                              f"{PLAN_TTL_S // 3600}h；网关重启会清空）"),
                    "hint": "请先 POST /v1/route/plan 重新生成计划；本接口不再接受伪造 plan_id"}, 404
    else:
        owner = plan_state.get("principal")
        if owner and pid and owner != pid:
            plan_flag = "principal_mismatch"
            if strict:
                return {"ok": False, "code": "plan_principal_mismatch",
                        "error": f"计划 {plan_id} 属于 {owner}，与本次调用 principal={pid} 不一致",
                        "plan_principal": owner, "caller_principal": pid}, 403
        stage_rec = (plan_state.get("stages") or {}).get(stage_id)
        if stage_rec is None:
            plan_flag = "stage_unknown"
            if strict:
                return {"ok": False, "code": "stage_unknown",
                        "error": f"stage_id={stage_id} 不在计划 {plan_id} 里",
                        "plan_stages": sorted((plan_state.get("stages") or {}).keys())}, 404
        else:
            planned_model = stage_rec.get("model_key")
            if planned_model and model_key != planned_model and outcome != "fallback":
                plan_flag = "model_mismatch"
                if strict:
                    return {"ok": False, "code": "model_mismatch",
                            "error": (f"model_key={model_key} 与计划 {plan_id}/{stage_id} 的 "
                                      f"{planned_model} 不符；若确为降级请把 outcome 设为 fallback"),
                            "planned_model": planned_model, "actual_model": model_key}, 400
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    usage_clean = {k: int(v) for k, v in usage.items()
                   if isinstance(v, (int, float)) and not isinstance(v, bool)}
    # ── Q3-11（2026-11-18）：预估 vs 实付差额（plan 估价快照已在 _plan_store 里）──
    estimate_snapshot = (stage_rec or {}).get("estimate") if stage_rec else None
    estimate_delta = None
    actual_in = usage_clean.get("prompt_tokens") or usage_clean.get("input_tokens") or 0
    actual_out = usage_clean.get("completion_tokens") or usage_clean.get("output_tokens") or 0
    if isinstance(estimate_snapshot, dict) and (actual_in or actual_out):
        planned_in = int(estimate_snapshot.get("input_tokens") or 0)
        planned_out = int(estimate_snapshot.get("output_tokens") or 0)
        estimate_delta = {
            "planned_input_tokens": planned_in, "planned_output_tokens": planned_out,
            "actual_input_tokens": actual_in, "actual_output_tokens": actual_out,
            "input_tokens_delta": actual_in - planned_in,
            "output_tokens_delta": actual_out - planned_out,
            "input_ratio": round(actual_in / planned_in, 3) if planned_in else None,
            "output_ratio": round(actual_out / planned_out, 3) if planned_out else None,
            "basis": "估价不含 system prompt/历史消息；正数=实付比预估多",
        }
        try:
            price = _price_for(_model_entry(model_key), actual_in, actual_out, _period())
            if price.get("known"):
                # ── N5（2026-11-19 书童侧复测）：差额行改用「微元」精度 ──────────────
                # 旧实现：actual_cost = round(price["cost"], 6)，但 price["cost"] 本身
                #   已在 _price_for 里被 round(...,3) 截断 ⇒ 61 in + 8 out 这类小样本
                #   实付被清零，显示 0 元（实测）。
                # 新实现：优先用 _price_for 新给的 cost_micro（6 位），并同时给出
                #   「厘」（1 厘 = 0.001 元）与「微元」两种可读展示，保证小样本可见。
                #   cost 字段本身仍保持 3 位（r4 测试套件锁定，不动）。
                micro = price.get("cost_micro")
                if micro is None:
                    micro = price.get("cost")
                actual = round(float(micro), 6)
                estimate_delta["actual_cost"] = actual
                estimate_delta["actual_cost_precision"] = 6
                estimate_delta["actual_cost_display"] = {
                    "unit": "厘", "value": round(actual * 1000, 3),
                    "text": f"{round(actual * 1000, 3)} 厘（{actual} 元）",
                }
                planned_micro = estimate_snapshot.get("cost_micro")
                if planned_micro is None:
                    planned_micro = estimate_snapshot.get("cost_known")
                estimate_delta["planned_cost"] = (round(float(planned_micro), 6)
                                                  if planned_micro is not None else None)
                estimate_delta["currency"] = price.get("currency")
                if planned_micro is not None:
                    estimate_delta["cost_delta"] = round(actual - float(planned_micro), 6)
                estimate_delta["precision_note"] = (
                    "actual_cost/planned_cost/cost_delta 均为 6 位小数（元）；"
                    "cost_known 字段仍为 3 位（历史口径），差额请用 cost_delta")
        except Exception:  # 价格/元数据缺失不影响标注主路径
            pass
    # Q2-3：annotation 允许只带 plan_id/stage_id/model_key —— 其余从 plan 状态补齐，
    # 这样 MCP execute 默认不传 strategy/capability 时学习链仍然可用。
    turn_ctx_clean = _clean_turn_ctx(payload.get("turn_ctx"))
    discipline_violation = _discipline_check(turn_ctx_clean, model_key, plan_id, stage_id)
    _ps = plan_state or {}
    _sr = stage_rec or {}
    strategy_final = (str(payload.get("strategy") or "").strip().lower()
                      or str(_ps.get("strategy") or "").strip().lower() or None)
    capability_final = (str(payload.get("capability") or "").strip().lower()
                        or str(_sr.get("capability") or "").strip().lower() or None)
    function_final = (str(payload.get("function") or "").strip().lower()
                      or str(_ps.get("function") or "").strip().lower() or None)
    stage_key_final = str(_ps.get("stage_key") or "").strip().lower() or None
    tier_final = str(_sr.get("tier") or "").strip().lower() or None
    ann = {
        "plan_id": plan_id, "stage_id": stage_id, "model_key": model_key,
        "planned_model": planned_model,
        "plan_state": plan_flag,
        "confirmed": confirmed, "outcome": outcome,
        "strategy": strategy_final,
        "resolved_strategy": str(_ps.get("strategy") or strategy_final or "").strip().lower() or None,
        "capability": capability_final,
        "function": function_final,
        "stage_key": stage_key_final,
        "tier": tier_final,
        "usage": usage_clean,
        "estimate": estimate_snapshot,
        "estimate_delta": estimate_delta,
        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "principal": _principal(principal).get("id"),
    }
    if turn_ctx_clean is not None:
        ann["turn_ctx"] = turn_ctx_clean
    if discipline_violation:
        ann["discipline_violation"] = discipline_violation
    _append_jsonl(annotations_path(), ann)
    learned = _maybe_learn(_principal(principal), ann)
    body = {"ok": True, "plan_id": plan_id, "stage_id": stage_id,
            "recorded": True, "learned": learned,
            "has_plan_state": plan_state is not None,
            "plan_state": plan_flag,
            "planned_model": planned_model,
            "estimate": estimate_snapshot,
            "estimate_delta": estimate_delta,
            "notice": ("已自动学习并写入 learnedOverrides" if learned
                       else ("已记录；未触发自动学习" if plan_flag == "ok"
                             else f"已记录（计划校验：{plan_flag}）"))}
    if turn_ctx_clean is not None:
        body["discipline_violation"] = discipline_violation
    return body, 200
