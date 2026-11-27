#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""宿主卡位上报的汇总与新鲜度判定（契约 v1.1 §4.3，接口规格 §1）。

职责边界
--------
- 卡占用由**卡所在宿主**上报，本模块只做校验、汇总、新鲜度判定与文件通道轮询；
  不代采、不反推、不驱动卸载、不写盘（§1.9 的文件通道只读）。
- 模块自身**不 import main**（避免循环依赖），无第三方依赖，只用标准库。

两个视角不混
------------
宿主视角的 `active_requests` 与本模块无关，网关视角的在飞数在 main 的
`occupancy_payload()` 里；本模块只承载宿主视角，两边分别保留、不合并。

时间口径
--------
宿主只发 Unix epoch 毫秒；对外输出 ISO+08:00、`timespec="seconds"`。
所有公开函数都接受注入的 `now_ms`，因此单测不依赖真实时钟。
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# §1.1 常量
# ---------------------------------------------------------------------------

STALE_SECONDS = 30.0          # reported_at 距今 > 30s ⇒ 过期
FUTURE_SKEW_MS = 60_000       # 未来时间戳容忍 60s，超过记 conflicts 且不 fresh
FILE_POLL_SECONDS = 30.0      # 文件通道轮询间隔上限（契约 ≤30s）
STORE_LIMIT = 64              # (host_id, model) 条目上限，超出淘汰最旧 reported_at
GPU_NOTE = "宿主上报，网关不自采"
REQUIRED_FIELDS = ("host_id", "model", "loaded", "active_requests", "last_active_ts", "reported_at")
OPTIONAL_FIELDS = ("gpu_util", "mem_used_mib", "preemptible")
COMPAT_FIELDS = {"mem_used_mb": "mem_used_mib"}   # 一个版本期兼容读入（同口径 MiB）

#: 兼容读入时 `compat` 里追加的标记（逐字照规格 §1.2）
COMPAT_LEGACY_USED = "mem_used_mb→mem_used_mib"
COMPAT_LEGACY_IGNORED = "mem_used_mb_ignored"
#: 冲突标记（逐字照规格 §1.2）
CONFLICT_PREEMPTIBLE = "preemptible_conflict"
CONFLICT_FUTURE = "reported_at_in_future"
#: snapshot 里两视角不合并的固定说明（规格 §1.4）
SNAPSHOT_NOTE = "网关视角与宿主视角分开两列，不合并"
#: 输出时间统一 +08:00（时区解析见 _resolve_tz）
ENV_OCCUPANCY_FILE = "ROUTER_OCCUPANCY_FILE"


def _resolve_tz():
    """解析对外输出的时区：优先 `ZoneInfo("Asia/Shanghai")`，不可用退回本机当前时区。

    与 main.py 的 TZ 口径一致（ZoneInfo 缺失时退化），保证两边输出的 ISO 字符串完全同款。
    """
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo("Asia/Shanghai")
    except Exception:  # pragma: no cover - 仅在 tzdata/zoneinfo 缺失时走到
        return datetime.now().astimezone().tzinfo or timezone(timedelta(hours=8))


#: 输出时间统一 +08:00
TZ = _resolve_tz()

LOG = logging.getLogger("occupancy_host")

# ---------------------------------------------------------------------------
# 进程内状态（全部由 _LOCK 保护）
# ---------------------------------------------------------------------------

_LOCK = threading.RLock()
#: (host_id, model) -> 存储记录（见 _record_of，不含随时间变化的 age/fresh/ISO 字段）
_STORE: dict[tuple[str, str], dict] = {}
#: source 名 -> {"name", "at", "accepted", "rejected"}（最近一次该类来源）
_SOURCES: dict[str, dict] = {}
#: 进程生命周期内累计被拒条目数（snapshot.rejected_total）
_REJECTED_TOTAL = 0
#: 文件路径 -> (st_mtime, st_size)，用于「mtime＋size 未变不重复 ingest」
_FILE_CACHE: dict[str, tuple[float, int]] = {}
#: 文件路径 -> (线程, 停止事件)，用于 start_poller 幂等
_POLLERS: dict[str, tuple[threading.Thread, threading.Event]] = {}

