#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地大WB驭档·模型智能换挡系统网关（OpenAI 兼容，单文件实现）。

接口
----
GET  /health                 健康检查（熔断 / 限频 / 最近错误）
GET  /v1/models              OpenAI 模型列表（auto / auto-fast / auto-strong，另列真实上游模型）
POST /v1/chat/completions    路由 + 转发；stream=true 时原样透传 SSE
POST /v1/completions         legacy completions，同样支持流式
GET  /v1/route/capabilities  hint 能力清单（契约 v1.0 §4：tiers / models / defaults / limits）
GET  /v1/route/occupancy     只读：网关视角 30s 窗口/按模型在飞数 ＋ 宿主视角上报（两列不混）
POST /v1/route/occupancy/report  宿主上报卡占用（契约 v1.1-d2 §4.3，push 通道；LAN 未通期走文件交换）
GET  /router/ledger?limit=N  最近 N 条判定账本
GET  /router/stats           各上游调用数/失败数/熔断/近 1 分钟速率/累计 token + hint 计数 + AFP 闸门计数
GET  /router/config          脱敏运行配置（只有密钥"是否已加载"，绝无密钥值）

hint 提示头（契约 v1.0）
--------------------------------------------------------------------
请求头 X-DSH-Route = base64(JSON{v, tier, model, stage, session, reason, confirm?})：
- v 主版本不符 / 头超 8KB / 解码失败 / 非法 JSON / reason 违纪 → 忽略＋计数 hint_invalid，默认路由 200；
- 提示永远不产生 4xx/5xx（只影响"选谁"，不影响"谁能连"）；
- 合法 hint 且 model 在能力清单且可用 → 用之（X-DSH-Route-Fallback: 0）；
  model 缺失/不在清单/不可用 → 按 tier 选档（Fallback: 1）；tier 也非法 → 默认路由；
- hint 只对虚拟模型（auto*）生效；请求体显式指定 upstream/model 时透传优先；
- 灰度开关 config/routing.json → hint.mode：record（默认，仅记录不执行）/ execute（执行），改后重启生效。

换挡守门（接口单 v1.0）
--------------------------------------------------------------------
请求头 X-DSH-Check = base64(JSON{prev:{tier,model,contextTokens,goalHash,ctxId},
next:{session,contextTokens,goalHash,ctxId,check:{goal,done,next,why,ctx}}})，
在确定生效提示头之前调用 checkSwitch(prev, next) 一次（仅换挡请求带此头）：
- allow → 按提示头执行；allow_with_count（对表五项有空）→ 照常执行，缺项数进账本（missing）；
- fallback（目标漂移/断崖/标识变）→ 提示头档位回落为 prev 上一档，reason 写回落原因；
- new_session（无 prev）→ 正常发；
- 上下文长度比 = 本次/上次，低于 0.8 判断崖（config 可配）；守门只做判定，
  不读配置运行态、不连上游、不持密钥、不阻塞请求，任何情况下不因守门结果报错。

路由流程
--------
1. 特征：估算输入 token、消息数、是否含图、是否带 tools、max_tokens、是否有 system；
2. 分级：L1 简单 / L2 普通 / L3 重（阈值见 config/routing.json）；
3. 时段：Asia/Shanghai，工作日 09:00-12:00、14:00-18:00 为高峰；
4. 查 routes[时段][级别]（含图片优先 image 规则）得到候选链；
5. 逐候选检查「熔断 / RPM / 能力 / 上下文」，失败切下一个，最多 max_attempts 次。

能力清单结构（capabilities v2，2026-11-13 变更）
----------------------------------------------
GET /v1/route/capabilities 的 models 由 **平铺字符串列表** 改为 **对象列表**，每个对象：
    id / provider / tier / context_window / max_tokens /
    modality（数组，如 ["text","vision"]）/
    price{currency, input_per_mtok{peak,offpeak}, output_per_mtok{peak,offpeak},
          cache_hit_input_per_mtok{peak,offpeak} | null}
- 取值只来自配置，不硬编码任何价格：先读 config/routing.json → capability_meta.models[<id>]，
  缺项再回落到 upstreams.json 的模型元数据（provider=上游 id、tier、context_window、
  max_tokens、modality 由 vision 推导）；两边都没有 ⇒ 输出 null（绝不填 0/假值）。
  price 只来自 capability_meta（没有就是 null，待后续填表）。
- 向后兼容开关：环境变量 ROUTER_CAPABILITIES_V2=0（也认 false/no/off，大小写不敏感）
  ⇒ 回到旧的平铺 models（纯字符串列表，旧调用方逐字节可用）；未设/其它值 ⇒ v2（默认）。
  开关按请求读环境变量，不用重启。
- 过渡字段：v2 返回里另带 models_legacy=[<id>...]（与旧 models 完全一致），
  供按字符串列表解析的调用方平滑迁移；v2 下旧的 models 不再可直接当字符串用。
- 契约主版本 v 不变（仍是 hint 契约版本），结构差异靠 models 元素类型区分。

占位接口 GET /v1/route/occupancy（只读，2026-11-13 新增；2026-11-14 按契约 v1.1-d2 §4.3 扩）
------------------------------------------------------------------------------------------
返回 {as_of, windows{active_30s, last_active_at}, by_model[{model, active_requests,
last_active_at}], gpu{reported_by, util, mem_used_mib, note, host_id?, reported_at?, fresh?},
host_view{as_of, fresh_seconds, sources, fresh_count, stale_count, items[], ...}}。
- `windows`/`by_model`/`by_model[].active_requests` ＝ **网关视角**（本进程三个计时点，
  请求进入 _occ_begin / 换候选 _occ_bind / 结束 _occ_end），不读账本文件、不连上游、
  不碰熔断与 AFP 闸门。
- `host_view` ＝ **宿主视角**（宿主 push 到 /v1/route/occupancy/report，或 LAN 未通期由宿主
  写 json、网关按 mtime 轮询 ≤30s 的文件交换通道）。两列并排**不合并成一个数**。
- 显存单位统一 **MiB**、字段名统一 `mem_used_mib`（v1.1 由 `mem_used_mb` 改名；输入端保留
  一个版本期的兼容读入：宿主仍发 `mem_used_mb` 时按同口径 MiB 收下并标 compat）。
- 新鲜度：`reported_at`（宿主 epoch **毫秒**）距今 > 30s 记过期，**只展示、不参与任何判断**
  （含停卡提示与等卸载重试）；缺必填项的上报整条拒收（进 rejected）。
- `preemptible` 只作提示与排序，不驱动任何动作；硬约束 `preemptible=true ⇒ active_requests=0`，
  冲突时以 active_requests 为准并记 `conflicts=["preemptible_conflict"]`（控制台标红）。

本地 503（契约 v1.1-d2 §4.4，2026-11-14 新增）
--------------------------------------------
- 本地候选回 503/507（或含显存关键词的 500）⇒ **不重试同一宿主**（该宿主其余本地候选一并
  跳过，按「该宿主该档不可用」置短冷却 `LOCAL_HOST_COOLDOWN_SECONDS`）；
- **不回裸 503**：统一结构化错误体 type=local_unavailable / code=local_vram_insufficient
  （或 card_busy），带 model/host_id/need_mib/free_mib/retryable=false/fallback（云端同档 id 建议值）；
  上游原文截断 300 字进账本 attempts[].local.raw 备核（不进响应）；
- 默认**不转云**、不卸卡；调用方带 `X-Route-Allow-Cloud: 1` 且候选阶梯里本就有云端同档才继续；
- `X-Route-Wait-Local=<秒>`（上限 20，默认关）⇒ 读占用快照等宿主卸完（卸载由宿主做，网关不驱动），
  就绪后**只重试一次**，超时回同一结构化错误、不换第二家。

Token 估算
----------
输入 token ≈ ceil(字符数 / 2.2) + 图片数 × 1000。
字符数只统计正文文本、非 data:URL 的图片链接、tools/functions 定义；data:URL 图片按固定 1000 token 计。
仅用于分级，不用于计费。

安全
----
密钥从部署目录的凭据文件（.credentials.yaml）的 refs 节点读取（环境变量同名优先），只在内存中使用；
日志、账本、接口都不输出密钥；账本只记长度类特征，不记录任何请求正文。

入口鉴权（可选，默认关）
------------------------
环境变量 ROUTER_API_KEY 为空/未设 ⇒ 不做任何鉴权（历史行为逐字节不变，靠网络边界：
只绑 127.0.0.1）；设置为非空值 ⇒ 除 GET /health（存活探针）外所有请求必须带
Authorization: Bearer <ROUTER_API_KEY>，否则 401（错误体 error.code=unauthorized、
error.reason 为机器可读原因；带 WWW-Authenticate）。密钥按请求读环境变量，比较用
hmac.compare_digest；密钥值不进日志/账本/接口。

AFP 感知分流（2026-11-12 管理员 17:0x 反馈①：火山 429 治理）
----------------------------------------------------------
背景：ark-agentplan 按 AFP 燃料值限额（5h 1万 / 7天 3.5万 / 月 10万，缓存命中全额
计费）。大请求（est 15 万 tokens ≈ 200+ AFP）把窗口余额瞬间打穿 ⇒ HTTP 429 ⇒
熔断 600s 常开循环（skip:circuit_open），火山全链路 0 成功。机制：
1. 配置 afp.enabled=true 时，对 afp.upstream（默认 ark-agentplan）在候选检查最前
   加一道闸门 afp_gate_check()：
   - 额度快照（`afp.quota_path` 指定的 JSON，采集器周期写入）读不到或过期
     （> stale_after_seconds）⇒ 闸门放行（保守＝维持现状，读不到≠拒绝）；
   - 三窗口（h5/d7/d30）取最紧余额 avail=min(limit-used)（下夹 0）：
     avail<=0 ⇒ skip:afp_exhausted（含周/月额度打穿——429 同码不同文案，控制台读数为准）；
     est_afp = est_input_tokens × rate_per_token ≤ min_charge_afp（小额，默认 1 AFP）
       ⇒ 放行（小额请求保持火山优先，把月包吃满）；
     est_afp > avail × (1-reserve) ⇒ skip:afp_would_exceed（大请求不硬挤，余额留给小请求）；
   - 被闸门跳过的候选只记 attempts[].error=skip:*，**不 note_failure、不开熔断**——
     下一轮采集读到余额恢复即自动回探（闸门每请求重查快照，mtime 变更才重读文件）。
2. rate_per_token 标定（2026-11-12，ledger 11-11 06:23–11:23 窗口）：控制台 5h 读数
   2991.709 AFP ↔ 网关成功 22,736,590 tokens（未命中 301,770＋缓存命中 22,394,496＋
   输出 40,324）⇒ 0.0013210 AFP/token；同窗 est 口径 0.0002427 AFP/est_token。
   取实际值口径（est 只是代理；est/actual p50≈0.54、长会话最大 2.32，闸门用
   est×实际折算率已含安全边际，另有 reserve 再留 10%）。
   注意：周/月额度同时受网关外消费者影响（DSH provider 直连 ark-agentplan、200 侧
   ccr 等），所以快照必须以控制台读数为准、不做本地累加。
3. 429 熔断时长单独调短（可配 afp.breaker_429_seconds，默认 300s < breaker.default
   600s）；429 响应体若带 "It will reset at <时间>"（AccountQuotaExceeded），按重置
   时刻精确冷却（夹在 1min~6h）。

启动
----
    cd ~/wb-router && python3 main.py
固定监听 127.0.0.1:18790。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib import error as urlerror
from urllib import parse as urlparse_mod
from urllib import request as urlrequest

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None  # type: ignore

try:
    import requests

    _HAS_REQUESTS = True
except ImportError:  # pragma: no cover
    requests = None  # type: ignore
    _HAS_REQUESTS = False

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None  # type: ignore

# 契约 v1.1-d2 两份实现（同目录、纯标准库、不 import main，避免循环依赖）：
#   occupancy_host     — 宿主上报归一/新鲜度/两视角分开/文件交换通道（§4.3）
#   local_unavailable  — 本地 503 结构化错误/同宿主短路/等卸载重试（§4.4）
import local_unavailable as local_unavail
import occupancy_host as occ_host
import price_resolver
import price_state  # 价格三态单一真源
import admin_ui
import router_strategies as rstrat
import router_shadow
import api_keys
import router_plan
admin_ui.set_gateway(sys.modules[__name__])  # 脚本以 __main__ 运行；避免 import main 得到第二份模块实例
rstrat.set_gateway(sys.modules[__name__])
router_plan.set_gateway(sys.modules[__name__])

# ---------------------------------------------------------------------------
# 路径 / 常量
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
api_keys.set_base(BASE_DIR)
CONFIG_DIR = BASE_DIR / "config"
DATA_DIR = Path(os.environ.get("ROUTER_DATA_DIR") or (BASE_DIR / "数据")).expanduser()
LEDGER_PATH = DATA_DIR / "ledger.jsonl"
CREDENTIALS_PATH = Path(
    os.environ.get("ROUTER_CREDENTIALS_PATH") or str(BASE_DIR / ".credentials.yaml")
).expanduser()
# 管理界面新增/修改的密钥只写这里（600），不碰主凭据文件；同名 key 覆盖主 refs。
EXTRA_CREDENTIALS_PATH = Path(
    os.environ.get("ROUTER_CREDENTIALS_EXTRA_PATH")
    or (CONFIG_DIR / "credentials.local.yaml")
).expanduser()

# 端口可用环境变量覆盖（默认不变）；仅用于隔离联调/测试实例，生产行为不变
HOST = os.environ.get("ROUTER_HOST") or "127.0.0.1"
PORT = int(os.environ.get("ROUTER_PORT") or 18790)
MAX_BODY_BYTES = 64 * 1024 * 1024  # 允许带大图/长上下文

# --- 入口鉴权（可选，默认关）-------------------------------------------------
# ROUTER_API_KEY 未设/空串 ⇒ 不鉴权（默认，行为与历史一致，靠网络边界）；
# 设为非空 ⇒ 除 AUTH_EXEMPT_PATHS 外都要 Authorization: Bearer <key>。
AUTH_ENV = "ROUTER_API_KEY"
AUTH_EXEMPT_PATHS = frozenset({"/health"})  # 存活探针（supervisor/巡检/启动等待都探它）
# ── Q3-1（2026-11-18）：只接受 POST 的路径。GET 命中时回 JSON 405，
#    不再落 404「未知接口」（旧行为会让排障者以为路由没部署）。
POST_ONLY_PATHS = frozenset({
    "/v1/route/plan", "/v1/route/annotation", "/v1/route/occupancy/report",
    "/v1/chat/completions", "/v1/completions", "/v1/embeddings", "/v1/rerank",
})
# Q3-1：错误信封默认值（status -> (type, code)）；网关自产错误一律走这套。
_STATUS_ERROR_DEFAULTS = {
    400: ("invalid_request_error", "bad_request"),
    401: ("authentication_error", "unauthorized"),
    403: ("permission_error", "forbidden"),
    404: ("not_found_error", "not_found"),
    405: ("method_not_allowed", "method_not_allowed"),
    409: ("conflict_error", "conflict"),
    413: ("payload_too_large", "payload_too_large"),
    422: ("invalid_request_error", "unprocessable_entity"),
    429: ("rate_limit_error", "rate_limited"),
    500: ("internal_error", "internal_error"),
    502: ("upstream_error", "upstream_error"),
    503: ("service_unavailable", "service_unavailable"),
}
# Q3-1：canonical type 集合（旧调用点传简称时归一到这里）
_CANONICAL_ERROR_TYPES = frozenset({t for t, _ in _STATUS_ERROR_DEFAULTS.values()})
# Q3-1：上游错误归类（保留原始报文到 detail，不丢证据也不直接甩英文给调用方）
_UPSTREAM_ERROR_HINTS = (
    (("context_length", "context window", "too long", "maximum context"), "上下文超过模型上限"),
    (("rate limit", "rate_limit", "too many requests", "429"), "上游限流"),
    (("invalid api key", "incorrect api key", "unauthorized", "401"), "上游鉴权失败"),
    (("insufficient", "quota", "balance", "余额"), "上游额度/余额不足"),
    (("model not found", "does not exist", "unknown model", "404"), "上游没有该模型"),
    (("timeout", "timed out", "deadline"), "上游超时"),
    (("overloaded", "server error", "internal", "5xx"), "上游内部错误"),
)


def classify_upstream_error(status: int, code: str = "", message: str = "", raw_text: str = "") -> str:
    """Q3-1：把上游错误归成一句中文（保留 code；原始报文另放 detail）。"""
    hay = f"{code} {message} {raw_text[:1200]}".lower()
    for keys, zh in _UPSTREAM_ERROR_HINTS:
        if any(k in hay for k in keys):
            return zh
    if status == 429:
        return "上游限流"
    if status in (401, 403):
        return "上游鉴权失败"
    if status == 404:
        return "上游没有该模型/接口"
    if status == 408:
        return "上游超时"
    if status >= 500:
        return "上游内部错误"
    return f"上游返回 HTTP {status}"
AUTH_REASONS = {
    "disabled": "未启用入口鉴权（未设置 ROUTER_API_KEY）",
    "exempt": "该路径免鉴权",
    "ok": "鉴权通过",
    "missing_authorization": "缺少 Authorization 头",
    "bad_scheme": "Authorization 必须是 Bearer <key> 形式",
    "invalid_key": "API key 不匹配",
}
TAIL_BUFFER_BYTES = 256 * 1024  # 流式尾部缓冲，只用于提取 usage，不落盘
START_TS = time.time()
# L5 ②（2026-11-20）：进程启动时刻的显式别名。routing.json → capability_meta.models 是
# **启动时一次性进内存**的；用它与 routing.json 的 mtime 比，就能看出内存缓存是否已过期。
PROC_START = START_TS
# Q3-2：listen backlog 生效值。源码原意 64 但写在 ThreadingHTTPServer(...) 之后（__init__ 内
# 已 listen）⇒ 实际一直是默认 5。改为子类类属性，并在 /health 暴露真实值供核对。
LISTEN_BACKLOG = 128
LOG = logging.getLogger("router")

_TOTAL = {"requests": 0, "successes": 0, "failures": 0, "rejected": 0,
          "tokens_prompt": 0, "tokens_completion": 0}
_TOTAL_LOCK = threading.Lock()

# ── Q2-4（2026-11-18）：对外开放的两个安全阀（外网经 gateway-proxy 进来）────────
# ① per-key rpm：api_keys 签发时已有 rpm 字段但从未生效；对外开放前必须落地。
# ② 失败鉴权轻量节流：同一来源+同一 token 连续失败达阈值 ⇒ 429，避免重试风暴。
# 两者均为进程内内存，不写盘；重启清零。
_KEY_RPM_LOCK = threading.Lock()
_KEY_RPM: dict[str, list[float]] = {}
_AUTH_FAIL_LOCK = threading.Lock()
_AUTH_FAIL: dict[str, list[float]] = {}
_KEY_RPM_WINDOW = 60.0
_AUTH_FAIL_WINDOW = 60.0
_AUTH_FAIL_LIMIT = int((os.environ.get("ROUTER_AUTH_FAIL_LIMIT") or "20").strip() or 20)


def key_rpm_check(principal: dict | None) -> tuple[bool, int]:
    """per-key rpm 滑动窗口。返回 (allowed, retry_after_s)。rpm<=0 视为不限。"""
    if not isinstance(principal, dict):
        return True, 0
    try:
        rpm = int(principal.get("rpm") or 0)
    except (TypeError, ValueError):
        rpm = 0
    if rpm <= 0:
        return True, 0
    key_id = str(principal.get("id") or principal.get("name") or "unknown")
    now = time.time()
    with _KEY_RPM_LOCK:
        window = _KEY_RPM.setdefault(key_id, [])
        while window and now - window[0] > _KEY_RPM_WINDOW:
            window.pop(0)
        if len(window) >= rpm:
            retry = max(1, int(_KEY_RPM_WINDOW - (now - window[0])) + 1)
            return False, retry
        window.append(now)
        return True, 0


# ── B5 只读兼容入口（1.0.3.2 T6，默认关）────────────────────────────────────
# 口径：/v1/chat/completions 带 X-WB-Route-Mode: passthrough 且 key 显式开通才生效；
#      响应头回 X-WB-Model / X-WB-Strategy / X-WB-Usage-Kind；默认 0 命中（未开 ⇒ 403）。
B5_ENV = "ROUTER_B5_PASSTHROUGH"
B5_KEYS_ENV = "ROUTER_B5_PASSTHROUGH_KEYS"
B5_MODE_HEADER = "X-WB-Route-Mode"
B5_MODE_VALUE = "passthrough"


def b5_enabled() -> bool:
    raw = (os.environ.get(B5_ENV) or "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def b5_key_allowed(principal: dict | None) -> bool:
    """per-key 开通：principal.passthrough=true 或 env 白名单（id/name）。"""
    if not isinstance(principal, dict):
        return False
    if principal.get("passthrough") is True:
        return True
    allow = {item.strip() for item in (os.environ.get(B5_KEYS_ENV) or "").split(",") if item.strip()}
    if not allow:
        return False
    return str(principal.get("id") or "") in allow or str(principal.get("name") or "") in allow


def _auth_fail_key(addr: str, authorization: str | None) -> str:
    token = (authorization or "").strip()
    fp = hashlib.sha256(token.encode("utf-8")).hexdigest()[:16] if token else "none"
    return f"{addr}|{fp}"


def auth_fail_check(addr: str, authorization: str | None) -> int:
    """返回当前窗口内失败次数（超阈值由调用方决定 429）。"""
    k = _auth_fail_key(addr, authorization)
    now = time.time()
    with _AUTH_FAIL_LOCK:
        window = _AUTH_FAIL.setdefault(k, [])
        while window and now - window[0] > _AUTH_FAIL_WINDOW:
            window.pop(0)
        return len(window)


def auth_fail_record(addr: str, authorization: str | None) -> None:
    k = _auth_fail_key(addr, authorization)
    now = time.time()
    with _AUTH_FAIL_LOCK:
        window = _AUTH_FAIL.setdefault(k, [])
        while window and now - window[0] > _AUTH_FAIL_WINDOW:
            window.pop(0)
        window.append(now)
        if len(_AUTH_FAIL) > 5000:  # 防内存无界
            for old in list(_AUTH_FAIL.keys())[:1000]:
                _AUTH_FAIL.pop(old, None)


# ---------------------------------------------------------------------------
# 入口鉴权（可选，默认关）：判定是纯函数，便于单测；开关只看环境变量有无
# ---------------------------------------------------------------------------

def router_api_key() -> str:
    """当前生效的入口鉴权密钥；空串＝关闭鉴权（默认）。

    按请求读环境变量（不缓存）：测试/热注入友好；未设时逐请求开销仅一次
    os.environ.get，可忽略。密钥值只在本进程内存中用，绝不进日志/接口。
    """
    return (os.environ.get(AUTH_ENV) or "").strip()


def auth_enabled() -> bool:
    """入口鉴权是否生效（ROUTER_API_KEY 非空即开）。"""
    return bool(router_api_key())


def check_gate_auth(path: str, authorization: str | None, expected_key: str) -> dict:
    """入口鉴权判定（纯函数，无 I/O、不抛异常）。

    Args:
        path: 已归一化的请求路径（/health 等）。
        authorization: 原始 Authorization 请求头（可为 None）。
        expected_key: 期望密钥；空串表示鉴权关闭。

    Returns:
        {"enabled": bool, "allowed": bool, "reason": str}；reason 取值见 AUTH_REASONS。
        鉴权关闭时恒 allowed=True（reason=disabled）⇒ 历史行为零变化。
    """
    if not expected_key:
        return {"enabled": False, "allowed": True, "reason": "disabled"}
    if path in AUTH_EXEMPT_PATHS:
        return {"enabled": True, "allowed": True, "reason": "exempt"}
    raw = (authorization or "").strip()
    if not raw:
        return {"enabled": True, "allowed": False, "reason": "missing_authorization"}
    # RFC 7235：auth-scheme 大小写不敏感（Bearer / bearer 等价）
    scheme, _, token = raw.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        return {"enabled": True, "allowed": False, "reason": "bad_scheme"}
    matched = hmac.compare_digest(token.encode("utf-8"), expected_key.encode("utf-8"))
    return {"enabled": True, "allowed": matched, "reason": "ok" if matched else "invalid_key"}


def request_auth(path: str, authorization: str | None) -> dict:
    """P1 入口鉴权：优先 per-client API key；否则沿用旧的单 key 可选闸门。

    返回 {"enabled","allowed","reason","principal"}；admin/health 免。
    """
    if path in AUTH_EXEMPT_PATHS:
        return {"enabled": False, "allowed": True, "reason": "exempt", "principal": None}
    if api_keys.required():
        token = (authorization or "").strip()
        info = api_keys.verify(authorization)
        if info is not None:
            return {"enabled": True, "allowed": True, "reason": "api_key", "principal": info}
        reason = "missing_authorization" if not token else "invalid_key"
        return {"enabled": True, "allowed": False, "reason": reason, "principal": None}
    legacy = check_gate_auth(path, authorization, router_api_key())
    return {**legacy, "principal": ({"id": "legacy", "name": "legacy", "scopes": ["plan", "chat"]}
                                    if legacy.get("allowed") else None)}


def require_scope(principal: dict | None, scope: str) -> bool:
    if not isinstance(principal, dict):
        return False
    scopes = principal.get("scopes") or []
    return scope in scopes


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

def _read_json(path: Path) -> dict:
    try:
        with path.open("r", encoding="utf-8") as fp:
            return json.load(fp)
    except FileNotFoundError as exc:
        raise SystemExit(f"缺少配置文件：{path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"配置文件 JSON 语法错误：{path}：{exc}") from exc


@dataclass
class Upstream:
    """上游通道定义（不含密钥）。"""

    id: str
    label: str
    base_url: str
    api_key_env: str
    max_rpm: int = 50
    dsh_only: bool = False
    models: dict[str, dict] = field(default_factory=dict)

    def model_spec(self, model_id: str) -> dict:
        return self.models.get(model_id) or {}


def _load_upstreams(doc: dict) -> list[Upstream]:
    result: list[Upstream] = []
    for raw in doc.get("upstreams") or []:
        try:
            result.append(Upstream(
                id=str(raw["id"]),
                label=str(raw.get("label") or raw["id"]),
                base_url=str(raw["base_url"]).rstrip("/"),
                api_key_env=str(raw["api_key_env"]),
                max_rpm=int(raw.get("max_rpm") or 50),
                dsh_only=bool(raw.get("dsh_only") or False),
                models=dict(raw.get("models") or {}),
            ))
        except KeyError as exc:
            raise SystemExit(f"upstreams.json 缺少字段 {exc}：{raw}") from exc
    ids = [u.id for u in result]
    if not result or len(ids) != len(set(ids)):
        raise SystemExit("upstreams.json 无上游或存在重复 id")
    return result


CONFIG = _read_json(CONFIG_DIR / "routing.json")
UPSTREAMS = _load_upstreams(_read_json(BASE_DIR / "upstreams.json"))
UPSTREAM_MAP = {u.id: u for u in UPSTREAMS}

TZ_NAME = str(CONFIG.get("timezone") or "Asia/Shanghai")
TZ = ZoneInfo(TZ_NAME) if ZoneInfo else None  # type: ignore[assignment]
# Q3-12：SSE 是否用 chunked 定界（环境变量 ROUTER_STREAM_CHUNKED=0 或 config.stream.chunked=false 秒回退）
_STREAM_CHUNKED = (os.environ.get("ROUTER_STREAM_CHUNKED")
                   or str((CONFIG.get("stream") or {}).get("chunked", True))).strip().lower() \
    not in ("0", "false", "off", "no")
CHARS_PER_TOKEN = float(CONFIG.get("token_estimate", {}).get("chars_per_token", 2.2))
IMAGE_TOKENS = int(CONFIG.get("token_estimate", {}).get("image_tokens", 1000))
MAX_ATTEMPTS = max(1, int(CONFIG.get("max_attempts", 3)))
BREAKER = CONFIG.get("breaker", {})
BREAKER_SECONDS = int(BREAKER.get("default_seconds", 600))
AUTH_BREAKER_SECONDS = int(BREAKER.get("auth_seconds", 3600))
# AFP 感知分流（2026-11-12 管理员 17:0x 反馈①）：429（额度型限流）单独调短、可配
AFP_429_BREAKER_SECONDS = float((CONFIG.get("afp") or {}).get("breaker_429_seconds", 300))
TIMEOUTS = CONFIG.get("timeouts", {})
CONNECT_TIMEOUT = float(TIMEOUTS.get("connect_seconds", 10))
READ_TIMEOUT = float(TIMEOUTS.get("read_seconds", 180))
STREAM_TIMEOUT = float(TIMEOUTS.get("stream_seconds", 600))
STRIP_FIELDS = list(CONFIG.get("strip_fields_on_4xx") or [])

# ── 1.0.3.2 T1 / R4·R5 上下文治理（M1 估算器；只做加法，默认 shadow）────────────
# 口径：CHARS_PER_TOKEN(2.2) 与 est_input_tokens 一字不动（保档位/AFP/golden 不变）；
#       保守估算只走新函数，供预算/准入/可观测使用，是否影响决策由 mode 决定。
# 窗口值只读 upstreams.json（context_governor 块只放策略参数，不放窗口）。
CTX_GOV_ENV = "ROUTER_CTX_GOVERNOR"
_CTX_GOV_CONFIG = (CONFIG.get("context_governor")
                   if isinstance(CONFIG.get("context_governor"), dict) else {})
_CTX_GOV_DEFAULTS = {
    "mode": "shadow", "reserve_ratio": 0.2, "min_reserve_tokens": 1024,
    "min_budget_tokens": 256,
    "estimate": {"cjk_per_token": 1.0, "non_cjk_per_token": 4.0, "image_tokens": 1000},
    "local": {"mode": "off", "input_ratio": 0.25},
    "trim": {"enabled": False, "keep_recent_turns": 6, "keep_images": 2,
             "tool_result_max_chars": 8000, "max_trims": 2},
    "error": {"structured": True, "status": 400, "allow_413": False},
    "observability": {"headers": True},
}
_CTX_MODES = ("off", "shadow", "enforce")


def _deep_merge(base: dict, override: dict) -> dict:
    out = {}
    for key, value in (base or {}).items():
        if isinstance(value, dict):
            out[key] = _deep_merge(value, (override or {}).get(key) or {})
        else:
            out[key] = value
    for key, value in (override or {}).items():
        if key not in out:
            out[key] = value
        elif isinstance(out[key], dict) and not isinstance(value, dict):
            continue
        elif not isinstance(out[key], dict) and isinstance(value, dict):
            continue
        elif not isinstance(out[key], dict):
            out[key] = value
    return out


def ctx_gov_params() -> dict:
    """上下文治理参数（config 为底、env 可只覆盖 mode；非法 env ⇒ off 并告警）。"""
    params = _deep_merge(_CTX_GOV_DEFAULTS, _CTX_GOV_CONFIG)
    raw = (os.environ.get(CTX_GOV_ENV) or "").strip().lower()
    if raw in _CTX_MODES:
        params["mode"] = raw
    elif raw:
        LOG.warning("非法 %s=%r，回落 off（只保留旧行为）", CTX_GOV_ENV, raw)
        params["mode"] = "off"
    if params.get("mode") not in _CTX_MODES:
        params["mode"] = "shadow"
    return params


_CJK_RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF),
               (0x3040, 0x30FF), (0xAC00, 0xD7AF), (0x3000, 0x303F), (0xFF00, 0xFFEF))


