"""模型路由网关 · 本地管理界面（stdlib-only；PyYAML 复用 main 的可选依赖）。

职责：
  - 用 OpenAI 协议探测供应商 `/v1/models`，读取模型清单与能力字段；
  - 用极小的 chat 请求探测 tools / vision 支持；
  - 编辑模型元数据（上下文、输出上限、vision、tools、tier）并保存到 upstreams.json；
  - 密钥写入网关专属的 config/credentials.local.yaml（600），不回显、不进日志；
  - 保存后热重载本进程的 UPSTREAMS/UPSTREAM_MAP/STATE，显式 model 调用立即生效。

边界：
  - 仅监听回环（网关本身只绑 127.0.0.1）；Host 必须是 loopback，防 DNS rebinding；
  - POST 要求 JSON Content-Type + 同源（Origin/Sec-Fetch-Site 检查），防 CSRF；
  - 管理登录：用户名/密码（默认 admin/admin；登录后可改），PBKDF2 哈希落 config/admin-auth.json（600），
    会话 cookie HttpOnly/SameSite=Strict；不再使用 token；
  - 只动 upstreams.json 与 credentials.local.yaml，不改 routing.json（auto 链仍按配置走）。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import router_strategies as rstrat
import api_keys
import router_plan
import router_live
from typing import Any

LOG = logging.getLogger("router.admin")

HTML_FILE = Path(__file__).with_name("admin.html")
# T1（2026-11-21）：路由运行状态看板页（单文件自包含；页面骨架零金额，数据只走登录后的
# /admin/api/live）。文件缺失 ⇒ 500 + admin_live_html_missing（页由 gw-live-web 交付）。
LIVE_HTML_FILE = Path(__file__).with_name("admin-live.html")

# B2 复盘页（1.0.3.2 T4）：静态骨架，不含任何金额；登录后由 /admin/api/report 拉数据。
REVIEW_HTML = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>复盘 · WB 路由</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:24px;color:#222}
h1{font-size:20px}table{border-collapse:collapse;width:100%;margin-top:12px}
td,th{border:1px solid #ddd;padding:6px 8px;text-align:left;font-size:14px}
.muted{color:#777}code{background:#f3f3f3;padding:1px 4px;border-radius:3px}</style></head>
<body><h1>复盘（只读）</h1>
<p class="muted">预估 vs 实付 / 请求实账。页面不内嵌金额；未登录时下方为空并提示先登录。</p>
<div id="msg" class="muted">加载中…</div>
<table id="tbl"><thead><tr><th>分组</th><th>阶段数</th><th>预估入 token</th><th>实际入 token</th><th>预估成本</th><th>实际成本</th><th>差额</th></tr></thead><tbody></tbody></table>
<p class="muted">数据接口：<code>/admin/api/report?range=7d&amp;group=model</code>（需登录）</p>
<script>
(async () => {
  const msg = document.getElementById('msg'), tbody = document.querySelector('#tbl tbody');
  try {
    const res = await fetch('/admin/api/report?range=7d&group=model', {credentials: 'same-origin'});
    if (res.status === 401) { msg.textContent = '未登录：请先到 /admin 登录。'; return; }
    if (!res.ok) { msg.textContent = '读取失败：' + res.status; return; }
    const data = await res.json();
    const groups = (data.annotations && data.annotations.groups) || {};
    const rows = Object.entries(groups);
    msg.textContent = rows.length ? '' : '暂无回执数据（annotations 为空）。';
    for (const [name, g] of rows) {
      const tr = document.createElement('tr');
      for (const v of [name, g.stages, g.planned_input_tokens, g.actual_input_tokens,
                       g.planned_cost, g.actual_cost, g.cost_delta]) {
        const td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  } catch (e) { msg.textContent = '读取失败：' + e; }
})();
</script></body></html>"""
# ── Q1-1 B（2026-11-18）：面板余额改为「请求时读盘」─────────────────────────────
# 背景：余额快照 window.__BALANCES__ 原本只在 apply-admin-uiv2.mjs 注入时写死进 admin.html，
#   一旦 cron 注入失败（曾连续 49 次 node: command not found），面板就永远停在旧数字。
# 做法：GET /admin 每次返回前，用 config/balances.json 的当前内容替换那一行 ⇒ 面板与注入
#   解耦、天然实时；读不到文件就原样返回（沿用烘焙值），绝不因为余额读失败而 500。
BALANCES_FILE = Path(__file__).with_name("config") / "balances.json"
_BALANCES_LINE_RE = re.compile(r"window\.__BALANCES__\s*=\s*[^\n]*")

# ── N3（2026-11-19 需求方令「/admin 去明文余额要改」）────────────────────────────
# 旧行为：inject 时把 balances.json 的 items（人民币/美元余额数字）整份塞进 HTML，
#   于是**未登录** GET /admin/ 的响应体里就有明文金额（而 /admin/api/balances 是 401）。
# 新行为：静态页/未登录只给骨架 —— fetched_at（时间戳，非金额）+ 空 items + locked 标记；
#   金额一律由前端在**已登录会话**下 GET /admin/api/balances 拉取后注入。
# 兼容：verify-q1.sh 的 Q1-1 判据「面板 fetched_at == balances.json」仍成立（时间戳照发）。
BALANCES_LOCKED_NOTICE = "余额在登录后由 /admin/api/balances 拉取；未登录响应不含任何金额"


def _balances_fetched_at() -> str:
    """只取时间戳（非金额）；读不到就空串，绝不因为余额读失败而 500。"""
    try:
        doc = json.loads(BALANCES_FILE.read_text(encoding="utf-8"))
        return str((doc or {}).get("fetched_at") or "")
    except Exception:
        return ""


def _skeleton_balances_script() -> str:
    doc = {"fetched_at": _balances_fetched_at(), "items": [], "locked": True,
           "notice": BALANCES_LOCKED_NOTICE}
    return "window.__BALANCES__ = " + json.dumps(doc, ensure_ascii=False,
                                                 separators=(",", ":")) + ";"


def _inject_balances(html: str) -> str:
    """N3：无论登录与否，服务端只注入骨架；金额一律走登录后的 API 拉取。"""
    try:
        script = _skeleton_balances_script()
        new_html, n = _BALANCES_LINE_RE.subn(lambda _m: script, html, count=1)
        return new_html if n else html
    except Exception:
        return html


def balances_public() -> dict:
    """N3：已登录才可调用；返回面板所需余额快照（原样，含 amount/display）。"""
    doc = json.loads(BALANCES_FILE.read_text(encoding="utf-8"))
    if not isinstance(doc, dict):
        raise ValueError("balances.json 结构不是对象")
    return doc


