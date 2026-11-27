#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地通道「装不下／卡被占」（本地 503）判定与处置（契约 v1.1 §4.4）。

本模块只做四件事，全部无副作用（除 §2.7 的进程内冷却表）：
1. **认人**：判出哪些上游是本地通道（`is_private_base_url`／`local_upstreams`／`host_id_for`）；
2. **认故障**：把本地上游的 503/507（或带显存关键词的 500）归成
   `code=local_vram_insufficient` ＋ `reason∈{vram_insufficient, card_busy}`（契约 §4.4.2 固定
   code、§4.4.5 用 reason 区分），并尽量取出 need/free MiB（`classify`）；
3. **守口径**：`X-Route-Wait-Local` / `X-Route-Allow-Cloud` 两个调用方开关，
   以及结构化错误体（`error_body`）；
4. **同宿主冷却 ＋ 等卸载后只重试一次**（`note_host_down`／`host_down`／
   `wait_for_retry_ready`）。

硬纪律（规格 §0／§2）：
- 只用标准库，不联网、不写盘、不 import main（避免循环依赖）；
- `occupancy_host` **只在 `wait_for_retry_ready` 内懒 import**，导入失败按「无信号」
  处理（返回 `(False, None)`），绝不让本模块 import 挂掉；
- 绝不驱动卸载、不调外部命令（卸载由宿主做）；
- 上游原文只进账本备核，不进响应（`raw` ≤300 字符）。