def _is_cjk_char(ch: str) -> bool:
    code = ord(ch)
    return any(lo <= code <= hi for lo, hi in _CJK_RANGES)


def _text_char_split(value: Any) -> tuple[int, int]:
    """统计 CJK / 非 CJK 字符数（语义与 `_text_chars` 相同，只是拆开计数）。"""
    if value is None:
        return 0, 0
    if isinstance(value, str):
        cjk = sum(1 for ch in value if _is_cjk_char(ch))
        return cjk, len(value) - cjk
    if isinstance(value, list):
        cjk = other = 0
        for part in value:
            if isinstance(part, str):
                c, o = _text_char_split(part)
            elif isinstance(part, dict):
                if part.get("type") == "text":
                    c, o = _text_char_split(str(part.get("text") or ""))
                elif part.get("type") != "image_url":
                    c, o = 0, len(json.dumps(part, ensure_ascii=False))
                else:
                    c, o = 0, 0
            else:
                c, o = 0, len(json.dumps(part, ensure_ascii=False))
            cjk += c
            other += o
        return cjk, other
    raw = json.dumps(value, ensure_ascii=False)
    return _text_char_split(raw)


def context_tokens_estimate(features: "Features", params: dict | None = None) -> int:
    """保守上下文估算（CJK 1.0 / 非 CJK 4.0 / 图 1000）；不改 `est_input_tokens`。"""
    cfg = (params or ctx_gov_params()).get("estimate") or {}
    cjk = max(0, int(getattr(features, "cjk_chars", 0) or 0))
    other = max(0, int(getattr(features, "other_chars", 0) or 0))
    if cjk + other == 0 and int(getattr(features, "chars", 0) or 0) > 0:
        cjk = int(features.chars)          # 降级：没拆分数据 ⇒ 按全 CJK（宁严不松）
    per_cjk = float(cfg.get("cjk_per_token", 1.0)) or 1.0
    per_other = float(cfg.get("non_cjk_per_token", 4.0)) or 4.0
    image_tokens = int(cfg.get("image_tokens", IMAGE_TOKENS))
    tokens = math.ceil(cjk / per_cjk + other / per_other)
    return tokens + int(getattr(features, "image_count", 0) or 0) * image_tokens


def context_budget(window: int, max_tokens: int = 0, params: dict | None = None) -> dict:
    """预算对象（纯函数、每轮现算、无缓存）：窗口 − 余量；input_cap 再扣输出预算。"""
    cfg = params or ctx_gov_params()
    window = int(window or 0)
    output = max(0, int(max_tokens or 0))
    reserve = max(int(cfg.get("min_reserve_tokens", 1024)),
                  math.ceil(window * float(cfg.get("reserve_ratio", 0.2))))
    budget = window - reserve
    return {"window": window, "reserve": reserve, "output": output,
            "budget": budget, "input_cap": budget - output}


def context_verdict(upstream_id: str, model_id: str, features: "Features",
                    params: dict | None = None) -> dict:
    """上下文判定（band=pass|compress|reject|unknown；kind 细分原因）。

    窗口只读 upstreams.json；未声明 ⇒ unknown（放行，保留旧透传语义）。
    mode 不在这里决定"放不放"——那是 candidate_supported 的事；这里只给判定与数据。
    """
    cfg = params or ctx_gov_params()
    upstream = UPSTREAM_MAP.get(upstream_id)
    spec = upstream.model_spec(model_id) if upstream is not None else {}
    est = context_tokens_estimate(features, cfg)
    output = max(0, int(getattr(features, "max_tokens", 0) or 0))
    window = spec.get("context_window")
    if not (isinstance(window, int) and window > 0):
        return {"band": "unknown", "kind": "no_window", "window": None, "budget": None,
                "need": est + output, "est": est, "out": output, "reserved": None,
                "input_cap": None, "why": "候选未声明 context_window（放行）"}
    budget = context_budget(window, output, cfg)
    if budget["budget"] < int(cfg.get("min_budget_tokens", 256)):
        return {"band": "unknown", "kind": "budget_too_small", **budget,
                "need": est + output, "est": est, "out": output,
                "why": f"预算退化（budget={budget['budget']} < {cfg.get('min_budget_tokens')}），不判"}
    need = est + output
    local_cfg = cfg.get("local") or {}
    local_mode = str(local_cfg.get("mode") or "off").lower()
    is_local = upstream_id in local_upstream_ids()
    if is_local and local_mode != "off":
        cap = math.ceil(window * float(local_cfg.get("input_ratio", 0.25)))
        if est > cap:
            return {"band": "reject", "kind": "local_input_cap", **budget,
                    "need": need, "est": est, "out": output, "local_cap": cap,
                    "why": f"local_input_cap:est={est}>{cap}(W={window}×{local_cfg.get('input_ratio')})"}
    if output > budget["budget"]:
        return {"band": "reject", "kind": "output_reserve", **budget,
                "need": need, "est": est, "out": output,
                "why": f"output_reserve:out={output}>budget={budget['budget']}"}
    if est > budget["input_cap"]:
        return {"band": "reject", "kind": "input_overflow", **budget,
                "need": need, "est": est, "out": output,
                "why": f"input_overflow:est={est}>cap={budget['input_cap']}"
                       f"(W={window},rv={budget['reserve']},out={output})"}
    trim_cfg = cfg.get("trim") or {}
    if trim_cfg.get("enabled"):
        return {"band": "pass", "kind": "pass", **budget, "need": need,
                "est": est, "out": output, "why": "预算内"}
    return {"band": "pass", "kind": "pass", **budget, "need": need,
            "est": est, "out": output, "why": "预算内"}


def context_reject_info(attempts: list[dict]) -> dict | None:
    """从 attempts[].ctx_gov 里找第一条「上下文拒收」记录（enforce 下才有 reject）。"""
    for attempt in attempts or []:
        if not isinstance(attempt, dict):
            continue
        ctx_gov = attempt.get("ctx_gov")
        if isinstance(ctx_gov, dict) and ctx_gov.get("band") == "reject":
            return dict(ctx_gov)
    return None


def context_error_body(info: dict, params: dict | None = None) -> dict:
    """结构化超窗错误（默认 400；413 仅在 error.allow_413=true 时启用）。

    契约：code=context_window_exceeded，带 context 数值与三个可执行 options；
    只在"全部候选因上下文被拒"时使用，非上下文类错误完全不受影响。
    """
    cfg = (params or ctx_gov_params()).get("error") or {}
    status = 413 if cfg.get("allow_413") else int(cfg.get("status") or 400)
    kind = str(info.get("kind") or "input_overflow")
    window = info.get("window")
    budget = info.get("budget")
    need = info.get("need")
    reserved = info.get("reserved")
    if kind == "local_input_cap":
        message = (f"上下文超出本地模型输入上限（本轮 {need} > 本地上限，窗口 {window}）；"
                   f"可压缩历史、改用云端模型，或允许网关裁剪后重发")
    elif kind == "output_reserve":
        message = (f"max_tokens 预留吃光预算（out={info.get('out')} > budget={budget}，窗口 {window}）；"
                   f"请调小 max_tokens 或改用更大窗口的模型")
    else:
        message = (f"上下文超出可用预算（本轮 {need} > {info.get('input_cap')}，窗口 {window}，"
                   f"预留 {reserved}）")
    return {
        "error": {"message": message, "type": "invalid_request_error",
                  "code": "context_window_exceeded", "status": status},
        "context": {"window": window, "budget": budget, "reserved": reserved,
                    "need": need, "est": info.get("est"), "out": info.get("out"),
                    "input_cap": info.get("input_cap"), "kind": kind},
        "options": [
            {"id": "compact_context", "hint": "先压缩/摘要历史再发"},
            {"id": "raise_window", "hint": "改走窗口更大的模型/上游"},
            {"id": "enable_trim", "hint": "允许网关按最近 N 轮裁剪后重发"},
        ],
    }

_CONTEXT_ERROR_KEYWORDS = ("context_length_exceeded", "maximum context", "context window",
                           "context length", "too many tokens", "too long",
                           "上下文长度", "超出上下文", "上下文超限", "exceed context")


def is_context_error(status: int, body: bytes | str | None) -> bool:
    """上游 4xx 是否属于「上下文超长」类（规则 6-lite 的触发判据）。"""
    if status not in _CLIENT_ERROR_STATUSES:
        return False
    if isinstance(body, (bytes, bytearray)):
        text = bytes(body).decode("utf-8", "replace")
    else:
        text = str(body or "")
    low = text.lower()
    return any(key in low for key in _CONTEXT_ERROR_KEYWORDS)


def _trim_text(value, max_chars: int) -> tuple[object, bool]:
    """把单条字符串/多模态 part 的文本截断到 max_chars（图片 part 不截）。"""
    if not isinstance(value, str):
        return value, False
    if len(value) <= max_chars:
        return value, False
    return value[:max_chars] + "…[网关已截断]", True


def _drop_group(msgs: list, start: int) -> list:
    """从 start 起删掉一个「整轮」：user 消息 + 其后全部 assistant/tool 消息，直到下一个 user。"""
    end = start
    while end < len(msgs):
        role = (msgs[end].get("role") if isinstance(msgs[end], dict) else "") or ""
        if end > start and role in ("user", "system", "developer"):
            break
        end += 1
    return msgs[:start] + msgs[end:]


def trim_body(payload: dict, features: "Features",
              budget: dict | None = None, params: dict | None = None) -> tuple[dict, dict]:
    """规则 5 阶梯裁剪（纯函数，不抛）。只在调用方明确开启时使用。

    顺序：① tool 回显截断 → ② 丢最老整轮（system/developer 永不丢）→ ③ 图片只留最近 N 张。
    返回 (新 payload, stats)；未裁剪时 payload 内容逐字节不变（仅深拷贝）。
    """
    cfg = (params or ctx_gov_params()).get("trim") or {}
    stats = {"dropped_turns": 0, "dropped_images": 0, "truncated_tools": 0,
             "trimmed_chars": 0, "changed": False}
    import copy as _copy
    try:
        body = _copy.deepcopy(payload)
    except Exception:
        return payload, stats
    messages = body.get("messages")
    if not isinstance(messages, list):
        return payload, stats
    max_tool_chars = max(64, int(cfg.get("tool_result_max_chars") or 8000))
    keep_images = max(0, int(cfg.get("keep_images") or 0))
    # ① tool 回显截断：只截 role=tool 的 content（字符串）
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "tool":
            continue
        content = msg.get("content")
        new, cut = _trim_text(content, max_tool_chars)
        if cut:
            msg["content"] = new
            stats["truncated_tools"] += 1
            stats["trimmed_chars"] += len(content) - len(new)
    # ③ 图片只留最近 N 张（从后往前保留）
    seen = 0
    for msg in reversed(messages):
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for part in reversed(content):
            if isinstance(part, dict) and part.get("type") == "image_url":
                if seen >= keep_images:
                    part.clear()
                    part.update({"type": "text", "text": "[图片已裁剪]"})
                    stats["dropped_images"] += 1
                else:
                    seen += 1
    # ② 丢最老整轮（保留 system/developer 与最后一轮）
    def _est() -> int:
        try:
            return context_tokens_estimate(extract_features(body), params)
        except Exception:
            return 0
    cap = None
    if isinstance(budget, dict):
        cap = budget.get("input_cap")
    if cap is not None:
        guard = 0
        while _est() > cap and guard < 200:
            guard += 1
            # 找最老的非 system/user? 以 user 为整轮起点；跳过首个 system
            idx = None
            for i, msg in enumerate(messages):
                role = (msg.get("role") if isinstance(msg, dict) else "") or ""
                if role == "user" and i + 1 < len(messages):
                    idx = i
                    break
            if idx is None:
                break
            before = len(messages)
            messages = _drop_group(messages, idx)
            stats["dropped_turns"] += 1
            body["messages"] = messages
            if len(messages) == before:
                break
    stats["changed"] = bool(stats["dropped_turns"] or stats["dropped_images"]
                            or stats["truncated_tools"])
    stats["est_after"] = _est()
    return body, stats



PEAK_WEEKDAYS = set(int(d) for d in CONFIG.get("peak", {}).get("weekdays", [1, 2, 3, 4, 5]))


def _hhmm_to_minutes(text: str) -> int:
    hour, minute = str(text).split(":")[:2]
    return int(hour) * 60 + int(minute)


PEAK_WINDOWS = [
    (_hhmm_to_minutes(w[0]), _hhmm_to_minutes(w[1]))
    for w in CONFIG.get("peak", {}).get("windows", [])
]
VIRTUAL_MODELS: dict[str, dict] = dict(CONFIG.get("virtual_models") or {})
# 2026-11-17 四条策略虚拟模型（三策略改名＋新增推荐；策略文件由管理界面维护，网关按 mtime 热读）
# 注意：虚拟模型只用于模型网关与插件在后台识别、控制、调度，不在 DSH 前台输入框和模型管理中体现（约定）。
for _name, _desc in {
    "auto-cost": "价格优先策略：按档位走「价格优先」链（一般任务优先省钱）",
    "auto-capability": "能力优先策略：按档位走「最强组合」链（创意/思考，不计成本）",
    "auto-function": "预设功能：请求头 X-DSH-Route-Function 指定功能，路由到该功能的模型链",
    "auto-recommend": "推荐策略：结合单价与档位实时推荐；请求头 X-DSH-Route-Mode: price|capability|preset（默认 price）",
}.items():
    VIRTUAL_MODELS.setdefault(_name, {"description": _desc})
ROUTES: dict[str, dict] = dict(CONFIG.get("routes") or {})
STRATEGIES: dict[str, Any] = dict(CONFIG.get("strategies") or {})

_BREAKER_STATUSES = {402, 408, 429}
_CLIENT_ERROR_STATUSES = {400, 413, 422}

# 熔断时长边界：上游若回 Retry-After 就按它精确冷却（1 分钟~6 小时），否则用默认 600s
_COOLDOWN_MIN, _COOLDOWN_MAX = 60.0, 6 * 3600.0


def parse_retry_after(headers: dict | None) -> float | None:
    """从响应头取 Retry-After（秒数或 HTTP-date），取不到返回 None。"""
    if not headers:
        return None
    raw = None
    for k, v in headers.items():
        if str(k).lower() == "retry-after":
            raw = v
            break
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        seconds = float(text)
    except ValueError:
        # HTTP-date 形式
        try:
            from email.utils import parsedate_to_datetime
            when = parsedate_to_datetime(text)
            seconds = when.timestamp() - time.time()
        except Exception:
            return None
    if seconds <= 0:
        return None
    return max(_COOLDOWN_MIN, min(_COOLDOWN_MAX, seconds))


_QUOTA_RESET_RE = re.compile(
    rb"reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")


def parse_quota_reset_seconds(body: bytes | None, now: float | None = None) -> float | None:
    """从 429 响应体取额度重置时刻（火山 AccountQuotaExceeded：
    "It will reset at 2026-11-16 00:00:00 +0800 CST"）→ 冷却秒数。

    夹在 1min~6h；解析不出 / 已过期返回 None（调用方回落短熔断默认值）。
    只取时间字符串，不保留响应体其它内容。
    """
    if not body:
        return None
    m = _QUOTA_RESET_RE.search(body)
    if not m:
        return None
    try:
        moment = datetime.strptime(m.group(1).decode("ascii"), "%Y-%m-%d %H:%M:%S")
        if TZ:
            moment = moment.replace(tzinfo=TZ)
        seconds = moment.timestamp() - (now if now is not None else time.time())
    except Exception:
        return None
    if seconds <= 0:
        return None
    return max(_COOLDOWN_MIN, min(_COOLDOWN_MAX, seconds))


# ---------------------------------------------------------------------------
# 密钥（仅内存）
# ---------------------------------------------------------------------------

_SECRETS: dict[str, str] | None = None
_SECRET_ORIGIN: dict[str, str] = {}
_SECRETS_LOCK = threading.Lock()


def _read_refs_file(path: Path) -> dict[str, str]:
    """只读 refs 节点；失败返回 {}，不打印内容（避免敏感串进日志）。"""
    if yaml is None:
        LOG.error("PyYAML 不可用，无法读取凭据文件：%s", path)
        return {}
    try:
        with path.open("r", encoding="utf-8") as fp:
            doc = yaml.safe_load(fp) or {}
    except FileNotFoundError:
        return {}
    except Exception as exc:  # 不打异常串，避免带出敏感内容
        LOG.error("凭据文件解析失败：%s（%s）", path, type(exc).__name__)
        return {}
    raw_refs = doc.get("refs") if isinstance(doc, dict) else None
    if not isinstance(raw_refs, dict):
        return {}
    return {str(k): str(v) for k, v in raw_refs.items() if isinstance(v, str)}


def _load_secrets() -> dict[str, str]:
    """主凭据 refs ＋ 管理界面扩展凭据（后者覆盖前者）；环境变量由 get_secret 优先。"""
    global _SECRETS, _SECRET_ORIGIN
    with _SECRETS_LOCK:
        if _SECRETS is not None:
            return _SECRETS
        main_refs = _read_refs_file(CREDENTIALS_PATH)
        extra_refs = _read_refs_file(EXTRA_CREDENTIALS_PATH)
        merged = dict(main_refs)
        merged.update(extra_refs)
        origin = {k: "refs" for k in main_refs}
        origin.update({k: "admin" for k in extra_refs})
        _SECRETS = merged
        _SECRET_ORIGIN = origin
        LOG.info("凭据已加载：%d 个 ref（主 %d ＋ 管理端扩展 %d，仅内存）",
                 len(merged), len(main_refs), len(extra_refs))
        return merged


def reload_secrets() -> dict[str, str]:
    """管理界面保存密钥后调用：清缓存并重新合并。"""
    global _SECRETS
    with _SECRETS_LOCK:
        _SECRETS = None
    return _load_secrets()


def get_secret(env_name: str) -> str | None:
    """环境变量优先，其次扩展凭据，最后主 credentials.yaml 的 refs。"""
    return os.environ.get(env_name) or _load_secrets().get(env_name)


def secret_source(env_name: str) -> str:
    """env / admin / refs / 空串；不返回值本身。"""
    if not env_name:
        return ""
    if os.environ.get(env_name):
        return "env"
    _load_secrets()
    return _SECRET_ORIGIN.get(env_name, "")


def secret_names_loaded() -> list[str]:
    """只暴露本网关用到的上游密钥名，不列出凭据文件里的其它条目。"""
    secrets = _load_secrets()
    return sorted({u.api_key_env for u in UPSTREAMS
                   if os.environ.get(u.api_key_env) or u.api_key_env in secrets})


# ---------------------------------------------------------------------------
# 上游运行状态：熔断 + 滑动窗口限频 + 计数
# ---------------------------------------------------------------------------

class UpstreamState:
    """单个上游健康状态。时间一律用 wall clock，便于单测注入假时钟。"""

    def __init__(self, upstream: Upstream):
        self.upstream = upstream
        self.lock = threading.Lock()
        self.circuit_until = 0.0
        self.failures = 0
        self.calls = self.successes = self.failed = self.rejected = 0
        self.tokens_prompt = self.tokens_completion = 0
        self.window: deque[float] = deque()
        self.last_error: str | None = None
        self.last_status: int | None = None
        self.last_latency_ms: int | None = None
        self._latency_sum = self._latency_n = 0

    def _prune(self, now: float) -> None:
        while self.window and now - self.window[0] >= 60:
            self.window.popleft()

    def allow(self, now: float) -> tuple[bool, str]:
        with self.lock:
            self._prune(now)
            if self.circuit_until > now:
                return False, f"circuit_open:{int(self.circuit_until - now)}s"
            if len(self.window) >= self.upstream.max_rpm:
                return False, f"rpm_limit:{len(self.window)}/{self.upstream.max_rpm}"
            return True, ""

    def note_call(self, now: float) -> None:
        with self.lock:
            self._prune(now)
            self.window.append(now)
            self.calls += 1

    def note_success(self, latency_ms: int | None = None) -> None:
        with self.lock:
            self.successes += 1
            self.failures = 0
            self.circuit_until = 0.0
            self.last_error = None
            if latency_ms is not None:
                self.last_latency_ms = latency_ms
                self._latency_sum += latency_ms
                self._latency_n += 1

    def note_failure(self, status: int, error: str, now: float, count: bool = True,
                     cooldown: float | None = None) -> None:
        """402/5xx/连接失败 -> 600s；429 -> AFP_429_BREAKER_SECONDS（默认 300s，可配，
        2026-11-12 管理员反馈①：429=额度型限流，短熔断＋快照闸门负责不再打常开）；
        401/403 -> 3600s；400/413/422 只记 rejected 不熔断。

        cooldown：上游 Retry-After / 429 响应体重置时刻给出的精确冷却秒数，
        优先级高于默认值（401/403 仍按 auth 口径）。
        """
        with self.lock:
            if count:
                self.failed += 1
                # ── Q1-7（2026-11-18 修）──────────────────────────────────────
                # 旧版 `self.failures += 1` 无条件执行：400/413/422 只记 rejected、不开熔断，
                # 却仍让 /health 的 circuit.failures +1 ⇒ 同一个对象里 state=closed 与
                # failures>0 自相矛盾，监控按 failures>0 告警就会被普通参数错误误报。
                # 现在：circuit.failures 只统计「真实上游/熔断类失败」，与 state 重新自洽。
                self.failures += 1
            else:
                # 客户端错误（400/413/422）：只记 rejected，不污染熔断计数
                self.rejected += 1
            self.last_status = status
            self.last_error = (error or f"HTTP {status}")[:300]
            if status in (401, 403):
                self.circuit_until = now + AUTH_BREAKER_SECONDS
            elif status == 429:
                # 429 单独调短（可配）：额度型限流靠 AFP 闸门管，熔断只做短暂退避；
                # 响应体/头给出重置时刻时按它精确冷却（夹 1min~6h）
                self.circuit_until = now + max(30.0, AFP_429_BREAKER_SECONDS)
                if cooldown:
                    self.circuit_until = now + max(_COOLDOWN_MIN, min(_COOLDOWN_MAX, cooldown))
            elif status == 0 or status in _BREAKER_STATUSES or 500 <= status <= 599:
                if cooldown:
                    self.circuit_until = now + max(_COOLDOWN_MIN, min(_COOLDOWN_MAX, cooldown))
                else:
                    self.circuit_until = now + BREAKER_SECONDS

    def note_usage(self, usage: dict | None) -> None:
        if not isinstance(usage, dict):
            return
        with self.lock:
            if isinstance(usage.get("prompt_tokens"), int):
                self.tokens_prompt += usage["prompt_tokens"]
            if isinstance(usage.get("completion_tokens"), int):
                self.tokens_completion += usage["completion_tokens"]

    def snapshot(self, now: float) -> dict:
        with self.lock:
            self._prune(now)
            is_open = self.circuit_until > now
            return {
                "id": self.upstream.id,
                "label": self.upstream.label,
                "calls": self.calls,
                "successes": self.successes,
                "failures": self.failed,
                "rejected": self.rejected,
                "rpm_1m": len(self.window),
                "max_rpm": self.upstream.max_rpm,
                "tokens": {"prompt": self.tokens_prompt, "completion": self.tokens_completion,
                           "total": self.tokens_prompt + self.tokens_completion},
                "circuit": {
                    "open": is_open,
                    "state": "open" if is_open else "closed",
                    # Q1-7（2026-11-18）：failures 只含真实上游/熔断类失败（与 state 自洽）；
                    # 客户端错误看 rejected；下方 last_error_count 是「所有错误」的累计，便于观测。
                    "failures": self.failures,
                    "rejected": self.rejected,
                    "last_error_count": self.failures + self.rejected,
                    "remaining_s": int(self.circuit_until - now) if is_open else 0,
                    "open_until": _iso_from_ts(self.circuit_until) if is_open else None,
                },
                "last_error": self.last_error,
                "last_status": self.last_status,
                "last_latency_ms": self.last_latency_ms,
                "avg_latency_ms": round(self._latency_sum / self._latency_n, 1) if self._latency_n else None,
            }


STATE: dict[str, UpstreamState] = {u.id: UpstreamState(u) for u in UPSTREAMS}


def reload_upstreams() -> dict:
    """管理界面保存后热重载 upstreams.json；不重载 routing.json（auto 链不变）。

    重建 STATE 会重置熔断/限频计数（配置变更时属预期）。
    """
    global UPSTREAMS, UPSTREAM_MAP, STATE
    doc = _read_json(BASE_DIR / "upstreams.json")
    new_upstreams = _load_upstreams(doc)
    UPSTREAMS = new_upstreams
    UPSTREAM_MAP = {u.id: u for u in new_upstreams}
    STATE = {u.id: UpstreamState(u) for u in new_upstreams}
    LOG.info("upstreams 已热重载：%d 家 / %d 模型（routing 未变）",
             len(new_upstreams), sum(len(u.models) for u in new_upstreams))
    return {"upstreams": len(new_upstreams),
            "models": sum(len(u.models) for u in new_upstreams)}


# ---------------------------------------------------------------------------
# AFP 感知分流（2026-11-12 管理员 17:0x 反馈①：火山 429 治理）
# 额度快照 = `afp.quota_path` 指定的 JSON（采集器周期写入；文件以控制台读数
# 为准——网关外还有直连消费者，本地累加必然漂移）。闸门只读快照＋估算，
# 不开熔断、不阻塞请求、不产生 4xx/5xx。
# ---------------------------------------------------------------------------

_AFP_CFG_FULL = dict(CONFIG.get("afp") or {})
AFP_ENABLED = bool(_AFP_CFG_FULL.get("enabled", False))
AFP_UPSTREAM_ID = str(_AFP_CFG_FULL.get("upstream") or "")
AFP_QUOTA_PATH = Path(str(
    _AFP_CFG_FULL.get("quota_path") or (DATA_DIR / "quota-snapshot.json"))).expanduser()
# 折算率 AFP/token（标定见模块 docstring；0 = 未标定 ⇒ 闸门不生效）
AFP_RATE_PER_TOKEN = float(_AFP_CFG_FULL.get("rate_per_token", 0.0) or 0.0)
# 余额保留比例：est_afp > avail×(1-reserve) ⇒ 跳过（给小请求留余量＋吸收估算误差）
AFP_RESERVE = float(_AFP_CFG_FULL.get("reserve", 0.1))
# 小额阈值（AFP）：估算消耗 ≤ 此值的小请求不因余额紧张被跳过（保持火山优先、月包吃满）
AFP_MIN_CHARGE = float(_AFP_CFG_FULL.get("min_charge_afp", 1.0))
# 快照过期时限：超过 ⇒ 闸门放行（读不到≠拒绝，保守＝维持现状）
AFP_STALE_AFTER = float(_AFP_CFG_FULL.get("stale_after_seconds", 7200))
# 闸门激活三条件：开关开、折算率已标定、目标上游存在（缺一＝零行为变化）
AFP_GATE_ACTIVE = (AFP_ENABLED and AFP_RATE_PER_TOKEN > 0
                   and AFP_UPSTREAM_ID in UPSTREAM_MAP)

# afp.enabled=true 但未配置 afp.upstream ⇒ 闸门定位不到目标上游：打 WARNING 并跳过 AFP
# 前置额度闸门（其余判据/路由逻辑一律不变；不因此拒绝请求、不产生 4xx/5xx）
if AFP_ENABLED and not AFP_UPSTREAM_ID:
    LOG.warning("afp.enabled=true 但未配置 afp.upstream：AFP 前置额度闸门已跳过（其余逻辑不变）")

_AFP_LOCK = threading.Lock()
_AFP_SNAPSHOT_CACHE: dict | None = None  # {"mtime": float, "checked": float, "snap": dict|None}
_AFP_STATS = {"gate_skipped": 0, "gate_allowed": 0, "est_afp_sum": 0.0,
              "snapshot_stale": 0, "snapshot_missing": 0}


def _afp_parse_snapshot(doc: dict, now_ts: float) -> tuple[dict | None, str]:
    """规范化额度快照：三窗口取最紧余额。

    返回 (snap, why)；why ∈ {ok, bad_doc, no_windows, stale}。
    snap = {"min_avail": float, "windows": {"h5": (used, limit), ...}, "collected_at": str}；
    used 超过 limit（打穿/口径滞后）按下夹 0 处理。
    """
    if not isinstance(doc, dict) or not isinstance(doc.get("afp"), dict):
        return None, "bad_doc"
    afp = doc["afp"]
    windows: dict[str, tuple[float, float]] = {}
    for key in ("h5", "d7", "d30"):
        w = afp.get(key)
        if not isinstance(w, dict):
            continue
        try:
            used = float(w.get("used"))
            limit = float(w.get("limit"))
        except (TypeError, ValueError):
            continue
        if limit <= 0:
            continue
        windows[key] = (used, limit)
    if not windows:
        return None, "no_windows"
    min_avail = min(max(0.0, limit - used) for used, limit in windows.values())
    collected = str(doc.get("collected_at") or "")
    if collected:
        try:
            moment = datetime.fromisoformat(collected)
            if moment.tzinfo is None and TZ:
                moment = moment.replace(tzinfo=TZ)
            if (now_ts - moment.timestamp()) > AFP_STALE_AFTER:
                return None, "stale"
        except ValueError:
            return None, "stale"  # 时间戳解析不了＝无法判新鲜度，按过期处理（保守放行）
    else:
        return None, "stale"  # 没有时间戳＝无法判新鲜度
    return {"min_avail": min_avail, "windows": windows, "collected_at": collected}, "ok"