def plugin_status_summary(profile: str = "web", timeout: int = 25) -> dict:
    """N8③：插件装配状态（只读）。复用 tools/plugin-reconcile.mjs --show --json。"""
    # 1.0.3.10 #12：按 DSH_HOME/当前树向上找 tools/，可用环境变量覆盖（原写死本机绝对路径）。
    env_tool = os.environ.get("PLUGIN_RECONCILE_PATH")
    if env_tool:
        tool = Path(env_tool)
    else:
        tool = None
        for base in (Path(os.environ["DSH_HOME"]),) if os.environ.get("DSH_HOME") else ():
            candidate = Path(base) / "tools" / "plugin-reconcile.mjs"
            if candidate.exists():
                tool = candidate
                break
        if tool is None:
            for parent in Path(__file__).resolve().parents:
                candidate = parent / "tools" / "plugin-reconcile.mjs"
                if candidate.exists():
                    tool = candidate
                    break
        if tool is None:
            tool = Path(__file__).resolve().parents[4] / "tools" / "plugin-reconcile.mjs"
    if not tool.exists():
        return {"ok": False, "error": "plugin-reconcile.mjs 不存在"}
    try:
        out = subprocess.run(["node", str(tool), "--profile", profile, "--show", "--json"],
                             capture_output=True, text=True, timeout=timeout)
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}"}
    if out.returncode != 0:
        return {"ok": False, "error": f"rc={out.returncode}"}
    try:
        doc = json.loads(out.stdout)
    except Exception:
        return {"ok": False, "error": "输出不是 JSON"}
    audit = doc.get("audit") if isinstance(doc.get("audit"), dict) else {}
    summ = audit.get("summary") if isinstance(audit.get("summary"), dict) else {}
    counts = doc.get("counts") if isinstance(doc.get("counts"), dict) else {}
    verdict = (f"bundles {summ.get('bundles_ok', '?')}/{summ.get('bundles_total', '?')}｜"
               f"patch 悬空 {summ.get('patch_dangling', '?')}｜home 悬空 {summ.get('home_patch_dangling', '?')}｜"
               f"重复 id {summ.get('patch_duplicates', '?')}｜启动未激活 {summ.get('startup_unknown_failures', '?')}｜"
               f"实例 {summ.get('instances', '?')}｜价格漂移 {'是' if summ.get('price_drift') else '否'}")
    return {"ok": True, "profile": doc.get("profile") or profile,
            "at": doc.get("at"), "counts": counts,
            "unmounted": doc.get("unmounted") or [],
            "empty_mount": doc.get("empty_mount") or [],
            "dangling_symlink": doc.get("dangling_symlink") or [],
            "summary": summ, "verdict": verdict,
            "source": "tools/plugin-reconcile.mjs --show --json（每次请求实时采样）"}


def backlog_public(payload: dict | None = None) -> dict:
    """N8③：网关 listen backlog 与运行时长（只读；取自 /health 同一份内存真值）。"""
    p = payload if isinstance(payload, dict) else {}
    return {"ok": True,
            "listen_backlog": p.get("listen_backlog"),
            "listen_backlog_source": p.get("listen_backlog_source"),
            "uptime_s": p.get("uptime")}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,40}$")
ENV_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}
MAX_ADMIN_BODY = 2 * 1024 * 1024

# 1x1 红色 PNG（视觉探测用；不落盘）
_PNG_1PX = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


_GATEWAY = None  # 由 main 在启动时注入（脚本以 __main__ 运行，不能 import main）


def set_gateway(module) -> None:
    global _GATEWAY
    _GATEWAY = module


def _gw():
    if _GATEWAY is None:  # pragma: no cover - 正常启动不会走到
        raise RuntimeError("admin_ui 未初始化：main 启动时应调用 set_gateway()")
    return _GATEWAY


# ---------------------------------------------------------------------------
# HTTP 基础
# ---------------------------------------------------------------------------


def _host_ok(handler) -> bool:
    host = (handler.headers.get("Host") or "").strip().lower()
    if not host:
        return False
    if host.startswith("["):
        hostname = host[1:host.find("]")] if "]" in host else host
    else:
        hostname = host.rsplit(":", 1)[0] if ":" in host else host
    return hostname in {"127.0.0.1", "localhost", "::1"}


# ---------------------------------------------------------------------------
# 管理登录（用户名/密码；默认 admin/admin，登录后可改）
# ---------------------------------------------------------------------------

SESSION_COOKIE = "gw_admin_session"
SESSION_TTL = 12 * 3600
PBKDF2_ITER = 200_000
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "admin"
MAX_LOGIN_FAILS = 5
LOGIN_WINDOW = 300.0

_SESSIONS: dict[str, dict] = {}
_SESSIONS_LOCK = threading.Lock()
_LOGIN_FAILS: dict[str, list[float]] = {}
_LOGIN_LOCK = threading.Lock()
_AUTH_LOCK = threading.Lock()


def _auth_file() -> Path:
    return _gw().BASE_DIR / "config" / "admin-auth.json"


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _hash_password(password: str, salt: bytes, iterations: int) -> str:
    return _b64(hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations))


def _make_auth_doc(username: str, password: str, *, default: bool) -> dict:
    salt = secrets.token_bytes(16)
    iterations = PBKDF2_ITER
    return {
        "version": 1,
        "username": username,
        "salt": _b64(salt),
        "hash": _hash_password(password, salt, iterations),
        "iterations": iterations,
        "default_password": bool(default),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }


def _load_auth() -> dict:
    """读认证文件；不存在则创建默认 admin/admin（600）。损坏则抛错（fail closed）。"""
    path = _auth_file()
    with _AUTH_LOCK:
        if not path.exists():
            doc = _make_auth_doc(DEFAULT_USERNAME, DEFAULT_PASSWORD, default=True)
            path.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write(path, json.dumps(doc, ensure_ascii=False, indent=2) + "\n", mode=0o600)
            LOG.warning("管理认证文件不存在，已创建默认 admin/admin（请尽快修改）")
            return doc
        try:
            with path.open("r", encoding="utf-8") as fp:
                doc = json.load(fp)
        except Exception as exc:
            LOG.error("管理认证文件解析失败：%s", type(exc).__name__)
            raise ValueError("管理认证文件损坏") from exc
        if not isinstance(doc, dict) or not isinstance(doc.get("username"), str) \
                or not isinstance(doc.get("salt"), str) or not isinstance(doc.get("hash"), str):
            raise ValueError("管理认证文件结构非法")
        doc.setdefault("iterations", PBKDF2_ITER)
        doc.setdefault("default_password", False)
        return doc


def _save_auth(doc: dict) -> None:
    path = _auth_file()
    with _AUTH_LOCK:
        _atomic_write(path, json.dumps(doc, ensure_ascii=False, indent=2) + "\n", mode=0o600)


def _verify_password(username: str, password: str, doc: dict) -> bool:
    try:
        salt = base64.b64decode(doc["salt"])
        iterations = int(doc.get("iterations") or PBKDF2_ITER)
        expected = str(doc["hash"])
    except Exception:
        return False
    actual = _hash_password(password, salt, iterations)
    user_ok = hmac.compare_digest(str(username).encode("utf-8"), str(doc["username"]).encode("utf-8"))
    pass_ok = hmac.compare_digest(actual.encode("utf-8"), expected.encode("utf-8"))
    return user_ok and pass_ok


def _cookie_value(handler, name: str) -> str:
    raw = handler.headers.get("Cookie") or ""
    for part in raw.split(";"):
        key, _, value = part.strip().partition("=")
        if key == name:
            return value.strip()
    return ""