__all__ = [
    "STALE_SECONDS", "FUTURE_SKEW_MS", "FILE_POLL_SECONDS", "STORE_LIMIT", "GPU_NOTE",
    "REQUIRED_FIELDS", "OPTIONAL_FIELDS", "COMPAT_FIELDS",
    "normalize", "ingest", "snapshot", "fresh_only", "find", "host_ready_for_retry",
    "file_path", "load_file", "poll_file", "start_poller", "reset_state",
    "iso_from_ms", "iso_from_ts",
]


# ---------------------------------------------------------------------------
# 小工具（就地实现，不依赖 main）
# ---------------------------------------------------------------------------

def _now_ms() -> int:
    """当前时刻的 Unix epoch 毫秒（模块内唯一的真实时钟入口，便于审计）。"""
    return int(time.time() * 1000)


def _iso_from_ms(ms: int) -> str | None:
    """epoch 毫秒 → ISO+08:00（秒精度）；超出 datetime 可表示范围时返回 None。

    上游理论上只发合理时间戳，但脏数据不应让整个快照崩掉，所以这里降级为 None。
    """
    try:
        return datetime.fromtimestamp(ms / 1000.0, TZ).isoformat(timespec="seconds")
    except (OverflowError, OSError, ValueError):
        LOG.debug("时间戳无法转换为 ISO：%r", ms)
        return None


def iso_from_ms(ms: int) -> str:
    """epoch 毫秒 → ISO+08:00（`timespec="seconds"`）。供 main 直接调用（规格 §1.10）。

    超出 datetime 可表示范围时抛 ValueError（正常时间戳不会走到）。
    """
    iso = _iso_from_ms(int(ms))
    if iso is None:
        raise ValueError(f"时间戳超出可表示范围：{ms!r}")
    return iso


def iso_from_ts(ts: float) -> str:
    """epoch 秒 → ISO+08:00（`timespec="seconds"`）。供 main 直接调用（规格 §1.10）。

    实现照 main.py 的 `_iso_from_ts`：`datetime.fromtimestamp(ts, TZ).isoformat(...)`。
    """
    return datetime.fromtimestamp(float(ts), TZ).isoformat(timespec="seconds")


def _require_text(raw: dict, field: str) -> str:
    """必填字符串字段：必须是 str，且去空白后非空（空串无法作为存储主键）。"""
    if field not in raw:
        raise ValueError(f"缺少必填字段 {field}")
    value = raw[field]
    if not isinstance(value, str):
        raise ValueError(f"字段 {field} 必须是 str，收到 {type(value).__name__}")
    if not value.strip():
        raise ValueError(f"字段 {field} 不能为空字符串")
    return value


def _require_bool(raw: dict, field: str) -> bool:
    """必填布尔字段：只认 bool（整数 0/1 不算）。"""
    if field not in raw:
        raise ValueError(f"缺少必填字段 {field}")
    value = raw[field]
    if not isinstance(value, bool):
        raise ValueError(f"字段 {field} 必须是 bool，收到 {type(value).__name__}")
    return value


def _require_int(raw: dict, field: str) -> int:
    """必填整数字段：只认 int，bool 不算（bool 是 int 子类，必须先排除）。"""
    if field not in raw:
        raise ValueError(f"缺少必填字段 {field}")
    value = raw[field]
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"字段 {field} 必须是 int，收到 {type(value).__name__}")
    return value


def _optional_number(raw: dict, field: str) -> float | None:
    """可选数值字段：键缺失或值为 None ⇒ None；int/float 收下；负数/NaN/Inf ⇒ None。

    类型错（字符串、bool 等）仍抛 ValueError——规格 §1.2 要求类型校验严格。
    """
    if field not in raw:
        return None
    value = raw[field]
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"字段 {field} 必须是 number 或 null，收到 {type(value).__name__}")
    number = float(value)
    if math.isnan(number) or math.isinf(number) or number < 0:
        return None
    return number