def afp_snapshot(now_ts: float | None = None) -> dict | None:
    """读额度快照（内容级缓存：原始字节未变则复用解析结果，变了立即重解析）。

    1.0.3.5-r6（2026-11-23 根治）：缓存判据由「(mtime_ns, size) 元数据」改为「原始字节比较」，
    消除「同 mtime 同 size 内容变却命中旧值」的边界（对侧复核保留项；对侧已复现
    「真实余额 0、缓存仍 8、闸门放行」）。代价：每请求一次 open+read（KB 级小文件，微秒量级），
    内容未变时跳过 JSON 解析；写端非原子时读到半文件会解析失败 ⇒ None（保守放行，不猜价）。

    文件缺失/解析失败/结构不对/过期 ⇒ None（调用方一律放行）。
    """
    global _AFP_SNAPSHOT_CACHE
    ts = time.time() if now_ts is None else now_ts
    with _AFP_LOCK:
        try:
            blob = AFP_QUOTA_PATH.read_bytes()
        except OSError:
            _AFP_STATS["snapshot_missing"] += 1
            _AFP_SNAPSHOT_CACHE = None
            return None
        cache = _AFP_SNAPSHOT_CACHE
        if cache and cache.get("blob") == blob:
            raw = cache.get("raw")
            if raw is None:
                # 1.0.3.6 口径：坏内容每次读取都计 snapshot_missing（此前只计首次，统计偏少）；
                # 只影响观测口径，不改变「解析失败 ⇒ 保守放行」的行为。
                _AFP_STATS["snapshot_missing"] += 1
                return None
        else:
            try:
                raw = json.loads(blob.decode("utf-8"))
            except Exception:
                _AFP_STATS["snapshot_missing"] += 1
                _AFP_SNAPSHOT_CACHE = {"blob": blob, "raw": None}
                return None
            _AFP_SNAPSHOT_CACHE = {"blob": blob, "raw": raw}
        if not raw:
            return None
        snap, why = _afp_parse_snapshot(raw, ts)
        if snap is None and why == "stale":
            _AFP_STATS["snapshot_stale"] += 1
        return snap


def afp_reset_cache() -> None:
    """测试/运维用：清空快照缓存（下次调用强制重读文件）。"""
    global _AFP_SNAPSHOT_CACHE
    with _AFP_LOCK:
        _AFP_SNAPSHOT_CACHE = None


def afp_est_tokens(est_input_tokens: int) -> float:
    """估算本请求走火山的 AFP 消耗（est 口径 × 实际折算率）。"""
    return round(est_input_tokens * AFP_RATE_PER_TOKEN, 3)


def afp_gate_check(upstream_id: str, est_input_tokens: int,
                   now_ts: float | None = None) -> tuple[bool, str]:
    """AFP 闸门（纯判定，不改任何状态、不开熔断）。

    返回 (allow, why)；allow=False 时 why ∈ {afp_exhausted, afp_would_exceed}。
    闸门未激活 / 非限额上游 / 快照读不到或过期 ⇒ 一律放行（保守＝维持现状）。
    """
    if not AFP_GATE_ACTIVE or upstream_id != AFP_UPSTREAM_ID:
        return True, ""
    snap = afp_snapshot(now_ts)
    if snap is None:
        return True, ""
    avail = snap["min_avail"]
    est = afp_est_tokens(est_input_tokens)
    if avail <= 0:
        return False, "afp_exhausted"
    if est <= AFP_MIN_CHARGE:
        return True, ""  # 小额：可用就走火山（月包吃满）
    if est > avail * (1.0 - AFP_RESERVE):
        return False, "afp_would_exceed"
    return True, ""


def afp_stats() -> dict:
    with _AFP_LOCK:
        counters = dict(_AFP_STATS)
    return {
        "enabled": AFP_ENABLED, "active": AFP_GATE_ACTIVE,
        "upstream": AFP_UPSTREAM_ID if AFP_GATE_ACTIVE else None,
        "rate_per_token": AFP_RATE_PER_TOKEN if AFP_GATE_ACTIVE else None,
        **counters,
    }


# ---------------------------------------------------------------------------
# 时间 / 特征 / 路由（纯函数）
# ---------------------------------------------------------------------------

def now_shanghai() -> datetime:
    return datetime.now(TZ) if TZ else datetime.now()


def _iso_from_ts(ts: float) -> str:
    return (datetime.fromtimestamp(ts, TZ) if TZ else datetime.fromtimestamp(ts)).isoformat(timespec="seconds")


def current_period(now: datetime | None = None) -> str:
    """peak / offpeak。工作日 09:00-12:00、14:00-18:00 为高峰（左闭右开）。"""
    moment = now or now_shanghai()
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=TZ) if TZ else moment
    else:
        moment = moment.astimezone(TZ) if TZ else moment
    if moment.isoweekday() not in PEAK_WEEKDAYS:
        return "offpeak"
    minutes = moment.hour * 60 + moment.minute
    return "peak" if any(start <= minutes < end for start, end in PEAK_WINDOWS) else "offpeak"


@dataclass
class Features:
    """请求的轻量特征：只有长度/结构，绝不含正文。"""

    est_input_tokens: int = 0
    chars: int = 0
    message_count: int = 0
    image_count: int = 0
    has_image: bool = False
    has_tools: bool = False
    max_tokens: int = 0
    has_system: bool = False
    # 1.0.3.2 T1：CJK/非 CJK 明细（只供上下文治理；不进账本 features 块）
    cjk_chars: int = 0
    other_chars: int = 0

    def as_dict(self) -> dict:
        """固定 8 键：账本 features 块与历史逐字节一致；CJK 明细只进 ctx_gov。"""
        return {"est_input_tokens": self.est_input_tokens,
                "chars": self.chars,
                "message_count": self.message_count,
                "image_count": self.image_count,
                "has_image": self.has_image,
                "has_tools": self.has_tools,
                "max_tokens": self.max_tokens,
                "has_system": self.has_system}


def _text_chars(value: Any) -> int:
    """统计 content 字符数；图片不做字符统计（按固定 token 计）。"""
    if value is None:
        return 0
    if isinstance(value, str):
        return len(value)
    if isinstance(value, list):
        total = 0
        for part in value:
            if isinstance(part, str):
                total += len(part)
            elif isinstance(part, dict):
                if part.get("type") == "text":
                    total += len(str(part.get("text") or ""))
                elif part.get("type") != "image_url":
                    total += len(json.dumps(part, ensure_ascii=False))
        return total
    return len(json.dumps(value, ensure_ascii=False))


def _count_images(value: Any) -> int:
    return sum(1 for p in value if isinstance(p, dict) and p.get("type") == "image_url") if isinstance(value, list) else 0


def extract_features(payload: dict, completions: bool = False) -> Features:
    """从请求体提取特征，不保留正文。"""
    feats = Features()
    raw_max = payload.get("max_tokens")
    if raw_max is None:
        raw_max = payload.get("max_completion_tokens")
    feats.max_tokens = max(0, raw_max) if isinstance(raw_max, int) and not isinstance(raw_max, bool) else 0

    if completions:
        prompt = payload.get("prompt")
        cjk, other = _text_char_split(prompt)
        feats.cjk_chars += cjk
        feats.other_chars += other
        feats.chars += cjk + other
        feats.message_count = 1 if prompt else 0
    else:
        messages = payload.get("messages")
        if isinstance(messages, list):
            feats.message_count = len(messages)
            for msg in messages:
                if not isinstance(msg, dict):
                    continue
                if msg.get("role") in ("system", "developer"):
                    feats.has_system = True
                content = msg.get("content")
                cjk, other = _text_char_split(content)
                feats.cjk_chars += cjk
                feats.other_chars += other
                feats.chars += cjk + other
                feats.image_count += _count_images(content)
    tools = payload.get("tools")
    if isinstance(tools, list) and tools:
        feats.has_tools = True
        raw_tools = json.dumps(tools, ensure_ascii=False)
        feats.other_chars += len(raw_tools)
        feats.chars += len(raw_tools)
    if payload.get("tool_choice"):
        feats.has_tools = True
    functions = payload.get("functions")
    if isinstance(functions, list) and functions:
        feats.has_tools = True
        raw_functions = json.dumps(functions, ensure_ascii=False)
        feats.other_chars += len(raw_functions)
        feats.chars += len(raw_functions)

    feats.has_image = feats.image_count > 0
    feats.est_input_tokens = math.ceil(feats.chars / CHARS_PER_TOKEN) + feats.image_count * IMAGE_TOKENS
    return feats


def classify(features: Features) -> str:
    """L1 简单 / L2 普通 / L3 重。"""
    comp = CONFIG.get("complexity", {})
    l1_input = int(comp.get("l1_input_tokens", 4000))
    l1_output = int(comp.get("l1_output_tokens", 2000))
    l3_input = int(comp.get("l3_input_tokens", 32000))
    l3_output = int(comp.get("l3_output_tokens", 16000))
    if features.est_input_tokens > l3_input or features.has_image or features.max_tokens > l3_output:
        return "L3"
    if (features.est_input_tokens < l1_input and not features.has_image
            and not features.has_tools and features.max_tokens <= l1_output):
        return "L1"
    return "L2"


def route_key(stage: str, features: Features) -> str:
    """含图片时优先图型规则。"""
    return "image" if features.has_image else stage


def split_candidate(candidate: str) -> tuple[str, str]:
    """拆 "upstream/model"；model 可再含 "/"（如 zhipu/model_b2）。"""
    if "/" not in candidate:
        return candidate, ""
    up_id, model = candidate.split("/", 1)
    return up_id, model