def _cookie_header(token: str, max_age: int) -> str:
    return f"{SESSION_COOKIE}={token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age={max_age}"


def _new_session(username: str) -> str:
    token = secrets.token_hex(32)
    with _SESSIONS_LOCK:
        _SESSIONS[token] = {"username": username, "expires": time.time() + SESSION_TTL}
    return token


def _session_user(handler) -> str | None:
    token = _cookie_value(handler, SESSION_COOKIE)
    if not token:
        return None
    now = time.time()
    with _SESSIONS_LOCK:
        rec = _SESSIONS.get(token)
        if not rec:
            return None
        if rec["expires"] <= now:
            _SESSIONS.pop(token, None)
            return None
        return str(rec["username"])


def _drop_session(handler) -> None:
    token = _cookie_value(handler, SESSION_COOKIE)
    if token:
        with _SESSIONS_LOCK:
            _SESSIONS.pop(token, None)


def _login_ip(handler) -> str:
    try:
        return str(handler.client_address[0])
    except Exception:
        return "unknown"


def _login_throttled(ip: str) -> bool:
    now = time.time()
    with _LOGIN_LOCK:
        arr = [t for t in _LOGIN_FAILS.get(ip, []) if now - t < LOGIN_WINDOW]
        _LOGIN_FAILS[ip] = arr
        return len(arr) >= MAX_LOGIN_FAILS


def _login_failed(ip: str) -> None:
    with _LOGIN_LOCK:
        _LOGIN_FAILS.setdefault(ip, []).append(time.time())


def _login_succeeded(ip: str) -> None:
    with _LOGIN_LOCK:
        _LOGIN_FAILS.pop(ip, None)


def _send_json_cookie(handler, status: int, obj: dict, token: str) -> int:
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return handler._send_bytes(status, body, "application/json; charset=utf-8",
                              {"Set-Cookie": _cookie_header(token, SESSION_TTL), "Cache-Control": "no-store"})


def _send_json_clearcookie(handler, status: int, obj: dict) -> int:
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return handler._send_bytes(status, body, "application/json; charset=utf-8",
                              {"Set-Cookie": _cookie_header("", 0), "Cache-Control": "no-store"})


def _auth_public(doc: dict) -> dict:
    return {
        "ok": True,
        "username": doc.get("username"),
        "default_password": bool(doc.get("default_password")),
        "updated_at": doc.get("updated_at"),
    }


