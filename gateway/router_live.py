#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""router_live.py —— 路由运行状态「只读」聚合快照（1.0.3.2 · 路由运行状态可视化 T1）

契约：本仓不随附内部设计契约；对外字段以本文件「数据契约」一节为准。
      第四节「数据契约」＝唯一真源；入口 `GET /admin/api/live?range=24h&limit=30`（需登录）。

边界（务必保持）：
  - **只读**：不执行、不写账、不调上游；不写 `数据/`、不改 `config/*`、不改进程状态；
  - 账本复用既有读法 `router_plan._iter_jsonl_rows(..., tail_bytes=1MB)`，时间解析复用
    `router_plan._epoch_of_at`，数字兜底复用 `router_plan._num` —— 不新造并行口径；
  - 成本复用 `price_resolver.effective_price` ＋ `price_resolver.estimate_cost`（按行 ts 的价格、
    行内 usage 的 token）；`(offer_id, 日期, period)` 维度的价格块做缓存，不做 2637 行逐行重算；
  - 老账本缺键 / 空账本 / 未知模型（无价）一律给默认值（0 / [] / {}），**绝不抛异常**；
  - 结果按 (range, limit) 缓存 2 秒（模块级 dict ＋ 时间戳），页面 5s 轮询足够用。

口径备注：
  - `ok` 判据沿用既有：`final_status` 以 `ok` 开头算成功（`ok` / `ok_stream`）；
  - `share` / `success_rate` 是 0–1 比率（4 位小数），金额单位元（3 位小数），耗时毫秒整数；
  - 成本取不到价（未知模型 / 本地免费 / 无 pricebook）一律 0，**不造 NaN、不当免费**宣传；
  - `upshift` ＝ 该层内「attempts ≥ 2（换过候选）」或「发生过 fallback」的请求数（跨档/降级近似）。