def _optional_bool(raw: dict, field: str) -> bool | None:
    """可选布尔字段：键缺失或值为 None ⇒ None；其余只认 bool。"""
    if field not in raw:
        return None
    value = raw[field]
    if value is None:
        return None
    if not isinstance(value, bool):
        raise ValueError(f"字段 {field} 必须是 bool 或 null，收到 {type(value).__name__}")
    return value


def _mem_used_mib(raw: dict, compat: list[str]) -> float | None:
    """按 §1.2 读入显存占用：`mem_used_mib` 为主，`mem_used_mb` 仅兼容读入。

    - 只有 `mem_used_mb` ⇒ 赋给 `mem_used_mib`，compat 记 `mem_used_mb→mem_used_mib`；
    - 两键同时出现 ⇒ 以 `mem_used_mib` 为准（哪怕它是 null），compat 记 `mem_used_mb_ignored`。
    """
    has_new = "mem_used_mib" in raw
    has_legacy = "mem_used_mb" in raw
    if has_new and has_legacy:
        compat.append(COMPAT_LEGACY_IGNORED)
        return _optional_number(raw, "mem_used_mib")
    if has_new:
        return _optional_number(raw, "mem_used_mib")
    if has_legacy:
        compat.append(COMPAT_LEGACY_USED)
        return _optional_number(raw, "mem_used_mb")
    return None


def _fresh_of(age_ms: int) -> bool:
    """§1.2 新鲜度判据：-60s ≤ age ≤ 30s 为 fresh（两端都是闭区间）。"""
    return -FUTURE_SKEW_MS <= age_ms <= int(STALE_SECONDS * 1000)


def _record_of(entry: dict) -> dict:
    """把 normalize 输出压成存储记录：剥掉随时间变化的 age_ms/fresh/stale/ISO 字段。

    这样快照与判断接口可以在任意注入的 now_ms 下**重算**新鲜度，
    而不是沿用上报当刻算出来的旧值。
    """
    return {
        "host_id": entry["host_id"],
        "model": entry["model"],
        "loaded": entry["loaded"],
        "active_requests": entry["active_requests"],
        "last_active_ts": entry["last_active_ts"],
        "reported_at": entry["reported_at"],
        "gpu_util": entry["gpu_util"],
        "mem_used_mib": entry["mem_used_mib"],
        "preemptible": entry["preemptible"],
        # 与时间无关的冲突在存储里留成标志；时间相关的（未来时间戳）在重算时补
        "preemptible_conflict": CONFLICT_PREEMPTIBLE in entry["conflicts"],
        "compat": list(entry["compat"]),
    }


def _materialize(record: dict, now_ms: int) -> dict:
    """存储记录 → 对外固定键结构（按 now_ms 重算 age_ms/fresh/stale/conflicts/ISO）。"""
    age_ms = now_ms - record["reported_at"]
    fresh = _fresh_of(age_ms)
    conflicts: list[str] = []
    if record.get("preemptible_conflict"):
        conflicts.append(CONFLICT_PREEMPTIBLE)
    if age_ms < -FUTURE_SKEW_MS:
        conflicts.append(CONFLICT_FUTURE)
    return {
        "host_id": record["host_id"],
        "model": record["model"],
        "loaded": record["loaded"],
        "active_requests": record["active_requests"],
        "last_active_ts": record["last_active_ts"],
        "reported_at": record["reported_at"],
        "gpu_util": record["gpu_util"],
        "mem_used_mib": record["mem_used_mib"],
        "preemptible": record["preemptible"],
        "age_ms": age_ms,
        "fresh": fresh,
        "stale": not fresh,
        "conflicts": conflicts,
        "compat": list(record.get("compat") or []),
        "last_active_at": _iso_from_ms(record["last_active_ts"]),
        "reported_at_iso": _iso_from_ms(record["reported_at"]),
    }