对应规格：内部接口规格 §0 ＋ §2 全部。
"""

from __future__ import annotations

import ipaddress
import logging
import re
import threading
import time
from urllib.parse import urlsplit

LOG = logging.getLogger("router.local_unavailable")

# ---------------------------------------------------------------------------
# 2.1 常量
# ---------------------------------------------------------------------------

LOCAL_UNAVAILABLE = "local_unavailable"
CODE_VRAM = "local_vram_insufficient"
CODE_CARD_BUSY = "card_busy"
REASON_VRAM = "vram_insufficient"
REASON_BUSY = "card_busy"
WAIT_LOCAL_HEADER = "X-Route-Wait-Local"
ALLOW_CLOUD_HEADER = "X-Route-Allow-Cloud"   # 按契约约定（契约只说"调用方显式允许"）
MAX_WAIT_SECONDS = 20.0
LOCAL_HOST_COOLDOWN_SECONDS = 60.0
ERROR_STATUS = 503

# 上游原文进账本时的截断长度（规格 §2.3：raw ≤300 字符，只备核不进响应）
RAW_MAX_CHARS = 300

# 契约 §4.4.2 把 `code` 写死为 local_vram_insufficient；§4.4.5 规定「装不下」与「卡被占满」
# 的差别只在 free_mib／host_id 与展示用 reason ⇒ code 恒 CODE_VRAM，卡占用只在 reason 体现。
# CODE_CARD_BUSY 因此只作 reason 取值常量保留（不是 code）。

# ---------------------------------------------------------------------------
# 2.2 本地上游识别
# ---------------------------------------------------------------------------

# 显存类关键词：先看「有数字」的三条正则，再看有没有「显存特征词」
_RE_ZH_VRAM = re.compile(r"显存不足\s*(\d+)\s*/\s*(\d+)")
_RE_MIB_PAIR = re.compile(r"(\d+)\s*MiB\s*/\s*(\d+)\s*MiB", re.IGNORECASE)
_RE_NEED_FREE = re.compile(r"need\s*(\d+).*?free\s*(\d+)", re.IGNORECASE | re.DOTALL)
# 只认「显存/VRAM/OOM/out of memory/insufficient」这类本地特征词；不把 memory 单词
# 单独当特征（会把普通 500 的 "memory leak" 类报错误判成装不下）
_RE_VRAM_WORDS = re.compile(r"显存|vram|out of memory|\boom\b|insufficient", re.IGNORECASE)
# 卡被占用类关键词（契约 §4.4.5：与装不下同用一条链，只差 reason）
_RE_BUSY_WORDS = re.compile(r"busy|卡被占用|满载|queue full|排队", re.IGNORECASE)
# 二进制响应体不做正文正则（省得在 jpeg 里碰运气），但仍按状态码走 ④ 保底
_BINARY_CONTENT_PREFIXES = ("image/", "audio/", "video/", "application/octet-stream")


def _header_value(headers, name: str) -> str | None:
    """大小写不敏感地取一个响应头值（dict 或 (k, v) 列表都认）。"""
    if headers is None:
        return None
    want = str(name).strip().lower()
    if isinstance(headers, dict):
        for key, value in headers.items():
            if str(key).strip().lower() == want:
                return None if value is None else str(value)
        return None
    try:
        pairs = list(headers)
    except TypeError:
        return None
    for pair in pairs:
        try:
            key, value = pair
        except (TypeError, ValueError):
            continue
        if str(key).strip().lower() == want:
            return None if value is None else str(value)
    return None


def _netloc_host(url: str) -> str:
    """从 base_url 里抠出主机名：去 userinfo、去端口、IPv6 去方括号、去尾点。"""
    if url is None:  # None 不能落到 "none" 这种裸主机名判定上
        return ""
    raw = str(url).strip().lower()
    if not raw:
        return ""
    if "://" in raw:
        netloc = urlsplit(raw).netloc
    else:  # 裸写 "192.168.1.7:8080/v1" / "ollama:11434" 也认
        netloc = raw.split("/", 1)[0]
    if not netloc:
        return ""
    host = netloc.rsplit("@", 1)[-1]
    if host.startswith("["):
        end = host.find("]")
        host = host[1:end] if end > 0 else host[1:]
    elif host.count(":") == 1:  # 只有一段冒号才当端口，别的当裸 IPv6
        host = host.split(":", 1)[0]
    return host.strip().rstrip(".")


def is_private_base_url(url: str) -> bool:
    """判断 base_url 是否指向本地/局域网通道。

    认：127.0.0.0/8、localhost、::1、10/8、172.16/12、192.168/16、`.local` 后缀、
    裸主机名（无点，如 `ollama`／`litellm`）、IPv6 回环与 ULA、链路本地、`0.0.0.0`。
    不认：公网域名（`api.provider-a.example.com`）、公网 IPv4（`8.8.8.8`）、172.16/12 之外的
    172.x（如 `172.32.1.1`）。空串/None/无法解析 ⇒ `False`（宁可不认本地，误判云端
    的代价更大）。
    """
    host = _netloc_host(url)
    if not host:
        return False
    if host == "localhost" or host.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        return bool(ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_unspecified)
    return "." not in host  # 裸主机名一律视为内网（需解析才知道，按本地优先）


def _field(item, name: str):
    """从 dict 或对象里取值（main 直传 Upstream 对象，配置里是 dict）。"""
    if isinstance(item, dict):
        return item.get(name)
    return getattr(item, name, None)


def _entries(upstreams) -> list:
    """把上游清单摊平：list[dict|obj]，或 upstreams.json 那种 {"upstreams": [...]}。"""
    if upstreams is None:
        return []
    if isinstance(upstreams, dict):
        inner = upstreams.get("upstreams")
        return list(inner) if isinstance(inner, (list, tuple)) else []
    try:
        return list(upstreams)
    except TypeError:
        return []


def _routing_section(routing, key: str):
    """取 routing 里的一个子节（routing 可能是 dict，也可能被包成对象）。"""
    section = _field(routing, key)
    return section if isinstance(section, dict) else None


def local_upstreams(upstreams, routing: dict | None = None) -> set[str]:
    """返回本地上游 id 集合；判定顺序：显式 `local` 布尔 > `routing.local.upstreams` 名单 > URL。

    `upstreams` 支持 `[{"id","base_url","local"(可选)}]`、带 `.id/.base_url` 属性的对象
    列表，或 `{"upstreams": [...]}` 整份配置。**不需要改生产配置**：这些键不存在
    就退到 URL 判定。
    """
    local_cfg = _routing_section(routing, "local")
    listed = local_cfg.get("upstreams") if local_cfg else None
    named = {str(x) for x in listed} if isinstance(listed, (list, tuple, set)) else set()

    result: set[str] = set()
    for item in _entries(upstreams):
        up_id = _field(item, "id")
        up_id = "" if up_id is None else str(up_id)
        if not up_id:
            continue
        explicit = _field(item, "local")
        if isinstance(explicit, bool):  # 显式布尔最硬：False 也不许 URL 翻案
            if explicit:
                result.add(up_id)
            continue
        if up_id in named:
            result.add(up_id)
            continue
        base_url = _field(item, "base_url")
        if is_private_base_url("" if base_url is None else str(base_url)):
            result.add(up_id)
    return result


def host_id_for(upstream_id: str, routing: dict | None = None) -> str:
    """上游 id → 宿主 id：`routing.local.host_ids[<upstream_id>]` 优先，缺省即上游 id。"""
    local_cfg = _routing_section(routing, "local")
    mapping = local_cfg.get("host_ids") if local_cfg else None
    if isinstance(mapping, dict):
        mapped = mapping.get(str(upstream_id))
        if isinstance(mapped, str) and mapped.strip():
            return mapped.strip()
        if isinstance(mapped, (int, float)) and not isinstance(mapped, bool):
            return str(mapped)
    return str(upstream_id)


# ---------------------------------------------------------------------------
# 2.3 故障归类
# ---------------------------------------------------------------------------


def _decode_body(body) -> str:
    """响应体转文本：bytes/str 都认，None ⇒ 空串，非法字节 replace。"""
    if body is None:
        return ""
    if isinstance(body, str):
        return body
    if isinstance(body, (bytes, bytearray)):
        return bytes(body).decode("utf-8", "replace")
    return str(body)


def _int_header(headers, name: str) -> int | None:
    """取整数响应头；非整数/负数 ⇒ None（不猜）。"""
    value = _header_value(headers, name)
    if value is None:
        return None
    text = value.strip()
    if not re.fullmatch(r"[+-]?\d+", text):
        return None
    number = int(text)
    return number if number >= 0 else None


def classify(status: int, body: bytes | None, headers: dict | None,
             content_type: str = "") -> dict | None:
    """把本地通道失败归成「装不下／卡被占」，非本地特征一律 `None`。

    触发：`status in (503, 507)`；或 `status == 500` 且正文命中显存/占用关键词
    （保守，普通 500 正文无关键词 ⇒ `None`）。500 只要带了 `x-vram-need-mib`／
    `x-vram-free-mib` 也认（头本身就是宿主自报的硬信号）。

    返回：
        {"code", "reason", "need_mib", "free_mib", "evidence", "raw"}
    其中 `evidence` ∈ {"header","body","none"}，`raw` 为上游原文去空白后 ≤300 字符
    （只进账本，不进响应）。
    """
    text = _decode_body(body).strip()
    need_header = _int_header(headers, "x-vram-need-mib")
    free_header = _int_header(headers, "x-vram-free-mib")
    header_hit = need_header is not None or free_header is not None
    vram_word = bool(_RE_VRAM_WORDS.search(text))
    busy_word = bool(_RE_BUSY_WORDS.search(text))

    if status in (503, 507):
        pass  # 状态码本身即本地通道失败，照规格 ④ 保底归类
    elif status == 500:
        if not (vram_word or busy_word or header_hit):
            return None
    else:
        return None

    need_mib: int | None = None
    free_mib: int | None = None
    evidence = "none"

    if header_hit:
        need_mib, free_mib = need_header, free_header
        evidence = "header"
    elif not str(content_type or "").strip().lower().startswith(_BINARY_CONTENT_PREFIXES):
        match = _RE_ZH_VRAM.search(text) or _RE_MIB_PAIR.search(text) or _RE_NEED_FREE.search(text)
        if match is not None:
            need_mib, free_mib = int(match.group(1)), int(match.group(2))
            evidence = "body"

    # 卡被占用的判据：命中 busy 词且**未**命中显存词、也没有取到显存数字
    # 契约 §4.4.2 的 code 写死 local_vram_insufficient；§4.4.5 的区分靠 reason（控制台展示用）
    if (busy_word and not vram_word and not header_hit
            and need_mib is None and free_mib is None):
        reason = REASON_BUSY
    else:
        reason = REASON_VRAM
    code = CODE_VRAM

    return {
        "code": code,
        "reason": reason,
        "need_mib": need_mib,
        "free_mib": free_mib,
        "evidence": evidence,
        "raw": text[:RAW_MAX_CHARS],
    }


# ---------------------------------------------------------------------------
# 2.4 / 2.5 调用方开关
# ---------------------------------------------------------------------------


def wait_seconds(headers: dict | None) -> float:
    """取 `X-Route-Wait-Local`：缺省/空/非法/≤0 ⇒ `0.0`（默认关），超过 20 ⇒ 截到 20。"""
    value = _header_value(headers, WAIT_LOCAL_HEADER)
    if value is None:
        return 0.0
    text = value.strip()
    if not text:
        return 0.0
    try:
        seconds = float(text)
    except (TypeError, ValueError):
        return 0.0
    if seconds != seconds or seconds <= 0:  # NaN / 非正数
        return 0.0
    if seconds > MAX_WAIT_SECONDS:
        return MAX_WAIT_SECONDS
    return seconds


def allow_cloud(headers: dict | None) -> bool:
    """取 `X-Route-Allow-Cloud`：∈{1,true,yes,on}（大小写不敏感）⇒ True，默认 False。"""
    value = _header_value(headers, ALLOW_CLOUD_HEADER)
    if value is None:
        return False
    return value.strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# 2.6 结构化错误体
# ---------------------------------------------------------------------------


def _opt_int(value) -> int | None:
    """数字转 int，None/布尔/NaN/非数字 ⇒ None（0 只表示真的 0）。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if value != value:  # NaN
            return None
        return int(value)
    return None