def _same_origin_ok(handler) -> bool:
    ctype = (handler.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if ctype != "application/json":
        return False
    sfs = (handler.headers.get("Sec-Fetch-Site") or "").strip().lower()
    if sfs and sfs not in ("same-origin", "none"):
        return False
    origin = (handler.headers.get("Origin") or "").strip()
    if origin:
        host = (handler.headers.get("Host") or "").strip()
        allowed = {
            f"http://{host}", f"https://{host}",
            "http://127.0.0.1:18790", "http://localhost:18790",
        }
        if origin not in allowed:
            return False
    return True


def _send_json(handler, status: int, obj: dict) -> int:
    return handler._send_json(status, obj)


def _fail(handler, status: int, message: str, code: str = "admin_error") -> int:
    return handler._send_error_json(status, message, "invalid_request_error", code)


def _read_body(handler) -> bytes:
    gateway = _gw()
    try:
        return handler._read_body()
    except gateway.PayloadTooLarge as exc:  # type: ignore[attr-defined]
        raise ValueError("请求体超过限制") from exc
    except ValueError:
        raise


# ---------------------------------------------------------------------------
# 配置 / 凭据读写
# ---------------------------------------------------------------------------


def _upstreams_path() -> Path:
    return _gw().BASE_DIR / "upstreams.json"


def _extra_credentials_path() -> Path:
    gateway = _gw()
    return Path(getattr(gateway, "EXTRA_CREDENTIALS_PATH"))


def _load_upstreams_doc() -> dict:
    with _upstreams_path().open("r", encoding="utf-8") as fp:
        doc = json.load(fp)
    if not isinstance(doc, dict) or not isinstance(doc.get("upstreams"), list):
        raise ValueError("upstreams.json 结构非法：缺少 upstreams[]")
    return doc


def _atomic_write(path: Path, text: str, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            fp.write(text)
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


def _backup_upstreams() -> str:
    src = _upstreams_path()
    if not src.exists():
        return ""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dst = src.parent / "config" / f"backup-{stamp}-upstreams.json"
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())
    return str(dst)


def _load_extra_refs() -> dict[str, str]:
    path = _extra_credentials_path()
    if not path.exists():
        return {}
    gateway = _gw()
    if gateway.yaml is None:
        return {}
    try:
        with path.open("r", encoding="utf-8") as fp:
            doc = gateway.yaml.safe_load(fp) or {}
        refs = doc.get("refs") if isinstance(doc, dict) else None
        return {str(k): str(v) for k, v in (refs or {}).items() if isinstance(v, str)}
    except Exception:
        LOG.exception("扩展凭据文件解析失败")
        return {}


def _save_extra_ref(env_name: str, secret: str) -> None:
    gateway = _gw()
    if gateway.yaml is None:
        raise ValueError("PyYAML 不可用，无法写扩展凭据")
    path = _extra_credentials_path()
    refs = _load_extra_refs()
    refs[env_name] = secret
    doc = {"version": 1, "refs": dict(sorted(refs.items()))}
    text = gateway.yaml.safe_dump(doc, allow_unicode=True, sort_keys=True)
    _atomic_write(path, text, mode=0o600)


def _filter_extra_ref(env_name: str) -> None:
    gateway = _gw()
    if gateway.yaml is None:
        return
    path = _extra_credentials_path()
    refs = _load_extra_refs()
    if env_name not in refs:
        return
    refs.pop(env_name, None)
    doc = {"version": 1, "refs": dict(sorted(refs.items()))}
    _atomic_write(path, gateway.yaml.safe_dump(doc, allow_unicode=True, sort_keys=True), mode=0o600)


def _secret_source(env_name: str) -> str:
    gateway = _gw()
    if not env_name:
        return ""
    if os.environ.get(env_name):
        return "env"
    if env_name in _load_extra_refs():
        return "admin"
    try:
        if env_name in gateway._load_secrets():  # type: ignore[attr-defined]
            return "refs"
    except Exception:
        pass
    return ""


def _resolve_key(payload: dict) -> str:
    gateway = _gw()
    key = str(payload.get("api_key") or "").strip()
    if key:
        return key
    env_name = str(payload.get("api_key_env") or "").strip()
    if not env_name and payload.get("id"):
        for item in _load_upstreams_doc().get("upstreams", []):
            if item.get("id") == payload.get("id"):
                env_name = str(item.get("api_key_env") or "")
                break
    if not env_name:
        return ""
    return gateway.get_secret(env_name) or ""


def _upstreams_public() -> dict:
    gateway = _gw()
    doc = _load_upstreams_doc()
    rows = []
    for item in doc.get("upstreams", []):
        env_name = str(item.get("api_key_env") or "")
        rows.append({
            "id": item.get("id"),
            "label": item.get("label") or item.get("id"),
            "base_url": item.get("base_url"),
            "api_key_env": env_name,
            "has_key": bool(gateway.get_secret(env_name)),
            "key_source": _secret_source(env_name),
            "max_rpm": item.get("max_rpm", 50),
            "models": item.get("models") or {},
        })
    return {
        "ok": True,
        "upstreams": rows,
        "paths": {
            "upstreams": str(_upstreams_path()),
            "credentials_extra": str(_extra_credentials_path()),
        },
        "auth_mode": "password",
        "gateway": {"listen": f"{gateway.HOST}:{gateway.PORT}"},
    }


# ---------------------------------------------------------------------------
# 模型探测 / 能力推断
# ---------------------------------------------------------------------------


def _num(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def _pick(meta: dict, *names: str) -> Any:
    for name in names:
        if name in meta and meta[name] not in (None, ""):
            return meta[name]
    return None


def _contains_image(value: Any) -> bool:
    if isinstance(value, str):
        return "image" in value.lower()
    if isinstance(value, (list, tuple)):
        return any(_contains_image(v) for v in value)
    return False


_KNOWN_CONTEXT = (
    (("gpt-4.1", "gpt-4-1"), 1047576),
    (("gpt-4o", "gpt-4-turbo", "gpt-4.5"), 128000),
    (("gpt-5", "gpt-5.1"), 400000),
    (("o1", "o3", "o4"), 200000),
    (("claude",), 200000),
    (("gemini",), 1048576),
    (("deepseek",), 131072),
    (("qwen",), 131072),
    (("glm",), 131072),
    (("kimi",), 262144),
    (("llama",), 131072),
    (("mistral", "mixtral"), 131072),
)


def _infer_model(model_id: str, meta: dict) -> dict:
    lid = model_id.lower()
    ctx = None
    for names in ("context_length", "context_window", "max_context_length", "max_model_len",
                  "max_input_tokens", "input_token_limit"):
        ctx = _num(_pick(meta, names))
        if ctx:
            break
    max_out = None
    for names in ("max_tokens", "max_output_tokens", "max_completion_tokens", "output_token_limit"):
        max_out = _num(_pick(meta, names))
        if max_out:
            break
    vision = None
    for names in ("vision", "supports_vision", "image_input", "supports_image_input"):
        val = _pick(meta, names)
        if isinstance(val, bool):
            vision = val
            break
    if vision is None:
        modalities = _pick(meta, "input_modalities", "modalities", "supported_modalities",
                            "capabilities", "features")
        if modalities is not None:
            vision = _contains_image(modalities)
    tools = None
    for names in ("tools", "supports_tools", "tool_calling", "function_calling", "supports_function_calling"):
        val = _pick(meta, names)
        if isinstance(val, bool):
            tools = val
            break
    if tools is None:
        caps = _pick(meta, "capabilities", "features")
        if isinstance(caps, (list, tuple)):
            text = " ".join(str(c).lower() for c in caps)
            if "tool" in text or "function" in text:
                tools = True
    guessed_ctx = ctx is None
    guessed_caps = vision is None or tools is None
    if ctx is None:
        for names, value in _KNOWN_CONTEXT:
            if any(token in lid for token in names):
                ctx = value
                break
        if ctx is None:
            ctx = 32768 if any(t in lid for t in ("local", "fast", "deep-", "exec-", "vision-mini")) else 131072
    if max_out is None:
        max_out = 8192 if ctx and ctx <= 65536 else 16384
    if vision is None:
        vision = any(t in lid for t in ("vision", "-vl", "vl-", "4o", "4.1", "gemini", "claude",
                                        "llava", "pixtral", "minicpm-v", "glm-4v", "qwen-vl", "omni"))
    if tools is None:
        tools = not any(t in lid for t in ("embed", "embedding", "rerank", "tts", "asr",
                                           "whisper", "dall-e", "audio", "image", "moderation"))
    return {
        "context_window": int(ctx),
        "max_tokens": int(max_out),
        "vision": bool(vision),
        "tools": bool(tools),
        "tier": "strong" if any(t in lid for t in ("pro", "max", "opus", "397b", "k3", "reasoner")) else "cheap",
        "label": model_id,
        "guessed": {"context": bool(guessed_ctx), "caps": bool(guessed_caps)},
        "raw_fields": sorted(k for k in meta.keys())[:40] if isinstance(meta, dict) else [],
    }


def _http_json(url: str, method: str = "GET", headers: dict | None = None,
               payload: dict | None = None, timeout: float = 30.0) -> tuple[int, dict | str, float]:
    data = None
    hdrs = {"Accept": "application/json", "User-Agent": "dsh-router-admin/1.0"}
    hdrs.update(headers or {})
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                parsed = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                parsed = raw.decode("utf-8", "replace")
            return resp.status, parsed, round((time.monotonic() - started) * 1000, 1)
    except urllib.error.HTTPError as exc:
        raw = exc.read() if hasattr(exc, "read") else b""
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            parsed = raw.decode("utf-8", "replace")
        return exc.code, parsed, round((time.monotonic() - started) * 1000, 1)
    except Exception as exc:
        return 0, f"{type(exc).__name__}: {exc}", round((time.monotonic() - started) * 1000, 1)


def _error_text(body: Any) -> str:
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            return str(err.get("message") or err.get("code") or err)[:240]
        if isinstance(err, str):
            return err[:240]
        return str(body.get("message") or json.dumps(body, ensure_ascii=False))[:240]
    return str(body)[:240]


def _probe_models(base_url: str, key: str) -> dict:
    base = base_url.rstrip("/")
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    status, body, ms = _http_json(base + "/models", headers=headers, timeout=20.0)
    if status != 200:
        return {"ok": False, "status": status, "latency_ms": ms,
                "error": f"/models 探测失败：{_error_text(body)}"}
    items = []
    if isinstance(body, dict):
        raw = body.get("data")
        if not isinstance(raw, list):
            raw = body.get("models")
    else:
        raw = None
    if not isinstance(raw, list):
        return {"ok": False, "status": status, "latency_ms": ms,
                "error": "/models 响应不是 OpenAI 结构（缺少 data[]）", "body": str(body)[:300]}
    for item in raw:
        if isinstance(item, str):
            model_id, meta = item, {}
        elif isinstance(item, dict):
            model_id = str(item.get("id") or item.get("name") or "").strip()
            meta = item
        else:
            continue
        if not model_id:
            continue
        inferred = _infer_model(model_id, meta)
        inferred["id"] = model_id
        inferred["owned_by"] = str(meta.get("owned_by") or "") if isinstance(meta, dict) else ""
        items.append(inferred)
    return {"ok": True, "status": status, "latency_ms": ms, "count": len(items), "models": items}


def _chat_probe(base_url: str, key: str, model: str, payload: dict, timeout: float = 45.0) -> dict:
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    url = base_url.rstrip("/") + "/chat/completions"
    body = {"model": model, "max_tokens": 16, "temperature": 0, "stream": False}
    body.update(payload)
    status, resp, ms = _http_json(url, method="POST", headers=headers, payload=body, timeout=timeout)
    out = {"status": status, "latency_ms": ms}
    if isinstance(resp, dict):
        choices = resp.get("choices")
        if isinstance(choices, list) and choices:
            message = choices[0].get("message") if isinstance(choices[0], dict) else {}
            out["content"] = str((message or {}).get("content") or "")[:300]
            out["tool_calls"] = (message or {}).get("tool_calls")
        out["model"] = resp.get("model")
        out["usage"] = resp.get("usage")
        if status != 200:
            out["error"] = _error_text(resp)
    else:
        out["error"] = str(resp)[:300]
    out["ok"] = status == 200
    return out


def _probe_capabilities(base_url: str, key: str, model: str, timeout: float = 45.0) -> dict:
    tools_payload = {
        "messages": [{"role": "user", "content": "请调用 ping 工具，不要直接回答。"}],
        "tools": [{"type": "function", "function": {
            "name": "ping", "description": "ping",
            "parameters": {"type": "object", "properties": {"note": {"type": "string"}}},
        }}],
        "tool_choice": "auto",
    }
    tools = _chat_probe(base_url, key, model, tools_payload, timeout=timeout)
    tools_supported = tools.get("ok") is True
    if tools_supported:
        called = isinstance(tools.get("tool_calls"), list) and len(tools.get("tool_calls") or []) > 0
        tools["verdict"] = "called" if called else "accepted"
        tools["supported"] = True
    else:
        tools["verdict"] = "rejected"
        tools["supported"] = False

    vision_payload = {
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "这张图是什么颜色？只答一个词。"},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{_PNG_1PX}"}},
        ]}],
    }
    vision = _chat_probe(base_url, key, model, vision_payload, timeout=timeout)
    vision["supported"] = vision.get("ok") is True
    vision["verdict"] = "accepted" if vision.get("ok") else "rejected"
    return {"ok": True, "model": model, "tools": tools, "vision": vision}