def _sort_key(item: dict):
    """§1.4 排序：fresh 优先 → active_requests 降 → mem_used_mib 降（None 当 -1）→ model 升。

    末尾补 host_id 作最终决胜，保证同 model 多宿主时顺序稳定（规格未要求，但不影响其判据）。
    """
    mem = item["mem_used_mib"]
    mem_rank = -mem if mem is not None else 1.0   # None 视作 -1 ⇒ 取负后为 1.0，排在有值之后
    return (0 if item["fresh"] else 1, -item["active_requests"], mem_rank, item["model"], item["host_id"])


def _evict_locked() -> None:
    """调用方须持 _LOCK：条目超过 STORE_LIMIT 时淘汰 reported_at 最旧的，直到不超限。"""
    while len(_STORE) > STORE_LIMIT:
        oldest_key = min(
            _STORE,
            key=lambda key: (_STORE[key]["reported_at"], key[0], key[1]),
        )
        _STORE.pop(oldest_key, None)


def _extract_reports(raw) -> tuple[list, list[dict]]:
    """拆解 ingest 支持的四种载荷形状，返回 (候选条目列表, 结构性 rejected)。

    支持：单条 dict；`{"reports": [...]}`；`{"report": {...}}`；list[dict]。
    """
    if isinstance(raw, list):
        return list(raw), []
    if isinstance(raw, dict):
        if "reports" in raw:
            reports = raw["reports"]
            if not isinstance(reports, list):
                return [], [{"index": 0, "error": "reports 必须是数组"}]
            return list(reports), []
        if "report" in raw:
            return [raw["report"]], []
        return [raw], []
    return [], [{"index": 0, "error": f"不支持的载荷类型：{type(raw).__name__}"}]


# ---------------------------------------------------------------------------
# §1.2 normalize
# ---------------------------------------------------------------------------

def normalize(raw: dict, now_ms: int | None = None) -> dict:
    """校验＋归一单条宿主上报，返回固定键结构（§1.2）。

    非法一率抛 ValueError（消息含字段名）。校验口径：
    `loaded`/`preemptible` 只认 bool（`None` 仅允许 preemptible）；`active_requests`、
    `last_active_ts`、`reported_at` 只认 int（bool 不算）；`active_requests` 必须 ≥0；
    `gpu_util`/`mem_used_mib` 认 int/float，负数/NaN/Inf → None。
    `fresh = (-60000 ≤ age ≤ 30000)`，`stale = not fresh`；冲突只记不改值
    （`preemptible=True` 与 `active_requests>0` 冲突时以 `active_requests` 为准）。
    """
    if not isinstance(raw, dict):
        raise ValueError(f"上报必须是 JSON 对象，收到 {type(raw).__name__}")

    host_id = _require_text(raw, "host_id")
    model = _require_text(raw, "model")
    loaded = _require_bool(raw, "loaded")
    active_requests = _require_int(raw, "active_requests")
    if active_requests < 0:
        raise ValueError(f"字段 active_requests 不能为负，收到 {active_requests}")
    last_active_ts = _require_int(raw, "last_active_ts")
    reported_at = _require_int(raw, "reported_at")

    compat: list[str] = []
    gpu_util = _optional_number(raw, "gpu_util")
    mem_used_mib = _mem_used_mib(raw, compat)
    preemptible = _optional_bool(raw, "preemptible")

    ts = _now_ms() if now_ms is None else int(now_ms)
    record = {
        "host_id": host_id,
        "model": model,
        "loaded": loaded,
        "active_requests": active_requests,
        "last_active_ts": last_active_ts,
        "reported_at": reported_at,
        "gpu_util": gpu_util,
        "mem_used_mib": mem_used_mib,
        "preemptible": preemptible,
        # 硬约束：宿主自评「可安全卸下」却在飞请求 >0 ⇒ 记冲突（不改 preemptible 值）
        "preemptible_conflict": preemptible is True and active_requests > 0,
        "compat": compat,
    }
    return _materialize(record, ts)