def error_body(model: str, host_id: str, info: dict, fallback: str | None = None) -> dict:
    """按契约 §4.4.2 拼结构化错误体（HTTP 503，字段名严格照契约）。

    `info` 取 `classify()` 的返回；缺项/为 None 时按 `CODE_VRAM` 保底，绝不让响应
    缺字段（客户端要认 `type`／`code`／`retryable`）。缺数字时 message 省掉括号段。
    """
    info = info if isinstance(info, dict) else {}
    code = info.get("code") or CODE_VRAM
    reason = info.get("reason") or REASON_VRAM
    evidence = info.get("evidence") or "none"
    need_mib = _opt_int(info.get("need_mib"))
    free_mib = _opt_int(info.get("free_mib"))

    if need_mib is not None and free_mib is not None:
        detail = f"（need {need_mib} MiB / free {free_mib} MiB）"
    elif need_mib is not None:
        detail = f"（need {need_mib} MiB）"
    elif free_mib is not None:
        detail = f"（free {free_mib} MiB）"
    else:
        detail = ""

    if reason == REASON_BUSY:
        message = f"本地卡被占用{detail}，该宿主暂不可用"
    else:
        message = f"本地显存不足{detail}，该宿主暂不可用"

    return {
        "error": {
            "type": LOCAL_UNAVAILABLE,
            "code": code,
            "message": message,
            "model": model,
            "host_id": host_id,
            "need_mib": need_mib,
            "free_mib": free_mib,
            "retryable": False,
            "fallback": fallback if fallback else None,
            "reason": reason,
            "evidence": evidence,
            "status": ERROR_STATUS,
        }
    }