"""

from __future__ import annotations

import copy
import json
import math
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import price_resolver
import router_plan

TZ_CN = timezone(timedelta(hours=8))

# range 秒数（契约 §4：range ∈ 1h|6h|24h|7d，默认 24h，非法回落 24h）
LIVE_RANGES = {"1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800}
DEFAULT_RANGE = "24h"
DEFAULT_LIMIT = 30
MIN_LIMIT = 1
MAX_LIMIT = 100

# 与 router_plan._LEDGER_TAIL_BYTES 同口径（1MB）；这里显式写死一个常量，避免依赖私有名不存在时炸。
_LEDGER_TAIL_BYTES = 1024 * 1024

# 结果缓存：key = (range_key, limit) -> (写入时刻 monotonic, payload)
_CACHE_TTL_S = 2.0
_CACHE_MAX_ENTRIES = 64
_CACHE_LOCK = threading.Lock()
_CACHE: dict[tuple[str, int], tuple[float, dict]] = {}

# 价格块缓存：key = (offer_id(=candidate), 日期 YYYY-MM-DD, period) -> prices dict（只含 input/output/cache_hit）
_PRICE_CACHE_MAX_ENTRIES = 50000
_PRICE_LOCK = threading.Lock()
_PRICE_CACHE: dict[tuple[str, str, str], dict] = {}

# 三层泳道（契约 §3：L1 轻判断 → L2 主力执行 → L3 关键决策）
# ⚠️ desc 是「档位说明」不是「供应商承诺」：L3 档按策略取强模，fast 策略的 L3 候选就是
# 本地大模（2026-11-21 24h 实况：L3 172 次请求 100% 走 provider_b/local-auto）⇒ 文案不许
# 写死"云端强模优先"，否则用户会以为数据错。
ROLE_META = (
    ("L1", "轻判断", "短输入/简单任务，本地小模型优先"),
    ("L2", "主力执行", "中等复杂度任务，主力模型执行，平衡成本与能力"),
    ("L3", "关键决策", "重量档：长上下文/复杂任务；按策略取强模，fast 策略下可为本地大模"),
)
_ROLE_KEYS = ("L1", "L2", "L3")

# main.py 没有版本常量（其 HTTP server_version 固定 "ModelRouter/1.0"）⇒ 按契约给一个可覆盖的兜底：
# 优先 env ROUTER_GATEWAY_VERSION / 模块属性，其次树内 VERSION 文件，最后本常量（当前发布版本）。
_GATEWAY_VERSION_FALLBACK = "1.0.3.2"

_CTX_BANDS = ("pass", "reject", "unknown")


# ---------------------------------------------------------------------------
# 参数解析 / 时间格式化
# ---------------------------------------------------------------------------
def _parse_range(range_key) -> tuple[str, int]:
    key = str(range_key or "").strip().lower()
    if key not in LIVE_RANGES:
        key = DEFAULT_RANGE
    return key, LIVE_RANGES[key]


def _parse_limit(limit) -> int:
    try:
        number = int(float(limit))
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return max(MIN_LIMIT, min(MAX_LIMIT, number))


def _offset_str(dt: datetime) -> str:
    raw = dt.strftime("%z") or "+0800"
    return raw[:3] + ":" + raw[3:]


def _iso_of(epoch=None) -> str:
    """epoch → 本地 +08:00 ISO（契约要求 +08:00，不用 strftime 的 +0800）。"""
    try:
        real = float(epoch)
        if real != real:          # NaN
            raise ValueError("nan")
        dt = datetime.fromtimestamp(real, TZ_CN)
    except (TypeError, ValueError, OverflowError, OSError):
        dt = datetime.now(TZ_CN)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + _offset_str(dt)


def _int_of(value, default: int = 0) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number or number in (float("inf"), float("-inf")):
        return default
    return int(number)


def _pct_of(values, percentile) -> float:
    """最近秩法分位数（nearest-rank）：空集给 0；偶数个样本取较低那一侧，口径确定可复算。"""
    if not values:
        return 0.0
    ordered = sorted(float(v) for v in values)
    index = int(math.ceil((percentile / 100.0) * len(ordered))) - 1
    index = max(0, min(len(ordered) - 1, index))
    return ordered[index]


def _pct_int(values, percentile) -> int:
    return int(round(_pct_of(values, percentile)))


def _round(value, digits: int):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    if number != number or number in (float("inf"), float("-inf")):
        return 0
    return round(number, digits)


# ---------------------------------------------------------------------------
# 账本行读取（复用 router_plan 口径）
# ---------------------------------------------------------------------------
def _gateway():
    """网关模块对象：与 `router_plan.report()` 一样走 `router_plan._gw()`。

    兜底只服务「独立调用」（如自检 `python3 -c "import router_live; ..."`：此时没有
    `main.py` 跑过 ⇒ `_gw()` 抛 RuntimeError）。优先复用 `sys.modules['__main__']`——
    生产里 main.py 是以脚本方式运行的，**绝不能** `import main` 造出第二份模块实例。
    """
    try:
        return router_plan._gw()
    except RuntimeError:
        pass
    main_module = sys.modules.get("__main__")
    if main_module is not None and hasattr(main_module, "LEDGER_PATH") \
            and hasattr(main_module, "health_payload"):
        router_plan.set_gateway(main_module)
        return main_module
    import main as main_module      # noqa: PLC0415 —— 仅独立调用时才会走到

    router_plan.set_gateway(main_module)
    return main_module


def _shadow_log_path() -> Path:
    """决策模型影子记录（`数据/shadow.jsonl`）；测试可 monkeypatch 本函数。"""
    return Path(_gateway().BASE_DIR) / "数据" / "shadow.jsonl"


def _row_epoch(row: dict):
    try:
        return router_plan._epoch_of_at(row.get("at") or row.get("ts"))
    except Exception:
        return None


def _attempts_of(row: dict) -> list[dict]:
    raw = row.get("attempts")
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if isinstance(item, dict):
            out.append(item)
    return out


def _chosen_of(row: dict) -> str:
    chosen = row.get("chosen") or row.get("model_chosen")
    if not chosen:
        for item in reversed(_attempts_of(row)):
            upstream = str(item.get("upstream") or "")
            model = str(item.get("model") or "")
            if upstream and model:
                chosen = f"{upstream}/{model}"
                break
    return str(chosen or "")


def _split_candidate(candidate: str) -> tuple[str, str]:
    """候选只在第一个 '/' 处切（与 main.split_candidate 同口径）；模型名可再含 '/'。"""
    text = str(candidate or "")
    if "/" not in text:
        return text, ""
    return text.split("/", 1)


def _total_ms_of(row: dict) -> int:
    direct = row.get("total_ms")
    if isinstance(direct, (int, float)) and not isinstance(direct, bool):
        return _int_of(direct)
    return sum(_int_of(item.get("ms")) for item in _attempts_of(row))


def _ctx_band_of(row: dict) -> str:
    for source in (row.get("ctx_gov"), *reversed(_attempts_of(row))):
        if isinstance(source, dict):
            inner = source.get("ctx_gov") if source.get("band") is None else source
            if isinstance(inner, dict):
                band = str(inner.get("band") or "").lower()
                if band in _CTX_BANDS:
                    return band
    return "unknown"


def _ctx_used_pct_of(row: dict):
    gov = row.get("ctx_gov")
    if not isinstance(gov, dict):
        return None
    used = gov.get("used")
    window = gov.get("window")
    try:
        used_f, window_f = float(used), float(window)
    except (TypeError, ValueError):
        return None
    if window_f <= 0 or used_f < 0 or used_f != used_f:
        return None
    return round(used_f / window_f, 4)


# ---------------------------------------------------------------------------
# 成本：pricebook 有效价（缓存在 (offer_id, 日期, period) 维度）
# ---------------------------------------------------------------------------
def _local_ids(gw) -> set:
    try:
        return set(gw.local_upstream_ids())
    except Exception:
        return set()


def _price_cache_key(candidate: str, epoch, period: str) -> tuple[str, str, str]:
    day = ""
    if epoch is not None:
        try:
            day = datetime.fromtimestamp(float(epoch), TZ_CN).strftime("%Y-%m-%d")
        except (TypeError, ValueError, OverflowError, OSError):
            day = ""
    return (str(candidate or ""), day, str(period or ""))


def _prices_for(gw, candidate: str, epoch, period: str) -> dict:
    """取 (offer_id, 日期, period) 维度的价格块；取不到/结构不对 ⇒ {}（成本按 0）。"""
    if not candidate:
        return {}
    key = _price_cache_key(candidate, epoch, period)
    with _PRICE_LOCK:
        cached = _PRICE_CACHE.get(key)
        if cached is not None:
            return cached
    prices: dict = {}
    try:
        offer = gw.pricebook_offer(candidate)
        if isinstance(offer, dict) and offer.get("price"):
            at = None
            if epoch is not None:
                try:
                    at = datetime.fromtimestamp(float(epoch), TZ_CN)
                except (TypeError, ValueError, OverflowError, OSError):
                    at = None
            priced = price_resolver.effective_price(offer, at=at)
            raw = (priced or {}).get("prices") or {}
            if isinstance(raw, dict) and raw.get("input") is not None and raw.get("output") is not None:
                prices = dict(raw)
    except Exception:
        prices = {}
    with _PRICE_LOCK:
        if len(_PRICE_CACHE) >= _PRICE_CACHE_MAX_ENTRIES:
            _PRICE_CACHE.clear()
        _PRICE_CACHE[key] = prices
    return prices


def _row_cost(gw, candidate: str, prompt_tokens: int, completion_tokens: int,
              epoch, period: str, cache_rate: float = 0.0) -> float:
    prices = _prices_for(gw, candidate, epoch, period)
    if not prices:
        return 0.0
    try:
        return float(price_resolver.estimate_cost(prices, prompt_tokens, completion_tokens,
                                                  cache_rate))
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# 聚合（单遍扫描）
# ---------------------------------------------------------------------------
def _new_bucket() -> dict:
    return {"requests": 0, "ok": 0, "failed": 0, "prompt": 0, "completion": 0,
            "cost": 0.0, "ms": [], "local": 0, "upshift": 0}


def _new_model_bucket() -> dict:
    return {"requests": 0, "ok": 0, "failed": 0, "prompt": 0, "completion": 0,
            "cost": 0.0, "ms": [], "local": 0, "stages": {}}


def _count_total_rows(path: Path) -> int:
    """整本账本的行数（只读；用于 freshness.ledger_total_rows）。失败 ⇒ 0。"""
    try:
        size = path.stat().st_size
        if size <= 0:
            return 0
        total = 0
        with path.open("rb") as fp:
            while True:
                chunk = fp.read(1024 * 1024)
                if not chunk:
                    break
                total += chunk.count(b"\n")
        with path.open("rb") as fp:
            fp.seek(-1, 2)
            if fp.read(1) != b"\n":
                total += 1
        return total
    except (OSError, ValueError):
        return 0


def _ledger_mtime(path: Path):
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _last_row_epoch_before(path: Path, tail_bytes: int):
    """尾部窗口之前「最后一条完整行」的 epoch（用于判断截断是否影响本 range）。

    只多读 ≤16KB（不整本重读）：取 tail 起点前的窗口，从末尾往前找能解析的行。
    取不到（空窗/坏行）⇒ None（调用方按保守口径标 partial）。
    """
    try:
        size = path.stat().st_size
        if size <= tail_bytes:
            return None
        start = max(0, size - tail_bytes - 16384)
        end = size - tail_bytes
        if end <= start:
            return None
        with path.open("rb") as fp:
            fp.seek(start)
            chunk = fp.read(end - start)
        text = chunk.decode("utf-8", "replace")
        # 窗口末尾可能切在半行上：不完整的那段直接丢掉
        if not text.endswith("\n"):
            cut = text.rfind("\n")
            text = text[:cut + 1] if cut >= 0 else ""
        for line in reversed(text.splitlines()[-8:]):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            if isinstance(row, dict):
                epoch = router_plan._epoch_of_at(row.get("at") or row.get("ts"))
                if epoch is not None:
                    return epoch
        return None
    except (OSError, ValueError):
        return None


def _gateway_version(gw) -> str:
    for attr in ("GATEWAY_VERSION", "VERSION", "__version__"):
        value = getattr(gw, attr, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    try:
        version_file = Path(gw.BASE_DIR) / "VERSION"
        text = version_file.read_text(encoding="utf-8").strip()
        if text:
            return text.splitlines()[0].strip()[:32]
    except (OSError, UnicodeDecodeError):
        pass
    return _GATEWAY_VERSION_FALLBACK


def _gateway_snapshot(gw) -> tuple[dict, list[dict]]:
    """网关健康＋上游熔断的**只读内存快照**（与 /health 同字段口径，零副作用）。

    **不**调用 `gw.health_payload()`：它会跑价格单源自证（可能外呼 stall-notify 告警），
    与「只读、不写账、不调上游」的契约相悖；这里只读 UPSTREAMS/STATE 的内存态。
    """
    now = time.time()
    version = _gateway_version(gw)
    gateway = {"ok": False, "uptime_s": 0, "version": version,
               "host": str(getattr(gw, "HOST", "127.0.0.1")),
               "port": _int_of(getattr(gw, "PORT", 0))}
    start = getattr(gw, "START_TS", None)
    if isinstance(start, (int, float)) and not isinstance(start, bool):
        gateway["uptime_s"] = max(0, int(now - float(start)))

    upstreams_attr = getattr(gw, "UPSTREAMS", None)
    state_map = getattr(gw, "STATE", None)
    items: list[dict] = []
    if isinstance(upstreams_attr, (list, tuple)) and isinstance(state_map, dict):
        gateway["ok"] = True
        for upstream in upstreams_attr:
            uid = str(getattr(upstream, "id", "") or "")
            item = {"id": uid, "state": "unknown", "circuit_state": "unknown",
                    "failures": 0, "remaining_s": 0, "open_until": None,
                    "models": list(getattr(upstream, "models", None) or [])}
            try:
                state_obj = state_map.get(uid)
                snap = state_obj.snapshot(now) if state_obj is not None else {}
                circuit = snap.get("circuit") if isinstance(snap, dict) else {}
                circuit = circuit if isinstance(circuit, dict) else {}
                item["failures"] = _int_of(circuit.get("failures"))
                item["remaining_s"] = _int_of(circuit.get("remaining_s"))
                item["open_until"] = circuit.get("open_until") or None
                item["circuit_state"] = str(circuit.get("state") or "unknown")
                if getattr(upstream, "dsh_only", False):
                    item["state"] = "dsh_only"
                elif circuit.get("open"):
                    item["state"] = "circuit_open"
                elif _int_of(snap.get("rpm_1m")) >= _int_of(getattr(upstream, "max_rpm", 0)):
                    item["state"] = "rate_limited"
                else:
                    item["state"] = "ok"
            except Exception:
                item["state"] = "unknown"
            items.append(item)
    return gateway, items


def _ctx_mode(gw, rows: list[dict]) -> str:
    try:
        params = gw.ctx_gov_params()
        mode = str((params or {}).get("mode") or "").strip().lower()
        if mode:
            return mode
    except Exception:
        pass
    counts: dict[str, int] = {}
    for row in rows:
        gov = row.get("ctx_gov")
        if isinstance(gov, dict):
            mode = str(gov.get("mode") or "").strip().lower()
            if mode:
                counts[mode] = counts.get(mode, 0) + 1
    if counts:
        return sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[0][0]
    return "off"


def _deciders_block(since: float) -> dict:
    overview = {"off": 0, "shadow": 0, "active": 0}
    by_strategy: dict[str, dict] = {}
    try:
        import router_deciders

        status = router_deciders.status()
        enabled = status.get("enabled") if isinstance(status, dict) else {}
        if isinstance(enabled, dict):
            for name, mode in enabled.items():
                key = str(mode or "off").strip().lower()
                if key not in overview:
                    key = "off"
                overview[key] += 1
                cfg = router_deciders.strategy_config(str(name))
                by_strategy[str(name)] = {"decider": cfg.get("decider"),
                                          "mode": str(cfg.get("mode") or "off")}
    except Exception:
        pass

    shadow = {"total": 0, "ok": 0, "error": 0, "timeout": 0, "p50_ms": 0}
    try:
        rows, _ = router_plan._iter_jsonl_rows(_shadow_log_path(), since=since,
                                               tail_bytes=_LEDGER_TAIL_BYTES)
        latencies = []
        ok = errors = timeouts = 0
        for row in rows:
            status_text = str(row.get("status") or "").strip().lower()
            latencies.append(_int_of(row.get("latency_ms")))
            if status_text == "ok":
                ok += 1
                continue
            errors += 1
            detail = (status_text + " " + str(row.get("error") or "")).lower()
            if status_text == "timeout" or "timeout" in detail or "timed out" in detail:
                timeouts += 1
        shadow = {"total": len(rows), "ok": ok, "error": errors, "timeout": timeouts,
                  "p50_ms": _pct_int(latencies, 50)}
    except Exception:
        pass
    return {"overview": overview, "by_strategy": by_strategy, "shadow": shadow}


def _build_snapshot(range_key: str, seconds: int, limit: int) -> dict:
    gw = _gateway()
    generated = time.time()

    range_key, seconds = _parse_range(range_key)
    limit = _parse_limit(limit)
    since = generated - seconds
    until = generated

    ledger_path = Path(gw.LEDGER_PATH)
    rows, truncated = router_plan._iter_jsonl_rows(
        ledger_path, since=since, tail_bytes=_LEDGER_TAIL_BYTES)
    local_ids = _local_ids(gw)

    total = _new_bucket()
    roles = {key: _new_bucket() for key in _ROLE_KEYS}
    role_models: dict[str, dict[str, dict]] = {key: {} for key in _ROLE_KEYS}
    models: dict[str, dict] = {}
    upstream_stats: dict[str, dict] = {}
    ctx_bands = {"pass": 0, "reject": 0, "unknown": 0}
    ctx_used: list[float] = []
    ctx_buckets = [0] * 10

    for row in rows:
        epoch = _row_epoch(row)
        chosen = _chosen_of(row)
        upstream_id, model_name = _split_candidate(chosen)
        is_local = bool(upstream_id) and upstream_id in local_ids
        usage = row.get("usage") if isinstance(row.get("usage"), dict) else {}
        prompt = _int_of(usage.get("prompt_tokens"))
        completion = _int_of(usage.get("completion_tokens"))
        status = str(row.get("final_status") or "")
        ok = status.startswith("ok")
        stage = str(row.get("stage") or "").strip().upper()
        if stage not in _ROLE_KEYS:
            stage = ""
        period = str(row.get("period") or "")
        total_ms = _total_ms_of(row)
        cache_rate = 0.0
        if prompt > 0:
            hit = _int_of(usage.get("prompt_cache_hit_tokens"))
            if hit > 0:
                cache_rate = max(0.0, min(1.0, hit / prompt))
        cost = _row_cost(gw, chosen, prompt, completion, epoch, period, cache_rate)
        attempts = _attempts_of(row)
        upshift = 1 if (len(attempts) >= 2 or row.get("fallback")) else 0
        band = _ctx_band_of(row)
        used_pct = _ctx_used_pct_of(row)

        targets = [total]
        if stage:
            targets.append(roles[stage])
        for target in targets:
            target["requests"] += 1
            target["ok" if ok else "failed"] += 1
            target["prompt"] += prompt
            target["completion"] += completion
            target["cost"] += cost
            target["ms"].append(total_ms)
            target["upshift"] += upshift
            if is_local:
                target["local"] += 1

        # 模型（分层内 + 全局）
        if chosen:
            key = chosen
            model_buckets = [models.setdefault(key, _new_model_bucket())]
            if stage:
                model_buckets.append(role_models[stage].setdefault(key, _new_model_bucket()))
            for bucket in model_buckets:
                bucket["requests"] += 1
                bucket["ok" if ok else "failed"] += 1
                bucket["prompt"] += prompt
                bucket["completion"] += completion
                bucket["cost"] += cost
                bucket["ms"].append(total_ms)
                bucket["local"] += 1 if is_local else 0
                if stage:
                    bucket["stages"][stage] = bucket["stages"].get(stage, 0) + 1

        # 上游（按 chosen 归属；失败按该行 ok 计）
        if upstream_id:
            stat = upstream_stats.setdefault(upstream_id, {"requests": 0, "failed": 0, "ms": []})
            stat["requests"] += 1
            stat["failed"] += 0 if ok else 1
            stat["ms"].append(total_ms)

        # 上下文治理
        ctx_bands[band] = ctx_bands.get(band, 0) + 1
        if used_pct is not None:
            ctx_used.append(used_pct)
            index = min(9, max(0, int(used_pct * 100) // 10))
            ctx_buckets[index] += 1

    requests = total["requests"]
    ok_count = total["ok"]
    failed_count = total["failed"]

    # ---- gateway / upstream 健康（**只读内存态**）----
    # 刻意不调用 gw.health_payload()：它会跑「价格单源自证」并可能外呼 stall-notify（有写/外呼副作用），
    # 而本 API 契约是「只读：不执行、不写账、不调上游」。这里只读 UPSTREAMS / STATE 的内存快照，
    # 字段与 /health 同口径（state/circuit/failures/remaining_s/open_until），零副作用。
    gateway, upstream_health = _gateway_snapshot(gw)

    upstreams: list[dict] = []
    seen_upstreams = set()
    for item in upstream_health:
        uid = str(item.get("id") or "")
        circuit = item.get("circuit") if isinstance(item.get("circuit"), dict) else {}
        stat = upstream_stats.get(uid) or {}
        seen_upstreams.add(uid)
        upstreams.append({
            "id": uid,
            "state": str(item.get("state") or "unknown"),
            "circuit_state": str(circuit.get("state") or "unknown"),
            "failures": _int_of(circuit.get("failures")),
            "remaining_s": _int_of(circuit.get("remaining_s")),
            "open_until": circuit.get("open_until") or None,
            "models": len(item.get("models") or []),
            "requests": _int_of(stat.get("requests")),
            "failed": _int_of(stat.get("failed")),
            "p50_ms": _pct_int(stat.get("ms") or [], 50),
        })
    for uid, stat in sorted(upstream_stats.items()):
        if uid in seen_upstreams:
            continue
        upstreams.append({
            "id": uid, "state": "unknown", "circuit_state": "unknown", "failures": 0,
            "remaining_s": 0, "open_until": None, "models": 0,
            "requests": _int_of(stat.get("requests")), "failed": _int_of(stat.get("failed")),
            "p50_ms": _pct_int(stat.get("ms") or [], 50),
        })

    # ---- roles（三层，顺序固定 L1→L2→L3；无数据也返回，便于泳道图空态） ----
    role_items = []
    for key, label, desc in ROLE_META:
        bucket = roles[key]
        role_requests = bucket["requests"]
        model_items = []
        for candidate, model_bucket in role_models[key].items():
            upstream, name = _split_candidate(candidate)
            top_stage = ""
            if model_bucket["stages"]:
                top_stage = sorted(model_bucket["stages"].items(),
                                   key=lambda kv: kv[1], reverse=True)[0][0]
            model_items.append({
                "key": candidate, "model": name, "upstream": upstream,
                "requests": model_bucket["requests"], "ok": model_bucket["ok"],
                "failed": model_bucket["failed"],
                "cost_cny": _round(model_bucket["cost"], 3),
                "share": _round(model_bucket["requests"] / role_requests, 4) if role_requests else 0.0,
                "local": bool(model_bucket["local"] * 2 >= model_bucket["requests"]
                              and model_bucket["requests"] > 0),
                "top_stage": top_stage or (key if model_bucket["stages"] else ""),
            })
        model_items.sort(key=lambda item: (-item["requests"], item["key"]))
        role_items.append({
            "key": key, "label": label, "desc": desc,
            "requests": role_requests, "ok": bucket["ok"], "failed": bucket["failed"],
            "p50_ms": _pct_int(bucket["ms"], 50), "p95_ms": _pct_int(bucket["ms"], 95),
            "prompt_tokens": bucket["prompt"], "completion_tokens": bucket["completion"],
            "cost_cny": _round(bucket["cost"], 3),
            "share": _round(role_requests / requests, 4) if requests else 0.0,
            "upshift": bucket["upshift"],
            "models": model_items,
        })

    # ---- models（全局，按请求数降序） ----
    model_items = []
    for candidate, bucket in models.items():
        upstream, name = _split_candidate(candidate)
        top_stage = ""
        if bucket["stages"]:
            top_stage = sorted(bucket["stages"].items(), key=lambda kv: kv[1], reverse=True)[0][0]
        model_items.append({
            "key": candidate, "upstream": upstream, "model": name,
            "requests": bucket["requests"], "ok": bucket["ok"], "failed": bucket["failed"],
            "p50_ms": _pct_int(bucket["ms"], 50), "p95_ms": _pct_int(bucket["ms"], 95),
            "prompt_tokens": bucket["prompt"], "completion_tokens": bucket["completion"],
            "cost_cny": _round(bucket["cost"], 3),
            "share": _round(bucket["requests"] / requests, 4) if requests else 0.0,
            "local": bool(upstream and upstream in local_ids),
            "top_stage": top_stage,
        })
    model_items.sort(key=lambda item: (-item["requests"], item["key"]))

    # ---- recent（新 → 旧，取最近 limit 条） ----
    indexed = []
    for index, row in enumerate(rows):
        epoch = _row_epoch(row)
        indexed.append((epoch if epoch is not None else float("-inf"), index, row))
    indexed.sort(key=lambda item: (item[0], item[1]), reverse=True)

    recent = []
    for epoch, _index, row in indexed[:limit]:
        chosen = _chosen_of(row)
        usage = row.get("usage") if isinstance(row.get("usage"), dict) else {}
        prompt = _int_of(usage.get("prompt_tokens"))
        completion = _int_of(usage.get("completion_tokens"))
        period = str(row.get("period") or "")
        cache_rate = 0.0
        if prompt > 0:
            hit = _int_of(usage.get("prompt_cache_hit_tokens"))
            if hit > 0:
                cache_rate = max(0.0, min(1.0, hit / prompt))
        cost = _row_cost(gw, chosen, prompt, completion, epoch, period, cache_rate)
        attempts = []
        for item in _attempts_of(row):
            attempts.append({
                "upstream": str(item.get("upstream") or ""),
                "model": str(item.get("model") or ""),
                "status": item.get("status"),
                "ms": _int_of(item.get("ms")),
                "error": item.get("error"),
            })
        candidates = row.get("candidates") if isinstance(row.get("candidates"), list) else []
        recent.append({
            "ts": _iso_of(epoch) if epoch is not None else str(row.get("ts") or row.get("at") or ""),
            "req_id": str(row.get("req_id") or ""),
            "virtual_model": str(row.get("virtual_model") or ""),
            "stage": str(row.get("stage") or ""),
            "period": period,
            "candidates": [str(item) for item in candidates][:12],
            "chosen": chosen,
            "ok": str(row.get("final_status") or "").startswith("ok"),
            "final_status": str(row.get("final_status") or ""),
            "total_ms": _total_ms_of(row),
            "attempts": attempts[:8],
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "cost_cny": _round(cost, 3),
            "ctx_band": _ctx_band_of(row),
            "ctx_used_pct": _ctx_used_pct_of(row),
        })

    # ---- freshness ----
    ledger_mtime = _ledger_mtime(ledger_path)
    try:
        ledger_size = ledger_path.stat().st_size
    except OSError:
        ledger_size = 0
    # partial 语义：截断且「被截掉的那段里还有本 range 的行」才算统计不完整；
    # 尾部 1MB 已覆盖整个 range 时（1h/6h/24h 常态）不误报红字，符合契约「超出标 partial」。
    partial = False
    if truncated:
        gap_epoch = _last_row_epoch_before(ledger_path, _LEDGER_TAIL_BYTES)
        partial = True if gap_epoch is None else bool(gap_epoch >= since)
    freshness = {
        "ledger_total_rows": _count_total_rows(ledger_path),
        "rows_in_range": len(rows),
        "scanned_bytes": int(min(ledger_size, _LEDGER_TAIL_BYTES)),
        "partial": bool(partial),
        "ledger_mtime": _iso_of(ledger_mtime) if ledger_mtime is not None else None,
    }

    # ---- kpi ----
    local_requests = total["local"]
    kpi = {
        "requests": requests,
        "ok": ok_count,
        "failed": failed_count,
        "success_rate": _round(ok_count / requests, 4) if requests else 0.0,
        "p50_ms": _pct_int(total["ms"], 50),
        "p95_ms": _pct_int(total["ms"], 95),
        "prompt_tokens": total["prompt"],
        "completion_tokens": total["completion"],
        "cost_cny": _round(total["cost"], 3),
        "local_share": _round(local_requests / requests, 4) if requests else 0.0,
        "cloud_share": _round((requests - local_requests) / requests, 4) if requests else 0.0,
    }

    # ---- ctx（上下文治理） ----
    ctx = {
        "mode": _ctx_mode(gw, rows),
        "bands": {"pass": ctx_bands.get("pass", 0), "reject": ctx_bands.get("reject", 0),
                  "unknown": ctx_bands.get("unknown", 0)},
        "p50_used_pct": _round(_pct_of(ctx_used, 50), 4),
        "buckets": [{"from": index * 10, "to": index * 10 + 10, "count": ctx_buckets[index]}
                    for index in range(10)],
    }

    notes = [
        "只读：不执行、不写账、不调上游",
        "账本只读尾部 1MB，超出标 partial",
        "成本＝按行 ts 的 pricebook 有效价 × 行内 token；取不到价（未知模型/本地）记 0，不猜价",
        "升档＝该请求 attempts 达 2 条以上或发生 fallback",
    ]
    if partial:
        notes.append("账本尾部 1MB 截断：范围内统计不完整（partial=true）")

    return {
        "ok": True,
        "mode": "read_only",
        "generated_at": _iso_of(generated),
        "range": {
            "key": range_key, "seconds": seconds,
            "since": _iso_of(since), "until": _iso_of(until),
        },
        "gateway": gateway,
        "freshness": freshness,
        "kpi": kpi,
        "roles": role_items,
        "recent": recent,
        "models": model_items,
        "upstreams": upstreams,
        "ctx": ctx,
        "deciders": _deciders_block(since),
        "notes": notes,
    }


def _degraded(range_key: str, limit: int, exc: BaseException) -> dict:
    """兜底载荷：任何未预期异常都不许 500，按契约给默认值（只报异常类型名，不泄内部信息）。"""
    generated = time.time()
    seconds = LIVE_RANGES.get(range_key, LIVE_RANGES[DEFAULT_RANGE])
    return {
        "ok": True,
        "mode": "read_only",
        "generated_at": _iso_of(generated),
        "range": {"key": range_key, "seconds": seconds,
                  "since": _iso_of(generated - seconds), "until": _iso_of(generated)},
        "gateway": {"ok": False, "uptime_s": 0, "version": _GATEWAY_VERSION_FALLBACK,
                    "host": "127.0.0.1", "port": 0},
        "freshness": {"ledger_total_rows": 0, "rows_in_range": 0, "scanned_bytes": 0,
                      "partial": False, "ledger_mtime": None},
        "kpi": {"requests": 0, "ok": 0, "failed": 0, "success_rate": 0.0, "p50_ms": 0,
                "p95_ms": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost_cny": 0.0,
                "local_share": 0.0, "cloud_share": 0.0},
        "roles": [{"key": key, "label": label, "desc": desc, "requests": 0, "ok": 0,
                   "failed": 0, "p50_ms": 0, "p95_ms": 0, "prompt_tokens": 0,
                   "completion_tokens": 0, "cost_cny": 0.0, "share": 0.0, "upshift": 0,
                   "models": []} for key, label, desc in ROLE_META],
        "recent": [],
        "models": [],
        "upstreams": [],
        "ctx": {"mode": "off", "bands": {"pass": 0, "reject": 0, "unknown": 0},
                "p50_used_pct": 0.0,
                "buckets": [{"from": index * 10, "to": index * 10 + 10, "count": 0}
                            for index in range(10)]},
        "deciders": {"overview": {"off": 0, "shadow": 0, "active": 0},
                     "by_strategy": {},
                     "shadow": {"total": 0, "ok": 0, "error": 0, "timeout": 0, "p50_ms": 0}},
        "notes": ["只读：不执行、不写账、不调上游",
                  "账本只读尾部 1MB，超出标 partial",
                  f"统计降级：{type(exc).__name__}（已按默认值返回，不影响网关）"],
    }


# ---------------------------------------------------------------------------
# 对外入口（唯一公开函数）
# ---------------------------------------------------------------------------
def snapshot(range_key: str = "24h", limit: int = 30) -> dict:
    """只读聚合快照（契约 §4）。只在内存里读账本尾部 + 影子记录，绝不写盘/调上游。

    :param range_key: 1h | 6h | 24h | 7d（非法回落 24h）
    :param limit: recent 条数，夹在 1..100（默认 30）
    :return: 契约 JSON（dict）；任何异常都降级成默认值，不抛出
    """
    range_key, _seconds = _parse_range(range_key)
    limit = _parse_limit(limit)
    cache_key = (range_key, limit)
    now = time.monotonic()
    with _CACHE_LOCK:
        cached = _CACHE.get(cache_key)
        if cached is not None and now - cached[0] < _CACHE_TTL_S:
            return copy.deepcopy(cached[1])
    try:
        payload = _build_snapshot(range_key, LIVE_RANGES[range_key], limit)
    except Exception as exc:      # noqa: BLE001 —— 契约要求绝不 500，一律降级
        payload = _degraded(range_key, limit, exc)
    with _CACHE_LOCK:
        _CACHE[cache_key] = (time.monotonic(), payload)
        if len(_CACHE) > _CACHE_MAX_ENTRIES:
            order = sorted(_CACHE.items(), key=lambda item: item[1][0])
            for stale_key, _stamp in order[:len(_CACHE) - _CACHE_MAX_ENTRIES]:
                _CACHE.pop(stale_key, None)
    return copy.deepcopy(payload)


def _reset_caches() -> None:
    """清空内存缓存（单测用；生产无调用方）。"""
    with _CACHE_LOCK:
        _CACHE.clear()
    with _PRICE_LOCK:
        _PRICE_CACHE.clear()