# ---------------------------------------------------------------------------
# §1.3 ingest
# ---------------------------------------------------------------------------

def ingest(raw, source: str = "push", now_ms: int | None = None) -> dict:
    """接收一批主机上报并按 (host_id, model) 覆盖入库，返回处理摘要（§1.3）。

    接受四种载荷：单条 dict、`{"reports": [...]}`、`{"report": {...}}`、list[dict]。
    非法条目**跳过不抛**（记进 rejected，带下标），不影响同一批其余条目。
    无论成败都会刷新 `source` 的「最近一次来源」记录。
    `stored` 为入库后**存储总条目数**（不是本次写入条数，见模块 docstring/回报）。
    """
    global _REJECTED_TOTAL
    ts = _now_ms() if now_ms is None else int(now_ms)
    candidates, rejected = _extract_reports(raw)
    accepted = 0
    with _LOCK:
        for index, candidate in enumerate(candidates):
            try:
                entry = normalize(candidate, ts)
            except ValueError as exc:
                rejected.append({"index": index, "error": str(exc)})
                continue
            _STORE[(entry["host_id"], entry["model"])] = _record_of(entry)
            accepted += 1
        _evict_locked()
        stored = len(_STORE)
        rejected.sort(key=lambda row: row["index"])   # 结构错（index 0）与逐条错混在一起时按序输出
        _SOURCES[source] = {
            "name": source,
            "at": _iso_from_ms(ts),
            "accepted": accepted,
            "rejected": len(rejected),
        }
        _REJECTED_TOTAL += len(rejected)
    return {"source": source, "accepted": accepted, "rejected": rejected, "stored": stored}


# ---------------------------------------------------------------------------
# §1.4 snapshot
# ---------------------------------------------------------------------------

def snapshot(now_ms: int | None = None) -> dict:
    """汇总快照（§1.4）：条目逐条按 now_ms 重算新鲜度，过期条目不删只计数。

    `gpu` 只在**存在 fresh 条目**时非 None，取 fresh 条目里 `mem_used_mib` 非 None 的最大者；
    全部过期或都没有显存数 ⇒ None（信号不全不猜）。
    """
    ts = _now_ms() if now_ms is None else int(now_ms)
    with _LOCK:
        records = list(_STORE.values())
        sources = [dict(_SOURCES[name]) for name in sorted(_SOURCES)]
        rejected_total = _REJECTED_TOTAL

    items = [_materialize(record, ts) for record in records]
    items.sort(key=_sort_key)

    fresh_items = [item for item in items if item["fresh"]]
    gpu = None
    with_mem = [item for item in fresh_items if item["mem_used_mib"] is not None]
    if with_mem:
        # 最大值优先；同显存时取上报更新的，再按 host_id 决胜（保证确定性）
        best = sorted(
            with_mem,
            key=lambda item: (-item["mem_used_mib"], -item["reported_at"], item["host_id"]),
        )[0]
        gpu = {
            "reported_by": "host",
            "host_id": best["host_id"],
            "util": best["gpu_util"],
            "mem_used_mib": best["mem_used_mib"],
            "reported_at": best["reported_at"],
            "fresh": True,
            "note": GPU_NOTE,
        }

    return {
        "as_of": _iso_from_ms(ts),
        "fresh_seconds": STALE_SECONDS,
        "sources": sources,
        "fresh_count": len(fresh_items),
        "stale_count": len(items) - len(fresh_items),
        "rejected_total": rejected_total,
        "note": SNAPSHOT_NOTE,
        "gpu": gpu,
        "items": items,
    }


# ---------------------------------------------------------------------------
# §1.5 判断用接口（只认 fresh）
# ---------------------------------------------------------------------------

def fresh_only(now_ms: int | None = None) -> list[dict]:
    """只返回 fresh 条目（判断/停卡提示只许用这个，排序与 snapshot.items 一致）。

    过期/信号不全的条目一律不参与判断——宁可不动，不可误停。
    """
    ts = _now_ms() if now_ms is None else int(now_ms)
    with _LOCK:
        records = list(_STORE.values())
    items = [_materialize(record, ts) for record in records]
    items = [item for item in items if item["fresh"]]
    items.sort(key=_sort_key)
    return items