# ---------------------------------------------------------------------------
# 2.7 同宿主短路（进程内冷却表）
# ---------------------------------------------------------------------------

_STATE_LOCK = threading.Lock()
# host_id -> {"code": str, "until": float}
_HOST_DOWN: dict[str, dict] = {}


def _stamp(now: float | None) -> float:
    """统一「现在」：None ⇒ 真实时钟；否则注入值（便于单测，不依赖真实时钟）。"""
    return time.time() if now is None else float(now)


def note_host_down(host_id: str, code: str, now: float | None = None,
                   ttl: float = LOCAL_HOST_COOLDOWN_SECONDS) -> dict:
    """把该宿主登记进短冷却（冷却期内 main 跳过该宿主**所有**本地候选）。

    返回 `{"code", "until", "remaining_s"}`。同宿主重复登记取**更晚**的 until（不缩短
    已在生效的冷却）；`ttl <= 0` 不落表（等于立即过期）。空 host_id 不落表。
    """
    stamp = _stamp(now)
    span = float(ttl) if ttl is not None else LOCAL_HOST_COOLDOWN_SECONDS
    if span != span or span < 0:  # NaN / 负数
        span = 0.0
    record_code = str(code or CODE_VRAM)
    hid = "" if host_id is None else str(host_id)

    if not hid:
        return {"code": record_code, "until": stamp + span, "remaining_s": span}

    with _STATE_LOCK:
        prev = _HOST_DOWN.get(hid)
        if span <= 0:
            if prev is not None and prev["until"] > stamp:
                return {"code": str(prev["code"]), "until": float(prev["until"]),
                        "remaining_s": round(float(prev["until"]) - stamp, 3)}
            _HOST_DOWN.pop(hid, None)
            return {"code": record_code, "until": stamp, "remaining_s": 0.0}
        until = stamp + span
        if prev is None or float(prev["until"]) <= stamp or until > float(prev["until"]):
            _HOST_DOWN[hid] = {"code": record_code, "until": until}
        current = _HOST_DOWN[hid]
        return {"code": str(current["code"]), "until": float(current["until"]),
                "remaining_s": round(float(current["until"]) - stamp, 3)}