def _dedup(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        text = str(item).strip()
        if text and text not in seen:
            seen.add(text)
            out.append(text)
    return out


_DECIDER_STRATEGY = {
    "auto-cost": "cost", "auto-capability": "capability", "auto-function": "function",
    "auto-recommend": "recommend", "auto-fast": "fast", "auto-strong": "strong",
}

try:  # [2026-11-20 约定] 每条策略可挂「决策模型」：先判后用；默认 off，行为零变化
    import router_deciders as _deciders
except Exception:  # noqa: BLE001
    _deciders = None


def _decider_override(virtual_model: str, key: str, features: Features,
                      function_name: str | None,
                      override: str | None = None) -> tuple[str, str | None]:
    """按策略挂的决策模型先判一次（active 模式才生效）。

    off/shadow/异常/低置信度一律原样返回（key, function_name）⇒ 主链路行为不变。
    """
    if _deciders is None:
        return key, function_name
    strategy = _DECIDER_STRATEGY.get((virtual_model or "").strip())
    if strategy is None:
        if (virtual_model or "").startswith("auto-fn-"):
            strategy = "function"
        else:
            strategy = "auto"
    try:
        meta = {"kind": strategy, "input_tokens": features.est_input_tokens,
                "has_tools": features.has_tools, "has_image": features.has_image,
                "first_message": ""}
        dec = _deciders.decide(strategy, meta, actual={"key": key, "function": function_name},
                               override=override)
    except Exception:  # noqa: BLE001
        return key, function_name
    if not dec:
        return key, function_name
    if dec.get("function"):
        function_name = dec["function"]
    if dec.get("level"):
        try:
            key = route_key(dec["level"], features)
        except Exception:  # noqa: BLE001
            pass
    return key, function_name


def build_candidates(virtual_model: str, stage: str, period: str, features: Features,
                     function_name: str | None = None,
                     route_mode: str | None = None,
                     decider_override: str | None = None) -> list[str]:
    """返回候选链：第一项主选，其余 fallback；[] 表示模型未知。

    route_mode：推荐策略模式头 X-DSH-Route-Mode（price/capability/preset），仅 auto-recommend 用。
    """
    name = (virtual_model or "auto").strip()
    if "/" in name:  # 显式指定 upstream/model：直接透传（功能头不覆盖显式模型）
        up_id, model = split_candidate(name)
        return [name] if up_id in UPSTREAM_MAP and model else []
    alias = [f"{u.id}/{name}" for u in UPSTREAMS if name in u.models]
    if len(alias) == 1:  # 裸真实模型 id 兼容
        return alias
    if name.startswith("auto-fn-"):
        fn_key = name[len("auto-fn-"):].strip().lower()
        chat_keys = {k for k, _label, chat in rstrat.FUNCTION_CATALOG if chat}
        if fn_key not in chat_keys:
            return []
        chain = rstrat.chain("function", route_key(stage, features), period, fn_key)
        return [c for c in _dedup(chain) if split_candidate(c)[0] in UPSTREAM_MAP
                and split_candidate(c)[1]]
    if name not in VIRTUAL_MODELS:
        return []
    key = route_key(stage, features)
    key, function_name = _decider_override(name, key, features, function_name, decider_override)
    if function_name:
        # 功能路由优先：auto-function / auto 等虚拟模型均可带 X-DSH-Route-Function
        chain = rstrat.chain("function", key, period, function_name)
    elif name == "auto-function":
        chain = []
    elif name == "auto-cost":
        chain = rstrat.chain("cost", key, period)
        if not chain:  # 策略文件缺失时回落现网 routes（=已采纳的全模型提案）
            table = ROUTES.get(period) or {}
            chain = list(table.get(key) or table.get(stage) or [])
    elif name == "auto-capability":
        chain = rstrat.chain("capability", key, period)
        if not chain:  # 回落现网 strong
            strong = STRATEGIES.get("strong") or {}
            by_period = strong.get(period) if isinstance(strong.get(period), dict) else {}
            chain = list(by_period.get(key) or by_period.get(stage)
                         or strong.get(key) or strong.get(stage) or strong.get("default") or [])
    elif name == "auto-recommend":
        # 推荐策略（2026-11-17）：实时按价/档排序；route_mode 走 X-DSH-Route-Mode 头
        chain = rstrat.chain("recommend", key, period, route_mode or "")
    elif name == "auto-fast":
        chain = list(STRATEGIES.get("fast") or [])
    elif name == "auto-strong":
        strong = STRATEGIES.get("strong") or {}
        by_period = strong.get(period) if isinstance(strong.get(period), dict) else {}
        # 时段优先（peak 避官方）；无时段子表时回落到旧的扁平写法
        chain = list(by_period.get(key) or by_period.get(stage)
                     or strong.get(key) or strong.get(stage) or strong.get("default") or [])
    else:
        table = ROUTES.get(period) or {}
        chain = list(table.get(key) or table.get(stage) or [])
    return [c for c in _dedup(chain) if split_candidate(c)[0] in UPSTREAM_MAP and split_candidate(c)[1]]


def candidate_supported(upstream_id: str, model_id: str, features: Features) -> tuple[bool, str]:
    """能力 / 上下文检查；未声明的透传模型默认放行。"""
    upstream = UPSTREAM_MAP.get(upstream_id)
    if upstream is None:
        return False, "unknown_upstream"
    spec = upstream.model_spec(model_id)
    if not spec:
        return True, ""
    if features.has_image and spec.get("vision") is False:
        return False, "model_no_vision"
    if features.has_tools and spec.get("tools") is False:
        return False, "model_no_tools"
    context = spec.get("context_window")
    if isinstance(context, int) and context > 0:
        mode = str((ctx_gov_params() or {}).get("mode") or "shadow").lower()
        if mode == "enforce":
            verdict = context_verdict(upstream_id, model_id, features)
            if verdict.get("band") == "reject":
                return False, f"context_overflow:{verdict.get('kind')}:{verdict.get('why')}"
        else:
            # off / shadow：放行判定保持旧口径（×1.05）；shadow 的预算判定只记观测
            need = features.est_input_tokens + max(0, features.max_tokens)
            if need > context * 1.05:
                return False, f"context_overflow:{need}>{context}"
    return True, ""


def build_reason(features: Features, stage: str, period: str, primary: str, candidate_count: int) -> str:
    """中文判定理由（进账本），一句话。"""
    period_cn = "高峰" if period == "peak" else "低峰"
    bits = [f"输入约 {features.est_input_tokens} tokens"]
    bits.append(f"含 {features.image_count} 张图" if features.has_image else f"{features.message_count} 条消息")
    if features.has_tools:
        bits.append("带工具")
    if features.has_system:
        bits.append("有 system")
    tail = f"另有 {candidate_count - 1} 个备选" if candidate_count > 1 else "无备选"
    return f"{period_cn}{stage}（{'，'.join(bits)}）→ 主选 {primary}；{tail}"


def ascii_reason(features: Features, stage: str, period: str, decision: str) -> str:
    """HTTP 头用：纯 ASCII，避免中文 header 编码异常。"""
    bits = [period, stage, f"est {features.est_input_tokens}tok"]
    if features.has_image:
        bits.append(f"{features.image_count}img")
    if features.has_tools:
        bits.append("tools")
    return f"{' / '.join(bits)} -> {decision}"


# ---------------------------------------------------------------------------
# hint 提示头（契约 v1.0：插件 → 网关）
# ---------------------------------------------------------------------------

HINT_HEADER = "X-DSH-Route"
_HINT_CFG = CONFIG.get("hint") or {}

# 灰度开关：record=仅记录不执行（默认，观察一周）；execute=执行。改后重启生效。
HINT_MODE = str(_HINT_CFG.get("mode") or "record").strip().lower()
if HINT_MODE not in ("record", "execute"):
    LOG.warning("hint.mode 配置非法（%r），按保守值 record 处理", _HINT_CFG.get("mode"))
    HINT_MODE = "record"
HINT_CONTRACT_VERSION = int(_HINT_CFG.get("contract_version") or 1)
HINT_MAX_HEADER_BYTES = int(_HINT_CFG.get("max_header_bytes") or 8192)
HINT_DEFAULT_TIER = str(_HINT_CFG.get("default_tier") or "mid")
HINT_REASON_MAX_CHARS = int(_HINT_CFG.get("reason_max_chars") or 64)
HINT_STAGE_MAX_CHARS = int(_HINT_CFG.get("stage_max_chars") or 64)
HINT_SESSION_MAX_CHARS = int(_HINT_CFG.get("session_max_chars") or 128)
HINT_CONFIRM_KEYS = [str(k) for k in (_HINT_CFG.get("confirm_required_keys")
                                      or ["goal", "done", "next", "why", "ctx"])]

# 能力清单：全部真实上游模型（upstream/model 全名）；模型名只是自报，双方不强求一致
HINT_CAPABILITY_MODELS: list[str] = [f"{u.id}/{m}" for u in UPSTREAMS for m in u.models]
HINT_CAPABILITY_SET = set(HINT_CAPABILITY_MODELS)

# 能力清单 v2（2026-11-13）：models 由字符串列表改对象列表；ROUTER_CAPABILITIES_V2=0 回旧结构。
# 元数据只在配置里：routing.json → capability_meta.models[<upstream/model>]，缺项回落 upstreams.json；
# 价格数字一律不写死在代码里（capability_meta 没有就是 null，待填表）。
CAPABILITIES_V2_ENV = "ROUTER_CAPABILITIES_V2"
_CAPABILITY_META = CONFIG.get("capability_meta") or {}
CAPABILITY_META_MODELS: dict[str, dict] = {
    str(k): v for k, v in (_CAPABILITY_META.get("models") or {}).items() if isinstance(v, dict)
}
CAPABILITY_CURRENCY_DEFAULT = str(_CAPABILITY_META.get("currency_default") or "CNY")
CAPABILITY_PRICE_FIELDS = ("input_per_mtok", "output_per_mtok", "cache_hit_input_per_mtok")


def _offer_currency(offer: dict, default: str | None = None) -> str:
    """报价币种（1.0.3.6 币种支持）：offer.currency → offer.price.currency → offer.meta.currency → 默认。

    口径与 router_strategies._recommend_price_view 一致；空/非字符串一律回落默认，不猜。
    """
    if not isinstance(offer, dict):
        return (default or CAPABILITY_CURRENCY_DEFAULT).strip().upper()
    _price = offer.get("price") if isinstance(offer.get("price"), dict) else {}
    _meta = offer.get("meta") if isinstance(offer.get("meta"), dict) else {}
    raw = offer.get("currency") or _price.get("currency") or _meta.get("currency")
    cur = str(raw).strip().upper() if isinstance(raw, str) and raw.strip() else ""
    return cur or (default or CAPABILITY_CURRENCY_DEFAULT).strip().upper()

# 档位映射（tier → 候选链）。链内条目必须是已配置的 upstream/model，未配置的启动时剔除并告警。
HINT_TIERS: dict[str, list[str]] = {}
for _tier_name, _raw_chain in (_HINT_CFG.get("tiers") or {}).items():
    _chain: list[str] = []
    for _cand in _raw_chain or []:
        _text = str(_cand).strip()
        if not _text:
            continue
        if _text not in HINT_CAPABILITY_SET:
            LOG.warning("hint.tiers[%s] 含未配置的模型 %r，已剔除", _tier_name, _text)
            continue
        if _text not in _chain:
            _chain.append(_text)
    HINT_TIERS[str(_tier_name)] = _chain

# hint / 守门计数器（仅观测，永不影响请求处理）
_HINT_TOTAL = {"received": 0, "valid": 0, "invalid": 0, "executed": 0,
               "record_only": 0, "honored": 0, "fallback": 0, "incomplete": 0,
               "guard_allow": 0, "guard_allow_with_count": 0, "guard_fallback": 0,
               "guard_new_session": 0, "guard_invalid": 0}
_HINT_LOCK = threading.Lock()


def _hint_add(**kwargs: int) -> None:
    with _HINT_LOCK:
        for key, value in kwargs.items():
            _HINT_TOTAL[key] = _HINT_TOTAL.get(key, 0) + value


def hint_stats() -> dict:
    with _HINT_LOCK:
        counters = dict(_HINT_TOTAL)
    return {"mode": HINT_MODE, "contract_version": HINT_CONTRACT_VERSION, **counters}


@dataclass
class ParsedHint:
    """X-DSH-Route 解析结果。ok=False 表示结构非法（hint_invalid）；None 表示没带头。"""

    ok: bool
    error: str | None          # 非法原因枚举：empty/oversize/bad_base64/bad_json/not_object/version_mismatch/reason_discipline
    tier: str | None           # 原样记录（可能不在档位表内＝非法档）
    model: str | None
    stage: str | None
    session: str | None
    reason: str | None
    confirm: dict | None
    incomplete_missing: list[str] = field(default_factory=list)


def _b64_try_decode(text: str) -> bytes | None:
    """标准/URL-safe base64 都认；自动补 padding；失败返回 None。"""
    padded = text + "=" * (-len(text) % 4)
    for decoder in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            return decoder(padded, validate=True)
        except Exception:
            continue
    return None


def parse_hint_header(raw: str | None) -> ParsedHint | None:
    """解析 X-DSH-Route；永不抛异常。返回 None＝请求没带该头。"""
    try:
        if raw is None:
            return None
        text = str(raw).strip()
        if not text:
            return ParsedHint(False, "empty", None, None, None, None, None, None)
        if len(text) > HINT_MAX_HEADER_BYTES:
            return ParsedHint(False, "oversize", None, None, None, None, None, None)
        data = _b64_try_decode(text)
        if data is None:
            return ParsedHint(False, "bad_base64", None, None, None, None, None, None)
        try:
            obj = json.loads(data.decode("utf-8"))
        except Exception:
            return ParsedHint(False, "bad_json", None, None, None, None, None, None)
        if not isinstance(obj, dict):
            return ParsedHint(False, "not_object", None, None, None, None, None, None)
        version = obj.get("v")
        if not isinstance(version, int) or isinstance(version, bool) or version != HINT_CONTRACT_VERSION:
            return ParsedHint(False, "version_mismatch", None, None, None, None, None, None)
        # reason 纪律（契约红线：≤64 字符、禁放正文/用户内容）——违纪整头作废，绝不落账本
        reason = obj.get("reason")
        if reason is not None and (not isinstance(reason, str) or len(reason) > HINT_REASON_MAX_CHARS):
            return ParsedHint(False, "reason_discipline", None, None, None, None, None, None)
        tier = obj.get("tier")
        tier = tier.strip() if isinstance(tier, str) and tier.strip() else None
        model = obj.get("model")
        model = model.strip() if isinstance(model, str) and model.strip() else None
        stage = obj.get("stage")
        stage = stage if isinstance(stage, str) and 0 < len(stage) <= HINT_STAGE_MAX_CHARS else None
        session = obj.get("session")
        session = session if isinstance(session, str) and 0 < len(session) <= HINT_SESSION_MAX_CHARS else None
        confirm_raw = obj.get("confirm")
        if confirm_raw is None:
            confirm, missing = None, []
        elif isinstance(confirm_raw, dict):
            confirm = confirm_raw
            missing = [k for k in HINT_CONFIRM_KEYS if k not in confirm_raw]
        else:  # 带 confirm 但结构不是对象＝结构缺项（§8 附注 A：只计数，不拦截）
            confirm, missing = None, list(HINT_CONFIRM_KEYS)
        return ParsedHint(True, None, tier, model, stage, session, reason, confirm, missing)
    except Exception:
        return ParsedHint(False, "internal", None, None, None, None, None, None)


def capabilities_v2_enabled() -> bool:
    """能力清单是否用 v2 结构（对象 models）。默认开；ROUTER_CAPABILITIES_V2=0/false/no/off 关。

    按请求读环境变量（不缓存）：测试/热注入友好，切换无需重启。
    """
    raw = (os.environ.get(CAPABILITIES_V2_ENV) or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _cap_int(value: Any) -> int | None:
    """配置里的整数字段：缺失/类型不对 → None（不填 0 假数）。"""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _cap_num(value: Any) -> int | float | None:
    """配置里的数字字段（价格）：bool 与非数字 → None。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def _cap_modality(meta_value: Any, vision: Any) -> list[str] | None:
    """模态：优先用配置数组；否则按 upstreams.json 的 vision 推导；都没有 → None。"""
    if isinstance(meta_value, list):
        return [str(item) for item in meta_value if isinstance(item, str) and item.strip()]
    if isinstance(vision, bool):
        return ["text", "vision"] if vision else ["text"]
    return None


def _cap_price_block(raw: Any) -> dict | None:
    """价格块（高峰/低峰两个价）：不是对象 → null；块内缺失的价 → null。"""
    if not isinstance(raw, dict):
        return None
    return {"peak": _cap_num(raw.get("peak")), "offpeak": _cap_num(raw.get("offpeak"))}


def capability_price(meta: dict) -> dict | None:
    """单个模型的价格结构；capability_meta 里没有 price → None（待填表，不猜价）。"""
    raw = meta.get("price")
    if not isinstance(raw, dict):
        return None
    currency = raw.get("currency")
    return {
        "currency": str(currency).strip() if isinstance(currency, str) and currency.strip()
        else CAPABILITY_CURRENCY_DEFAULT,
        **{key: _cap_price_block(raw.get(key)) for key in CAPABILITY_PRICE_FIELDS},
    }


def _price_has_number(block) -> bool:
    """价格块里是否有任何真实数字（峰谷/null 都不算）。"""
    if not isinstance(block, dict):
        return False
    for key in ("input_per_mtok", "output_per_mtok", "cache_hit_input_per_mtok"):
        val = block.get(key)
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            return True
        if isinstance(val, dict) and any(
                isinstance(v, (int, float)) and not isinstance(v, bool) for v in val.values()):
            return True
    return False


LOCAL_PROVIDER_IDS = frozenset({"provider_b", "local-lan", "local", "localhost"})


def _is_local_provider(pid: str, cid: str) -> bool:
    """本地车道判定：provider 名命中本地集合，或候选前缀命中（1.0.3.5 起不再只认 provider_b）。"""
    if pid in LOCAL_PROVIDER_IDS:
        return True
    head = cid.split("/", 1)[0] if cid else ""
    return head in LOCAL_PROVIDER_IDS


def price_state_of(candidate: str, provider: str | None, block) -> str:
    """价格三态：委托单一真源 price_state.py（单一真源）。

    判定逻辑原样迁至 price_state.state_of，本函数保留为兼容入口（行为零变化）。
    """
    return price_state.state_of(candidate, provider, block)


def price_label_of(state: str, fallback_label: str | None) -> str:
    if state == "local":
        return "0（本地）"
    if state == "unpriced":
        return "0（待用户录入）"
    return fallback_label or ""


def capability_model_entry(candidate: str) -> dict:
    """v2 的单个模型对象。只读配置：capability_meta 优先，缺项回落 upstreams.json，仍缺 → null。"""
    upstream_id, model_id = split_candidate(candidate)
    upstream = UPSTREAM_MAP.get(upstream_id)
    spec = upstream.model_spec(model_id) if upstream is not None else {}
    meta = CAPABILITY_META_MODELS.get(candidate) or {}

    provider = meta.get("provider")
    provider = (str(provider).strip() if isinstance(provider, str) and provider.strip()
                else (upstream_id if upstream is not None else None))
    tier = meta.get("tier")
    if not (isinstance(tier, str) and tier.strip()):
        tier = spec.get("tier")
    tier = str(tier).strip() if isinstance(tier, str) and tier.strip() else None
    context_window = _cap_int(meta.get("context_window"))
    if context_window is None:
        context_window = _cap_int(spec.get("context_window"))
    max_tokens = _cap_int(meta.get("max_tokens"))
    if max_tokens is None:
        max_tokens = _cap_int(spec.get("max_tokens"))
    price_block = capability_price(meta)
    # L5 单源化（2026-11-21 S1）：pricebook 派生优先；无源时保留 meta 旧值兜底（自证会把无源打红）。
    # 类型垫片只为双写期逐字节一致（数值不变）；meta 全删后按 derived 的规范表示输出。
    if price_single_source_enabled():
        _derived_block, _, _derived_errors = derived_price(candidate)
        if _derived_block is not None:
            price_block = _shim_number_types(_derived_block, price_block)
    # 2026-11-19 按配置补价：capability_meta 没填价的模型，若 pricebook 有有效报价，
    # 就用 pricebook 的当前有效价补出 price 块（单一真源仍是 pricebook；不猜价）。
    # 这样 /v1/route/prices、plan 估价、DSH 价格表导出三处口径一致。
    if not _price_has_number(price_block):
        try:
            _offer = pricebook_offer(candidate)
            if isinstance(_offer, dict) and _offer.get("price"):
                def _slot_from_offer(block):
                    if not isinstance(block, dict):
                        return None
                    if isinstance(block.get("flat"), (int, float)) and not isinstance(block.get("flat"), bool):
                        return {"flat": float(block["flat"])}
                    if "peak" in block or "offpeak" in block:
                        peak = block.get("peak")
                        off = block.get("offpeak")
                        return {"peak": (float(peak) if isinstance(peak, (int, float)) and not isinstance(peak, bool) else None),
                                "offpeak": (float(off) if isinstance(off, (int, float)) and not isinstance(off, bool) else None)}
                    return None

                _raw = _offer.get("price") or {}
                _in_block = _slot_from_offer(_raw.get("input_per_mtok") or _raw.get("input"))
                _out_block = _slot_from_offer(_raw.get("output_per_mtok") or _raw.get("output"))
                _cache_block = _slot_from_offer(_raw.get("cache_hit_input_per_mtok") or _raw.get("cache_hit"))
                if _in_block and _out_block:
                    price_block = {"currency": _offer_currency(_offer), "input_per_mtok": _in_block,
                                   "output_per_mtok": _out_block}
                    if _cache_block:
                        price_block["cache_hit_input_per_mtok"] = _cache_block
                else:
                    # expr/乘数类（如 provider_c billing_expr）：取当前有效价扁平化
                    _priced = price_resolver.effective_price(_offer)
                    _prices = (_priced or {}).get("prices") or {}
                    _in, _out = _prices.get("input"), _prices.get("output")
                    if isinstance(_in, (int, float)) and isinstance(_out, (int, float)):
                        price_block = {"currency": _offer_currency(_offer),
                                       "input_per_mtok": {"flat": float(_in)},
                                       "output_per_mtok": {"flat": float(_out)}}
                        if isinstance(_prices.get("cache_hit"), (int, float)):
                            price_block["cache_hit_input_per_mtok"] = {
                                "flat": float(_prices["cache_hit"])}
        except Exception:
            pass
    period = current_period()

    def _slot(key: str):
        block = (price_block or {}).get(key)
        if isinstance(block, dict):
            return block.get(period)
        return None

    offer = pricebook_offer(candidate)
    if offer is not None:
        label_out = offer_display_label(offer)
    else:
        label_out = display_label(provider, spec.get("label") or model_id,
                                  _slot("input_per_mtok"), _slot("output_per_mtok"))
    return {
        "id": candidate,
        "provider": provider,
        "tier": tier,
        "context_window": context_window,
        "max_tokens": max_tokens,
        "modality": _cap_modality(meta.get("modality"), spec.get("vision")),
        "price": price_block,
        "display_label": label_out,
    }


# ---------------------------------------------------------------------------
# L5 ②（2026-11-20）：价格双源一致性自检（只读、零副作用）
#
# 为什么需要：价格有两个**读取点**，刷新语义不同 ——
#   A) CAPABILITY_META_MODELS（routing.json → capability_meta.models）**启动时一次性进内存**；
#   B) load_pricebook()（config/pricebook.json）**按 mtime 热加载**。
# 合并点是 capability_model_entry()：meta 声明了价就用 meta，meta 没价才用 pricebook 有效价补。
# 于是同一进程里「meta 端口径」与「pricebook 端口径」可能相反（旧进程 unpriced=1 / 新进程 0），
# 会让 /v1/route/prices、/v1/route/capabilities、plan 估价、DSH 价格表导出四处口径互相打架。
# 本函数只做**观测**：把两源并列摆出来；不改任何价格、不改路由/估算行为。
#
# 三类不一致（任务口径，逐条列 candidate / 类型 / meta 值 / pricebook 值）：
#   ① value_diff     —— meta 声明了价、pricebook 也有价，但**逐槽位**比数字/结构不同（severity=conflict）；
#   ② meta_only      —— meta 有价，pricebook 无有效价（聚合视图会缺行）（severity=structural）；
#   ③ pricebook_only —— meta 无价，pricebook 有价（靠 capability_model_entry 现场补价）（severity=structural）。
# 比价一律**逐槽位（peak/offpeak/flat）对齐**，不按"当前时段"——两源的时段口径本就不同
# （网关政策 vs 各供应商闲时规则），按当前时段比会把同一张价目的峰谷槽比串、制造假红。
# status：真价差（①/read_error）或名单集合不等 ⇒ mismatch；只有 ②/③ 结构性缺项 ⇒ consistent
# （但缺项照样逐条列出，不隐藏）。
# 名单差集（meta 有/upstreams 无、upstreams 有/meta 无）放 roster 里如实列出，并计入 status。
#
# 注：本函数引用的 pricebook_offer()/load_pricebook() 定义在文件下方；Python 按调用时解析，
# 而本函数只在请求期（/health、/admin/api/price-consistency）被调用，模块加载期不会执行。
# ---------------------------------------------------------------------------

# 不再写死安装路径；按当前网关树定位工具，可用环境变量覆盖。
STALL_NOTIFY_PATH = os.environ.get(
    "STALL_NOTIFY_PATH",
    str(Path(os.environ.get("DSH_HOME") or BASE_DIR.parent) / "tools" / "stall-notify.mjs"),
)
STALL_NOTIFY_KEY = "price:dual-source"
STALL_NOTIFY_COOLDOWN_MIN = 360          # 与 stall-notify 自身的去重窗口一致
_STALL_NOTIFY_MIN_INTERVAL_S = 900.0     # 进程内节流：最多 15 分钟拉起一次 node（防 /health 轮询刷进程）
_STALL_NOTIFY_LOCK = threading.Lock()
_STALL_NOTIFY_LAST = {"at": 0.0}
PRICE_NOTIFY_ENV = "ROUTER_PRICE_NOTIFY"  # =0/false/no/off ⇒ 关掉告警外呼（测试/影子实例用）


def node_bin() -> str | None:
    """node 的**绝对**路径；找不到返回 None。

    T1 同类坑：cron/supervisor 的 PATH 里没有 /usr/local/bin，裸调 'node' 会 ENOENT。
    Python 侧没有 `process.execPath`，等价口径＝先按已知绝对路径找（/usr/local/bin/node 优先），
    再退到 shutil.which；两条路都没有就返回 None（调用方跳过告警，绝不影响 /health）。
    """
    for path in ("/usr/local/bin/node", "/usr/bin/node", "/bin/node"):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return shutil.which("node")


def price_notify_enabled() -> bool:
    raw = (os.environ.get(PRICE_NOTIFY_ENV) or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _slot_map(raw: Any) -> dict:
    """把价格块归一成 {槽位: 数字}：flat 型 → {"flat":v}；峰谷型 → {"peak":..,"offpeak":..}。

    只收真实数字（None/bool/非数字一律丢）；无任何数字 ⇒ {}（不猜价）。
    """
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return {"flat": round(float(raw), 3)}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, float] = {}
    for slot in ("flat", "peak", "offpeak"):
        val = raw.get(slot)
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            out[slot] = round(float(val), 3)
    return out


def _meta_price_sets(meta: dict) -> dict:
    """capability_meta **声明**的价：{input/output/cache_hit: {该键出现过的所有数字}}。

    只取「出现过哪些价格」，**不取它落在哪个槽位**——因为扁平写法（flat）与峰谷写法
    （peak/offpeak 同值）表达的是同一件事，形状不同不算不一致。
    """
    block = capability_price(meta)
    out: dict[str, set] = {}
    if not isinstance(block, dict):
        return out
    for name, key in (("input", "input_per_mtok"),
                      ("output", "output_per_mtok"),
                      ("cache_hit", "cache_hit_input_per_mtok")):
        slots = _slot_map(block.get(key))
        if slots:
            out[name] = set(slots.values())
    return out


# pricebook 采样点：工作日 24 个整点 + 周六 10:00（覆盖"周末维度"）。
# 为什么采样而不是取"当前有效价"：meta 的峰谷槽位按**网关统一政策**（工作日 09-12、14-18 为峰），
# pricebook 的有效价按**各供应商自己的规则**（供应商D 02-08 闲时、供应商C 09-12/14-18 ×2 乘数…）。
# 只取某一个时刻，会把两张本来一致的价目表比串（假红）；取「全周取值集合」则与时段口径无关：
#   供应商C base 1.0 + 09-12/14-18 ×2  ⇒ 集合 {1.0, 2.0}，正好等于 meta 的 {peak:2, offpeak:1}。
_PRICE_SAMPLE_HOURS = tuple(range(24))
_PRICE_SAMPLE_WEEKEND_HOUR = 10


def _sample_moment(hour: int, saturday: bool = False) -> datetime:
    """固定锚点的采样时刻（周一 2026-11-16 / 周六 2026-11-21，Asia/Shanghai）。

    用固定日期而不是"今天"：/health 的结果不应随星期几飘。
    """
    day = 21 if saturday else 16
    return datetime(2026, 11, day, hour, 0, 0, tzinfo=price_resolver.TZ_CN)


def _pricebook_price_sets(candidate: str) -> dict:
    """pricebook 每个价格键在**一整周内的取值集合**（按该报价自己的时段/乘数规则采样）。

    无报价/坏结构/无有效数字 ⇒ {}；绝不抛、不猜价。
    L5 单源化起：采样实现统一在 `_weekly_price_sets`（派生层与双源自检同一份口径）。
    """
    return _weekly_price_sets(pricebook_offer(candidate))


def _diverging_keys(meta_sets: dict, pb_sets: dict) -> dict:
    """逐键比「取值集合」；返回仅**键两侧都有**且集合不同的项 {键: {'meta':[..], 'pricebook':[..]}}。"""
    diffs: dict[str, dict] = {}
    for key in sorted(set(meta_sets) & set(pb_sets)):
        if meta_sets[key] != pb_sets[key]:
            diffs[key] = {"meta": sorted(meta_sets[key]), "pricebook": sorted(pb_sets[key])}
    return diffs


def price_consistency_snapshot() -> dict:
    """价格双源一致性快照（只读）。逐 candidate 判三类不一致，另附名单差集与缓存新鲜度。

    返回键：status / status_rule / checked_at / meta_models / hint_models / candidate_total /
            mismatch_count / counts / by_type / by_severity / mismatches / roster / period /
            routing_json_mtime[_ts] / pricebook_mtime_ts / process_started_at / stale_cache /
            pricebook_enabled。
    单个 candidate 出错只记该条，不影响整体。

    status 口径（明写，避免"看起来一致"的误读）：
      · mismatch —— 出现**真价差**（①：两源同键的取值集合不同）**或**名单集合不等；
      · consistent —— 无真价差且名单集合相等；此时若仍有 ②/③ 结构性缺项，
        它们照样逐条列在 mismatches 里（severity=structural），只是不把整灯打红。
    这样 /health 一眼能看出"是真冲突还是结构性缺行"，又不隐藏任何一条差异。
    """
    checked = time.time()
    period = current_period()
    names = sorted(set(CAPABILITY_META_MODELS) | set(HINT_CAPABILITY_MODELS))
    mismatches: list[dict] = []
    for candidate in names:
        try:
            meta_sets = _meta_price_sets(CAPABILITY_META_MODELS.get(candidate) or {})
            pb_sets = _pricebook_price_sets(candidate)
        except Exception as exc:  # 单条坏了只记这条，不拖垮 /health
            mismatches.append({"candidate": candidate, "type": "read_error",
                               "severity": "conflict", "meta": None, "pricebook": None,
                               "diff": None, "detail": f"{type(exc).__name__}: {exc}"})
            continue
        meta_block = ({k: sorted(v) for k, v in meta_sets.items()} or None)
        pb_block = ({k: sorted(v) for k, v in pb_sets.items()} or None)
        diffs = _diverging_keys(meta_sets, pb_sets)
        if diffs:
            mismatches.append({
                "candidate": candidate, "type": "value_diff", "severity": "conflict",
                "meta": meta_block, "pricebook": pb_block, "diff": diffs,
                "detail": "两源同键取值集合不同：" + ", ".join(
                    f"{k}(meta={diffs[k]['meta']} vs pb={diffs[k]['pricebook']})" for k in sorted(diffs)),
            })
        elif meta_sets and not pb_sets:
            mismatches.append({
                "candidate": candidate, "type": "meta_only", "severity": "structural",
                "meta": meta_block, "pricebook": None, "diff": None,
                "detail": "meta 声明了价，pricebook 无有效价（聚合/比价视图会缺行）",
            })
        elif pb_sets and not meta_sets:
            mismatches.append({
                "candidate": candidate, "type": "pricebook_only", "severity": "structural",
                "meta": None, "pricebook": pb_block, "diff": None,
                "detail": "meta 未填价，pricebook 有价（合并点会现场补价，两源口径本来就不一致）",
            })
        elif meta_sets and pb_sets and set(meta_sets) != set(pb_sets):
            # 公共键取值一致，但有一方多出/少了某个价格键（如 meta 有 cache_hit、pricebook 没有）
            only_meta = sorted(set(meta_sets) - set(pb_sets))
            only_pb = sorted(set(pb_sets) - set(meta_sets))
            mismatches.append({
                "candidate": candidate, "type": "key_diff", "severity": "structural",
                "meta": meta_block, "pricebook": pb_block, "diff": None,
                "detail": f"价格键覆盖不同：仅 meta 有 {only_meta}；仅 pricebook 有 {only_pb}",
            })

    by_type = {"value_diff": 0, "meta_only": 0, "pricebook_only": 0,
               "key_diff": 0, "read_error": 0}
    by_severity = {"conflict": 0, "structural": 0}
    for item in mismatches:
        key = str(item.get("type"))
        by_type[key] = by_type.get(key, 0) + 1
        sev = str(item.get("severity"))
        by_severity[sev] = by_severity.get(sev, 0) + 1

    routing_path = CONFIG_DIR / "routing.json"
    try:
        routing_mtime = routing_path.stat().st_mtime
    except OSError:
        routing_mtime = None
    try:
        pricebook_mtime = PRICEBOOK_PATH.stat().st_mtime
    except OSError:
        pricebook_mtime = None
    # 内存缓存过期判据：routing.json 在进程启动**之后**被改过 ⇒ capability_meta 是旧值
    stale_cache = bool(routing_mtime is not None and routing_mtime > PROC_START)
    roster_meta_only = sorted(set(CAPABILITY_META_MODELS) - HINT_CAPABILITY_SET)
    roster_upstream_only = sorted(HINT_CAPABILITY_SET - set(CAPABILITY_META_MODELS))
    roster_match = not roster_meta_only and not roster_upstream_only

    return {
        "status": ("consistent" if (by_severity["conflict"] == 0 and roster_match) else "mismatch"),
        "status_rule": ("mismatch ⇔ 真价差(value_diff/read_error) > 0 或 名单集合不等；"
                        "结构性缺项(meta_only/pricebook_only/key_diff)照样列出但不打红"),
        "checked_at": _iso_from_ts(checked),
        "meta_models": len(CAPABILITY_META_MODELS),
        "hint_models": len(HINT_CAPABILITY_MODELS),
        "candidate_total": len(names),
        "mismatch_count": len(mismatches),
        "counts": {"conflict": by_severity["conflict"], "structural": by_severity["structural"]},
        "by_type": by_type,
        "by_severity": by_severity,
        "mismatches": mismatches,
        "roster": {
            # 名单差集（信息项，也算进 status：集合不等即打红）
            "match": roster_match,
            "meta_only": roster_meta_only,
            "upstream_only": roster_upstream_only,
        },
        "period": period,
        "routing_json_mtime": (_iso_from_ts(routing_mtime) if routing_mtime else None),
        "routing_json_mtime_ts": routing_mtime,
        "pricebook_mtime_ts": pricebook_mtime,
        "process_started_at": _iso_from_ts(PROC_START),
        "stale_cache": stale_cache,
        "pricebook_enabled": pricebook_enabled(),
    }


def _notify_price_dual_source(snapshot: dict) -> None:
    """命中不一致时拉一次 tools/stall-notify.mjs（key=price:dual-source，冷却 360 分钟）。

    - 进程内节流 15 分钟：/health 可能被每秒轮询，不能每次都拉 node 进程；
    - node 一律用**绝对路径**（node_bin()，T1 同类 PATH 坑）；
    - 全程 try/except + 不检查退出码：告警失败绝不影响 /health、绝不改判据。
    """
    if not price_notify_enabled():
        return
    now = time.time()
    with _STALL_NOTIFY_LOCK:
        last = float(_STALL_NOTIFY_LAST.get("at") or 0.0)
        if now - last < _STALL_NOTIFY_MIN_INTERVAL_S:
            return
        _STALL_NOTIFY_LAST["at"] = now
    node = node_bin()
    if not node:
        LOG.warning("价格双源不一致，但找不到 node 可执行文件，跳过 stall-notify")
        return
    try:
        lines = [f"status={snapshot.get('status')} period={snapshot.get('period')} "
                 f"meta_models={snapshot.get('meta_models')} hint_models={snapshot.get('hint_models')} "
                 f"stale_cache={snapshot.get('stale_cache')}",
                 f"counts={snapshot.get('counts')} by_type={snapshot.get('by_type')}",
                 f"roster.match={snapshot.get('roster', {}).get('match')}"]
        for item in (snapshot.get("mismatches") or [])[:8]:
            lines.append(f"- {item.get('candidate')} [{item.get('type')}"
                         f"/{item.get('severity')}] meta={item.get('meta')} "
                         f"pricebook={item.get('pricebook')}")
        body = "\n".join(lines)
        subprocess.run(
            [node, STALL_NOTIFY_PATH,
             "--key", STALL_NOTIFY_KEY,
             "--title", "网关价格双源不一致（capability_meta vs pricebook）",
             "--body", body, "--level", "warn",
             "--cooldown-min", str(STALL_NOTIFY_COOLDOWN_MIN)],
            timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except Exception:
        LOG.warning("stall-notify 调用失败（已忽略，不影响 /health）", exc_info=True)


def price_consistency_payload() -> dict:
    """/health 用的安全包装：任何异常都不许把存活探针带下水。

    - ROUTER_PRICE_ATTEST=1 ⇒ 返回**单源自证**快照（S7 起默认开；S1–S6 默认关，golden 保持可对照 1.0.2.8）；
    - 否则返回旧双源快照（字段逐字节不变）；单源开启时**停用旧双源告警外呼**——
      pricebook 一刷新 meta 与 pricebook 就会合理分叉，旧告警会把正常调价当故障。
    """
    if price_attest_enabled():
        try:
            attest = price_attest_snapshot()
        except Exception as exc:
            LOG.exception("价格单源自证失败")
            return {"status": "error", "error": f"{type(exc).__name__}: {exc}",
                    "checked_at": _iso_from_ts(time.time())}
        if attest.get("status") == "mismatch":
            LOG.warning("价格单源自证不一致：unsourced=%s drift=%s fold_errors=%s",
                        (attest.get("coverage") or {}).get("unsourced"),
                        (attest.get("legacy") or {}).get("drift"),
                        len(attest.get("fold_errors") or []))
            _notify_price_attest(attest)
        return attest
    try:
        snapshot = price_consistency_snapshot()
    except Exception as exc:
        LOG.exception("价格双源一致性自检失败")
        return {"status": "error", "error": f"{type(exc).__name__}: {exc}",
                "checked_at": _iso_from_ts(time.time())}
    if snapshot.get("mismatch_count"):
        LOG.warning("价格双源不一致：%d 处（conflict=%s structural=%s period=%s）%s",
                    snapshot.get("mismatch_count"),
                    (snapshot.get("counts") or {}).get("conflict"),
                    (snapshot.get("counts") or {}).get("structural"),
                    snapshot.get("period"),
                    ", ".join(f"{m.get('candidate')}[{m.get('type')}]"
                              for m in (snapshot.get("mismatches") or [])[:6]))
    if snapshot.get("status") == "mismatch" and not price_single_source_enabled():
        _notify_price_dual_source(snapshot)
    return snapshot


# ---------------------------------------------------------------------------
# pricebook（P1 落地 2026-11-16）：config/pricebook.json 是**生成物**（scripts/price_sync.py），
# 只读、mtime 缓存；ROUTER_PRICEBOOK=0 或文件缺失 ⇒ 回退 capability_meta 旧读法。
# ---------------------------------------------------------------------------
PRICEBOOK_ENV = "ROUTER_PRICEBOOK"
PRICEBOOK_PATH = CONFIG_DIR / "pricebook.json"
PRICE_VIEWS = ("list", "effective", "best")
_PRICEBOOK_LOCK = threading.Lock()
_PRICEBOOK_CACHE: dict[str, Any] = {"mtime": None, "doc": None}


def pricebook_enabled() -> bool:
    raw = (os.environ.get(PRICEBOOK_ENV) or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def load_pricebook() -> dict | None:
    """读生成物（mtime 未变不重读）；缺失/坏 JSON ⇒ None（不抛、不猜价）。"""
    if not pricebook_enabled():
        return None
    try:
        mtime = PRICEBOOK_PATH.stat().st_mtime
    except OSError:
        return None
    with _PRICEBOOK_LOCK:
        if _PRICEBOOK_CACHE.get("mtime") == mtime:
            return _PRICEBOOK_CACHE.get("doc")
        try:
            doc = _read_json(PRICEBOOK_PATH)
        except Exception:
            LOG.warning("pricebook 读取失败，回落 capability_meta：%s", PRICEBOOK_PATH)
            doc = None
        _PRICEBOOK_CACHE.update(mtime=mtime, doc=doc)
        return doc


def pricebook_meta() -> dict:
    book = load_pricebook()
    if not book:
        return {"enabled": False, "path": str(PRICEBOOK_PATH)}
    return {
        "enabled": True,
        "schema": book.get("schema"),
        "generated_at": book.get("generated_at"),
        "degraded": book.get("degraded") or [],
        "snapshots": book.get("snapshots") or [],
        "families": sorted((book.get("models") or {}).keys()),
    }


def _pricebook_nodes() -> list[dict]:
    book = load_pricebook() or {}
    return [node for node in (book.get("models") or {}).values() if isinstance(node, dict)]


def pricebook_offer(candidate: str) -> dict | None:
    """按 candidate（provider/model）取报价；找不到 ⇒ None。"""
    upstream_id, model_id = split_candidate(candidate)
    for node in _pricebook_nodes():
        for offer in node.get("offers") or []:
            if offer.get("provider") == upstream_id and offer.get("model_id") == model_id:
                return offer
    return None


def pricebook_family(family: str) -> dict | None:
    for node in _pricebook_nodes():
        if node.get("family") == family or (node.get("offers") or [{}])[0].get("family") == family:
            return node
    return None


# ---------------------------------------------------------------------------
# L5 单源化（2026-11-21 S1）：价格块统一由 pricebook 派生（只读、零副作用）
#
# 真源：config/pricebook.json（市场价，scripts/price_sync.py 生成）
#      ＋ config/price-supplements.json（抓不到的事实：缓存价、别名；派生层合并）
# 派生：别名解析 → offer（可叠加补记）→ 周 25 点采样（与双源自检同一锚点）→ 每键取值集合折叠
#       1 值 ⇒ 两槽同值；2 值 ⇒ peak=max / offpeak=min；>2 值 ⇒ 报错（两档契约表达不了，不硬折）
# 缓存：按 (pricebook mtime, supplements mtime) 缓存；改价目下一次请求即生效，无需重启
# 回退：ROUTER_PRICE_SINGLE_SOURCE=0 ⇒ capability_meta 旧读法（S1 不删 meta 价，双写一版）
# ---------------------------------------------------------------------------
PRICE_SINGLE_SOURCE_ENV = "ROUTER_PRICE_SINGLE_SOURCE"
PRICE_ATTEST_ENV = "ROUTER_PRICE_ATTEST"
SUPPLEMENTS_PATH = CONFIG_DIR / "price-supplements.json"
_PRICE_ATTEST_NOTIFY_KEY = "price:attest"
_SR_ONLY_VALUES = ("0", "false", "no", "off")


def price_single_source_enabled() -> bool:
    raw = (os.environ.get(PRICE_SINGLE_SOURCE_ENV) or "").strip().lower()
    return raw not in _SR_ONLY_VALUES


def price_attest_enabled() -> bool:
    # 1.0.3.2 T9：发布态默认开（单源自证取代旧双源快照）；env=0/false/no/off 可回退旧口径。
    raw = (os.environ.get(PRICE_ATTEST_ENV) or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _is_price_num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _normalize_price_number(value: float) -> int | float:
    """整数价输出 int（与既有配置/golden 的表示一致），非整数保留 float。"""
    num = float(value)
    return int(num) if num == int(num) else num


_SUPP_CACHE_LOCK = threading.Lock()
_SUPP_CACHE: dict[str, Any] = {"mtime": None, "doc": {}}


def load_price_supplements() -> dict:
    """读 config/price-supplements.json（mtime 缓存）；缺失/坏结构 ⇒ {}（不猜价）。"""
    try:
        mtime = SUPPLEMENTS_PATH.stat().st_mtime
    except OSError:
        return {}
    with _SUPP_CACHE_LOCK:
        if _SUPP_CACHE.get("mtime") == mtime:
            return _SUPP_CACHE.get("doc") or {}
        try:
            doc = _read_json(SUPPLEMENTS_PATH)
        except Exception:
            LOG.warning("price-supplements 读取失败（按空处理）：%s", SUPPLEMENTS_PATH)
            doc = {}
        if not isinstance(doc, dict):
            doc = {}
        _SUPP_CACHE.update(mtime=mtime, doc=doc)
        return doc


def price_aliases() -> dict:
    """价格别名（provider/model → provider/model）：pricebook.supplements 与补记文件合并。"""
    out: dict[str, str] = {}
    book = load_pricebook() or {}
    supp_book = book.get("supplements")
    book_aliases = (supp_book or {}).get("aliases") if isinstance(supp_book, dict) else None
    for src in (book_aliases, load_price_supplements().get("aliases")):
        if not isinstance(src, dict):
            continue
        for key, val in src.items():
            if isinstance(key, str) and isinstance(val, str) and key and val:
                out[key] = val
    return out


def resolve_price_candidate(candidate: str, aliases: dict | None = None) -> str:
    """沿别名链解析到真实报价候选；环检测，最多 8 跳（防御坏配置）。"""
    table = aliases if isinstance(aliases, dict) else price_aliases()
    seen: set[str] = set()
    current = candidate
    for _ in range(8):
        if current not in table or current in seen:
            break
        seen.add(current)
        current = table[current]
    return current


def _supplement_patch(candidate: str) -> dict | None:
    node = (load_price_supplements().get("candidates") or {}).get(candidate)
    patch = node.get("price_patch") if isinstance(node, dict) else None
    return patch if isinstance(patch, dict) and patch else None


def _offer_with_supplement(candidate: str, offer: dict) -> dict:
    """补记按 offer 副本叠加（不改 pricebook 内存对象；S7 并入发布物后仍幂等）。"""
    patch = _supplement_patch(candidate)
    if not patch:
        return offer
    try:
        item = json.loads(json.dumps(offer))
    except Exception:
        return offer
    price = item.setdefault("price", {})
    if not isinstance(price, dict):
        price = {}
        item["price"] = price
    for key, block in patch.items():
        price[key] = block
    return item


def _zero_price_block() -> dict:
    zero = {"peak": 0, "offpeak": 0}
    return {"currency": CAPABILITY_CURRENCY_DEFAULT,
            "input_per_mtok": dict(zero),
            "output_per_mtok": dict(zero),
            "cache_hit_input_per_mtok": dict(zero)}


def _fold_price_sets(sets: dict) -> tuple[dict, list[str]]:
    """每键周取值集合 → 两档块；>2 个不同值不硬折（两档契约表达不了），记错。"""
    folded: dict[str, Any] = {}
    errors: list[str] = []
    for key in ("input", "output", "cache_hit"):
        vals = sets.get(key) or set()
        nums = sorted({_normalize_price_number(round(float(v), 6))
                       for v in vals if _is_price_num(v)})
        if not nums:
            folded[key] = None
        elif len(nums) == 1:
            folded[key] = {"peak": nums[0], "offpeak": nums[0]}
        elif len(nums) == 2:
            folded[key] = {"peak": nums[1], "offpeak": nums[0]}
        else:
            folded[key] = None
            errors.append(f"{key}:{len(nums)}distinct_values")
    return folded, errors


def _weekly_price_sets(offer: dict) -> dict:
    """给定 offer，采一整周（工作日 24 整点＋周六 10:00）每个价格键的取值集合。"""
    if not isinstance(offer, dict):
        return {}
    out: dict[str, set] = {}
    try:
        moments = [_sample_moment(hour) for hour in _PRICE_SAMPLE_HOURS]
        moments.append(_sample_moment(_PRICE_SAMPLE_WEEKEND_HOUR, saturday=True))
        for moment in moments:
            priced = price_resolver.effective_price(offer, at=moment)
            prices = (priced or {}).get("prices") or {}
            for name in ("input", "output", "cache_hit"):
                val = prices.get(name)
                if _is_price_num(val):
                    out.setdefault(name, set()).add(round(float(val), 3))
    except Exception:
        return {}
    return out


def _derive_block_from_offer(offer: dict) -> tuple[dict | None, list[str]]:
    """offer → (capability 价格块 | None, 折叠错误列表)。"""
    folded, errors = _fold_price_sets(_weekly_price_sets(offer))
    if folded.get("input") is None and folded.get("output") is None:
        return None, errors or ["no price numbers"]
    return {"currency": _offer_currency(offer),
            "input_per_mtok": folded.get("input"),
            "output_per_mtok": folded.get("output"),
            "cache_hit_input_per_mtok": folded.get("cache_hit")}, errors


_DERIVED_LOCK = threading.Lock()
_DERIVED_CACHE: dict[str, Any] = {"key": None, "blocks": {}, "classes": {}, "errors": {}}


def _file_mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _derived_cache_key() -> tuple:
    return (_file_mtime(PRICEBOOK_PATH), _file_mtime(SUPPLEMENTS_PATH), pricebook_enabled())


def _derive_price_uncached(candidate: str) -> tuple[dict | None, str, list[str]]:
    if not pricebook_enabled():
        return None, "pricebook-disabled", ["pricebook disabled"]
    aliases = price_aliases()
    real = resolve_price_candidate(candidate, aliases)
    offer = pricebook_offer(real)
    if offer is None:
        upstream_id, _ = split_candidate(candidate)
        if upstream_id == "provider_b":
            return _zero_price_block(), "local", []
        return None, "no-source", ["no pricebook offer"]
    block, errors = _derive_block_from_offer(_offer_with_supplement(real, offer))
    if block is None:
        return None, "no-source", errors or ["no usable price numbers"]
    if real != candidate:
        price_class = "alias"
    elif _supplement_patch(real):
        price_class = "offer+supplement"
    else:
        price_class = "offer"
    return block, price_class, errors


def derived_price(candidate: str) -> tuple[dict | None, str, list[str]]:
    """派生价格块（按 pricebook/supplements mtime 缓存）；返回 (块, 类别, 折叠错误)。"""
    key = _derived_cache_key()
    with _DERIVED_LOCK:
        if _DERIVED_CACHE.get("key") != key:
            _DERIVED_CACHE.update(key=key, blocks={}, classes={}, errors={})
        if candidate in _DERIVED_CACHE["blocks"]:
            return (_DERIVED_CACHE["blocks"][candidate],
                    _DERIVED_CACHE["classes"][candidate],
                    list(_DERIVED_CACHE["errors"][candidate]))
    block, price_class, errors = _derive_price_uncached(candidate)
    with _DERIVED_LOCK:
        if _DERIVED_CACHE.get("key") == key:
            _DERIVED_CACHE["blocks"][candidate] = block
            _DERIVED_CACHE["classes"][candidate] = price_class
            _DERIVED_CACHE["errors"][candidate] = errors
    return block, price_class, errors


def _shim_number_types(derived: dict | None, legacy: dict | None) -> dict | None:
    """类型垫片（双写期）：数值相同 ⇒ 沿用 legacy 的 int/float 表示，保逐字节一致。

    仅过渡期用（S1 不删 meta 价）；删掉 meta 价格后按 `_normalize_price_number` 规范输出。
    """
    if not isinstance(derived, dict) or not isinstance(legacy, dict):
        return derived
    try:
        out = json.loads(json.dumps(derived))
    except Exception:
        return derived
    for key in ("input_per_mtok", "output_per_mtok", "cache_hit_input_per_mtok"):
        db, lb = out.get(key), legacy.get(key)
        if not isinstance(db, dict) or not isinstance(lb, dict):
            continue
        for slot in ("peak", "offpeak"):
            dv, lv = db.get(slot), lb.get(slot)
            if _is_price_num(dv) and _is_price_num(lv) and float(dv) == float(lv):
                db[slot] = lv
    return out


def _derived_price_source(candidate: str, price_class: str | None) -> str | None:
    if price_class == "local":
        return "本地模型：自托管，单价 0"
    if price_class in ("offer", "offer+supplement", "alias"):
        return "价格来源：pricebook 单源派生（周采样折叠两档）"
    return None


def price_source_text(candidate: str, meta: dict | None) -> str | None:
    """价格来源文案：meta 有就沿用（逐字节不变）；没有才给派生默认文案。"""
    src = (meta or {}).get("price_source") if isinstance(meta, dict) else None
    if isinstance(src, str) and src.strip():
        return src
    if not price_single_source_enabled():
        return None
    _, price_class, _ = derived_price(candidate)
    return _derived_price_source(candidate, price_class)


def _pricebook_sha256() -> str | None:
    try:
        return hashlib.sha256(PRICEBOOK_PATH.read_bytes()).hexdigest()
    except OSError:
        return None


def _price_block_value_diffs(derived: dict | None, legacy: dict | None) -> list[dict]:
    """单源等价性：legacy 有数字而派生缺/不同 ⇒ 记差异（legacy 无价不算差异）。"""
    diffs: list[dict] = []
    if not isinstance(derived, dict) or not isinstance(legacy, dict):
        return diffs
    for key in ("input_per_mtok", "output_per_mtok", "cache_hit_input_per_mtok"):
        db, lb = derived.get(key), legacy.get(key)
        if not isinstance(lb, dict):
            continue
        db = db if isinstance(db, dict) else {}
        for slot in ("peak", "offpeak"):
            lv, dv = lb.get(slot), db.get(slot)
            if not _is_price_num(lv):
                continue
            if not _is_price_num(dv):
                diffs.append({"key": key, "slot": slot, "derived": dv, "legacy": lv})
            elif float(dv) != float(lv):
                diffs.append({"key": key, "slot": slot, "derived": dv, "legacy": lv})
    return diffs


def _price_block_type_drift(derived: dict | None, legacy: dict | None) -> bool:
    if not isinstance(derived, dict) or not isinstance(legacy, dict):
        return False
    for key in ("input_per_mtok", "output_per_mtok", "cache_hit_input_per_mtok"):
        db, lb = derived.get(key), legacy.get(key)
        if not isinstance(db, dict) or not isinstance(lb, dict):
            continue
        for slot in ("peak", "offpeak"):
            dv, lv = db.get(slot), lb.get(slot)
            if _is_price_num(dv) and _is_price_num(lv) and float(dv) == float(lv) \
                    and type(dv) is not type(lv):
                return True
    return False


def _pricebook_orphan_offers() -> list[str]:
    """pricebook 里有、但 upstreams 已无的报价（聚合/比价视图会出现，信息项）。"""
    out = []
    for node in _pricebook_nodes():
        for offer in node.get("offers") or []:
            candidate = f"{offer.get('provider')}/{offer.get('model_id')}"
            if candidate not in HINT_CAPABILITY_SET:
                out.append(candidate)
    return sorted(out)


def price_attest_snapshot() -> dict:
    """单源自证（ROUTER_PRICE_ATTEST=1 时挂到 /health.price_consistency）。

    A 等价性：派生块 vs legacy meta 数值逐项（双写期守护，drift 应为 0）；
    B 覆盖性：每个候选都有来源（offer/offer+supplement/alias/local），unsourced 应为 0；
    orphan_offers 只列信息，不计红。
    """
    checked = time.time()
    candidates = sorted(set(CAPABILITY_META_MODELS) | HINT_CAPABILITY_SET)
    classes: dict[str, int] = {}
    unsourced: list[str] = []
    drift: list[dict] = []
    type_shim: list[str] = []
    fold_errors: list[dict] = []
    derived_count = 0
    for candidate in candidates:
        meta = CAPABILITY_META_MODELS.get(candidate) or {}
        legacy = capability_price(meta)
        block, price_class, errors = derived_price(candidate)
        classes[price_class] = classes.get(price_class, 0) + 1
        if errors:
            fold_errors.append({"candidate": candidate, "errors": list(errors)})
        if block is None:
            unsourced.append(candidate)
            continue
        derived_count += 1
        diffs = _price_block_value_diffs(block, legacy)
        if diffs:
            drift.append({"candidate": candidate, "diffs": diffs})
        elif _price_block_type_drift(block, legacy):
            type_shim.append(candidate)
    roster_meta_only = sorted(set(CAPABILITY_META_MODELS) - HINT_CAPABILITY_SET)
    roster_upstream_only = sorted(HINT_CAPABILITY_SET - set(CAPABILITY_META_MODELS))
    roster_match = not roster_meta_only and not roster_upstream_only
    book = load_pricebook() or {}
    supp_book = book.get("supplements") if isinstance(book.get("supplements"), dict) else {}
    applied = supp_book.get("applied")
    status = ("consistent" if (not unsourced and not drift and not fold_errors and roster_match)
              else "mismatch")
    return {
        "status": status,
        "status_rule": ("mismatch ⇔ unsourced>0 或 legacy_drift>0 或 折叠错误>0 或 名单集合不等；"
                        "orphan_offers 仅信息项，不计红"),
        "mode": "single-source",
        "source": {
            "single_source_enabled": price_single_source_enabled(),
            "pricebook_enabled": pricebook_enabled(),
            "schema": book.get("schema"),
            "generated_at": book.get("generated_at"),
            "sha256": _pricebook_sha256(),
            "supplements_file": str(SUPPLEMENTS_PATH),
            "supplements_aliases": len(price_aliases()),
            "supplements_applied_in_book": len(applied) if isinstance(applied, list) else None,
        },
        "coverage": {
            "candidates": len(candidates),
            "derived": derived_count,
            "classes": classes,
            "unsourced": len(unsourced),
            "unsourced_ids": unsourced,
        },
        "legacy": {
            "meta_models": len(CAPABILITY_META_MODELS),
            "drift": len(drift),
            "drift_items": drift,
            "type_shim_rows": len(type_shim),
            "type_shim_ids": type_shim,
        },
        "orphan_offers": _pricebook_orphan_offers(),
        "roster": {"match": roster_match, "meta_only": roster_meta_only,
                    "upstream_only": roster_upstream_only},
        "fold_errors": fold_errors,
        "period": current_period(),
        "checked_at": _iso_from_ts(checked),
        "stale": {
            "pricebook_mtime_ts": _file_mtime(PRICEBOOK_PATH),
            "supplements_mtime_ts": _file_mtime(SUPPLEMENTS_PATH),
            "process_started_at": _iso_from_ts(PROC_START),
        },
    }


_ATTEST_NOTIFY_LOCK = threading.Lock()
_ATTEST_NOTIFY_LAST = {"at": 0.0}
_ATTEST_NOTIFY_MIN_INTERVAL_S = 900.0


def _notify_price_attest(snapshot: dict) -> None:
    """单源自证命中（unsourced/drift）时外呼 stall-notify（进程内 15 分钟节流）。

    只读诊断；告警失败绝不影响 /health。单源期旧"双源不一致"告警已停用，由本告警接手。
    """
    if not price_notify_enabled():
        return
    now = time.time()
    with _ATTEST_NOTIFY_LOCK:
        if now - float(_ATTEST_NOTIFY_LAST.get("at") or 0.0) < _ATTEST_NOTIFY_MIN_INTERVAL_S:
            return
        _ATTEST_NOTIFY_LAST["at"] = now
    node = node_bin()
    if not node:
        LOG.warning("价格单源自证不一致，但找不到 node，跳过 stall-notify")
        return
    coverage = snapshot.get("coverage") or {}
    legacy = snapshot.get("legacy") or {}
    lines = [f"mode={snapshot.get('mode')} status={snapshot.get('status')} "
             f"unsourced={coverage.get('unsourced')} drift={legacy.get('drift')} "
             f"fold_errors={len(snapshot.get('fold_errors') or [])}",
             f"pricebook={snapshot.get('source', {}).get('generated_at')} "
             f"sha256={(snapshot.get('source', {}).get('sha256') or '')[:16]}",
             "unsourced_ids=" + ",".join(coverage.get("unsourced_ids") or [])]
    for item in (legacy.get("drift_items") or [])[:6]:
        lines.append(f"- {item.get('candidate')} {item.get('diffs')}")
    try:
        subprocess.run(
            [node, STALL_NOTIFY_PATH,
             "--key", _PRICE_ATTEST_NOTIFY_KEY,
             "--title", "网关价格单源自证不一致（unsourced/legacy_drift）",
             "--body", "\n".join(lines), "--level", "warn",
             "--cooldown-min", str(STALL_NOTIFY_COOLDOWN_MIN)],
            timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    except Exception:
        LOG.warning("stall-notify 调用失败（已忽略，不影响 /health）", exc_info=True)



def _offer_view(offer: dict, view: str, group: str | None) -> dict:
    if view == "list":
        return price_resolver.list_price(offer)
    if view == "best":
        return price_resolver.best_case(offer, group=group)
    return price_resolver.effective_price(offer, group=group)


def _fmt_price(v: Any) -> str:
    """单价格式化：¥入/出 两个数，**固定 3 位小数**（用户 2026-11-17 定）。

    2026-11-17 13:15 约定「单位价（¥/百万 token）也按小数点后三位计」⇒ 由 `:g`（1.2 / 2）
    改为 `:.3f`（1.200 / 2.000）。缺价 → 空串，不写 0 假数。
    """
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return ""
    return f"{v:.3f}"


def display_label(provider: str | None, label: str | None,
                  price_in: Any = None, price_out: Any = None) -> str:
    """统一显示规则：`供应商/模型标签/¥入/出`。

    - 单价只取输入/输出两个数（缓存价留给比价表）；
    - 任一侧缺价 ⇒ 不带价段（保持 `供应商/模型标签`），不猜价、不写 0；
    - provider/label 缺失时用占位 `?`，保证段数恒定、便于机器解析。
    """
    prov = (provider or "?").strip() or "?"
    name = (label or "?").strip() or "?"
    pin, pout = _fmt_price(price_in), _fmt_price(price_out)
    if pin and pout:
        return f"{prov}/{name}/¥{pin}/{pout}"
    return f"{prov}/{name}"


def offer_display_label(offer: dict, view: str = "effective",
                        group: str | None = None) -> str:
    """按 pricebook offer 生成 display_label（默认当前时段有效价）。"""
    provider = offer.get("provider")
    label = offer.get("display") or offer.get("model_id")
    try:
        priced = _offer_view(offer, view, group)
        prices = priced.get("prices") or {}
    except Exception:
        prices = {}
    return display_label(provider, label, prices.get("input"), prices.get("output"))


def price_aggregate(model: str, view: str = "effective", group: str | None = None) -> dict:
    """同模型跨供应商聚合视图：family 名或 candidate 都接受。"""
    view = view if view in PRICE_VIEWS else "effective"
    node = pricebook_family(model)
    if node is None:
        offer = pricebook_offer(model)
        if offer is None:
            return {"model": model, "view": view, "group": group, "count": 0, "offers": [],
                    "note": "pricebook 未收录（或 ROUTER_PRICEBOOK=0），回落 capability_meta 行"}
        node = {"family": offer.get("family"), "offers": [offer]}
    rows = []
    for offer in node.get("offers") or []:
        meta = offer.get("meta") or {}
        candidate = f"{offer.get('provider')}/{offer.get('model_id')}"
        try:
            priced = _offer_view(offer, view, group)
        except Exception:
            priced = {"currency": "CNY", "prices": {}, "note": "价格结构不可用"}
        row = {
            "id": offer.get("id") or candidate,
            "display_label": display_label(offer.get("provider"),
                                           offer.get("display") or offer.get("model_id"),
                                           (priced.get("prices") or {}).get("input"),
                                           (priced.get("prices") or {}).get("output")),
            "provider": offer.get("provider"),
            "model_id": offer.get("model_id"),
            "billing": offer.get("billing"),
            "routable": candidate in HINT_CAPABILITY_SET,
            "pricing": priced,
            "confidence": meta.get("confidence"),
            "estimated": bool(meta.get("estimated")),
            "comparable": bool(meta.get("comparable", True)),
            "source": (meta.get("source") or {}).get("url"),
            "fetched_at": (meta.get("source") or {}).get("fetched_at"),
        }
        rows.append(row)
    def _sort_input(row: dict) -> float:
        value = (row["pricing"].get("prices") or {}).get("input")
        if isinstance(value, dict):
            nums = [v for v in (value.get("peak"), value.get("offpeak"))
                    if isinstance(v, (int, float))]
            return min(nums) if nums else 0.0
        return float(value) if isinstance(value, (int, float)) else 0.0

    rows.sort(key=lambda r: (not r["comparable"], r["estimated"], _sort_input(r)))
    return {"model": model, "family": node.get("family"), "view": view, "group": group,
            "count": len(rows), "offers": rows}


def price_catalog_payload(query: dict | None = None) -> dict:
    """GET /v1/route/prices：旧字段逐字节保留；新增 pricebook 元信息与 ?model=&view= 聚合视图。

    ?model=<family|candidate>  同模型跨供应商报价（pricebook）；
    ?view=effective|list|best  默认 effective（当前时刻真实价）；
    ?group=<分组>              供应商C等分组倍率（如 gc-chat）。
    """
    query = query or {}
    rows = []
    for candidate in CAPABILITY_META_MODELS:
        entry = capability_model_entry(candidate)
        meta = CAPABILITY_META_MODELS.get(candidate) or {}
        entry["routable"] = candidate in HINT_CAPABILITY_SET
        entry["price_source"] = price_source_text(candidate, meta)
        entry["price_note"] = meta.get("price_note")
        # Q2-7：三态只加在 /v1/route/prices 上（capabilities v2 的字段集保持 r4 契约不变）
        _state = price_state_of(candidate, entry.get("provider"), entry.get("price"))
        entry["price_state"] = _state
        entry["price_label"] = price_label_of(_state, entry.get("display_label"))
        rows.append(entry)
    # ── Q2-7（2026-11-18）：价格三态（priced/local/unpriced）+ schema 版本 ──
    # 口径（1.0.2 已定）：本地 → 0（本地）；云端未填价 → 0（待用户录入）且保留未定价标记；
    # 25 个可路由模型「全部有价态」，不再出现「price 全 null、调用方自己猜」。
    counts = {"priced": 0, "local": 0, "unpriced": 0}
    unpriced_ids: list[str] = []
    for row in rows:
        state = str(row.get("price_state") or "unpriced")
        counts[state] = counts.get(state, 0) + 1
        if state == "unpriced":
            unpriced_ids.append(str(row.get("id")))
    payload = {"ok": True, "schema": "wb-route-prices/2",
               "currency": CAPABILITY_CURRENCY_DEFAULT,
               "period": current_period(),
               "peak_rule": "工作日 09:00-12:00、14:00-18:00 为高峰；周末全天低谷",
               "price_policy": {
                   "local": "0（本地）",
                   "unpriced": "0（待用户录入）·未定价（不当作免费）",
                   "priced": "按已填单价估算",
               },
               "counts": counts,
               "unpriced_ids": unpriced_ids,
               "models": rows,
               "pricebook": pricebook_meta()}
    model = str((query.get("model") or [""])[0] or "").strip()
    if model:
        view = str((query.get("view") or ["effective"])[0] or "effective").strip()
        group = (query.get("group") or [None])[0]
        payload["aggregate"] = price_aggregate(model, view, group)
    return payload


def capabilities_payload() -> dict:
    """GET /v1/route/capabilities：契约 §4 结构（v / tiers / models / defaults / limits）。

    v2（默认）：models 是对象列表（id/provider/tier/context_window/max_tokens/modality/price），
    另带 models_legacy=[id...] 供按字符串列表解析的调用方过渡；
    ROUTER_CAPABILITIES_V2=0 ⇒ models 仍是旧的纯字符串列表（逐字节兼容）。
    """
    v2 = capabilities_v2_enabled()
    payload = {
        "v": HINT_CONTRACT_VERSION,
        "tiers": {name: list(chain) for name, chain in HINT_TIERS.items()},
        "models": ([capability_model_entry(c) for c in HINT_CAPABILITY_MODELS]
                   if v2 else list(HINT_CAPABILITY_MODELS)),
        "defaults": {"tier": HINT_DEFAULT_TIER},
        "limits": {"hint_max_bytes": HINT_MAX_HEADER_BYTES},
    }
    if v2:
        payload["models_legacy"] = list(HINT_CAPABILITY_MODELS)
    return payload


def hint_model_usable(candidate: str, features: Features,
                      state_map: dict | None = None) -> tuple[bool, str]:
    """决策期可用性：熔断 / RPM / AFP 闸门 / 能力（vision/上下文）。只读，不改状态。"""
    up_id, model_id = split_candidate(candidate)
    st = (state_map or STATE).get(up_id)
    if st is None:
        return False, "unknown_upstream"
    allowed, why = st.allow(time.time())
    if not allowed:
        return False, why
    ok_afp, why_afp = afp_gate_check(up_id, features.est_input_tokens)
    if not ok_afp:
        return False, why_afp
    return candidate_supported(up_id, model_id, features)


def _first_usable(chain: list[str], features: Features,
                  state_map: dict | None = None) -> tuple[str | None, int]:
    for cand in chain:
        ok, _why = hint_model_usable(cand, features, state_map)
        if ok:
            return cand, 0
    return None, 1


def build_hint_decision(parsed: ParsedHint, features: Features,
                        state_map: dict | None = None) -> dict:
    """hint 执行梯队（纯决策，不调上游）：model 可用→用之；否则按 tier；再否则默认（candidates=None）。

    返回 {candidates, fallback, reason, model, would_choose, would_fallback}；
    reason 枚举：ok / model_missing / model_unknown / model_unavailable / tier_invalid。
    """
    tier_chain = list(HINT_TIERS.get(parsed.tier) or []) if parsed.tier else []
    model = parsed.model
    if model and model in HINT_CAPABILITY_SET:
        usable, _why = hint_model_usable(model, features, state_map)
        if usable:
            chain = [model] + [c for c in tier_chain if c != model]
            return {"candidates": chain, "fallback": 0, "reason": "ok",
                    "model": model, "would_choose": model, "would_fallback": 0}
        if tier_chain:
            would, wf = _first_usable(tier_chain, features, state_map)
            return {"candidates": tier_chain, "fallback": 1, "reason": "model_unavailable",
                    "model": model, "would_choose": would, "would_fallback": wf}
        return {"candidates": None, "fallback": 1, "reason": "model_unavailable",
                "model": model, "would_choose": None, "would_fallback": 1}
    if tier_chain:
        would, wf = _first_usable(tier_chain, features, state_map)
        return {"candidates": tier_chain, "fallback": 1,
                "reason": "model_missing" if not model else "model_unknown",
                "model": model, "would_choose": would, "would_fallback": wf}
    return {"candidates": None, "fallback": 1,
            "reason": "tier_invalid" if not model else "model_unknown",
            "model": model, "would_choose": None, "would_fallback": 1}


def build_hint_ctx(parsed: ParsedHint | None, virtual_model: str) -> dict:
    """计数 + 汇总 hint 上下文（进 ctx，供账本/响应头使用）。"""
    if parsed is None:
        return {"present": False, "ok": False}
    _hint_add(received=1)
    if not parsed.ok:
        _hint_add(invalid=1)
        return {"present": True, "ok": False, "error": parsed.error, "mode": HINT_MODE,
                "tier": None, "model": None, "stage": None, "session": None,
                "reason_field": None, "virtual": False, "executed": False,
                "confirm_missing": []}
    _hint_add(valid=1)
    if HINT_MODE == "record":
        _hint_add(record_only=1)
    if parsed.incomplete_missing:
        _hint_add(incomplete=1)
    return {"present": True, "ok": True, "error": None, "mode": HINT_MODE,
            "tier": parsed.tier, "model": parsed.model, "stage": parsed.stage,
            "session": parsed.session, "reason_field": parsed.reason,
            "virtual": virtual_model in VIRTUAL_MODELS, "executed": False,
            "confirm_missing": list(parsed.incomplete_missing)}


def hint_outcome(chosen: str | None, hctx: dict | None) -> tuple[int | None, str | None]:
    """最终 (fallback, reason枚举)：与响应头 X-DSH-Route-Fallback/Reason 同源。

    无头 → (None, None)；结构非法 → (1, "hint_invalid")；显式模型透传 → (1, "explicit_model")；
    record 灰度 → (1, "record_only")；execute 且决策直用 hint 模型但调用期失败 → (1, "model_failed")。
    """
    if not hctx or not hctx.get("present"):
        return None, None
    if not hctx.get("ok"):
        return 1, "hint_invalid"
    if not hctx.get("virtual"):
        return 1, "explicit_model"
    if hctx.get("mode") == "record":
        return 1, "record_only"
    decision = hctx.get("decision")
    if not decision:
        return 1, "tier_invalid"
    if decision.get("fallback") == 0:
        if chosen and chosen == decision.get("model"):
            return 0, "ok"
        return 1, "model_failed"
    return 1, decision.get("reason") or "tier_invalid"


def hint_applied(hctx: dict | None) -> int:
    """账本 applied 列（跨侧口径 2026-11-12，与灰狼逐字对齐）：hint 实际生效并改写了
    本次选档 → 1，否则 0。判定＝灰度档为 execute 且 hctx["executed"] 为真（即
    decision.candidates 被采用）；record 灰度恒 0（只观测不执行）。

    hctx["mode"] 是请求期 HINT_MODE 的快照（build_hint_ctx 写入），不读全局、纯函数；
    `executed` 只在 execute 模式且决策有候选链时置真，两条件合起来＝口径原文。
    注意 applied≠fallback：fallback 是「判定回落」，record 下也记 1；是否真按 hint 选档看本列。
    """
    if not hctx or hctx.get("mode") != "execute":
        return 0
    return 1 if hctx.get("executed") else 0


def hint_ledger_fields(chosen: str | None, hctx: dict | None) -> dict:
    """账本 hint 字段（契约 §5：hint / tier / model_requested / model_chosen / fallback /
    hint_stage / session + 观测扩展）＋守门字段（接口单 §五）。顶层 stage 已被复杂度
    L1/L2/L3 占用，hint 的 stage 标签记为 hint_stage（不改既有字段语义）。"""
    if not hctx or not hctx.get("present"):
        fields = {"hint": 0, "hint_error": None, "tier": None, "model_requested": None,
                  "model_chosen": chosen, "fallback": None, "applied": 0, "hint_stage": None,
                  "session": None, "hint_reason": None, "hint_mode": None,
                  "hint_incomplete": False, "hint_incomplete_missing": []}
        # X-DSH-Check 可能带了而 X-DSH-Route 没带：守门观测照记
        fields.update(guard_ledger_fields(
            (hctx or {}).get("raw_tier"), (hctx or {}).get("raw_model"), (hctx or {}).get("guard")))
        return fields
    fallback, reason = hint_outcome(chosen, hctx)
    fields = {
        "hint": 1 if hctx.get("ok") else 0,
        "hint_error": hctx.get("error"),
        "tier": hctx.get("tier"),
        "model_requested": hctx.get("model"),
        "model_chosen": chosen,
        "fallback": fallback,
        "applied": hint_applied(hctx),
        "hint_stage": hctx.get("stage"),
        "session": hctx.get("session"),
        "hint_reason": reason,
        "hint_mode": hctx.get("mode"),
        "hint_incomplete": bool(hctx.get("confirm_missing")),
        "hint_incomplete_missing": list(hctx.get("confirm_missing") or []),
    }
    # record 灰度：额外记「若执行会怎么选」，供观察周对比
    if hctx.get("ok") and hctx.get("mode") == "record" and hctx.get("decision"):
        decision = hctx["decision"]
        fields["hint_would_choose"] = decision.get("would_choose")
        fields["hint_would_fallback"] = decision.get("would_fallback")
    fields.update(guard_ledger_fields(hctx.get("raw_tier"), hctx.get("raw_model"), hctx.get("guard")))
    return fields


# ---------------------------------------------------------------------------
# 换挡守门（接口单 v1.0：X-DSH-Check；对应融合契约 §二/§四）
# ---------------------------------------------------------------------------
# 调用位置：_handle_generation 内，解析 X-DSH-Route 之后、构造生效 hint 决策之前，
# 仅换挡请求（带 X-DSH-Check 头）介入；普通请求零开销。
# 守门只做判定：不读配置运行态、不连上游、不持密钥、不阻塞请求；
# 任何情况下不得因守门结果向调用方返回错误（契约 §3 硬约束）。

CHECK_HEADER = "X-DSH-Check"
_GUARD_CFG = (CONFIG.get("hint") or {}).get("guard") or {}

# 守门整体旁路开关（向后兼容口子：false＝视同没带 X-DSH-Check，插件走原路）
GUARD_ENABLED = bool(_GUARD_CFG.get("enabled", True))
# 断崖阈值：本次/上次上下文比低于该值 → fallback（接口单 §四，可配）
GUARD_CONTEXT_RATIO_MIN = float(_GUARD_CFG.get("context_ratio_min", 0.8))
# 对表五项（接口单锁定命名：goal / done / next / why / ctx）
GUARD_CHECK_KEYS = [str(k) for k in (_GUARD_CFG.get("check_keys")
                                    or ["goal", "done", "next", "why", "ctx"])]
GUARD_MAX_HEADER_BYTES = int(_GUARD_CFG.get("max_header_bytes") or 8192)

GUARD_ACTION_ALLOW = "allow"
GUARD_ACTION_ALLOW_WITH_COUNT = "allow_with_count"
GUARD_ACTION_FALLBACK = "fallback"
GUARD_ACTION_NEW_SESSION = "new_session"


@dataclass
class ParsedCheck:
    """X-DSH-Check 解析结果。ok=False 表示头结构非法（守门旁路，不拦不报错）。"""

    ok: bool
    error: str | None          # empty/oversize/bad_base64/bad_json/not_object/no_next
    prev: dict | None          # 上一次 {tier, model, contextTokens, goalHash, ctxId}
    next: dict | None          # 本次 {session, contextTokens, goalHash, ctxId, check{goal,done,next,why,ctx}}


def parse_check_header(raw: str | None) -> ParsedCheck | None:
    """解析 X-DSH-Check；永不抛异常。返回 None＝请求没带该头。"""
    try:
        if raw is None:
            return None
        text = str(raw).strip()
        if not text:
            return ParsedCheck(False, "empty", None, None)
        if len(text) > GUARD_MAX_HEADER_BYTES:
            return ParsedCheck(False, "oversize", None, None)
        data = _b64_try_decode(text)
        if data is None:
            return ParsedCheck(False, "bad_base64", None, None)
        try:
            obj = json.loads(data.decode("utf-8"))
        except Exception:
            return ParsedCheck(False, "bad_json", None, None)
        if not isinstance(obj, dict):
            return ParsedCheck(False, "not_object", None, None)
        prev = obj.get("prev")
        prev = prev if isinstance(prev, dict) else None
        nxt = obj.get("next")
        if not isinstance(nxt, dict):
            return ParsedCheck(False, "no_next", prev, None)
        return ParsedCheck(True, None, prev, nxt)
    except Exception:
        return ParsedCheck(False, "internal", None, None)


def _check_item_present(value: Any) -> bool:
    """对表单项：非空字符串才算「有」（空串/None/非字符串＝缺项）。"""
    return isinstance(value, str) and bool(value.strip())


def _positive_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value > 0 else None


def _hash_changed(prev_value: Any, next_value: Any) -> bool:
    """两个指纹都存在且不同才算「变」；缺数据不判（宁放行不误拦）。"""
    if isinstance(prev_value, str) and prev_value.strip() and isinstance(next_value, str) and next_value.strip():
        return prev_value != next_value
    return False


def check_switch(prev: dict | None, nxt: dict | None) -> dict:
    """换挡守门判定（接口单 v1.0 §三/§四）。纯函数：无 I/O、无状态、永不抛异常。

    返回 {action, reason, contextRatio, missing, prev_tier, prev_model}：
    - action：allow / allow_with_count / fallback / new_session；
    - reason：ok / check_missing / goal_drift / context_cliff / ctx_changed / no_prev；
    - contextRatio：本次/上次上下文 token 比（缺数据＝None，不判崖）；
    - missing：对表五项缺项数（只记不判，接口单 §四）。
    """
    if not isinstance(nxt, dict):
        return {"action": GUARD_ACTION_NEW_SESSION, "reason": "no_prev", "contextRatio": None,
                "missing": 0, "prev_tier": None, "prev_model": None}
    check = nxt.get("check")
    check = check if isinstance(check, dict) else {}
    missing = sum(1 for key in GUARD_CHECK_KEYS if not _check_item_present(check.get(key)))
    prev_ok = isinstance(prev, dict) and (
        isinstance(prev.get("tier"), str) and prev.get("tier").strip()
        or isinstance(prev.get("model"), str) and prev.get("model").strip())
    if not prev_ok:
        # 无上一档可回落＝非换挡（新会话/首请求），正常发
        return {"action": GUARD_ACTION_NEW_SESSION, "reason": "no_prev", "contextRatio": None,
                "missing": missing, "prev_tier": None, "prev_model": None}
    prev_tokens = _positive_number(prev.get("contextTokens"))
    next_tokens = _positive_number(nxt.get("contextTokens"))
    ratio = round(next_tokens / prev_tokens, 4) if prev_tokens and next_tokens else None
    # fallback 判定优先级：目标漂移 > 断崖 > 标识变（动作相同，reason 标签取信息量最大者）
    if _hash_changed(prev.get("goalHash"), nxt.get("goalHash")):
        action, reason = GUARD_ACTION_FALLBACK, "goal_drift"
    elif ratio is not None and ratio < GUARD_CONTEXT_RATIO_MIN:
        action, reason = GUARD_ACTION_FALLBACK, "context_cliff"
    elif _hash_changed(prev.get("ctxId"), nxt.get("ctxId")):
        action, reason = GUARD_ACTION_FALLBACK, "ctx_changed"
    elif missing:
        action, reason = GUARD_ACTION_ALLOW_WITH_COUNT, "check_missing"
    else:
        action, reason = GUARD_ACTION_ALLOW, "ok"
    return {"action": action, "reason": reason, "contextRatio": ratio, "missing": missing,
            "prev_tier": prev.get("tier") if isinstance(prev.get("tier"), str) else None,
            "prev_model": prev.get("model") if isinstance(prev.get("model"), str) else None}


def evaluate_guard(check_parsed: ParsedCheck | None) -> dict:
    """守门评估＋计数；返回进 hctx 的 guard 块。present=False＝请求没带 X-DSH-Check。"""
    if check_parsed is None:
        return {"present": False}
    if not check_parsed.ok:
        _hint_add(guard_invalid=1)
        return {"present": True, "ok": False, "error": check_parsed.error, "action": None,
                "reason": "bad_check_header", "contextRatio": None, "missing": 0,
                "prev_tier": None, "prev_model": None}
    verdict = check_switch(check_parsed.prev, check_parsed.next)
    _hint_add(**{f"guard_{verdict['action']}": 1})
    return {"present": True, "ok": True, "error": None, **verdict}


def apply_guard_to_hint(parsed: ParsedHint, guard: dict) -> ParsedHint:
    """守门 fallback：hint 档位整体回落为 prev 上一档（tier/model），其余字段保留。

    prev 缺 model 就只回落 tier（model=None，按档选）；prev 缺 tier 就只回落 model。
    注意不能对缺侧保留 next 原值——那会让高档模型穿透守门。record 灰度下同样构造
    （供 would_* 观测），但执行轨不改（不替换 candidates）。"""
    if not parsed.ok or guard.get("action") != GUARD_ACTION_FALLBACK:
        return parsed
    tier = guard.get("prev_tier")
    model = guard.get("prev_model")
    return ParsedHint(
        ok=True, error=None,
        tier=tier.strip() if isinstance(tier, str) and tier.strip() else None,
        model=model.strip() if isinstance(model, str) and model.strip() else None,
        stage=parsed.stage, session=parsed.session, reason=parsed.reason,
        confirm=parsed.confirm, incomplete_missing=parsed.incomplete_missing)


def guard_ledger_fields(raw_tier: str | None, raw_model: str | None, guard: dict | None) -> dict:
    """账本守门字段（接口单 §五：action / reason / contextRatio / missing ＋ 审计增量）。

    raw_tier/raw_model：原始 X-DSH-Route 想要的档位（fallback 时与生效 tier/model 不同）。"""
    if not guard or not guard.get("present"):
        return {"guard_present": False, "guard_error": None, "guard_action": None,
                "guard_reason": None, "contextRatio": None, "missing": None,
                "guard_next_tier": None, "guard_next_model": None,
                "guard_prev_tier": None, "guard_prev_model": None}
    return {
        "guard_present": True,
        "guard_error": guard.get("error"),
        "guard_action": guard.get("action"),
        "guard_reason": guard.get("reason"),
        "contextRatio": guard.get("contextRatio"),
        "missing": guard.get("missing"),
        "guard_next_tier": raw_tier,
        "guard_next_model": raw_model,
        "guard_prev_tier": guard.get("prev_tier"),
        "guard_prev_model": guard.get("prev_model"),
    }


# ---------------------------------------------------------------------------
# 上游调用
# ---------------------------------------------------------------------------

@dataclass
class UpstreamResult:
    status: int  # 0=连接失败，-1=缺密钥
    headers: dict
    body: bytes | None
    reader: Any
    error: str | None
    ms: int
    url: str


def call_upstream(upstream: Upstream, model_id: str, payload: dict, stream: bool, endpoint: str) -> UpstreamResult:
    """转发到上游；只改 model 由调用方完成，其余字段原样发送。"""
    url = upstream.base_url + endpoint
    key = get_secret(upstream.api_key_env)
    if not key:
        return UpstreamResult(-1, {}, None, None, f"missing_key:{upstream.api_key_env}", 0, url)
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if stream else "application/json",
        "User-Agent": "dsh-model-router/1.0",
    }
    started = time.monotonic()
    if _HAS_REQUESTS:
        try:
            resp = requests.post(
                url, data=data, headers=headers, stream=stream,
                timeout=(CONNECT_TIMEOUT, STREAM_TIMEOUT if stream else READ_TIMEOUT),
            )
            ms = int((time.monotonic() - started) * 1000)
            hdrs = {str(k).lower(): v for k, v in resp.headers.items()}
            if stream:
                return UpstreamResult(resp.status_code, hdrs, None, resp, None, ms, url)
            return UpstreamResult(resp.status_code, hdrs, resp.content, None, None, ms, url)
        except Exception as exc:  # 网络/超时/TLS
            ms = int((time.monotonic() - started) * 1000)
            return UpstreamResult(0, {}, None, None, f"{type(exc).__name__}: {exc}"[:200], ms, url)

    # requests 不可用时的 urllib 兜底
    req = urlrequest.Request(url, data=data, headers=headers, method="POST")
    try:
        resp = urlrequest.urlopen(req, timeout=STREAM_TIMEOUT if stream else READ_TIMEOUT)
        ms = int((time.monotonic() - started) * 1000)
        hdrs = {str(k).lower(): v for k, v in (resp.headers or {}).items()}
        if stream:
            return UpstreamResult(resp.status, hdrs, None, resp, None, ms, url)
        return UpstreamResult(resp.status, hdrs, resp.read(), None, None, ms, url)
    except urlerror.HTTPError as exc:
        ms = int((time.monotonic() - started) * 1000)
        hdrs = {str(k).lower(): v for k, v in (exc.headers or {}).items()}
        return UpstreamResult(exc.code, hdrs, None, exc, None, ms, url)
    except Exception as exc:
        ms = int((time.monotonic() - started) * 1000)
        return UpstreamResult(0, {}, None, None, f"{type(exc).__name__}: {exc}"[:200], ms, url)


def read_body_bytes(res: UpstreamResult) -> bytes:
    if res.body is not None:
        return res.body
    if res.reader is None:
        return b""
    try:
        return (res.reader.content or b"") if _HAS_REQUESTS else (res.reader.read() or b"")
    except Exception:
        return b""


def close_result(res: UpstreamResult) -> None:
    if res.reader is not None:
        try:
            res.reader.close()
        except Exception:
            pass


def iter_chunks(reader: Any) -> Iterable[bytes]:
    if _HAS_REQUESTS and hasattr(reader, "iter_content"):
        yield from reader.iter_content(chunk_size=8192)
        return
    while True:
        chunk = reader.read(8192)
        if not chunk:
            return
        yield chunk


def short_error(res: UpstreamResult) -> str:
    """账本用错误摘要：只有状态码/异常类型，不带上游响应体。"""
    return res.error or f"HTTP {res.status} {http.client.responses.get(res.status, '')}".strip()


_USAGE_KEY_RE = re.compile(r'"usage"\s*:\s*')


def scan_usage_bytes(buf: bytes) -> dict | None:
    """从流式尾部缓冲中提取 usage（只取数字，不保留正文；支持嵌套 details）。"""
    found: dict | None = None
    text = buf.decode("utf-8", "replace")
    decoder = json.JSONDecoder()
    index = 0
    while True:
        pos = text.find('"usage"', index)
        if pos < 0:
            break
        match = _USAGE_KEY_RE.match(text, pos)
        if not match:
            index = pos + 1
            continue
        try:
            obj, end = decoder.raw_decode(text, match.end())
        except Exception:
            index = pos + 1
            continue
        if isinstance(obj, dict) and obj.get("prompt_tokens") is not None:
            found = obj
        index = end
    return found


# ---------------------------------------------------------------------------
# 账本 / 统计
# ---------------------------------------------------------------------------

_LEDGER_LOCK = threading.Lock()


def append_ledger(entry: dict) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
        with _LEDGER_LOCK, LEDGER_PATH.open("a", encoding="utf-8") as fp:
            fp.write(line + "\n")
    except Exception as exc:
        LOG.error("写账本失败：%s", type(exc).__name__)


def make_ledger_entry(req_id: str, virtual_model: str, features: Features, stage: str, period: str,
                      candidates: list[str], chosen: str | None, reason: str, attempts: list[dict],
                      usage: dict | None, final_status: str, now: datetime | None = None,
                      hint_fields: dict | None = None,
                      afp_est: float | None = None,
                      local_fields: dict | None = None,
                      bad_request_fallbacks: list[str] | None = None) -> dict:
    """账本条目：只有特征/状态/耗时/token，绝不包含请求正文。

    hint_fields：hint_ledger_fields() 的产物（契约 §5 的 hint/tier/model_requested/
    model_chosen/fallback/hint_stage/session 等字段）；缺省＝无 hint 的空字段。
    afp_est：AFP 闸门激活时本请求走火山的估算消耗（None＝闸门未激活）。
    local_fields：契约 v1.1-d2 §4.4 本地不可用字段（local_failure/local_fallback）；
    缺省＝不写这两键（非本地请求的账本条目结构与历史逐字节一致）。
    bad_request_fallbacks：上游 400/413/422 不再打断候选链（2026-11-14 起）⇒ 记录
    「哪些候选因上游 4xx 被跳过、换了下一候选」，元素形如 "<upstream>/<model>:<status>"；
    缺省＝不写该键（无此情形的条目结构与历史逐字节一致）。"""
    entry = {
        "ts": (now or now_shanghai()).isoformat(timespec="seconds"),
        "req_id": req_id,
        "virtual_model": virtual_model,
        "stage": stage,
        "period": period,
        "candidates": list(candidates),
        "chosen": chosen,
        "reason": reason,
        "features": features.as_dict(),
        "attempts": list(attempts),
        "usage": usage if isinstance(usage, dict) else None,
        "final_status": final_status,
        "afp_est": afp_est,
    }
    entry.update(hint_fields or hint_ledger_fields(chosen, None))
    if local_fields:
        entry.update(local_fields)
    if bad_request_fallbacks:
        entry["bad_request_fallbacks"] = list(bad_request_fallbacks)
    return entry


def read_ledger(limit: int) -> list[dict]:
    """只读文件尾部 1MB，避免大文件全量加载。"""
    if not LEDGER_PATH.exists():
        return []
    try:
        size = LEDGER_PATH.stat().st_size
        block = min(size, 1024 * 1024)
        with LEDGER_PATH.open("rb") as fp:
            fp.seek(size - block)
            lines = fp.read().decode("utf-8", "replace").splitlines()
        if block < size and lines:
            lines = lines[1:]  # 丢掉被截断的首行
        items: list[dict] = []
        for line in lines[-limit:]:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                items.append(obj)
        return items
    except Exception as exc:
        LOG.error("读账本失败：%s", type(exc).__name__)
        return []


def _total_add(**kwargs: int) -> None:
    with _TOTAL_LOCK:
        for key, value in kwargs.items():
            _TOTAL[key] = _TOTAL.get(key, 0) + value


def stats_payload() -> dict:
    now = time.time()
    with _TOTAL_LOCK:
        totals = dict(_TOTAL)
    return {
        "uptime_s": round(now - START_TS, 1),
        "generated_at": _iso_from_ts(now),
        "totals": totals,
        "upstreams": {u.id: STATE[u.id].snapshot(now) for u in UPSTREAMS},
        "routing": {
            "period": current_period(),
            "virtual_models": list(VIRTUAL_MODELS),
            "max_attempts": MAX_ATTEMPTS,
        },
        "hint": hint_stats(),
        "afp": afp_stats(),
    }


_PATH_KEY_RE = re.compile(r"(^|_)(path|file|dir)$", re.IGNORECASE)


def _collect_path_fields(obj: Any, prefix: str, out: list[tuple[str, str]]) -> None:
    """Q3-4：递归收集配置里的「路径型」字段（键名以 path/file/dir 结尾，值像绝对路径）。"""
    if isinstance(obj, dict):
        for raw_key, value in obj.items():
            key = f"{prefix}.{raw_key}" if prefix else str(raw_key)
            if isinstance(value, (dict, list)):
                _collect_path_fields(value, key, out)
            elif isinstance(value, str) and _PATH_KEY_RE.search(str(raw_key)) \
                    and (value.startswith("/") or value.startswith("~")):
                out.append((key, value))
    elif isinstance(obj, list):
        for idx, value in enumerate(obj):
            _collect_path_fields(value, f"{prefix}[{idx}]", out)


def config_drift_payload() -> dict:
    """Q3-4：只读配置漂移巡检——路径型字段指向不存在的路径就报出来。

    只读、无副作用；不读密钥值，只检查存在性。`/health` 每次调用都算（纯 stat，毫秒级）。
    口径：
      · `missing` = required 缺项（驱动 ok=false）；
      · `optional_missing` = 可选/暂不要求存在的缺项（如 afp 关闭时的额度快照、
        extra_credentials_path），只展示不告警；
      · 2026-11-18 Q3-4 补：`afp.enabled=false` 时额度快照可不存在（闸门没开）。
    """
    fields: list[tuple[str, str]] = []
    _collect_path_fields(CONFIG, "routing", fields)
    fields.extend([
        ("ledger_path", str(LEDGER_PATH)),
        ("credentials_path", str(CREDENTIALS_PATH)),
        ("extra_credentials_path", str(EXTRA_CREDENTIALS_PATH)),
    ])
    afp_enabled = bool((CONFIG.get("afp") or {}).get("enabled"))
    missing: list[dict] = []
    optional_missing: list[dict] = []
    seen = set()
    for key, raw in fields:
        if (key, raw) in seen:
            continue
        seen.add((key, raw))
        expanded = os.path.expanduser(raw)
        if not os.path.isabs(expanded):
            expanded = str(BASE_DIR / expanded)
        if not os.path.exists(expanded):
            optional = (key == "extra_credentials_path"
                        or (key.startswith("routing.afp.") and not afp_enabled))
            item = {"config": key, "path": raw, "exists": False, "optional": optional}
            (optional_missing if optional else missing).append(item)
    return {
        "ok": not missing,
        "checked": len(seen),
        "missing": missing,
        "optional_missing": optional_missing,
        "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def health_payload() -> dict:
    now = time.time()
    items = []
    for upstream in UPSTREAMS:
        snap = STATE[upstream.id].snapshot(now)
        if upstream.dsh_only:
            state = "dsh_only"
        elif snap["circuit"]["open"]:
            state = "circuit_open"
        elif snap["rpm_1m"] >= upstream.max_rpm:
            state = "rate_limited"
        else:
            state = "ok"
        items.append({
            "id": upstream.id,
            "state": state,
            "circuit": snap["circuit"],
            "last_error": snap["last_error"],
            "models": list(upstream.models),
        })
    return {
        "ok": True,
        "uptime": round(now - START_TS, 1),
        "upstreams": items,
        # Q3-2：listen backlog 真实生效值（ss 的 Send-Q 应对得上）
        "listen_backlog": LISTEN_BACKLOG,
        "listen_backlog_source": "RouterHTTPServer.request_queue_size",
        # Q3-4：配置里指向不存在路径的字段（只读巡检；ok=false 时看 missing）
        "config_drift": config_drift_payload(),
        # L5 ②（2026-11-20）：价格双源一致性（capability_meta vs pricebook）——
        # **纯新增键**，既有键一个不动；只观测、不改任何价格/路由/估算行为。
        "price_consistency": price_consistency_payload(),
        # B4（1.0.3.2 T5）：影子判定状态——**仅开启时出现**（默认关 ⇒ /health 形状与 1.0.3.1 一致）
        **({"shadow": router_shadow.status()} if router_shadow.enabled() else {}),
    }


# ---------------------------------------------------------------------------
# 占位（occupancy）：GET /v1/route/occupancy
# 只读观测，数据全部来自本进程内存——请求进入（_occ_begin）、换候选（_occ_bind）、
# 结束（_occ_end）三个计时点。不读账本文件、不连上游、不碰熔断/AFP 闸门/鉴权。
# GPU 字段不由网关采集（宿主上报），一律 null + 固定 note。
# ---------------------------------------------------------------------------

OCCUPANCY_WINDOW_SECONDS = 30.0     # windows.active_30s 的滑动窗口
_OCCUPANCY_KEEP_SECONDS = 60.0      # 已结束请求保留 60s，供 30s 窗口统计
_OCCUPANCY_GPU_NOTE = "宿主上报，网关不自采"

_OCC_LOCK = threading.Lock()
_OCC_ACTIVE: dict[str, dict] = {}   # req_id -> {model, started, ended}；ended 非空=已结束待清
_OCC_MODEL_LAST: dict[str, float] = {}
_OCC_LAST_ACTIVE: float | None = None


def _occ_prune(now: float) -> None:
    """调用方须持 _OCC_LOCK：清掉结束超过 KEEP 秒的条目，防止字典无限增长。"""
    stale = [rid for rid, item in _OCC_ACTIVE.items()
             if item["ended"] is not None and now - item["ended"] > _OCCUPANCY_KEEP_SECONDS]
    for rid in stale:
        _OCC_ACTIVE.pop(rid, None)


def _occ_mark(model: str, now: float) -> None:
    """调用方须持 _OCC_LOCK：记录某模型的最近活跃时刻（全局同记，剪枝不影响它）。"""
    global _OCC_LAST_ACTIVE
    _OCC_MODEL_LAST[model] = now
    _OCC_LAST_ACTIVE = now


def _occ_begin(req_id: str, model: str, now: float | None = None) -> None:
    """请求进入生成流程：登记在飞请求（model 先记主候选，换候选时用 _occ_bind 更正）。"""
    ts = time.time() if now is None else now
    with _OCC_LOCK:
        _occ_prune(ts)
        _OCC_ACTIVE[req_id] = {"model": model, "started": ts, "ended": None}
        _occ_mark(model, ts)


def _occ_bind(req_id: str, model: str, now: float | None = None) -> None:
    """请求实际要打的候选变了：把在飞条目的 model 更正为该候选（by_model 才准）。"""
    ts = time.time() if now is None else now
    with _OCC_LOCK:
        item = _OCC_ACTIVE.get(req_id)
        if item is None:
            return
        item["model"] = model
        _occ_mark(model, ts)


def _occ_end(req_id: str, now: float | None = None) -> None:
    """请求结束（成功/失败/流式/异常都走这里，由 finally 保证）。幂等。"""
    ts = time.time() if now is None else now
    with _OCC_LOCK:
        item = _OCC_ACTIVE.get(req_id)
        if item is None or item["ended"] is not None:
            return
        item["ended"] = ts
        _occ_mark(item["model"], ts)
        _occ_prune(ts)


def _occ_reset() -> None:
    """测试辅助：清空占位状态（生产路径不调用）。"""
    global _OCC_LAST_ACTIVE
    with _OCC_LOCK:
        _OCC_ACTIVE.clear()
        _OCC_MODEL_LAST.clear()
        _OCC_LAST_ACTIVE = None


def _occ_empty_host_view(now_ms: int | None = None) -> dict:
    """宿主视角的空态（无上报/异常兜底）：字段形状与 occupancy_host.snapshot() 一致。"""
    ms = int(time.time() * 1000) if now_ms is None else now_ms
    return {
        "as_of": occ_host.iso_from_ms(ms),
        "fresh_seconds": occ_host.STALE_SECONDS,
        "sources": [], "fresh_count": 0, "stale_count": 0, "rejected_total": 0,
        "note": "网关视角与宿主视角分开两列，不合并",
        "gpu": None,
        "items": [],
    }


def occupancy_host_view(now_ms: int | None = None) -> dict:
    """宿主视角快照：先按 mtime 懒轮询一次文件通道（≤30s 间隔，mtime 未变零开销），再取快照。

    契约 v1.1-d2 §4.3：判断只许用 fresh 条目（fresh_only）；过期只展示。本函数永不抛异常
    （观测接口不因自身故障影响调用方，也不影响主请求链路）。
    """
    try:
        occ_host.poll_file(now_ms=now_ms)
    except Exception:  # 文件通道故障只影响宿主视角，不影响网关视角
        LOG.warning("occupancy 文件通道轮询失败", exc_info=True)
    try:
        return occ_host.snapshot(now_ms=now_ms)
    except Exception:
        LOG.exception("宿主视角快照构造失败")
        return _occ_empty_host_view(now_ms)


def _decorate_host_view(host_view: dict) -> dict:
    """Q3-3：给宿主视角加显式「接没接上」三态，避免 null 被读成「卡空闲」。

    现网宿主上报端其实没部署（sources=[]、fresh_count=0），但旧响应只给 null 字段，
    面板/脚本很容易把「没数据」当「0 占用」。这里按三态诚实原则显式标 not_connected。
    """
    out = dict(host_view)
    connected = bool(out.get("fresh_count") or out.get("sources"))
    out["connected"] = connected
    out["status"] = "connected" if connected else "not_connected"
    out["status_text"] = "已接入" if connected else "未接入"
    if not connected:
        note = str(out.get("note") or "").strip()
        extra = "宿主上报端未部署：GPU/宿主列为空属预期，不代表卡空闲"
        out["note"] = (note + "；" + extra) if note else extra
    return out


def occupancy_payload(now: float | None = None) -> dict:
    """GET /v1/route/occupancy：网关视角 ＋ 宿主视角两列（只读，永不抛异常）。

    windows.active_30s：最近 30 秒内有活动的请求数（当前在飞 + 30 秒内结束的都算）；
    windows.last_active_at：全进程最后一次活动（请求进入/换候选/结束）的 +08:00 时间；
    by_model：**网关视角**当前在飞数 + 最近活跃时刻，只列在飞或 60 秒内有活动的模型；
    host_view：**宿主视角**上报（含新鲜度与两视角分开的说明），判断只用 fresh 条目；
    gpu：宿主上报口径，网关不自采 ⇒ 无 fresh 上报时 util/mem_used_mib 恒 null。
    """
    ts = time.time() if now is None else now
    now_ms = int(ts * 1000)
    window_start = ts - OCCUPANCY_WINDOW_SECONDS
    keep_start = ts - _OCCUPANCY_KEEP_SECONDS
    try:
        with _OCC_LOCK:
            _occ_prune(ts)
            items = [(rid, dict(item)) for rid, item in _OCC_ACTIVE.items()]
            last_active = _OCC_LAST_ACTIVE
            model_last = dict(_OCC_MODEL_LAST)
            active_by_model: dict[str, int] = {}
            for _rid, item in items:
                if item["ended"] is None:
                    active_by_model[item["model"]] = active_by_model.get(item["model"], 0) + 1
        active_30s = 0
        for _rid, item in items:
            started, ended = item["started"], item["ended"]
            if started > ts:                       # 未来时间戳（假时钟注入）不计
                continue
            if ended is None:                      # 在飞：只要已开始就算窗口内活跃
                active_30s += 1
            elif ended >= window_start:            # 已结束：结束时刻落在窗口内才算
                active_30s += 1
        by_model = [
            {"model": model,
             "active_requests": active_by_model.get(model, 0),
             "last_active_at": _iso_from_ts(when)}
            for model, when in model_last.items()
            if active_by_model.get(model, 0) > 0 or when >= keep_start
        ]
        by_model.sort(key=lambda row: (-row["active_requests"], row["model"]))
        host_view = _decorate_host_view(occupancy_host_view(now_ms))
        gpu = dict(host_view.get("gpu") or {
            "reported_by": "host",
            "util": None,
            "mem_used_mib": None,
            "note": _OCCUPANCY_GPU_NOTE,
        })
        gpu["connected"] = host_view["connected"]
        gpu["status"] = host_view["status"]
        return {
            "as_of": _iso_from_ts(ts),
            "windows": {
                "active_30s": active_30s,
                "last_active_at": _iso_from_ts(last_active) if last_active is not None else None,
            },
            "by_model": by_model,
            "gpu": gpu,
            "host_view": host_view,
            "host_view_status": host_view["status"],
        }
    except Exception:  # 观测接口绝不因自身异常影响调用方
        LOG.exception("占位快照构造失败")
        host_view = _decorate_host_view(_occ_empty_host_view(now_ms))
        return {
            "as_of": _iso_from_ts(ts),
            "windows": {"active_30s": 0, "last_active_at": None},
            "by_model": [],
            "gpu": {"reported_by": "host", "util": None, "mem_used_mib": None,
                    "note": _OCCUPANCY_GPU_NOTE, "connected": host_view["connected"],
                    "status": host_view["status"]},
            "host_view": host_view,
            "host_view_status": host_view["status"],
        }


def _model_entries_for_virtual(name: str) -> list[dict]:
    """虚拟模型→候选真实模型（用于 /v1/models 的保守 contextWindow/capabilities）。"""
    rows: list[dict] = []
    if name == "auto-function":
        for key, _label, chat in rstrat.FUNCTION_CATALOG:
            if not chat:
                continue
            for period in ("peak", "offpeak"):
                rows.extend(capability_model_entry(c) for c in rstrat.chain("function", "L2", period, key))
    elif name.startswith("auto-fn-"):
        key = name[len("auto-fn-"):]
        for period in ("peak", "offpeak"):
            rows.extend(capability_model_entry(c) for c in rstrat.chain("function", "L2", period, key))
    elif name == "auto-cost":
        for period in ("peak", "offpeak"):
            for stage in ("L1", "L2", "L3"):
                rows.extend(capability_model_entry(c) for c in rstrat.chain("cost", stage, period))
    elif name == "auto-capability":
        for stage in ("L1", "L2", "L3"):
            rows.extend(capability_model_entry(c) for c in rstrat.chain("capability", stage, "offpeak"))
    elif name == "auto-recommend":
        for stage in ("L1", "L2", "L3"):
            rows.extend(capability_model_entry(c) for c in rstrat.chain("recommend", stage, "offpeak"))
    elif name in ("auto-fast", "auto-strong", "auto"):
        # 已采纳的现网 routes/STRATEGIES 作为回落来源
        for period in ("peak", "offpeak"):
            table = (STRATEGIES.get("fast") if name == "auto-fast"
                     else (STRATEGIES.get("strong") if name == "auto-strong" else ROUTES.get(period)))
            if isinstance(table, dict):
                for value in table.values():
                    if isinstance(value, list):
                        rows.extend(capability_model_entry(c) for c in value)
                    elif isinstance(value, str):
                        rows.append(capability_model_entry(value))
            elif isinstance(table, list):
                rows.extend(capability_model_entry(c) for c in table)
    # 去重
    seen, out = set(), []
    for row in rows:
        key = row.get("id")
        if key and key not in seen:
            seen.add(key)
            out.append(row)
    return out


def _virtual_model_entry(name: str, meta: dict) -> dict:
    entries = _model_entries_for_virtual(name)
    contexts = [e.get("context_window") for e in entries if isinstance(e.get("context_window"), int)]
    max_tokens = [e.get("max_tokens") for e in entries if isinstance(e.get("max_tokens"), int)]
    modalities = sorted({m for e in entries for m in (e.get("modality") or [])})
    tools_ok = bool(entries) and all(True for _ in entries)  # 虚拟链只暴露 chat-compatible 模型
    out = {
        "id": name, "object": "model", "created": int(START_TS),
        "owned_by": "model-router", "description": meta.get("description", ""), "router": True,
        "context_window": min(contexts) if contexts else None,
        "max_output_tokens": min(max_tokens) if max_tokens else None,
        "vision": ("vision" in modalities) if modalities else None,
        "tools": tools_ok,
        "capabilities": {
            "input": modalities or ["text"],
            "context_window": min(contexts) if contexts else None,
            "max_output_tokens": min(max_tokens) if max_tokens else None,
        },
    }
    return out


def models_payload() -> dict:
    created = int(START_TS)
    data = []
    for model_id, meta in VIRTUAL_MODELS.items():
        row = _virtual_model_entry(model_id, meta)
        row["created"] = created
        data.append(row)
    # Q12/Q47：chat 可执行的功能虚拟模型 auto-fn-<key>
    for key, label, chat in rstrat.FUNCTION_CATALOG:
        if not chat:
            continue
        if any(x.get("id") == f"auto-fn-{key}" for x in data):
            continue
        if not _model_entries_for_virtual(f"auto-fn-{key}"):
            continue  # 该功能当前没有可执行模型，不暴露
        row = _virtual_model_entry(f"auto-fn-{key}", {"description": f"功能路由：{label}"})
        row["created"] = created
        data.append(row)
    if CONFIG.get("expose", {}).get("upstream_models", True):
        for upstream in UPSTREAMS:
            for model_id, spec in upstream.models.items():
                _cand = f"{upstream.id}/{model_id}"
                _offer = pricebook_offer(_cand)
                if _offer is not None:
                    _dl = offer_display_label(_offer)
                else:
                    _meta = CAPABILITY_META_MODELS.get(_cand) or {}
                    _pb = capability_price(_meta)
                    _per = current_period()

                    def _slot_of(key: str, _pb=_pb, _per=_per):
                        blk = (_pb or {}).get(key)
                        return blk.get(_per) if isinstance(blk, dict) else None

                    _dl = display_label(upstream.id, spec.get("label") or model_id,
                                        _slot_of("input_per_mtok"), _slot_of("output_per_mtok"))
                data.append({
                    "id": f"{upstream.id}/{model_id}", "object": "model", "created": created,
                    "owned_by": upstream.id, "description": spec.get("label", ""),
                    "display_label": _dl,
                    "context_window": spec.get("context_window"),
                    "max_output_tokens": spec.get("max_tokens"), "vision": bool(spec.get("vision")),
                    "tools": bool(spec.get("tools", True)),
                    "capabilities": {
                        "input": (["text", "vision"] if spec.get("vision") else ["text"]),
                        "context_window": spec.get("context_window"),
                        "max_output_tokens": spec.get("max_tokens"),
                    },
                })
    return {"object": "list", "data": data}


def public_config() -> dict:
    """脱敏配置：只暴露 key 环境变量名与"是否已加载"，绝无密钥值。"""
    return {
        "routing": CONFIG,
        "upstreams": [{
            "id": u.id, "label": u.label, "base_url": u.base_url, "api_key_env": u.api_key_env,
            "has_key": bool(get_secret(u.api_key_env)), "max_rpm": u.max_rpm, "models": u.models,
        } for u in UPSTREAMS],
        "ledger_path": str(LEDGER_PATH),
        "credentials_path": str(CREDENTIALS_PATH),
        "extra_credentials_path": str(EXTRA_CREDENTIALS_PATH),
        "strategies": rstrat.strategies_summary(),
        "secrets_loaded_keys": secret_names_loaded(),  # 只有名称
        "runtime": {
            "period": current_period(),
            "listening": f"{HOST}:{PORT}",
            "requests_http": "requests" if _HAS_REQUESTS else "urllib",
        },
    }


# ---------------------------------------------------------------------------
# 本地 503 集成辅助（契约 v1.1-d2 §4.4）
# 只做「识别本地上游 / 宿主 / 云端同档建议」三件小事，判定与错误体都在
# local_unavailable.py 里（便于单测）；本段不新增任何必需配置。
# ---------------------------------------------------------------------------

_LOCAL_IDS_CACHE: dict[str, object] = {}


def local_upstream_ids() -> set[str]:
    """本地上游 id 集合（缓存；签名变了才重算）。

    判定优先级：upstreams.json 条目里的显式 ``local`` 布尔 > config 的
    ``local.upstreams`` 名单 > base_url 是否私有地址（LiteLLM 默认跑在本机/内网）。
    生产配置零改动：以上键都不存在时纯按 base_url 判定。
    """
    rows = [{"id": u.id, "base_url": u.base_url, "local": getattr(u, "local", None)}
            for u in UPSTREAMS]
    local_conf = CONFIG.get("local") if isinstance(CONFIG.get("local"), dict) else {}
    signature = json.dumps([rows, local_conf], sort_keys=True, ensure_ascii=False, default=str)
    if _LOCAL_IDS_CACHE.get("signature") == signature:
        return _LOCAL_IDS_CACHE["ids"]  # type: ignore[return-value]
    try:
        ids = set(local_unavail.local_upstreams(rows, CONFIG))
    except Exception:  # 识别失败一律当「没有本地上游」：老行为零变化
        LOG.exception("本地上游识别失败，按无本地上游处理")
        ids = set()
    _LOCAL_IDS_CACHE["signature"] = signature
    _LOCAL_IDS_CACHE["ids"] = ids
    return ids


def local_host_id(upstream_id: str) -> str:
    """本地上游所属宿主 id：config.local.host_ids 覆盖优先，缺省＝上游 id。"""
    try:
        return local_unavail.host_id_for(upstream_id, CONFIG)
    except Exception:
        return upstream_id


def candidate_tier(candidate: str) -> str | None:
    """候选的档位（取 capability_model_entry 的 tier；取不到给 None，绝不猜）。"""
    try:
        entry = capability_model_entry(candidate)
    except Exception:
        return None
    return entry.get("tier") if isinstance(entry, dict) else None


def local_ledger_fields(local_failure: dict | None, allow_cloud: bool,
                        attempts: list[dict], local_ids: set[str]) -> dict | None:
    """契约 v1.1-d2 §4.4 账本字段：本地不可用事实 ＋ 是否真的转云（None＝无此事，账本零新增键）。

    local_fallback 取值：
      - "local_unavailable→cloud"：调用方显式允许且确实走到了云端候选（契约 §4.4.3 口径）；
      - "local_unavailable"：默认不转云，直接回结构化错误。
    raw 只进账本备核（≤300 字），绝不出现在响应里。
    """
    if not local_failure:
        return None
    info = local_failure["info"]
    went_cloud = any(a.get("status") is not None and a.get("upstream") not in local_ids
                     for a in attempts)
    return {
        "local_failure": {
            "code": info.get("code"), "reason": info.get("reason"),
            "host_id": local_failure.get("host_id"),
            "need_mib": info.get("need_mib"), "free_mib": info.get("free_mib"),
            "evidence": info.get("evidence"), "raw": info.get("raw"),
        },
        "local_fallback": ("local_unavailable→cloud" if (allow_cloud and went_cloud)
                           else "local_unavailable"),
    }


def cloud_fallback_suggestion(candidates: list[str], after_index: int,
                              base_tier: str | None = None) -> str | None:
    """本地装不下时给调用方的**建议值**（只是建议，不自动转）：候选阶梯里本候选之后
    第一个云端（非本地）候选；能判档位时要求同档（tier 相同或任一侧未知）。"""
    local_ids = local_upstream_ids()
    for candidate in candidates[after_index + 1:]:
        up_id, _model_id = split_candidate(candidate)
        if up_id in local_ids:
            continue
        tier = candidate_tier(candidate)
        if base_tier is None or tier is None or tier == base_tier:
            return candidate
    return None


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------

class PayloadTooLarge(Exception):
    pass


class RouterHTTPServer(ThreadingHTTPServer):
    """Q3-2：request_queue_size 必须在 __init__ 之前生效。

    HTTPServer.__init__ 内部已 server_activate()→listen()，实例化后再赋值不生效；
    类属性在构造前就存在，listen 时读到的就是 LISTEN_BACKLOG。
    """
    request_queue_size = LISTEN_BACKLOG
    daemon_threads = True


class RouterHandler(BaseHTTPRequestHandler):
    server_version = "ModelRouter/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        return  # 统一由 _dispatch 记录，且不打印请求体

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    # ── Q3-1（2026-11-18）：补齐方法层，让 405 分支真正可达 ──────────────
    # 原实现只定义 do_GET/do_POST/do_OPTIONS：PUT/PATCH/DELETE 在进入 _dispatch 之前
    # 就被 BaseHTTPRequestHandler 用 HTML 501 回掉，_dispatch 里的 JSON 405 是死代码。
    def do_PUT(self) -> None:  # noqa: N802
        self._dispatch("PUT")

    def do_PATCH(self) -> None:  # noqa: N802
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def do_HEAD(self) -> None:  # noqa: N802
        # ── N8②（2026-11-19）：支持 HEAD ────────────────────────────────────
        # 旧行为：HEAD 对任何路径一律 405（部分监控/探活工具默认发 HEAD，会误判为服务不可用；
        #   实测 `HEAD /tools/wb/health` → 405）。
        # 新行为：HEAD 与 GET 同头部、**不写 body**（_head_only 让 _send_bytes 只发头部，
        #   Content-Length 仍按 GET 的实际长度给）；POST-only 路径仍按 GET 规则回 405 JSON。
        self._head_only = True
        try:
            self._dispatch("GET")
        finally:
            self._head_only = False

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _dispatch(self, method: str) -> None:
        started = time.monotonic()
        parsed = urlparse_mod.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        status, note = 500, ""
        try:
            # 管理界面自带 loopback/Host/token/同源校验；不走 API key 闸门（浏览器不便带 Bearer）
            if path == "/admin" or path.startswith("/admin/"):
                verdict = {"allowed": True, "reason": "admin", "principal": None}
            else:
                verdict = request_auth(path, self.headers.get("Authorization"))
            self._api_principal = verdict.get("principal")
            if not verdict["allowed"]:
                # Q2-4：失败节流（同来源+同 token 60s 内 > 阈值 ⇒ 429；阈值内仍正常 401）
                addr = str(self.client_address[0]) if self.client_address else "?"
                if auth_fail_check(addr, self.headers.get("Authorization")) >= _AUTH_FAIL_LIMIT:
                    status = self._send_rate_limited(_AUTH_FAIL_WINDOW,
                                                     "该来源失败鉴权过于频繁，已临时限流",
                                                     "auth_fail_throttled")
                    note = "auth_reject:throttled"
                    return
                auth_fail_record(addr, self.headers.get("Authorization"))
                status = self._send_unauthorized(verdict["reason"])
                note = f"auth_reject:{verdict['reason']}"
                LOG.warning("入口鉴权拒绝 path=%s reason=%s", path, verdict["reason"])
                return
            # Q2-4：per-key rpm（只有启用 per-client key 时生效；rpm<=0 不限）
            if api_keys.required() and verdict.get("principal"):
                ok, retry = key_rpm_check(verdict["principal"])
                if not ok:
                    status = self._send_rate_limited(retry, "该 API key 超过 rpm 上限")
                    note = "auth_reject:key_rpm_exceeded"
                    LOG.warning("per-key rpm 拒绝 key=%s", (verdict.get("principal") or {}).get("id"))
                    return
            if method == "GET":
                status, note = self._do_get(path, urlparse_mod.parse_qs(parsed.query))
            elif method == "POST":
                status, note = self._do_post(path, urlparse_mod.parse_qs(parsed.query))
            else:
                status = self._send_error_json(405, f"不支持的方法 {method}", "method_not_allowed")
        except (BrokenPipeError, ConnectionResetError):
            status, note = 499, "client_closed"
        except Exception as exc:
            LOG.exception("请求处理异常 path=%s", path)
            try:
                status = self._send_error_json(500, f"网关内部错误：{type(exc).__name__}", "internal_error")
            except Exception:
                pass
        finally:
            # N8②：HEAD 走的是 GET 分支，日志如实标成 HEAD，别把探活混进 GET 统计。
            LOG.info("%s %s -> %s %dms %s",
                     "HEAD" if getattr(self, "_head_only", False) else method, path, status,
                     int((time.monotonic() - started) * 1000), note)

    def _do_get(self, path: str, query: dict) -> tuple[int, str]:
        if path == "/admin" or path.startswith("/admin/"):
            return admin_ui.handle(self, "GET", path, query), "admin"
        if path == "/health":
            return self._send_json(200, health_payload()), "health"
        if path == "/v1/models":
            return self._send_json(200, models_payload()), "models"
        if path == "/v1/route/capabilities":
            # 契约 §4：无鉴权（服务本身只绑本机/内网），自报档位与模型清单
            return self._send_json(200, capabilities_payload()), "capabilities"
        if path == "/v1/route/prices":
            return self._send_json(200, price_catalog_payload(query)), "prices"
        if path == "/v1/route/occupancy":
            # 只读占位：进程内存统计 + 宿主上报的 GPU 口径（网关不自采）
            return self._send_json(200, occupancy_payload()), "occupancy"
        if path == "/v1/route/functions":
            return self._send_json(200, rstrat.functions_payload()), "functions"
        if path == "/v1/route/strategies":
            return self._send_json(200, rstrat.public()), "strategies"
        if path == "/v1/route/shadow":
            # B4 影子判定只读汇总（1.0.3.2 T5）：不执行、不调用模型。
            principal = getattr(self, "_api_principal", None)
            if api_keys.required() and principal is not None and not require_scope(principal, "plan"):
                return (self._send_error_json(403, "该 API key 无 plan scope",
                                              "forbidden", "scope"), "scope")
            range_key = str((query.get("range") or ["7d"])[0] or "7d").strip().lower()[:16]
            return self._send_json(200, router_shadow.summary(range_key)), "shadow"
        if path == "/v1/route/report":
            # B2 复盘报告（1.0.3.2 T4）：只读聚合，不执行不写账。
            principal = getattr(self, "_api_principal", None)
            if api_keys.required() and principal is not None and not require_scope(principal, "plan"):
                return (self._send_error_json(403, "该 API key 无 plan scope",
                                              "forbidden", "scope"), "scope")
            range_key = str((query.get("range") or ["7d"])[0] or "7d").strip().lower()[:16]
            group = str((query.get("group") or ["model"])[0] or "model").strip().lower()[:16]
            return self._send_json(200, router_plan.report(range_key, group)), "report"
        if path == "/v1/route/discipline":
            # B1 边界纪律（1.0.3.2 T2）：只读聚合 annotations 里的 discipline_violation。
            principal = getattr(self, "_api_principal", None)
            if api_keys.required() and principal is not None and not require_scope(principal, "plan"):
                return (self._send_error_json(403, "该 API key 无 plan scope",
                                              "forbidden", "scope"), "scope")
            range_key = str((query.get("range") or ["7d"])[0] or "7d").strip().lower()[:16]
            report = router_plan.discipline_report(range_key)
            return self._send_json(200 if report.get("ok") else 500, report), "discipline"
        if path == "/router/ledger":
            try:
                limit = max(1, min(int((query.get("limit") or ["50"])[0]), 500))
            except (TypeError, ValueError):
                limit = 50
            items = read_ledger(limit)
            return self._send_json(200, {"object": "list", "count": len(items), "data": items}), "ledger"
        if path == "/router/stats":
            return self._send_json(200, stats_payload()), "stats"
        if path == "/router/config":
            return self._send_json(200, public_config()), "config"
        if path == "/":
            return self._send_json(200, {
                "name": "dsh-model-router", "listen": f"{HOST}:{PORT}",
                "endpoints": ["GET /health", "GET /v1/models", "GET /v1/route/capabilities", "GET /v1/route/prices",
                              "GET /v1/route/occupancy", "POST /v1/route/occupancy/report",
                              "POST /v1/chat/completions", "POST /v1/completions",
                              "GET /router/ledger?limit=N", "GET /router/stats", "GET /router/config",
                              "GET /v1/route/functions", "GET /v1/route/strategies",
                              "POST /v1/route/plan", "POST /v1/route/annotation",
                              "GET /admin", "GET /admin/api/upstreams"],
            }), "index"
        # Q3-1：路径存在但只接受 POST ⇒ 405（不是 404）
        if path in POST_ONLY_PATHS:
            return (self._send_error_json(405, f"接口 {path} 只接受 POST；收到 GET",
                                          "method_not_allowed", "method_not_allowed"),
                    "method_not_allowed")
        return self._send_error_json(404, f"未知接口：{path}", "not_found"), "not_found"

    def _handle_occupancy_report(self) -> tuple[int, str]:
        """POST /v1/route/occupancy/report：宿主上报卡占用（契约 v1.1-d2 §4.3 push 通道）。

        收 7 字段＋host_id＋reported_at（时间一律 epoch 毫秒）；单条非法只影响该条
        （进 rejected），其余照收 ⇒ 仍回 200，方便宿主按条重发；整体非 JSON/非对象才 400。
        鉴权沿用入口闸门（ROUTER_API_KEY，默认关）。过期（reported_at 距今>30s）**照收**，
        由读取侧标 stale：只展示、不参与任何判断。
        """
        try:
            raw = self._read_body()
        except PayloadTooLarge:
            return (self._send_error_json(413, "请求体超过 64MB 限制", "payload_too_large"),
                    "report_too_large")
        except ValueError as exc:
            return (self._send_error_json(400, f"请求体读取失败：{exc}", "invalid_request_error"),
                    "report_bad_body")
        if not raw:
            return (self._send_error_json(400, "上报体为空", "invalid_request_error", "empty_report"),
                    "report_empty")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return (self._send_error_json(400, "上报体不是合法 JSON", "invalid_request_error",
                                          "bad_json"), "report_bad_json")
        if not isinstance(payload, (dict, list)):
            return (self._send_error_json(400, "上报体必须是 JSON 对象或数组", "invalid_request_error",
                                          "bad_report_shape"), "report_bad_shape")
        try:
            result = occ_host.ingest(payload, source="push")
        except ValueError as exc:
            return (self._send_error_json(400, f"上报结构非法：{exc}", "invalid_request_error",
                                          "bad_report_shape"), "report_bad_shape")
        except Exception:
            LOG.exception("宿主上报处理异常")
            return (self._send_error_json(500, "网关内部错误（上报未落）", "internal_error"),
                    "report_internal_error")
        LOG.info("occupancy report accepted=%d rejected=%d stored=%d",
                 result.get("accepted", 0), len(result.get("rejected") or []),
                 result.get("stored", 0))
        body = {"ok": bool(result.get("accepted")), **result,
                "as_of": _iso_from_ts(time.time())}
        return self._send_json(200, body), "occupancy_report"

    def _handle_passthrough(self, path: str) -> tuple[int, str]:
        """P6（2026-11-16 约定「加 /v1/embeddings、/v1/rerank 转发」）：向量/重排轻量转发。

        只接受显式 upstream/model（不做自动路由、不计占用、不写账本）；其余字段原样透传；
        密钥仍是上游 api_key_env（只在本进程内存）。
        """
        principal = getattr(self, "_api_principal", None)
        if api_keys.required() and principal is not None and not require_scope(principal, "chat"):
            return self._send_error_json(403, "该 API key 无 chat scope", "forbidden", "scope"), "scope"
        try:
            raw = self._read_body()
        except PayloadTooLarge:
            return self._send_error_json(413, "请求体超过 64MB 限制", "payload_too_large"), "too_large"
        except ValueError as exc:
            return self._send_error_json(400, f"请求体读取失败：{exc}", "invalid_request_error"), "bad_body"
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._send_error_json(400, "请求体不是合法 JSON", "invalid_request_error"), "bad_json"
        if not isinstance(payload, dict):
            return self._send_error_json(400, "请求体必须是 JSON 对象", "invalid_request_error"), "bad_shape"
        virtual_model = payload.get("model")
        if not isinstance(virtual_model, str) or not virtual_model.strip():
            return (self._send_error_json(400, "缺少 model（须为 upstream/model 形式）",
                                          "invalid_request_error", "bad_model"), "bad_model")
        up_id, model_id = split_candidate(virtual_model.strip())
        upstream = UPSTREAM_MAP.get(up_id)
        if upstream is None or not model_id:
            return (self._send_error_json(404, f"未知上游或模型：{virtual_model}（须为 upstream/model）",
                                          "invalid_request_error", "model_not_found"), "unknown_model")
        if upstream.dsh_only:
            return (self._send_error_json(400, f"上游 {up_id} 仅限 DSH 内部使用",
                                          "invalid_request_error", "dsh_only"), "dsh_only")
        forward = dict(payload)
        forward["model"] = model_id
        endpoint = "/embeddings" if path == "/v1/embeddings" else "/rerank"
        res = call_upstream(upstream, model_id, forward, stream=False, endpoint=endpoint)
        body = read_body_bytes(res)
        close_result(res)
        LOG.info("passthrough %s model=%s/%s -> %s %dms %dB",
                 path, up_id, model_id, res.status, res.ms, len(body or b""))
        if res.status == 0:
            return (self._send_error_json(502, f"上游不可达：{res.error or 'unknown'}",
                                          "upstream_error"), "upstream_error")
        headers = {"X-Route-Upstream": f"{up_id}/{model_id}"}
        # Q3-1：上游 4xx/5xx 不再原样透传英文报文 ⇒ 统一信封 + 中文归类 + detail 留原文
        if res.status >= 400:
            return self._send_upstream_error(res.status, body, headers), "upstream_error"
        return self._send_raw_json(res.status, body, headers), "passthrough"

    def _do_post(self, path: str, query: dict | None = None) -> tuple[int, str]:
        query = query or {}
        if path == "/admin" or path.startswith("/admin/"):
            return admin_ui.handle(self, "POST", path, query), "admin"
        if path == "/v1/route/occupancy/report":
            return self._handle_occupancy_report()
        if path in ("/v1/route/plan", "/v1/route/annotation", "/v1/route/replay"):
            return self._handle_plan_api(path)
        if path in ("/v1/embeddings", "/v1/rerank"):
            return self._handle_passthrough(path)
        if path not in ("/v1/chat/completions", "/v1/completions"):
            return self._send_error_json(404, f"未知接口：{path}", "not_found"), "not_found"
        try:
            raw = self._read_body()
        except PayloadTooLarge:
            return self._send_error_json(413, "请求体超过 64MB 限制", "payload_too_large"), "too_large"
        except ValueError as exc:
            return self._send_error_json(400, f"请求体读取失败：{exc}", "invalid_request_error"), "bad_body"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._send_error_json(400, "请求体不是合法 JSON", "invalid_request_error"), "bad_json"
        if not isinstance(payload, dict):
            return self._send_error_json(400, "请求体必须是 JSON 对象", "invalid_request_error"), "bad_shape"
        return self._handle_generation(payload, completions=(path == "/v1/completions"))

    def _handle_plan_api(self, path: str) -> tuple[int, str]:
        """P1：计划/标注 API（鉴权已在 _dispatch 过；scope=plan）。"""
        principal = getattr(self, "_api_principal", None)
        if api_keys.required() and principal is not None and not require_scope(principal, "plan"):
            return self._send_error_json(403, "该 API key 无 plan scope", "forbidden", "scope"), "scope"
        try:
            raw = self._read_body()
        except PayloadTooLarge:
            return self._send_error_json(413, "请求体超过 64MB 限制", "payload_too_large"), "too_large"
        except ValueError as exc:
            return self._send_error_json(400, f"请求体读取失败：{exc}", "invalid_request_error"), "bad_body"
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._send_error_json(400, "请求体不是合法 JSON", "invalid_request_error"), "bad_json"
        if not isinstance(payload, dict):
            return self._send_error_json(400, "请求体必须是 JSON 对象", "invalid_request_error"), "bad_shape"
        if path == "/v1/route/plan":
            # B3（1.0.3.2 T3）：插件 L2/L3 双写 body+头；缺 body 时用头补（宿主转发兼容）。
            if not payload.get("automation_level"):
                hdr_level = (self.headers.get("X-WB-Automation-Level") or "").strip()
                if hdr_level:
                    payload = {**payload, "automation_level": hdr_level[:16]}
            body, status = router_plan.build_plan(payload, principal)
        elif path == "/v1/route/replay":
            body, status = router_plan.replay(payload)
        else:
            body, status = router_plan.annotate(payload, principal)
        return self._send_json(status, body), path.rsplit("/", 1)[-1]

    def _handle_generation(self, payload: dict, completions: bool) -> tuple[int, str]:
        principal = getattr(self, "_api_principal", None)
        if api_keys.required() and principal is not None and not require_scope(principal, "chat"):
            return self._send_error_json(403, "该 API key 无 chat scope", "forbidden", "scope"), "scope"
        b5_active = False
        if (self.headers.get(B5_MODE_HEADER) or "").strip().lower() == B5_MODE_VALUE:
            if not b5_enabled() or not b5_key_allowed(principal):
                return (self._send_error_json(403, "只读兼容入口未开启或该 key 无权限",
                                              "forbidden", "passthrough_denied"),
                        "passthrough_denied")
            b5_active = True
        virtual_model = payload.get("model") or "auto"
        if not isinstance(virtual_model, str):
            return self._send_error_json(400, "model 必须是字符串", "invalid_request_error"), "bad_model"
        virtual_model = virtual_model.strip() or "auto"
        if completions:
            if "prompt" not in payload:
                return self._send_error_json(400, "缺少 prompt", "invalid_request_error"), "no_prompt"
        else:
            messages = payload.get("messages")
            if not isinstance(messages, list) or not messages:
                return self._send_error_json(400, "messages 必须是非空数组", "invalid_request_error"), "no_messages"

        stream = bool(payload.get("stream"))
        features = extract_features(payload, completions=completions)
        stage, period = classify(features), current_period()
        function_name = (self.headers.get("X-DSH-Route-Function")
                         or self.headers.get("X-Router-Function") or "").strip().lower()[:64]
        # 推荐策略模式头（2026-11-17 约定）：price（默认）/ capability / preset
        route_mode = (self.headers.get("X-DSH-Route-Mode") or "").strip().lower()[:32]
        # [2026-11-20] 决策模型开关的用户级覆盖：off|shadow|active（不在集合里就回落策略配置）
        decider_override = (self.headers.get("X-WB-Decider") or "").strip().lower()[:16] or None

        # hint 提示头（契约 v1.0）：解析失败不影响请求；执行与否由灰度开关决定
        parsed = parse_hint_header(self.headers.get(HINT_HEADER))
        # 换挡守门（接口单 v1.0）：在确定生效提示头之前调用一次；仅换挡请求（带
        # X-DSH-Check）介入。守门只做判定，任何情况下不因守门结果报错。
        check_parsed = parse_check_header(self.headers.get(CHECK_HEADER)) if GUARD_ENABLED else None
        guard = evaluate_guard(check_parsed)
        effective_parsed = parsed
        if (parsed is not None and parsed.ok
                and guard.get("action") == GUARD_ACTION_FALLBACK):
            # 守门回落：生效提示头改用上一档 tier/model（record 灰度同样构造供 would_* 观测，
            # 但执行轨只在 execute 模式替换 candidates）
            effective_parsed = apply_guard_to_hint(parsed, guard)
        hctx = build_hint_ctx(effective_parsed, virtual_model)
        hctx["guard"] = guard
        hctx["raw_tier"] = parsed.tier if parsed is not None else None
        hctx["raw_model"] = parsed.model if parsed is not None else None
        if hctx.get("ok") and hctx.get("virtual"):
            hctx["decision"] = build_hint_decision(effective_parsed, features)
            if HINT_MODE == "execute" and hctx["decision"].get("candidates"):
                hctx["executed"] = True
                _hint_add(executed=1)

        if virtual_model.strip() == "auto-function" and not function_name:
            return self._send_error_json(400, "auto-function 需要请求头 X-DSH-Route-Function: <功能key>",
                                         "invalid_request_error", "function_required"), "function_required"
        candidates = build_candidates(virtual_model, stage, period, features,
                                      function_name=function_name or None, route_mode=route_mode or None,
                                      decider_override=decider_override)
        if hctx.get("executed"):
            candidates = hctx["decision"]["candidates"]
        if not candidates and function_name:
            return self._send_error_json(400, f"功能路由未配置或链为空：{function_name}",
                                         "invalid_request_error", "function_not_configured"), "function_not_configured"
        if not candidates:
            detail = (f"未知模型：{virtual_model}。可用：{', '.join(VIRTUAL_MODELS)}，"
                      "或 <upstream>/<model>")
            return self._send_error_json(404, detail, "invalid_request_error", "model_not_found"), "unknown_model"

        req_id = f"req-{uuid.uuid4().hex[:12]}"
        ctx = {
            "req_id": req_id, "virtual_model": virtual_model, "features": features,
            "stage": stage, "period": period, "hint": hctx,
            "reason": build_reason(features, stage, period, candidates[0], len(candidates)),
            # AFP 估算（仅闸门激活时记，供账本观测；不进响应头——协议字段冻结）
            "afp_est": afp_est_tokens(features.est_input_tokens) if AFP_GATE_ACTIVE else None,
            "stream": bool(stream),
        }
        if b5_active:
            ctx["b5"] = {"mode": B5_MODE_VALUE, "strategy": virtual_model}
        if hctx.get("ok") and hctx.get("virtual"):
            # 观测计数：决策直用 hint 模型＝honored；tier 降级/其他＝fallback
            decision = hctx["decision"]
            if decision.get("fallback") == 0:
                _hint_add(honored=1)
            else:
                _hint_add(fallback=1)
        LOG.info("路由 #%s model=%s stage=%s period=%s est=%dtok cand=%s", req_id, virtual_model,
                 stage, period, features.est_input_tokens, " > ".join(candidates[:MAX_ATTEMPTS]))
        if hctx.get("ok") and hctx.get("virtual"):
            LOG.info("hint #%s mode=%s tier=%s model=%s -> %s fallback=%s", req_id, HINT_MODE,
                     hctx.get("tier"), hctx.get("model"), hctx["decision"].get("would_choose"),
                     hctx["decision"].get("would_fallback"))
        # B4 影子判定（1.0.3.2 T5，默认关）：只记录、不改选模；异步线程 + 失败丢弃。
        try:
            router_shadow.submit(req_id, features.as_dict(), stage, period,
                                 context_tokens_estimate(features))
        except Exception:
            LOG.warning("B4 shadow submit 失败（已忽略，不影响路由）", exc_info=True)
        # 占位计时点①：请求进入（model 先记主候选，实际打哪个由 _forward 的 _occ_bind 更正）；
        # 无论成功/失败/流式/异常，finally 里必定 _occ_end，计数不会漏减。
        _occ_begin(req_id, candidates[0])
        try:
            return self._forward(payload, candidates, ctx, stream, completions), \
                f"{virtual_model}/{stage}/{period}/{req_id}"
        finally:
            _occ_end(req_id)

    def _forward(self, payload: dict, candidates: list[str], ctx: dict, stream: bool, completions: bool) -> int:
        """逐个候选尝试；失败切 fallback（最多 MAX_ATTEMPTS 次）。

        契约 v1.1-d2 §4.4（本地 503）：本地候选装不下时**不重试同一宿主**、**不回裸 503**、
        默认**不转云**、不卸卡；`X-Route-Wait-Local=<秒>`（≤20，默认关）等宿主卸完只重试一次。
        """
        endpoint = "/completions" if completions else "/chat/completions"
        req_id = ctx["req_id"]
        # 1.0.3.2 T1/M4：上下文治理观测（shadow 只记不改；off 完全无副作用）
        _ctx_cfg = ctx_gov_params()
        _ctx_mode = str(_ctx_cfg.get("mode") or "shadow").lower()
        _ctx_active = _ctx_mode != "off"
        _ctx_cache: dict[str, dict] = {}

        def _verdict(candidate: str) -> dict:
            if candidate not in _ctx_cache:
                up_id, model_id = split_candidate(candidate)
                _ctx_cache[candidate] = context_verdict(up_id, model_id, ctx["features"], _ctx_cfg)
            return _ctx_cache[candidate]

        def _attempt_ctx_gov(candidate: str) -> dict:
            verdict = _verdict(candidate)
            return {"band": verdict.get("band"), "need": verdict.get("need"),
                    "cap": verdict.get("input_cap"), "kind": verdict.get("kind")}

        def _trim_trimmable(up_id: str, model_id: str, body0: dict):
            """规则 5（默认关）：enforce 下输入超预算时，裁一版再判；仍超 ⇒ 不放。"""
            if not (_ctx_active and _ctx_mode == "enforce"):
                return None
            if not (_ctx_cfg.get("trim") or {}).get("enabled"):
                return None
            verdict = _verdict(f"{up_id}/{model_id}")
            if verdict.get("band") != "reject" or verdict.get("kind") != "input_overflow":
                return None
            new_body, stats = trim_body(body0, ctx["features"], verdict, _ctx_cfg)
            if not stats.get("changed"):
                return None
            new_verdict = context_verdict(up_id, model_id, extract_features(new_body), _ctx_cfg)
            if new_verdict.get("band") == "reject":
                return None
            return new_body, stats, new_verdict

        def _set_ctx_gov(chosen_candidate: str, usage_dict: dict | None = None) -> None:
            if not _ctx_active or not chosen_candidate:
                return
            verdict = _verdict(chosen_candidate)
            used = None
            if isinstance(usage_dict, dict):
                try:
                    raw_used = int(usage_dict.get("prompt_tokens") or 0)
                except (TypeError, ValueError):
                    raw_used = 0
                used = raw_used or None
            ctx["ctx_gov"] = {
                "mode": _ctx_mode, "band": verdict.get("band"), "kind": verdict.get("kind"),
                "window": verdict.get("window"), "budget": verdict.get("budget"),
                "need": verdict.get("need"), "est": verdict.get("est"),
                "out": verdict.get("out"),
                "reserved": (verdict.get("reserved") if verdict.get("reserved") is not None
                             else verdict.get("reserve")),
                "input_cap": verdict.get("input_cap"), "trimmed": 0,
                "used": used, "used_kind": "actual" if used is not None else "est",
                "params": {"reserve_ratio": _ctx_cfg.get("reserve_ratio"),
                            "min_reserve_tokens": _ctx_cfg.get("min_reserve_tokens"),
                            "local": _ctx_cfg.get("local"),
                            "estimate": _ctx_cfg.get("estimate"),
                            "error": _ctx_cfg.get("error")},
            }

        attempts: list[dict] = []
        chosen: str | None = None
        usage: dict | None = None
        out_raw: bytes | None = None
        out_headers: dict | None = None
        client_error_detail = ""
        final_status = "failed"
        # 本地通道开关（按请求头取，默认全关：不等待、不允许转云）
        local_ids = local_upstream_ids()
        wait_local_s = local_unavail.wait_seconds(self.headers)
        allow_cloud = local_unavail.allow_cloud(self.headers)
        local_failure: dict | None = None   # 最近一次「本地装不下」的结构化事实
        wait_local_used = False             # 等卸载重试只允许一次

        def _accept(res: UpstreamResult, up_id: str, model_id: str, attempt: dict,
                    st: "UpstreamState") -> None:
            """成功响应落位：非流式存原字节待回写，流式立即透传 SSE。"""
            nonlocal chosen, usage, out_raw, out_headers, final_status
            st.note_success(res.ms)
            chosen = f"{up_id}/{model_id}"
            if stream:
                _set_ctx_gov(chosen)
                written, stream_err, stream_usage = self._relay_stream(
                    res, self._router_headers(req_id, chosen, ctx))
                usage = stream_usage
                st.note_usage(stream_usage)
                attempt["error"] = stream_err
                final_status = ("ok_stream" if not stream_err
                                else ("stream_empty" if written == 0 else "stream_error"))
            else:
                out_raw = read_body_bytes(res)
                close_result(res)
                try:
                    parsed = json.loads(out_raw) if out_raw else None
                except json.JSONDecodeError:
                    parsed = None
                if isinstance(parsed, dict):
                    usage = parsed.get("usage")
                    st.note_usage(usage)
                else:
                    LOG.warning("#%s 上游返回非 JSON 响应", req_id)
                _set_ctx_gov(chosen, usage if isinstance(usage, dict) else None)
                out_headers = self._router_headers(req_id, chosen, ctx)
                final_status = "ok"
        # 上游 400/413/422 属「该上游特有拒收」（2026-11-14 免费对照实证：同请求体打
        # 免费池/移动云/本地 9/9 全 200）⇒ 不再打断候选链，换下一候选继续试。
        # 本列表记录被跳过的候选（账本 bad_request_fallbacks 键，缺省不写键）。
        bad_request_fallbacks: list[str] = []

        for index, candidate in enumerate(candidates[:MAX_ATTEMPTS]):
            up_id, model_id = split_candidate(candidate)
            upstream_def = UPSTREAM_MAP.get(up_id)
            if upstream_def is not None and upstream_def.dsh_only:
                attempts.append({"upstream": up_id, "model": model_id, "status": None, "ms": 0,
                                 "error": "dsh_only"})
                continue
            st = STATE.get(up_id)
            if st is None:
                attempts.append({"upstream": up_id, "model": model_id, "status": None, "ms": 0,
                                 "error": "unknown_upstream"})
                continue
            is_local = up_id in local_ids
            host_id = local_host_id(up_id) if is_local else None
            # 本地装不下后：同一宿主进入短冷却期，其所有本地候选直接跳过（不重试同宿主）
            if is_local and host_id is not None:
                down = local_unavail.host_down(host_id)
                if down:
                    attempts.append({"upstream": up_id, "model": model_id, "status": None, "ms": 0,
                                     "error": f"skip:local_host_cooldown({down['code']},"
                                              f"{round(float(down['remaining_s']))}s)"})
                    continue
            # 默认不转云：本地装不下后**跳过**云端候选（调用方显式允许才继续），
            # 但同阶梯里其它本地宿主仍可试（§4.4.1 只禁「同一宿主」重试）
            if local_failure is not None and not allow_cloud and not is_local:
                attempts.append({"upstream": up_id, "model": model_id, "status": None, "ms": 0,
                                 "error": "skip:cloud_not_allowed(local_unavailable)"})
                continue
            # AFP 感知分流（2026-11-12 反馈①）：限额型上游先过额度闸门——
            # 估算超窗口余额的请求直接跳过且**不计熔断**（skip:afp_*），余额恢复自动回探
            ok_afp, why_afp = afp_gate_check(up_id, ctx["features"].est_input_tokens)
            if not ok_afp:
                with _AFP_LOCK:
                    _AFP_STATS["gate_skipped"] += 1
                attempts.append({"upstream": up_id, "model": model_id, "status": None, "ms": 0,
                                 "error": f"skip:{why_afp}"})
                continue
            if up_id == AFP_UPSTREAM_ID and AFP_GATE_ACTIVE:
                with _AFP_LOCK:
                    _AFP_STATS["gate_allowed"] += 1
                    _AFP_STATS["est_afp_sum"] = round(
                        _AFP_STATS["est_afp_sum"] + afp_est_tokens(ctx["features"].est_input_tokens), 3)
            allowed, why = st.allow(time.time())
            if allowed:
                allowed, why = candidate_supported(up_id, model_id, ctx["features"])
            _trim_result = None
            if (not allowed and _ctx_mode == "enforce"
                    and (_ctx_cfg.get("trim") or {}).get("enabled")
                    and str(why).startswith("context_overflow:input_overflow")):
                _trim_result = _trim_trimmable(up_id, model_id, dict(payload))
                if _trim_result is not None:
                    allowed, why = True, "trimmed"
            if not allowed:
                attempts.append({"upstream": up_id, "model": model_id, "status": None, "ms": 0,
                                 "error": f"skip:{why}"})
                continue

            # 占位计时点②：真正要打这个候选了，把在飞条目的 model 更正为它（by_model 才准）
            _occ_bind(req_id, f"{up_id}/{model_id}")
            if _trim_result is not None:
                body = dict(_trim_result[0])   # 裁剪后的深拷贝产物
            else:
                body = dict(payload)  # 浅拷贝即可：只改顶层 model/stream，剥离也是顶层字段
            body["model"] = model_id
            body["stream"] = stream
            stripped: list[str] = []
            retry_after_wait = False     # 等卸载就绪后放行的一次额外调用
            _trim_count = 0              # 规则 6-lite：本次候选已裁剪重发次数
            _trim_pending = False        # 下一次 attempt 标记 ctx_trim_retry
            done = False
            while True:
                st.note_call(time.time())
                res = call_upstream(st.upstream, model_id, body, stream, endpoint)
                success = 200 <= res.status < 300
                attempt = {"upstream": up_id, "model": model_id, "status": res.status,
                           "ms": res.ms, "error": None if success else short_error(res)}
                if stripped:
                    attempt["stripped"] = list(stripped)
                if _trim_pending:
                    attempt["ctx_trim_retry"] = True
                    _trim_pending = False
                attempts.append(attempt)

                if success:
                    if _trim_result is not None:
                        _stats = _trim_result[1]
                        attempt["trimmed"] = _stats
                        if isinstance(ctx.get("ctx_gov"), dict):
                            _orig = int(_verdict(f"{up_id}/{model_id}").get("est") or 0)
                            ctx["ctx_gov"]["trimmed"] = max(0, _orig - int(_stats.get("est_after") or 0))
                            ctx["ctx_gov"]["band"] = "compress"
                    _accept(res, up_id, model_id, attempt, st)
                    done = True
                    break

                # 失败：区分"上游故障"与"客户端参数问题"（响应体只读一次，各处复用）
                fail_body = b"" if res.status in (0, -1) else read_body_bytes(res)
                if res.status in _CLIENT_ERROR_STATUSES:
                    snippet = fail_body[:300].decode("utf-8", "replace").strip()
                    client_error_detail = snippet or client_error_detail
                # 429 且响应头无 Retry-After：尝试从响应体取额度重置时刻（火山
                # AccountQuotaExceeded 的 "It will reset at ..."）精确冷却
                cooldown = parse_retry_after(res.headers)
                if res.status == 429 and cooldown is None:
                    cooldown = parse_quota_reset_seconds(fail_body)
                st.note_failure(res.status, short_error(res), time.time(),
                                count=res.status not in _CLIENT_ERROR_STATUSES,
                                cooldown=cooldown)
                close_result(res)

                # 规则 6-lite（1.0.3.2，默认关）：上游报上下文类 4xx ⇒ 同候选裁一版重发
                if (_ctx_mode == "enforce" and (_ctx_cfg.get("trim") or {}).get("enabled")
                        and _trim_count < int((_ctx_cfg.get("trim") or {}).get("max_trims") or 2)
                        and is_context_error(res.status, fail_body)):
                    _trimmed2, _st2 = trim_body(body, ctx["features"],
                                                _verdict(f"{up_id}/{model_id}"), _ctx_cfg)
                    if _st2.get("changed"):
                        body = _trimmed2
                        body["model"] = model_id
                        body["stream"] = stream
                        _trim_count += 1
                        _trim_pending = True
                        LOG.warning("#%s %s/%s 返回 %d（上下文类），裁剪后重发（%d/%d）",
                                    req_id, up_id, model_id, res.status, _trim_count,
                                    int((_ctx_cfg.get("trim") or {}).get("max_trims") or 2))
                        continue

                # 上游不支持某可选字段导致 4xx：剥离后同上游重试一次
                if res.status in (400, 422) and not stripped:
                    fields = pick_strip_fields(body)
                    if fields:
                        for name in fields:
                            body.pop(name, None)
                        stripped = fields
                        LOG.warning("#%s %s/%s 返回 %d，剥离字段重试：%s", req_id, up_id, model_id,
                                    res.status, ",".join(fields))
                        continue

                # 契约 §4.4：本地装不下 ⇒ 结构化记录 + 同宿主短路（默认不重试、不转云）
                info = local_unavail.classify(res.status, fail_body, res.headers) if is_local else None
                if info is not None:
                    local_unavail.note_host_down(host_id or up_id, info["code"])
                    attempt["local"] = {
                        "code": info["code"], "reason": info["reason"],
                        "host_id": host_id or up_id,
                        "need_mib": info["need_mib"], "free_mib": info["free_mib"],
                        "evidence": info["evidence"], "raw": info["raw"],
                    }
                    local_failure = {"candidate": candidate, "index": index,
                                     "upstream": up_id, "model": model_id,
                                     "host_id": host_id or up_id, "info": info,
                                     "tier": candidate_tier(candidate)}
                    # 「等宿主腾出来」按需开、默认关；就绪后同宿主只重试一次
                    if wait_local_s > 0 and not wait_local_used:
                        wait_local_used = True
                        since_ms = int(time.time() * 1000)
                        prev_entry = occ_host.find(host_id or up_id, model_id, fresh=True)
                        ready, entry = local_unavail.wait_for_retry_ready(
                            host_id or up_id, model_id, wait_local_s, since_ms,
                            prev_mem_mib=(prev_entry or {}).get("mem_used_mib"))
                        attempt["local"]["wait_local"] = {
                            "seconds": wait_local_s, "ready": bool(ready),
                            "reported_at": (entry or {}).get("reported_at"),
                            "mem_used_mib": (entry or {}).get("mem_used_mib"),
                        }
                        if ready:
                            retry_after_wait = True
                            continue
                    break
                break

            if done:
                break
            if retry_after_wait:   # 等卸载就绪但重试仍失败：到此为止，不换第二家本地
                break
            if attempts and attempts[-1].get("status") in _CLIENT_ERROR_STATUSES:
                # 上游 400/413/422 ⇒ 换下一候选（2026-11-14 起不再打断候选链）：
                # 熔断口径不变（note_failure 已按 count=False 不计熔断，attempts 照记）；
                # 剥字段重试仍在上方 round0 完成，走到这里＝剥完/无字段可剥仍拒。
                bad_request_fallbacks.append(
                    f"{up_id}/{model_id}:{attempts[-1]['status']}")
                LOG.warning("#%s %s/%s 返回 %s（upstream_bad_request），换下一候选",
                            req_id, up_id, model_id, attempts[-1]["status"])
                continue

        if _ctx_active:
            if "ctx_gov" not in ctx:
                _set_ctx_gov(chosen or (candidates[0] if candidates else ""))
            for _attempt in attempts:
                if "ctx_gov" not in _attempt:
                    _cand = f"{_attempt.get('upstream')}/{_attempt.get('model')}"
                    _attempt["ctx_gov"] = _attempt_ctx_gov(_cand)

        if out_headers is not None and out_raw is not None:
            self._ledger(ctx, candidates, chosen, attempts, usage, final_status,
                         local_ledger_fields(local_failure, allow_cloud, attempts, local_ids),
                         bad_request_fallbacks=bad_request_fallbacks)
            return self._send_raw_json(200, out_raw, out_headers)
        if chosen and stream:  # 流式响应头已发出，无法再改状态码
            self._ledger(ctx, candidates, chosen, attempts, usage, final_status,
                         local_ledger_fields(local_failure, allow_cloud, attempts, local_ids),
                         bad_request_fallbacks=bad_request_fallbacks)
            return 200

        # 契约 §4.4.2：本地装不下 ⇒ 统一结构化错误体，**不回裸 503**
        if local_failure is not None:
            info = local_failure["info"]
            suggestion = cloud_fallback_suggestion(candidates, local_failure["index"],
                                                   local_failure["tier"])
            body = local_unavail.error_body(
                model=local_failure["candidate"], host_id=local_failure["host_id"],
                info=info, fallback=suggestion)
            local_fields = local_ledger_fields(local_failure, allow_cloud, attempts, local_ids) or {}
            local_fields["local_failure"].update({"wait_local_s": wait_local_s,
                                                  "allow_cloud": allow_cloud,
                                                  "fallback_suggestion": suggestion})
            self._ledger(ctx, candidates, chosen, attempts, usage, "local_unavailable", local_fields,
                         bad_request_fallbacks=bad_request_fallbacks)
            return self._send_json(local_unavail.ERROR_STATUS, body)

        # 1.0.3.2 T1/M2：enforce 下全部候选因上下文被跳过 ⇒ 结构化超窗错误（默认 400）
        _reject = context_reject_info(attempts) if _ctx_active else None
        if _reject and (_ctx_cfg.get("error") or {}).get("structured", True):
            _full = ctx.get("ctx_gov") if isinstance(ctx.get("ctx_gov"), dict) else {}
            _reject = {**{k: _full.get(k) for k in
                          ("window", "budget", "reserved", "need", "est", "out", "input_cap")},
                       **{k: v for k, v in _reject.items() if v is not None}}
            final_status = "context_rejected"
            self._ledger(ctx, candidates, chosen, attempts, usage, final_status,
                         local_ledger_fields(local_failure, allow_cloud, attempts, local_ids),
                         bad_request_fallbacks=bad_request_fallbacks)
            _err_cfg = _ctx_cfg.get("error") or {}
            _status = 413 if _err_cfg.get("allow_413") else int(_err_cfg.get("status") or 400)
            return self._send_json(_status, context_error_body(_reject, _ctx_cfg))

        # 最后一次失败的 4xx 才回 400：候选链换了上游后，「早前候选 400、末位候选 502」
        # 的序列会出现（旧逻辑下 400 直接 break 故不可达，原判断里冗余的
        # client_error_detail 条件已去掉）——末位是上游故障就该回 502。
        is_client_error = bool(
            attempts and attempts[-1].get("status") in _CLIENT_ERROR_STATUSES)
        if is_client_error:
            final_status = "client_error"
        self._ledger(ctx, candidates, chosen, attempts, usage, final_status,
                     local_ledger_fields(local_failure, allow_cloud, attempts, local_ids),
                     bad_request_fallbacks=bad_request_fallbacks)
        if is_client_error:
            detail = client_error_detail[:300] or "上游拒绝请求参数"
            return self._send_error_json(
                400, f"上游拒绝请求参数（请检查模型不支持的字段）：{detail}",
                "invalid_request_error", "upstream_bad_request")
        summary = "；".join(
            f"{a['upstream']}/{a['model']}="
            + (str(a["status"]) if a.get("status") is not None else str(a.get("error") or "skip"))
            for a in attempts) or "无可用候选"
        return self._send_error_json(502, f"所有候选上游均失败：{summary}",
                                     "upstream_error", "all_upstreams_failed")

    def _ledger(self, ctx: dict, candidates: list[str], chosen: str | None, attempts: list[dict],
                usage: dict | None, final_status: str,
                local_fields: dict | None = None,
                bad_request_fallbacks: list[str] | None = None) -> None:
        _entry = make_ledger_entry(
            req_id=ctx["req_id"], virtual_model=ctx["virtual_model"], features=ctx["features"],
            stage=ctx["stage"], period=ctx["period"], candidates=candidates, chosen=chosen,
            reason=ctx["reason"], attempts=attempts, usage=usage, final_status=final_status,
            hint_fields=hint_ledger_fields(chosen, ctx.get("hint")),
            afp_est=ctx.get("afp_est"), local_fields=local_fields,
            bad_request_fallbacks=bad_request_fallbacks)
        # 1.0.3.2 T1/M4：上下文治理观测键（mode=off 时 ctx 里没有该键 ⇒ 账本结构逐字节不变）
        if isinstance(ctx.get("ctx_gov"), dict):
            _entry["ctx_gov"] = ctx["ctx_gov"]
        # B5（1.0.3.2 T6）：只读兼容入口的审计标记（缺省不写）
        if isinstance(ctx.get("b5"), dict):
            _entry["passthrough"] = True
            _entry["passthrough_mode"] = ctx["b5"].get("mode")
        append_ledger(_entry)
        ok = final_status in ("ok", "ok_stream")
        _total_add(
            requests=1, successes=1 if ok else 0, failures=0 if ok else 1,
            rejected=sum(1 for a in attempts if a.get("status") in _CLIENT_ERROR_STATUSES),
            tokens_prompt=int((usage or {}).get("prompt_tokens") or 0) if isinstance(usage, dict) else 0,
            tokens_completion=int((usage or {}).get("completion_tokens") or 0) if isinstance(usage, dict) else 0,
        )

    # -- 响应工具 ----------------------------------------------------------
    def _router_headers(self, req_id: str, decision: str, ctx: dict) -> dict:
        headers = {
            "X-Router-Decision": decision,
            "X-Router-Reason": ascii_reason(ctx["features"], ctx["stage"], ctx["period"], decision),
            "X-Router-Request-Id": req_id,
        }
        # 契约 §5：hint 响应头。无 hint 的请求不带（老客户端零变化）。
        hctx = ctx.get("hint")
        if hctx and hctx.get("present") and hctx.get("ok"):
            fallback, reason = hint_outcome(decision, hctx)
            headers["X-DSH-Route-Chosen"] = decision
            headers["X-DSH-Route-Fallback"] = "1" if fallback else "0"
            headers["X-DSH-Route-Reason"] = reason or "ok"
        # 接口单 v1.0：守门动作回带（联调观测用；不是回问，网关只记账）
        guard = (hctx or {}).get("guard") if hctx else None
        if guard and guard.get("present"):
            if guard.get("ok"):
                headers["X-DSH-Route-Guard"] = f"{guard.get('action')}:{guard.get('reason')}"
            else:
                headers["X-DSH-Route-Guard"] = f"bypass:{guard.get('error')}"
        # 1.0.3.2 T6/B5：只读兼容入口的实际模型/策略/用量口径
        b5 = ctx.get("b5") if isinstance(ctx.get("b5"), dict) else None
        if b5:
            headers["X-WB-Model"] = decision
            headers["X-WB-Strategy"] = str(b5.get("strategy") or "")
            headers["X-WB-Usage-Kind"] = "stream" if ctx.get("stream") else "actual"
        # 1.0.3.2 T1/M4：上下文治理响应头（off 时 ctx 无该键 ⇒ 一个头都不发）
        cg = ctx.get("ctx_gov") if isinstance(ctx.get("ctx_gov"), dict) else None
        if cg and (ctx_gov_params().get("observability") or {}).get("headers", True):
            if cg.get("window") is not None:
                headers["X-DSH-Context-Window"] = str(cg.get("window"))
            if cg.get("budget") is not None:
                headers["X-DSH-Context-Budget"] = str(cg.get("budget"))
            if cg.get("used") is not None:
                headers["X-DSH-Context-Used"] = str(cg.get("used"))
            else:
                headers["X-DSH-Context-Used"] = str(cg.get("est") or "")
            headers["X-DSH-Context-Used-Kind"] = str(cg.get("used_kind") or "est")
            headers["X-DSH-Trimmed"] = str(int(cg.get("trimmed") or 0))
            headers["X-DSH-Band"] = str(cg.get("band") or "unknown")
        return headers

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        # Q3-12：跨源 JS 要能读路由/决策头（Fetch 规范：不加 Expose-Headers 就一律读不到）
        self.send_header("Access-Control-Expose-Headers",
                         "X-Router-Decision, X-Router-Reason, X-Router-Request-Id, "
                         "X-Route-Upstream, X-DSH-Route-Chosen, X-DSH-Route-Fallback, "
                         "X-DSH-Route-Reason, X-DSH-Route-Guard, "
                         "X-DSH-Context-Window, X-DSH-Context-Budget, X-DSH-Context-Used, "
                         "X-DSH-Context-Used-Kind, X-DSH-Trimmed, X-DSH-Band, "
                         "X-WB-Model, X-WB-Strategy, X-WB-Usage-Kind")
        self.send_header("Access-Control-Max-Age", "600")

    def _send_bytes(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> int:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        # N8②：HEAD 请求只发头部（Content-Length 仍按 GET 的真实长度），不写 body。
        if not getattr(self, "_head_only", False):
            self.wfile.write(body)
        return status

    def _send_json(self, status: int, obj: dict) -> int:
        return self._send_bytes(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                                "application/json; charset=utf-8")

    def _send_raw_json(self, status: int, raw: bytes, headers: dict) -> int:
        return self._send_bytes(status, raw or b"{}", "application/json; charset=utf-8", headers)

    def _send_upstream_error(self, status: int, raw: bytes, headers: dict | None = None) -> int:
        """Q3-1：上游错误也归一到同一信封；原始报文降级到 detail（截断，不丢证据）。"""
        text = (raw or b"").decode("utf-8", "replace")
        detail: Any = None
        orig_code = orig_type = orig_msg = ""
        try:
            parsed = json.loads(text) if text else None
            err = parsed.get("error") if isinstance(parsed, dict) else None
            if isinstance(err, dict):
                orig_code = str(err.get("code") or "")
                orig_type = str(err.get("type") or "")
                orig_msg = str(err.get("message") or "")
                detail = parsed
            elif isinstance(err, str):
                orig_msg = err
                detail = parsed
            else:
                detail = parsed
        except (UnicodeDecodeError, json.JSONDecodeError):
            detail = text[:2048]
        if detail is not None and len(json.dumps(detail, ensure_ascii=False)) > 8192:
            detail = text[:4096]                       # 防上游超大错误体撑爆响应
        d_type, d_code = _STATUS_ERROR_DEFAULTS.get(status, ("upstream_error", f"upstream_http_{status}"))
        payload = {"error": {
            "message": classify_upstream_error(status, orig_code, orig_msg, text),
            "type": orig_type or d_type,
            "code": orig_code or d_code,
            "status": status,
            "upstream_status": status,
            "upstream_message": orig_msg[:500] or None,
            "detail": detail,
        }}
        out = dict(headers or {})
        out["X-Route-Upstream-Error"] = "1"
        return self._send_bytes(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                "application/json; charset=utf-8", out)

    def _send_error_json(self, status: int, message: str, err_type: str | None = None,
                         code: str | None = None) -> int:
        # ── Q3-1（2026-11-18）：全站单一错误信封 {error:{message,type,code,status}} ──
        # 旧实现：413 有时 type=payload_too_large、有时 invalid_request_error；400/404 多数无 code。
        # 现在：未给 type 时按状态码取默认；调用方给了 invalid_request_error 但状态不是 400
        # 时也纠正为状态对应的 type；code 永远有值。上游透传错误另走 _send_upstream_error。
        default_type, default_code = _STATUS_ERROR_DEFAULTS.get(
            status, ("invalid_request_error", f"http_{status}"))
        etype = err_type or default_type
        # 旧调用点会传 "not_found"/"forbidden" 这类简称 ⇒ 归一到 canonical type
        if etype not in _CANONICAL_ERROR_TYPES:
            etype = default_type
        err = {"message": message, "type": etype, "code": code or default_code, "status": status}
        return self._send_json(status, {"error": err})

    def _send_rate_limited(self, retry_after: int, message: str,
                           code: str = "rate_limit_exceeded") -> int:
        """Q2-4：429 统一信封 + Retry-After（per-key rpm / 失败节流共用）。
        [2026-11-19 Q4-5] 429 在读取请求体之前返回 ⇒ 必须关连接，避免未读 body
        污染 keep-alive 的下一个请求（实测会退化成 BaseHTTPRequestHandler 的
        HTML 501）。与 _send_unauthorized 同口径。"""
        self.close_connection = True
        payload = {"error": {"message": message, "type": "rate_limit_error",
                             "code": code, "status": 429,
                             "retry_after": max(1, int(retry_after))}}
        return self._send_bytes(429, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                "application/json; charset=utf-8",
                                {"Retry-After": str(max(1, int(retry_after))),
                                 "Connection": "close"})

    def _send_unauthorized(self, reason: str) -> int:
        """401 未鉴权：错误体带机器可读 reason；连接置 close 避免未读请求体污染 keep-alive。"""
        self.close_connection = True
        body = {"error": {
            "message": f"网关鉴权失败：{AUTH_REASONS.get(reason, reason)}",
            "type": "authentication_error",
            "code": "unauthorized",
            "status": 401,
            "reason": reason,
        }}
        return self._send_bytes(401, json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                "application/json; charset=utf-8",
                                {"WWW-Authenticate": 'Bearer realm="model-router"',
                                 "Connection": "close"})

    # -- 流式透传 ----------------------------------------------------------
    def _relay_stream(self, res: UpstreamResult, headers: dict) -> tuple[int, str | None, dict | None]:
        """把上游 SSE 写给客户端，返回 (字节数, 错误标记, usage)。

        Q3-12（2026-11-18）：优先用 `Transfer-Encoding: chunked` 做定界，允许 keep-alive
        连接复用（旧实现只能 `Connection: close`，每个流式请求独占一条 TCP）。
        回退开关：环境变量 `ROUTER_STREAM_CHUNKED=0` 或 config.stream.chunked=false
        ⇒ 立刻回到旧的「关连接定界」；HTTP/1.0 客户端也自动回退。
        """
        use_chunked = _STREAM_CHUNKED and self.request_version != "HTTP/1.0"
        self.send_response(200)
        self.send_header("Content-Type", res.headers.get("content-type") or "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        if use_chunked:
            self.send_header("Transfer-Encoding", "chunked")
            self.close_connection = False
        else:
            self.send_header("Connection", "close")
            self.close_connection = True
        self._cors()
        for key, value in headers.items():
            if key.lower() in ("connection", "transfer-encoding", "content-length"):
                continue                      # hop-by-hop 由本层决定，不抄上游
            self.send_header(key, value)
        self.end_headers()

        total = 0
        tail = bytearray()
        err: str | None = None

        def _write_payload(payload: bytes) -> None:
            if use_chunked:
                self.wfile.write(f"{len(payload):X}\r\n".encode("ascii") + payload + b"\r\n")
            else:
                self.wfile.write(payload)
            self.wfile.flush()

        try:
            for chunk in iter_chunks(res.reader):
                if not chunk:
                    continue
                _write_payload(chunk)
                total += len(chunk)
                tail.extend(chunk)
                if len(tail) > TAIL_BUFFER_BYTES:
                    del tail[:-TAIL_BUFFER_BYTES]
        except (BrokenPipeError, ConnectionResetError):
            err = "client_disconnected"
        except Exception as exc:
            err = f"stream_error:{type(exc).__name__}"
            LOG.warning("流式转发中断：%s", err)
            try:
                _write_payload(b'data: {"error":{"message":"upstream stream interrupted"}}\n\n')
            except Exception:
                pass
        finally:
            if use_chunked:
                try:
                    self.wfile.write(b"0\r\n\r\n")   # 正常/异常都要收尾，否则客户端挂住
                    self.wfile.flush()
                except Exception:
                    pass
            close_result(res)
        return total, err, scan_usage_bytes(bytes(tail))

    # -- 请求体 ------------------------------------------------------------
    def _read_body(self) -> bytes:
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            chunks: list[bytes] = []
            total = 0
            while True:
                line = self.rfile.readline(65536).strip()
                if not line:
                    break
                try:
                    size = int(line.split(b";")[0], 16)
                except ValueError as exc:
                    raise ValueError("chunk 长度非法") from exc
                if size == 0:
                    self.rfile.readline(65536)
                    break
                total += size
                if total > MAX_BODY_BYTES:
                    raise PayloadTooLarge()
                chunks.append(self.rfile.read(size))
                self.rfile.read(2)
            return b"".join(chunks)

        length_text = self.headers.get("Content-Length")
        if not length_text:
            return b""
        try:
            length = int(length_text)
        except ValueError as exc:
            raise ValueError("Content-Length 非法") from exc
        if length < 0:
            raise ValueError("Content-Length 非法")
        if length > MAX_BODY_BYTES:
            raise PayloadTooLarge()
        return self.rfile.read(length)


def pick_strip_fields(payload: dict) -> list[str]:
    """只剥离请求体里确实存在、且属于可选字段的项。"""
    return [name for name in STRIP_FIELDS if name in payload]


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(level=logging.INFO, datefmt="%H:%M:%S",
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    missing = [u.id for u in UPSTREAMS if not get_secret(u.api_key_env)]
    if missing:
        LOG.warning("以下上游缺少密钥（相关路由会失败）：%s", ", ".join(missing))

    # 契约 v1.1-d2 §4.3 通道①：LAN 未通期宿主写 json、网关按 mtime 轮询（≤30s，daemon）。
    # 读的是只读快照文件；文件不存在/坏 JSON 只记一条 warning，不影响主链路。
    try:
        occ_host.start_poller()
        LOG.info("occupancy 文件通道轮询已启动：%s", occ_host.file_path())
    except Exception:
        LOG.exception("occupancy 文件通道轮询启动失败（不影响路由）")

    server = RouterHTTPServer((HOST, PORT), RouterHandler)
    LOG.info("WB驭档·模型智能换挡系统网关已启动：http://%s:%d（listen_backlog=%d，Ctrl+C 退出）",
             HOST, PORT, server.request_queue_size)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        LOG.info("收到中断，正在关闭")
    finally:
        server.server_close()
        LOG.info("已关闭，端口 %d 释放", PORT)


if __name__ == "__main__":
    main()
