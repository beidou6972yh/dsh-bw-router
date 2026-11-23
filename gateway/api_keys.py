"""WB 网关 · 按客户端签发的 API key（P1）。

设计（Q30 A）：
  - 管理面签发 per-client key：name / scopes(plan,chat) / rpm；
  - 只存 PBKDF2-SHA256 哈希＋盐，明文只在创建/轮换时返回一次；
  - 所有 /v1/* API 用 Authorization: Bearer <token>；admin/health 不走 key；
  - 默认 required=false，便于平滑上线；WB_API_KEYS_REQUIRED=1 或管理面打开后强制；
  - key 轮换/吊销立即生效；最后使用时间只做低频写，避免每请求落盘。

本模块只读写 config/api-keys.json（样例文件 api-keys.example.json），不碰上游/密钥。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

BASE_DIR: Path | None = None
_LOCK = threading.Lock()
_LAST_USE_FLUSH: dict[str, float] = {}
_TOKEN_PREFIX = "wb_"
PBKDF2_ITER = 200_000
_VALID_SCOPES = ("plan", "chat")

# ── Q2-2（2026-11-18）：鉴权查询改成「前缀预筛 + 验证缓存」 ────────────────
# 旧实现：每请求读盘 + 沿 keys 逐个 PBKDF2-200k（3 key 时 0.30s/请求）。
# 新实现：① 明文前缀（token[:12]，已在签发记录里）先筛候选，无效 token 微秒级失败；
#          ② 命中过一次的 token 用 sha256(token) 作键缓存 principal（TTL 300s），热路径 0 次 PBKDF2；
#          ③ 吊销/轮换/创建时显式清缓存；外部改文件（mtime 变且非自写）也清缓存。
# 开关：ROUTER_AUTH_CACHE=0 回旧行为；ROUTER_AUTH_CACHE_TTL 调 TTL；ROUTER_AUTH_CACHE_MAX 调容量。
CACHE_MAX = int((os.environ.get("ROUTER_AUTH_CACHE_MAX") or "10000").strip() or 10000)
CACHE_TTL = float((os.environ.get("ROUTER_AUTH_CACHE_TTL") or "300").strip() or 300)
_DOC_LOCK = threading.Lock()
_DOC_CACHE: dict[str, Any] = {"mtime": None, "doc": None, "gen": 0, "self_write_ts": 0.0}
_VERIFY_LOCK = threading.Lock()
_VERIFY_CACHE: dict[str, dict] = {}


def set_base(base: str | Path) -> None:
    global BASE_DIR
    BASE_DIR = Path(base)


def _base() -> Path:
    if BASE_DIR is None:
        return Path(__file__).resolve().parent
    return BASE_DIR


def path() -> Path:
    return _base() / "config" / "api-keys.json"


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _hash(token: str, salt: bytes, iterations: int) -> str:
    return _b64(hashlib.pbkdf2_hmac("sha256", token.encode("utf-8"), salt, iterations))


def _atomic_write(doc: dict) -> None:
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="api-keys.", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            fp.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
            fp.flush()
            os.fsync(fp.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _blank() -> dict:
    return {"version": 1, "required": False, "keys": []}


def load() -> dict:
    """读配置；不存在则创建空白（required=false）。损坏 fail closed。"""
    p = path()
    if not p.exists():
        doc = _blank()
        _atomic_write(doc)
        return doc
    try:
        with p.open("r", encoding="utf-8") as fp:
            doc = json.load(fp)
    except Exception as exc:
        raise ValueError("api-keys.json 损坏") from exc
    if not isinstance(doc, dict) or not isinstance(doc.get("keys"), list):
        raise ValueError("api-keys.json 结构非法")
    doc.setdefault("version", 1)
    doc.setdefault("required", False)
    return doc


def _cache_enabled() -> bool:
    raw = (os.environ.get("ROUTER_AUTH_CACHE") or "").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _token_fp(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _stat_mtime() -> float | None:
    try:
        return path().stat().st_mtime
    except OSError:
        return None


def _doc_gen() -> int:
    return int(_DOC_CACHE.get("gen") or 0)


def load_cached() -> dict:
    """鉴权热路径用：按 mtime 缓存配置；外部改动会清验证缓存，自写不清。"""
    mtime = _stat_mtime()
    with _DOC_LOCK:
        cached = _DOC_CACHE
        if cached.get("doc") is not None and mtime is not None and cached.get("mtime") == mtime:
            return cached["doc"]
        doc = load()  # 保持与 load() 一致的校验/fail-closed 语义
        if cached.get("doc") is not None:
            # 自写（save() 刚写过盘）不失效；外部改动 ⇒ 代际 +1 并清缓存。
            # 用「写盘时刻」判断而非计数器，避免多次 save 累积导致外部改动被误判为自写。
            self_ts = float(cached.get("self_write_ts") or 0.0)
            if mtime is None or mtime <= self_ts + 0.5:
                pass
            else:
                cached["gen"] = int(cached.get("gen") or 0) + 1
                with _VERIFY_LOCK:
                    _VERIFY_CACHE.clear()
        cached["doc"] = doc
        cached["mtime"] = mtime
        return doc


def invalidate_verify() -> None:
    """吊销/轮换/创建后调用：让缓存立即失效，不等 TTL。"""
    with _VERIFY_LOCK:
        _VERIFY_CACHE.clear()


def _remember(fp: str, principal: dict) -> None:
    if not _cache_enabled():
        return
    with _VERIFY_LOCK:
        _VERIFY_CACHE[fp] = {"principal": dict(principal), "gen": _doc_gen(), "at": time.time()}
        if len(_VERIFY_CACHE) > max(100, CACHE_MAX):
            # 简单 FIFO 淘汰（dict 保持插入序），避免无界内存
            for old in list(_VERIFY_CACHE.keys())[: max(1, len(_VERIFY_CACHE) - CACHE_MAX)]:
                _VERIFY_CACHE.pop(old, None)


def save(doc: dict) -> None:
    with _LOCK:
        _atomic_write(doc)
    with _DOC_LOCK:
        _DOC_CACHE["doc"] = doc
        _DOC_CACHE["mtime"] = _stat_mtime()
        _DOC_CACHE["self_write_ts"] = time.time()


def required() -> bool:
    """强制校验 key？env WB_API_KEYS_REQUIRED 优先，否则看文件。"""
    raw = (os.environ.get("WB_API_KEYS_REQUIRED") or "").strip().lower()
    if raw:
        return raw not in ("0", "false", "no", "off")
    try:
        return bool(load().get("required"))
    except Exception:
        return True  # 配置损坏则 fail closed


def set_required(value: bool) -> dict:
    doc = load()
    doc["required"] = bool(value)
    doc["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    save(doc)
    return public_doc(doc)


def _norm_scopes(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return ["plan", "chat"]
    out = []
    for item in raw:
        text = str(item or "").strip().lower()
        if text in _VALID_SCOPES and text not in out:
            out.append(text)
    return out or ["plan", "chat"]


def _public_key(item: dict) -> dict:
    return {
        "id": item.get("id"),
        "name": item.get("name"),
        "prefix": item.get("prefix"),
        "scopes": list(item.get("scopes") or []),
        "rpm": item.get("rpm"),
        "created_at": item.get("created_at"),
        "last_used_at": item.get("last_used_at"),
        "revoked_at": item.get("revoked_at"),
    }


def public_doc(doc: dict | None = None) -> dict:
    doc = load() if doc is None else doc
    return {
        "ok": True,
        "required": bool(doc.get("required")),
        "env_required": (os.environ.get("WB_API_KEYS_REQUIRED") or "").strip(),
        "keys": [_public_key(k) for k in doc.get("keys", []) if isinstance(k, dict)],
        "path": str(path()),
    }


def _new_record(name: str, scopes: list[str], rpm: int) -> tuple[dict, str]:
    token = _TOKEN_PREFIX + secrets.token_urlsafe(32)
    salt = secrets.token_bytes(16)
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    rec = {
        "id": "key-" + secrets.token_hex(6),
        "name": str(name).strip()[:64] or "client",
        "prefix": token[:12],
        "salt": _b64(salt),
        "hash": _hash(token, salt, PBKDF2_ITER),
        "iterations": PBKDF2_ITER,
        "scopes": scopes,
        "rpm": max(1, min(int(rpm), 10000)),
        "created_at": now,
        "last_used_at": None,
        "revoked_at": None,
    }
    return rec, token


def create(name: str = "", scopes: Any = None, rpm: int = 600) -> dict:
    doc = load()
    rec, token = _new_record(name, _norm_scopes(scopes), rpm)
    doc.setdefault("keys", []).append(rec)
    save(doc)
    invalidate_verify()
    return {"ok": True, "key": _public_key(rec), "token": token,
            "notice": "明文 token 只显示这一次；请立即交给客户端保存。"}


def _find(doc: dict, key_id: str) -> dict | None:
    for item in doc.get("keys", []):
        if isinstance(item, dict) and item.get("id") == key_id:
            return item
    return None


def revoke(key_id: str) -> dict:
    doc = load()
    rec = _find(doc, str(key_id or ""))
    if rec is None:
        return {"ok": False, "error": "key 不存在"}
    if not rec.get("revoked_at"):
        rec["revoked_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        save(doc)
        invalidate_verify()
    return {"ok": True, "key": _public_key(rec)}


def rotate(key_id: str) -> dict:
    doc = load()
    rec = _find(doc, str(key_id or ""))
    if rec is None:
        return {"ok": False, "error": "key 不存在"}
    if rec.get("revoked_at"):
        return {"ok": False, "error": "key 已吊销，不能轮换"}
    token = _TOKEN_PREFIX + secrets.token_urlsafe(32)
    salt = secrets.token_bytes(16)
    rec["prefix"] = token[:12]
    rec["salt"] = _b64(salt)
    rec["hash"] = _hash(token, salt, PBKDF2_ITER)
    rec["iterations"] = PBKDF2_ITER
    rec["created_at"] = rec.get("created_at") or time.strftime("%Y-%m-%dT%H:%M:%S%z")
    rec["last_used_at"] = None
    doc["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    save(doc)
    invalidate_verify()
    return {"ok": True, "key": _public_key(rec), "token": token,
            "notice": "旧 token 已立即失效；新明文只显示这一次。"}


def _bearer(authorization: str | None) -> str:
    raw = (authorization or "").strip()
    if not raw:
        return ""
    scheme, _, token = raw.partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


def verify(authorization: str | None, need_scope: str = "") -> dict | None:
    """校验 Bearer token；成功返回 {id,name,scopes,...}，失败 None。

    Q2-2：缓存命中（同一 token、配置未变、TTL 内）直接返回，不再跑 PBKDF2；
    冷路径先按明文前缀筛候选，只对候选逐个 PBKDF2（通常 1 个）。
    """
    token = _bearer(authorization)
    if not token:
        return None
    fp = _token_fp(token)
    now_epoch = time.time()
    if _cache_enabled():
        # 先看配置文件有没有被外部改过（stat 约 2µs）；变了就重读并清验证缓存。
        mt = _stat_mtime()
        if mt is not None and mt != _DOC_CACHE.get("mtime"):
            try:
                load_cached()
            except Exception:
                return None
        with _VERIFY_LOCK:
            hit = _VERIFY_CACHE.get(fp)
            if hit and hit.get("gen") == _doc_gen() and (now_epoch - float(hit.get("at") or 0)) <= CACHE_TTL:
                cached_principal = dict(hit["principal"])
                scopes = list(cached_principal.get("scopes") or [])
                if need_scope and need_scope not in scopes:
                    return None
                return cached_principal
    try:
        doc = load_cached()
    except Exception:
        return None
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    keys = [rec for rec in doc.get("keys", [])
            if isinstance(rec, dict) and not rec.get("revoked_at")]
    # 前缀预筛：signing 时 token[:12] 已存 prefix；无 prefix 字段的旧记录退回全表（兼容）
    prefix = token[:12]
    if any(str(rec.get("prefix") or "") for rec in keys):
        candidates = [rec for rec in keys if str(rec.get("prefix") or "") == prefix]
    else:
        candidates = keys
    if not candidates:
        return None  # 前缀不命中：微秒级失败，不跑 PBKDF2（无效 token 不再与合法请求同价）
    matched: dict | None = None
    for rec in candidates:
        try:
            salt = base64.b64decode(rec["salt"])
            expected = str(rec["hash"])
            iterations = int(rec.get("iterations") or PBKDF2_ITER)
        except Exception:
            continue
        actual = _hash(token, salt, iterations)
        if hmac.compare_digest(actual.encode("utf-8"), expected.encode("utf-8")):
            matched = rec
            break
    if matched is None:
        return None
    scopes = list(matched.get("scopes") or [])
    if need_scope and need_scope not in scopes:
        return None
    # 低频写 last_used（每 key 最多 60s 一次），失败不影响鉴权；save 会标记 self_write
    key_id = str(matched.get("id") or "")
    last = _LAST_USE_FLUSH.get(key_id, 0.0)
    if time.time() - last > 60:
        _LAST_USE_FLUSH[key_id] = time.time()
        try:
            full = load()
            for rec in full.get("keys", []):
                if isinstance(rec, dict) and rec.get("id") == key_id:
                    rec["last_used_at"] = now
                    break
            save(full)
        except Exception:
            pass
    principal = {"id": key_id, "name": matched.get("name"), "prefix": matched.get("prefix"),
                 "scopes": scopes, "rpm": matched.get("rpm"),
                 # B5（1.0.3.2 T6）：只读兼容入口的 per-key 开关（缺省 false ⇒ 默认关）
                 "passthrough": bool(matched.get("passthrough"))}
    _remember(fp, principal)
    return dict(principal)


def principal_from(authorization: str | None, need_scope: str = "") -> dict | None:
    return verify(authorization, need_scope)