def host_down(host_id: str, now: float | None = None) -> dict | None:
    """查该宿主是否仍在冷却期：返回值或 `None`（未登记/已过期）；过期即清表。"""
    stamp = _stamp(now)
    hid = "" if host_id is None else str(host_id)
    if not hid:
        return None
    with _STATE_LOCK:
        record = _HOST_DOWN.get(hid)
        if record is None:
            return None
        until = float(record["until"])
        if stamp >= until:
            _HOST_DOWN.pop(hid, None)
            return None
        return {"code": str(record["code"]), "until": until,
                "remaining_s": round(until - stamp, 3)}


def reset_state() -> None:
    """清空冷却表（测试用；生产不调用）。"""
    with _STATE_LOCK:
        _HOST_DOWN.clear()


# ---------------------------------------------------------------------------
# 2.8 等宿主卸载后只重试一次
# ---------------------------------------------------------------------------


def _default_finder():
    """懒 import `occupancy_host` 取 `host_ready_for_retry`；不可用 ⇒ None（无信号）。

    模块文件可能比本文件晚落盘，所以**只在函数内 import**，且任何异常都吞掉——
    绝不能让「占用模块缺失」把本模块或网关请求带崩。
    """
    try:
        import occupancy_host  # noqa: PLC0415 —— 故意懒导入，避免硬依赖
    except Exception as exc:  # ImportError / 模块自身报错 都算无信号
        LOG.warning("等卸载重试：occupancy_host 不可用（%s: %s），按无信号处理",
                    type(exc).__name__, exc)
        return None
    finder = getattr(occupancy_host, "host_ready_for_retry", None)
    if not callable(finder):
        LOG.warning("等卸载重试：occupancy_host 无 host_ready_for_retry，按无信号处理")
        return None
    return finder


def _call_finder(finder, host_id: str, model: str, since_ms: int,
                 prev_mem_mib: float | None) -> tuple[bool, dict | None]:
    """调一次 finder 并归一成 `(ready, entry)`；finder 抛错 ⇒ 当「未就绪、无条目」。"""
    try:
        result = finder(host_id, model, since_ms, prev_mem_mib)
    except Exception as exc:
        LOG.warning("等卸载重试：finder 异常（%s: %s），按未就绪继续等",
                    type(exc).__name__, exc)
        return (False, None)
    if isinstance(result, tuple):
        if len(result) >= 2:
            return (bool(result[0]), result[1])
        if len(result) == 1:
            return (bool(result[0]), None)
        return (False, None)
    return (bool(result), None)


def wait_for_retry_ready(host_id: str, model: str, seconds: float, since_ms: int,
                         prev_mem_mib: float | None = None, *,
                         sleep=time.sleep, now_fn=time.time,
                         finder=None) -> tuple[bool, dict | None]:
    """等宿主腾出来，最多 `seconds` 秒，返回 `(ready, 最后一条占用条目)`。

    - `seconds <= 0` ⇒ 立即 `(False, None)`（默认关，不等待）；
    - 每轮调 `occupancy_host.host_ready_for_retry(host_id, model, since_ms, prev_mem_mib)`，
      以 `min(1.0, 剩余)` 分片 sleep，总时长 ≤ `seconds`；
    - `finder` 注入便于单测（签名同上四个位置参数，可返回 `(ready, entry)` 或布尔）；
    - `finder=None` 时懒 import `occupancy_host`，导入失败 ⇒ `(False, None)`（无信号）；
    - **不驱动卸载、不调外部命令**（卸载由宿主做）。
    """
    try:
        budget = float(seconds)
    except (TypeError, ValueError):
        return (False, None)
    if budget != budget or budget <= 0:  # NaN / 非正数
        return (False, None)

    probe = finder if finder is not None else _default_finder()
    if probe is None:
        return (False, None)

    now = float(now_fn())
    deadline = now + budget
    last_entry: dict | None = None
    last_now = now
    stalls = 0

    while True:
        ready, entry = _call_finder(probe, host_id, model, since_ms, prev_mem_mib)
        if entry is not None:
            last_entry = entry
        if ready:
            return (True, last_entry)

        now = float(now_fn())
        remaining = deadline - now
        if remaining <= 0:
            return (False, last_entry)
        if now <= last_now:
            # 假时钟不前进时的自保：不许空转到天荒地老
            stalls += 1
            if stalls > 3:
                LOG.warning("等卸载重试：时钟未前进（now_fn 恒为 %s），提前结束", now)
                return (False, last_entry)
        else:
            stalls = 0
        last_now = now
        step = min(1.0, remaining)
        if step <= 0:
            return (False, last_entry)
        sleep(step)