def find(host_id, model, fresh: bool = True, now_ms: int | None = None) -> dict | None:
    """按 (host_id, model) 查条目并按 now_ms 重算新鲜度。

    `fresh=True`（默认）时过期条目视同不存在（返回 None）；`fresh=False` 时连过期条目也返回。
    未收录 ⇒ None。
    """
    ts = _now_ms() if now_ms is None else int(now_ms)
    with _LOCK:
        record = _STORE.get((host_id, model))
    if record is None:
        return None
    entry = _materialize(record, ts)
    if fresh and not entry["fresh"]:
        return None
    return entry


def host_ready_for_retry(host_id, model, since_ms: int, prev_mem_mib: float | None = None,
                         now_ms: int | None = None) -> tuple[bool, dict | None]:
    """「等宿主腾出来」后能否只重试一次（供 main 的 `X-Route-Wait-Local` 用，§1.5）。

    返回 `(ready, entry)`，规则严格照规格：
    - 无 fresh 条目 ⇒ `(False, None)`（信号不全一律不据此重试）；
    - `loaded is False` ⇒ `(True, entry)`（宿主报告已卸下）；
    - `active_requests == 0` 且 `reported_at >= since_ms` 且
      （`prev_mem_mib is None` 或 `mem_used_mib is None` 或 `mem_used_mib < prev_mem_mib`）
      ⇒ `(True, entry)`（空闲且显存确实降下来了）；
    - 其它 ⇒ `(False, entry)`。
    """
    entry = find(host_id, model, fresh=True, now_ms=now_ms)
    if entry is None:
        return (False, None)
    if entry["loaded"] is False:
        return (True, entry)
    mem_dropped = (
        prev_mem_mib is None
        or entry["mem_used_mib"] is None
        or entry["mem_used_mib"] < prev_mem_mib
    )
    if entry["active_requests"] == 0 and entry["reported_at"] >= since_ms and mem_dropped:
        return (True, entry)
    return (False, entry)


# ---------------------------------------------------------------------------
# §1.6 文件交换通道（契约 §4.3 通道两阶段之①）
# ---------------------------------------------------------------------------

def file_path() -> Path:
    """占用上报文件的路径：`ROUTER_OCCUPANCY_FILE` 优先，否则 `<副本>/数据/occupancy-host.json`。

    副本目录下若设置了 `ROUTER_DATA_DIR`（main 的账本目录口径），则跟着它走，
    保证账本与占用文件落在同一个数据目录里；两者都没设就是模块同级的 `数据/`。
    """
    env_file = os.environ.get(ENV_OCCUPANCY_FILE)
    if env_file:
        return Path(env_file).expanduser()
    env_dir = os.environ.get("ROUTER_DATA_DIR")
    if env_dir:
        return Path(env_dir).expanduser() / "occupancy-host.json"
    return Path(__file__).resolve().parent / "数据" / "occupancy-host.json"


def _cache_key(target: Path) -> str:
    """缓存键：统一成绝对路径，避免相对/绝对写法导致 mtime 缓存失效。"""
    return str(target.expanduser().resolve())


def _stat_of(target: Path) -> os.stat_result:
    """取文件 stat（单独抽出，便于 load_file / poll_file 各自的异常分支）。"""
    return target.stat()