# ---------------------------------------------------------------------------
# 保存 / 删除
# ---------------------------------------------------------------------------


# 2026-11-23 Q-dycoding 防再犯②：缺失窗口/无明确证据的能力一律**留 null（unknown）**，
# 不再用 131072/8192 兜底——兜底值会被后续误当实测事实写进配置（23:25 事故即如此）。
_UNKNOWN_CTX_DEFAULTS = {"context_window": 131072, "max_tokens": 8192}


def _norm_model_spec(spec: dict, *, allow_defaults: bool = True) -> dict:
    """规范化单模型元数据。

    ``allow_defaults=True``（默认，兼容老调用/界面手填行）保留 historical 兜底值；
    ``allow_defaults=False`` 用于**保存路径**：缺失即 None（unknown），由网关按
    "未声明窗口=unknown 放行" 处理，杜绝把兜底当事实落盘。
    """
    ctx = _num(spec.get("context_window"))
    max_out = _num(spec.get("max_tokens"))
    tier = str(spec.get("tier") or "cheap")
    if tier not in ("cheap", "strong", "mid"):
        tier = "cheap"
    if allow_defaults:
        ctx_val, max_val = int(ctx or 131072), int(max_out or 8192)
    else:
        ctx_val = int(ctx) if isinstance(ctx, int) and ctx > 0 else None
        max_val = int(max_out) if isinstance(max_out, int) and max_out > 0 else None
    out: dict[str, Any] = {
        "context_window": ctx_val,
        "max_tokens": max_val,
        "vision": bool(spec.get("vision")),
        "tools": bool(spec.get("tools", True)),
        "tier": tier,
    }
    label = str(spec.get("label") or "").strip()
    if label:
        out["label"] = label[:120]
    note = str(spec.get("note") or "").strip()
    if note:
        out["note"] = note[:400]
    return out


def _referenced_models() -> set[str]:
    gateway = _gw()
    refs: set[str] = set()

    def add(value: Any) -> None:
        if isinstance(value, str):
            refs.add(value)
        elif isinstance(value, list):
            for item in value:
                add(item)
        elif isinstance(value, dict):
            for item in value.values():
                add(item)

    config = getattr(gateway, "CONFIG", {}) or {}
    add(config.get("routes"))
    add(config.get("strategies"))
    add((config.get("hint") or {}).get("tiers"))
    return refs


# ---------------------------------------------------------------------------
# 价格同步（P1 落地 2026-11-16）：保存供应商后**异步**抓价写 config/pricebook.json；
# 不阻塞保存响应；失败只记状态，不影响供应商生效。手动入口：POST /admin/api/prices/refresh
# ---------------------------------------------------------------------------
_PRICE_SYNC_LOCK = threading.Lock()
_PRICE_SYNC_STATE: dict[str, Any] = {
    "running": False, "started_at": None, "finished_at": None,
    "ok": None, "error": None, "stdout": "", "path": None,
}


def price_sync_status() -> dict:
    with _PRICE_SYNC_LOCK:
        state = dict(_PRICE_SYNC_STATE)
    state["running"] = bool(state.get("running"))
    return state


def _kick_price_sync() -> dict:
    """起一个后台线程跑 scripts/price_sync.py --out config/pricebook.json。"""
    with _PRICE_SYNC_LOCK:
        if _PRICE_SYNC_STATE.get("running"):
            return {"status": "running", **_PRICE_SYNC_STATE}
        _PRICE_SYNC_STATE.update(running=True, started_at=time.time(),
                                 finished_at=None, ok=None, error=None, stdout="")
    gw = _gw()
    script = Path(gw.BASE_DIR) / "scripts" / "price_sync.py"
    out = Path(gw.BASE_DIR) / "config" / "pricebook.json"

    def _run() -> None:
        result: dict[str, Any] = {"ok": False, "error": None, "stdout": "", "path": str(out)}
        try:
            proc = subprocess.run(
                [sys.executable, str(script), "--out", str(out)],
                capture_output=True, text=True, timeout=240,
                cwd=str(gw.BASE_DIR),
            )
            result["ok"] = proc.returncode == 0
            result["stdout"] = (proc.stdout or "")[-2000:]
            if not result["ok"]:
                result["error"] = (proc.stderr or "")[-2000:]
        except Exception as exc:  # noqa: BLE001 - 后台任务不抛
            result["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            with _PRICE_SYNC_LOCK:
                _PRICE_SYNC_STATE.update(running=False, finished_at=time.time(), **result)
            LOG.info("price_sync 结束 ok=%s path=%s", result.get("ok"), out)

    threading.Thread(target=_run, name="price-sync", daemon=True).start()
    return {"status": "queued", "path": str(out)}


def _save_upstream(payload: dict) -> dict:
    gateway = _gw()
    item = payload.get("upstream")
    if not isinstance(item, dict):
        raise ValueError("缺少 upstream 对象")
    uid = str(item.get("id") or "").strip()
    if not ID_RE.match(uid):
        raise ValueError("id 只能用小写字母/数字/_.-，且以字母或数字开头（≤41 字符）")
    base_url = str(item.get("base_url") or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("base_url 必须是 http(s)://host/... 形式")
    max_rpm = _num(item.get("max_rpm")) or 50
    doc = _load_upstreams_doc()
    raw_list = doc.get("upstreams") or []
    raw_list_before = json.loads(json.dumps(raw_list))  # 改前快照（只读，用于保存后 diff）
    existing = next((u for u in raw_list if u.get("id") == uid), None)
    env_name = str(item.get("api_key_env") or "").strip()
    if not env_name:
        env_name = (existing or {}).get("api_key_env") or ("UP_" + re.sub(r"[^A-Z0-9]+", "_", uid.upper()) + "_API_KEY")
    if not ENV_RE.match(env_name):
        raise ValueError("api_key_env 只能是大写字母/数字/下划线（3-64 字符）")
    models = item.get("models")
    if not isinstance(models, dict):
        raise ValueError("models 必须是对象（model id → 元数据）")
    norm_models: dict[str, dict] = {}
    for model_id, spec in models.items():
        model_id = str(model_id or "").strip()
        if not model_id or any(ch in model_id for ch in "\r\n\t"):
            raise ValueError(f"模型 id 非法：{model_id!r}")
        if not isinstance(spec, dict):
            raise ValueError(f"模型 {model_id} 的元数据必须是对象")
        # 2026-11-23 防再犯②：保存路径不再把缺失窗口填成 131072/8192 假值
        norm_models[model_id] = _norm_model_spec(spec, allow_defaults=False)
    if not norm_models:
        raise ValueError("至少保留一个模型（或先读取模型清单）")

    # ── 2026-11-23 防再犯①：防「残缺表整表覆盖」────────────────────────────
    # 背景（11-22 23:25 事故）：上游 443 超时 ⇒ 界面只拿到部分模型 ⇒ 点保存按残缺表
    # 整表替换 ⇒ 上游模型数缩水。此处默认**拒绝缩表**，除非显式
    # allow_drop=true（删模型是有意为之时由调用方明示），并把将被删的 id 报回来。
    old_models = dict((existing or {}).get("models") or {})
    dropped = [m for m in old_models if m not in norm_models]
    if dropped and not bool(payload.get("allow_drop")):
        raise ValueError(
            "拒绝保存：本次提交会删除 %d 个已有模型（%s）。"
            "若确属有意删除，请带 allow_drop=true 重试。"
            % (len(dropped), ", ".join(dropped[:8]) + (" …" if len(dropped) > 8 else "")))

    new_item = {
        "id": uid,
        "label": str(item.get("label") or uid)[:120],
        "base_url": base_url,
        "api_key_env": env_name,
        "max_rpm": int(max_rpm),
        "models": norm_models,
    }
    if existing is not None:
        idx = raw_list.index(existing)
        raw_list[idx] = new_item
    else:
        raw_list.append(new_item)
    doc["upstreams"] = raw_list
    backup = _backup_upstreams()
    before_counts = {u.get("id"): len(u.get("models") or {}) for u in (raw_list_before or [])}
    _atomic_write(_upstreams_path(), json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    # 2026-11-23 防再犯③：保存后比对「改前/改后」模型数，任一上游减少即 WARNING 留痕，
    # 供 23:50 审计与人工复核（不阻塞保存——缩表已在上面被 allow_drop 闸拦住，
    # 走到这里还减少的，只可能是显式 allow_drop 或同名 id 变更，属信息项）。
    after_counts = {u.get("id"): len(u.get("models") or {}) for u in raw_list}
    shrunk = {k: (before_counts.get(k), v) for k, v in after_counts.items()
              if k in before_counts and v < before_counts[k]}
    if shrunk:
        LOG.warning("管理界面保存后模型数减少：%s（上游=%s）", shrunk, uid)

    api_key = str(payload.get("api_key") or "").strip()
    if api_key:
        _save_extra_ref(env_name, api_key)

    gateway.reload_upstreams()
    gateway.reload_secrets()
    refs = _referenced_models()
    unreferenced = sorted(k for k in (f"{uid}/{m}" for m in norm_models) if k not in refs)
    warnings = []
    if unreferenced:
        warnings.append(f"以下模型未进 auto 链（可显式 model 调用）：{', '.join(unreferenced[:8])}"
                        + (" …" if len(unreferenced) > 8 else ""))
    if not gateway.get_secret(env_name):
        warnings.append(f"密钥未设置（{env_name}），相关调用会失败")
    price_sync = _kick_price_sync()
    if dropped:
        warnings.append("已按 allow_drop=true 删除模型：" + ", ".join(dropped))
    return {"ok": True, "saved": new_item["id"], "backup": backup, "warnings": warnings,
            "dropped": dropped,
            "price_sync": price_sync,
            "upstreams": _upstreams_public()["upstreams"]}


def _delete_upstream(payload: dict) -> dict:
    gateway = _gw()
    uid = str(payload.get("id") or "").strip()
    if not uid:
        raise ValueError("缺少 id")
    doc = _load_upstreams_doc()
    raw_list = doc.get("upstreams") or []
    target = next((u for u in raw_list if u.get("id") == uid), None)
    if target is None:
        raise ValueError(f"供应商不存在：{uid}")
    doc["upstreams"] = [u for u in raw_list if u.get("id") != uid]
    if not doc["upstreams"]:
        raise ValueError("至少保留一个上游；未删除")
    backup = _backup_upstreams()
    _atomic_write(_upstreams_path(), json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    env_name = str(target.get("api_key_env") or "")
    still_used = any(str(u.get("api_key_env") or "") == env_name for u in doc["upstreams"])
    if env_name.startswith("UP_") and not still_used:
        try:
            _filter_extra_ref(env_name)
        except Exception:
            LOG.exception("清理扩展凭据失败")
    gateway.reload_upstreams()
    gateway.reload_secrets()
    return {"ok": True, "deleted": uid, "backup": backup,
            "upstreams": _upstreams_public()["upstreams"]}


# ---------------------------------------------------------------------------
# 路由入口
# ---------------------------------------------------------------------------


def _read_json(handler) -> dict:
    raw = _read_body(handler)
    if not raw:
        raise ValueError("请求体为空")
    if len(raw) > MAX_ADMIN_BODY:
        raise ValueError("请求体过大")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ValueError("请求体不是合法 JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是 JSON 对象")
    return payload


def _post_json(handler, path: str) -> tuple[dict | None, int | None]:
    """CSRF/JSON 校验 + 读 body；失败时直接写响应并返回 (None, status)。"""
    if not _same_origin_ok(handler):
        return None, _fail(handler, 403, "拒绝跨站/非 JSON 请求", "admin_csrf_rejected")
    try:
        return _read_json(handler), None
    except ValueError as exc:
        return None, _fail(handler, 400, str(exc), "admin_bad_body")


def handle(handler, method: str, path: str, query: dict) -> int:
    """处理 /admin*；返回 HTTP 状态码。调用方负责记录日志。"""
    if not _host_ok(handler):
        return _fail(handler, 403, "仅允许 loopback 访问管理界面", "admin_host_rejected")

    # 页面/登录页不含密钥，允许未登录先加载；数据类 API 一律要求会话。
    if method == "GET" and path in ("/admin", "/admin/"):
        try:
            html = HTML_FILE.read_text(encoding="utf-8")
        except FileNotFoundError:
            return _fail(handler, 500, "admin.html 缺失", "admin_html_missing")
        html = _inject_balances(html)   # Q1-1 B：余额请求时读盘，不依赖 cron 注入
        return handler._send_bytes(200, html.encode("utf-8"), "text/html; charset=utf-8",
                                   {"Cache-Control": "no-store"})

    if method == "GET" and path in ("/admin/review", "/admin/review/"):
        # B2 复盘页（1.0.3.2 T4）：页面本身零金额；数据只在登录后调 /admin/api/report 拉取。
        return handler._send_bytes(200, REVIEW_HTML.encode("utf-8"),
                                   "text/html; charset=utf-8", {"Cache-Control": "no-store"})

    if method == "GET" and path in ("/admin/live", "/admin/live/"):
        # T1（2026-11-21）：路由运行状态页（只读看板）。页面骨架零金额；
        # 数据只在登录后调 /admin/api/live 拉取。页面文件由 gw-live-web 交付，缺失即结构化 500。
        try:
            live_html = LIVE_HTML_FILE.read_text(encoding="utf-8")
        except FileNotFoundError:
            return _fail(handler, 500, "admin-live.html 缺失", "admin_live_html_missing")
        except OSError as exc:
            return _fail(handler, 500, f"读取 admin-live.html 失败：{type(exc).__name__}",
                         "admin_internal")
        return handler._send_bytes(200, live_html.encode("utf-8"),
                                   "text/html; charset=utf-8", {"Cache-Control": "no-store"})

    # -- 登录（不需要会话） -------------------------------------------------
    if method == "POST" and path == "/admin/api/login":
        payload, err = _post_json(handler, path)
        if err is not None:
            return err
        ip = _login_ip(handler)
        if _login_throttled(ip):
            LOG.warning("管理登录被限流 ip=%s", ip)
            return _fail(handler, 429, "登录尝试过多，请 5 分钟后再试", "admin_rate_limited")
        username = str(payload.get("username") or "").strip()
        password = str(payload.get("password") or "")
        try:
            doc = _load_auth()
        except ValueError as exc:
            return _fail(handler, 500, str(exc), "admin_auth_broken")
        if not _verify_password(username, password, doc):
            _login_failed(ip)
            time.sleep(0.2)
            LOG.warning("管理登录失败 ip=%s user=%r", ip, username[:32])
            return _fail(handler, 401, "用户名或密码错误", "admin_bad_credentials")
        _login_succeeded(ip)
        token = _new_session(str(doc["username"]))
        LOG.info("管理登录成功 ip=%s user=%s", ip, doc["username"])
        return _send_json_cookie(handler, 200, {
            "ok": True, "username": doc["username"],
            "default_password": bool(doc.get("default_password")),
        }, token)

    # -- 退出（可无会话） ---------------------------------------------------
    if method == "POST" and path == "/admin/api/logout":
        _, err = _post_json(handler, path)
        if err is not None:
            return err
        _drop_session(handler)
        return _send_json_clearcookie(handler, 200, {"ok": True})

    # -- 以下都要登录 -------------------------------------------------------
    user = _session_user(handler)
    if not user:
        return _fail(handler, 401, "请先登录", "admin_unauthorized")

    if method == "GET" and path == "/admin/api/me":
        try:
            doc = _load_auth()
        except ValueError as exc:
            return _fail(handler, 500, str(exc), "admin_auth_broken")
        return _send_json(handler, 200, _auth_public(doc))

    if method == "GET" and path == "/admin/api/upstreams":
        return _send_json(handler, 200, _upstreams_public())

    # ── N3（2026-11-19）：余额改由登录后的 API 提供（金额不再出现在静态页）──
    if method == "GET" and path == "/admin/api/balances":
        try:
            doc = balances_public()
        except FileNotFoundError:
            return _fail(handler, 404, "余额快照尚未生成", "admin_balances_missing")
        except Exception as exc:
            return _fail(handler, 500, f"读取余额快照失败：{type(exc).__name__}", "admin_internal")
        return _send_json(handler, 200, {"ok": True, **doc})

    # ── N8③（2026-11-19）：面板只读区块（插件状态 / backlog）────────────────
    if method == "GET" and path == "/admin/api/plugin-status":
        return _send_json(handler, 200, plugin_status_summary())

    if method == "GET" and path == "/admin/api/backlog":
        try:
            payload = _gw().health_payload()
        except Exception as exc:
            return _fail(handler, 500, f"读取健康信息失败：{type(exc).__name__}", "admin_internal")
        return _send_json(handler, 200, backlog_public(payload))

    if method == "GET" and path == "/admin/api/prices/status":
        return _send_json(handler, 200, {"ok": True, **price_sync_status()})

    # L5 ②（2026-11-20）：价格双源一致性快照 —— 与 GET /health 的 price_consistency
    # **同一个函数**（main.price_consistency_payload），面板/巡检拿到的口径与探针完全一致。
    # 只读；不写盘、不改价格。失败也只回 500 错误信封，不影响其它接口。
    if method == "GET" and path == "/admin/api/price-consistency":
        try:
            snapshot = _gw().price_consistency_payload()
        except Exception as exc:
            return _fail(handler, 500, f"读取价格一致性失败：{type(exc).__name__}", "admin_internal")
        return _send_json(handler, 200, {"ok": True, **snapshot})

    # B2 复盘报告 API（1.0.3.2 T4）：只读聚合，与 /v1/route/report 同一实现。
    if method == "GET" and path == "/admin/api/report":
        range_key = str((query.get("range") or ["7d"])[0] or "7d").strip().lower()[:16]
        group = str((query.get("group") or ["model"])[0] or "model").strip().lower()[:16]
        try:
            report = _gw().router_plan.report(range_key, group)
        except Exception as exc:
            return _fail(handler, 500, f"读取复盘报告失败：{type(exc).__name__}", "admin_internal")
        return _send_json(handler, 200, report)

    # T1（2026-11-21）：路由运行状态只读聚合（契约 §4）。**只读**：不执行、不写账、不调上游；
    # range/limit 由 router_live 归一（非法回落 24h / 夹 1..100），这里不做第二次口径。
    if method == "GET" and path == "/admin/api/live":
        range_key = str((query.get("range") or ["24h"])[0] or "24h").strip().lower()[:16]
        raw_limit = (query.get("limit") or ["30"])[0]
        try:
            live = router_live.snapshot(range_key, raw_limit)
        except Exception as exc:      # snapshot 内部已兜底；这里只是最后一道闸
            return _fail(handler, 500, f"读取运行状态失败：{type(exc).__name__}", "admin_internal")
        return handler._send_bytes(
            200, json.dumps(live, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8", {"Cache-Control": "no-store"})

    if method == "GET" and path == "/admin/api/strategies":
        return _send_json(handler, 200, rstrat.public())

    if method == "GET" and path == "/admin/api/api-keys":
        try:
            return _send_json(handler, 200, api_keys.public_doc())
        except Exception as exc:
            return _fail(handler, 500, f"读取 API key 失败：{type(exc).__name__}", "admin_internal")

    if method == "GET" and path == "/admin/api/learned-overrides":
        return _send_json(handler, 200, {
            "ok": True,
            "auto_learn": router_plan.auto_learn_enabled(),
            "learned_overrides": rstrat.learned_overrides(),
            "counters": router_plan.load_learned_state().get("counters") or {},
        })

    if method == "GET" and path == "/admin/api/strategies/defaults":
        return _send_json(handler, 200, {
            "ok": True, "strategies": rstrat.defaults(),
            "functions": rstrat.function_catalog(),
            "models": sorted(rstrat._allowed_models()),
        })

    if method == "POST" and path == "/admin/api/change-credentials":
        payload, err = _post_json(handler, path)
        if err is not None:
            return err
        try:
            doc = _load_auth()
        except ValueError as exc:
            return _fail(handler, 500, str(exc), "admin_auth_broken")
        current = str(payload.get("current_password") or "")
        new_username = str(payload.get("new_username") or "").strip()
        new_password = str(payload.get("new_password") or "")
        if not _verify_password(user, current, doc):
            return _fail(handler, 401, "当前密码错误", "admin_bad_credentials")
        if not re.match(r"^[A-Za-z0-9_.-]{3,32}$", new_username):
            return _fail(handler, 400, "用户名需 3-32 位字母/数字/_.-", "admin_bad_username")
        if not (6 <= len(new_password) <= 128):
            return _fail(handler, 400, "新密码长度需 6-128 位", "admin_bad_password")
        new_doc = _make_auth_doc(new_username, new_password, default=False)
        _save_auth(new_doc)
        with _SESSIONS_LOCK:
            _SESSIONS.clear()  # 改密后所有旧会话失效
        token = _new_session(new_username)
        LOG.info("管理登录凭据已修改：user=%s", new_username)
        return _send_json_cookie(handler, 200, {
            "ok": True, "username": new_username, "default_password": False,
        }, token)

    if method == "POST" and path == "/admin/api/strategies/save":
        payload, err = _post_json(handler, path)
        if err is not None:
            return err
        raw = payload.get("strategies") if isinstance(payload.get("strategies"), dict) else payload
        try:
            doc, errors = rstrat.save(raw)
        except Exception as exc:
            LOG.exception("保存路由策略失败")
            return _fail(handler, 500, f"保存路由策略失败：{type(exc).__name__}", "admin_internal")
        if errors:
            return _send_json(handler, 400, {
                "ok": False,
                "error": {"message": "策略校验失败：" + "；".join(errors[:8]), "type": "invalid_request_error",
                          "code": "strategy_invalid"},
                "errors": errors,
                "strategies": doc,
            })
        return _send_json(handler, 200, {"ok": True, "saved": True, **rstrat.public()})

    if method == "POST" and path.startswith("/admin/api/"):
        if not _same_origin_ok(handler):
            return _fail(handler, 403, "拒绝跨站/非 JSON 请求", "admin_csrf_rejected")
        try:
            payload = _read_json(handler)
        except ValueError as exc:
            return _fail(handler, 400, str(exc), "admin_bad_body")

        try:
            if path == "/admin/api/api-keys/create":
                scopes = payload.get("scopes")
                try:
                    rpm = int(payload.get("rpm") or 600)
                except (TypeError, ValueError):
                    rpm = 600
                return _send_json(handler, 200, api_keys.create(
                    str(payload.get("name") or "client"), scopes, rpm))

            if path == "/admin/api/api-keys/revoke":
                return _send_json(handler, 200, api_keys.revoke(str(payload.get("id") or "")))

            if path == "/admin/api/api-keys/rotate":
                return _send_json(handler, 200, api_keys.rotate(str(payload.get("id") or "")))

            if path == "/admin/api/api-keys/required":
                return _send_json(handler, 200, api_keys.set_required(bool(payload.get("required"))))

            if path == "/admin/api/learned-overrides/delete":
                strategy = str(payload.get("strategy") or "").strip().lower()
                capability = str(payload.get("capability") or "").strip().lower()
                removed = rstrat.remove_learned_override(strategy, capability)
                return _send_json(handler, 200, {"ok": True, "removed": removed})

            if path == "/admin/api/auto-learn":
                enabled = bool(payload.get("enabled"))
                pth = router_plan.settings_path()
                doc = router_plan.settings()
                doc["auto_learn"] = enabled
                router_plan._atomic_json(pth, doc)
                return _send_json(handler, 200, {"ok": True, "auto_learn": enabled})

            if path == "/admin/api/probe-models":
                base_url = str(payload.get("base_url") or "").strip()
                if not base_url:
                    raise ValueError("缺少 base_url")
                parsed = urllib.parse.urlparse(base_url)
                if parsed.scheme not in ("http", "https") or not parsed.netloc:
                    raise ValueError("base_url 必须是 http(s)://host/... 形式")
                return _send_json(handler, 200, _probe_models(base_url, _resolve_key(payload)))

            if path == "/admin/api/probe-capabilities":
                base_url = str(payload.get("base_url") or "").strip()
                model = str(payload.get("model") or "").strip()
                if not base_url or not model:
                    raise ValueError("缺少 base_url 或 model")
                parsed = urllib.parse.urlparse(base_url)
                if parsed.scheme not in ("http", "https") or not parsed.netloc:
                    raise ValueError("base_url 必须是 http(s)://host/... 形式")
                return _send_json(handler, 200, _probe_capabilities(
                    base_url, _resolve_key(payload), model))

            if path == "/admin/api/test":
                base_url = str(payload.get("base_url") or "").strip()
                model = str(payload.get("model") or "").strip()
                if not base_url or not model:
                    raise ValueError("缺少 base_url 或 model")
                parsed = urllib.parse.urlparse(base_url)
                if parsed.scheme not in ("http", "https") or not parsed.netloc:
                    raise ValueError("base_url 必须是 http(s)://host/... 形式")
                result = _chat_probe(base_url, _resolve_key(payload), model, {
                    "messages": [{"role": "user", "content": "只回复OK两个字母"}],
                })
                result["ok"] = bool(result.get("ok"))
                return _send_json(handler, 200, result)

            if path == "/admin/api/prices/refresh":
                return _send_json(handler, 200, _kick_price_sync())

            if path == "/admin/api/save":
                return _send_json(handler, 200, _save_upstream(payload))

            if path == "/admin/api/delete":
                return _send_json(handler, 200, _delete_upstream(payload))
        except ValueError as exc:
            return _fail(handler, 400, str(exc), "admin_invalid")
        except Exception as exc:
            LOG.exception("管理操作失败 path=%s", path)
            return _fail(handler, 500, f"管理操作失败：{type(exc).__name__}", "admin_internal")

        return _fail(handler, 404, f"未知管理接口：{path}", "admin_not_found")

    return _fail(handler, 404, f"未知管理接口：{path}", "admin_not_found")