def load_file(path=None, now_ms: int | None = None) -> dict:
    """读文件 → `ingest(source="file")`，返回 ingest 结果 + `{"file", "mtime"}`。

    文件不存在 / JSON 坏 / 解码失败 ⇒ 返回 `{"error": ..., "file": ...}`（不抛、不影响既有存储），
    便于 main 在启动时直接调用而不必包 try。
    成功时顺手刷新 mtime 缓存，使紧跟其后的 `poll_file` 不会重复 ingest。
    """
    target = Path(path).expanduser() if path is not None else file_path()
    key = _cache_key(target)
    try:
        stat_result = _stat_of(target)
        text = target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {"error": "file_not_found", "file": str(target)}
    except OSError as exc:
        return {"error": f"os_error: {exc}", "file": str(target)}
    try:
        payload = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return {"error": f"bad_json: {exc}", "file": str(target)}

    result = ingest(payload, source="file", now_ms=now_ms)
    with _LOCK:
        _FILE_CACHE[key] = (stat_result.st_mtime, stat_result.st_size)
    result["file"] = str(target)
    result["mtime"] = stat_result.st_mtime
    return result


def poll_file(path=None, now_ms: int | None = None, force: bool = False) -> dict | None:
    """轮询占用文件：mtime＋size 未变且非 force ⇒ 返回 None（不重复 ingest）。

    文件不存在 / JSON 坏 ⇒ 返回 `{"error": ...}`，**不污染既有存储**；
    坏 JSON 时故意不更新 mtime 缓存，文件一修好（mtime 变）就会重新读取。
    """
    target = Path(path).expanduser() if path is not None else file_path()
    key = _cache_key(target)
    try:
        stat_result = _stat_of(target)
    except FileNotFoundError:
        return {"error": "file_not_found", "file": str(target)}
    except OSError as exc:
        return {"error": f"os_error: {exc}", "file": str(target)}

    with _LOCK:
        cached = _FILE_CACHE.get(key)
    if not force and cached == (stat_result.st_mtime, stat_result.st_size):
        return None
    return load_file(target, now_ms=now_ms)


def _poll_loop(target: Path, interval: float, stop: threading.Event) -> None:
    """轮询线程主体：每轮 poll_file 一次，异常吞掉只记 warning，收到 stop 即退出。"""
    while not stop.is_set():
        try:
            poll_file(target)
        except Exception:  # 轮询线程绝不因单轮异常退出
            LOG.warning("占用文件轮询失败：%s", target, exc_info=True)
        stop.wait(interval)


def start_poller(path=None, interval=FILE_POLL_SECONDS) -> threading.Thread:
    """启动 daemon 轮询线程（`interval` 秒一轮，上限 FILE_POLL_SECONDS）。

    异常吞掉只记 `LOG.warning`；对同一路径重复调用**幂等**，返回同一个线程对象。
    间隔非法（非数/非有限/≤0）时回落 FILE_POLL_SECONDS；`interval` 传大于上限按上限跑。
    """
    target = Path(path).expanduser() if path is not None else file_path()
    key = _cache_key(target)
    try:
        wait_s = float(interval)
    except (TypeError, ValueError):
        wait_s = FILE_POLL_SECONDS
    if not math.isfinite(wait_s) or wait_s <= 0:
        wait_s = FILE_POLL_SECONDS
    wait_s = min(wait_s, FILE_POLL_SECONDS)

    with _LOCK:
        existing = _POLLERS.get(key)
        if existing is not None and existing[0].is_alive():
            return existing[0]
        stop = threading.Event()
        thread = threading.Thread(
            target=_poll_loop,
            args=(target, wait_s, stop),
            name=f"occupancy-poll:{target}",
            daemon=True,
        )
        _POLLERS[key] = (thread, stop)
    thread.start()
    return thread


def reset_state() -> None:
    """清空存储 / 来源 / mtime 缓存与累计计数（测试用；生产不调用）。

    顺手停掉本模块起过的轮询线程（先 join 再清，避免线程收尾把数据又写回来），
    这样单测之间不会互相污染。
    """
    global _REJECTED_TOTAL
    with _LOCK:
        pollers = list(_POLLERS.values())
        _POLLERS.clear()
    for _thread, stop in pollers:
        stop.set()
    for thread, _stop in pollers:
        if thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)
    with _LOCK:
        _STORE.clear()
        _SOURCES.clear()
        _FILE_CACHE.clear()
        _REJECTED_TOTAL = 0
