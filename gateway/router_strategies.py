"""模型路由网关 · 路由策略（价格优先 / 能力优先 / 预设功能 / 推荐）。

存储：$BASE_DIR/config/router-strategies.json（管理界面保存；网关按 mtime 热读，无需重启）。
读取：main.build_candidates 在请求时调用 chain()；admin_ui 提供读写 API。

四条策略（用户 2026-11-17 定：三策略改名＋新增推荐）：
  - cost（价格优先，原「性价比」）：按档位 L1/L2/L3/image 的有序候选链，默认按现网 routes（高峰避官方、低峰官方优先）
  - capability（能力优先，原「能力」）：按档位的有序“最强组合”，不在意单价
  - function（预设功能，原「功能路由」）：function key → 有序模型链；请求用 X-DSH-Route-Function 头指定功能
    功能清单含视觉/音频/视频识别、工具调用、生成类、超长上下文、向量、排序、决策、文本、系统操控、代码、测试、记忆等；
    非 chat 兼容功能只做“映射”，由客户端按该模型调用对应端点（网关当前只代理 chat/completions）。
  - recommend（推荐）：结合 pricebook 单价与 capability_meta 档位实时计算，三种预设模式：
    price（价格优先，默认）/ capability（能力优先）/ preset（预设功能）；
    用户可在管理界面调整推荐链后保存为覆盖层（recommend 节），保存后以覆盖层优先、实时计算兜底。
    虚拟模型 auto-recommend ＋ 请求头 X-DSH-Route-Mode: price|capability|preset；
    虚拟模型只用于网关与插件后台识别/调度，不在 DSH 前台输入框与模型管理中体现。

安全：本模块不读密钥；只读写策略文件；模型引用在保存与请求时都会按当前 upstreams 过滤。
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path

import price_resolver

STAGES = ("L1", "L2", "L3", "image")
PERIODS = ("peak", "offpeak")

# 推荐策略（2026-11-17 用户令）：三种预设模式；默认 price（价格优先）
RECOMMEND_MODES = ("price", "capability", "preset")
RECOMMEND_DEFAULT_MODE = "price"

# (key, 中文名, 是否 chat 兼容)
FUNCTION_CATALOG = [
    ("vision", "图形识别", True),
    ("audio", "音频识别", False),
    ("video", "视频识别", False),
    ("tools", "工具调用", True),
    ("image_generation", "图形生成", False),
    ("audio_generation", "音频生成", False),
    ("video_generation", "视频生成", False),
    ("long_context", "超长上下文", True),
    ("embedding", "向量模型", False),
    ("rerank", "排序模型", False),
    ("decision", "决策模型", True),
    ("writing", "文本撰写", True),
    ("system_control", "系统操控", True),
    ("coding", "代码编写", True),
    ("code_testing", "代码测试", True),
    ("memory", "记忆模型", True),
]
FUNCTION_KEYS = {key for key, _label, _chat in FUNCTION_CATALOG}
FUNC_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,31}$")

_GATEWAY = None
_LOCK = threading.Lock()
_CACHE: dict = {"key": None, "doc": None}


def set_gateway(module) -> None:
    global _GATEWAY
    _GATEWAY = module


def _gw():
    if _GATEWAY is None:  # pragma: no cover
        raise RuntimeError("router_strategies 未初始化")
    return _GATEWAY


def strategies_path() -> Path:
    return Path(_gw().BASE_DIR) / "config" / "router-strategies.json"


def function_catalog() -> list[dict]:
    return [{"key": k, "label": label, "chat_compatible": chat} for k, label, chat in FUNCTION_CATALOG]


def _dedup_chain(value, allowed: set[str] | None = None) -> list[str]:
    out: list[str] = []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return out
    for item in value:
        text = str(item or "").strip()
        if not text:
            continue
        if allowed is not None and text not in allowed:
            continue
        if text not in out:
            out.append(text)
    return out


def _allowed_models() -> set[str]:
    keys: set[str] = set()
    for upstream in getattr(_gw(), "UPSTREAMS", []) or []:
        for model_id in (upstream.models or {}):
            keys.add(f"{upstream.id}/{model_id}")
    return keys


def _read_doc() -> dict | None:
    path = strategies_path()
    try:
        mtime = path.stat().st_mtime_ns
    except FileNotFoundError:
        return None
    cache_key = (str(path), mtime)
    with _LOCK:
        if _CACHE.get("key") == cache_key:
            return _CACHE.get("doc")
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        if not isinstance(doc, dict):
            return None
        _CACHE["key"] = cache_key
        _CACHE["doc"] = doc
        return doc


def _write_doc(doc: dict) -> None:
    path = strategies_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="router-strategies.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            fp.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
            fp.flush()
            os.fsync(fp.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    with _LOCK:
        _CACHE["key"] = None
        _CACHE["doc"] = None


def _candidate_order() -> list[str]:
    """按 upstreams.json 声明顺序列出全部候选（不含任何具体环境写死的模型名）。

    R7（2026-11-20，回灌 1.0.2.7r1）：默认链一律「按当前 upstreams 现场推导」——
    换任意一份 upstreams.json 都能自立一套默认链，不会残留已经不存在的模型 id。
    """
    order: list[str] = []
    for upstream in getattr(_gw(), "UPSTREAMS", []) or []:
        for model_id in (upstream.models or {}):
            order.append(f"{upstream.id}/{model_id}")
    return order


def _spec_for(candidate: str) -> dict:
    """取候选在 upstreams.json 里的模型规格（tier/vision/context_window…）；取不到 ⇒ {}。"""
    gw = _gw()
    up_id, model_id = gw.split_candidate(candidate)
    for upstream in getattr(gw, "UPSTREAMS", []) or []:
        if upstream.id == up_id:
            return upstream.model_spec(model_id) or {}
    return {}


def _tier_rank(spec: dict) -> int:
    """strong=0、其余=1，用于把强模型排在链头（不写死具体模型名）。"""
    return 0 if str(spec.get("tier") or "").strip().lower() == "strong" else 1


def _default_function_chains(allowed: set[str]) -> dict[str, list[str]]:
    """默认功能链：按当前 upstreams.json 声明的能力/档位/上下文长度现场推导。

    R7（2026-11-20，回灌 1.0.2.7r1）：不再写死任何具体环境的模型 id。
    旧实现写死了 provider_i/*×6、provider_b/exec-35b、provider_b/vision-mini 等；
    实测 11 个写死名里 8 个在当前 upstreams.json 已不存在 ⇒ 一旦策略文件缺失走
    defaults() 回退，功能链会大面积空掉。现在改为现场推导，天然跟随 upstreams。
    """
    candidates = [c for c in _candidate_order() if c in allowed]
    specs = {c: _spec_for(c) for c in candidates}
    strong_first = sorted(candidates, key=lambda c: (_tier_rank(specs[c]), candidates.index(c)))
    vision = [c for c in strong_first if specs[c].get("vision")]
    long_ctx = sorted(candidates, key=lambda c: -(specs[c].get("context_window") or 0))
    text_chain = strong_first[:3]
    return {
        "vision": vision[:3],
        "audio": [],
        "video": [],
        "tools": text_chain,
        "image_generation": [],
        "audio_generation": [],
        "video_generation": [],
        "long_context": long_ctx[:3],
        "embedding": [],
        "rerank": [],
        "decision": text_chain,
        "writing": text_chain,
        "system_control": text_chain,
        "coding": text_chain,
        "code_testing": text_chain,
        "memory": [],
    }


def defaults() -> dict:
    """默认策略：cost 取现网 routes；capability 取最强组合；function 取推荐映射；recommend 无覆盖层（实时算）。"""
    gw = _gw()
    allowed = _allowed_models()
    routes = gw.CONFIG.get("routes") or {}
    cost: dict[str, dict[str, list[str]]] = {"peak": {}, "offpeak": {}}
    for period in PERIODS:
        table = routes.get(period) or {}
        for stage in STAGES:
            cost[period][stage] = _dedup_chain(table.get(stage) or [], allowed)
    # 能力策略 = 最强组合：按 upstreams.json 的 tier/vision 现场推导（不写死模型 id）
    # R7（2026-11-20，回灌 1.0.2.7r1）：旧实现在这里写死 5 个强链名 + 6 个视觉链名，
    # 当前 upstreams 里 8/11 已不存在 ⇒ 回退链几乎空掉。改为现场推导。
    candidates = [c for c in _candidate_order() if c in allowed]
    specs = {c: _spec_for(c) for c in candidates}
    strong_chain = [c for c in sorted(candidates, key=lambda c: _tier_rank(specs[c]))
                    if _tier_rank(specs[c]) == 0]
    if not strong_chain:
        strong_chain = list(candidates)
    image_chain = ([c for c in strong_chain if specs[c].get("vision")]
                   or [c for c in candidates if specs[c].get("vision")])
    cap: dict[str, list[str]] = {stage: list(strong_chain) for stage in ("L1", "L2", "L3")}
    cap["image"] = image_chain
    return {
        "version": 1,
        "cost": cost,
        "capability": cap,
        "function": _default_function_chains(allowed),
        "recommend": {},  # 推荐策略默认无覆盖层（实时计算）；管理界面保存后才有
        "learned_overrides": {},
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "defaults": True,
    }


def effective() -> dict:
    return _read_doc() or defaults()


def normalize(raw: dict, allowed: set[str] | None = None) -> tuple[dict, list[str]]:
    """清洗/校验策略对象；返回 (doc, errors)。"""
    allowed = allowed if allowed is not None else _allowed_models()
    errors: list[str] = []
    if not isinstance(raw, dict):
        return defaults(), ["策略必须是 JSON 对象"]
    raw_cost = raw.get("cost") if isinstance(raw.get("cost"), dict) else {}
    cost: dict[str, dict[str, list[str]]] = {"peak": {}, "offpeak": {}}
    for period in PERIODS:
        table = raw_cost.get(period) if isinstance(raw_cost.get(period), dict) else raw_cost
        for stage in STAGES:
            cost[period][stage] = _dedup_chain(table.get(stage), allowed)
    raw_cap = raw.get("capability") if isinstance(raw.get("capability"), dict) else {}
    capability = {stage: _dedup_chain(raw_cap.get(stage), allowed) for stage in STAGES}
    raw_fn = raw.get("function") if isinstance(raw.get("function"), dict) else {}
    functions: dict[str, list[str]] = {}
    for key, value in raw_fn.items():
        key = str(key or "").strip().lower()
        if not FUNC_KEY_RE.match(key):
            errors.append(f"功能 key 非法：{key!r}（小写字母/数字/下划线，2-32 位）")
            continue
        chain = _dedup_chain(value, allowed)
        dropped = [str(x) for x in (value if isinstance(value, list) else [value])
                   if str(x or "").strip() and str(x).strip() not in allowed]
        if dropped:
            errors.append(f"功能 {key} 含未配置模型，已剔除：{', '.join(dropped[:6])}")
        functions[key] = chain
    # recommend（推荐策略覆盖层）：按档位存链；只接受已配置模型；空链=清掉覆盖层（回到实时计算）。
    raw_rec = raw.get("recommend") if isinstance(raw.get("recommend"), dict) else {}
    recommend: dict[str, list[str]] = {}
    for stage in STAGES:
        chain = _dedup_chain(raw_rec.get(stage), allowed)
        if chain:
            recommend[stage] = chain
    # learned_overrides：策略 + 能力/角色 → 模型；只接受已配置模型，不猜。
    raw_lo = raw.get("learned_overrides") if isinstance(raw.get("learned_overrides"), dict) else {}
    learned: dict[str, dict[str, dict]] = {}
    for strategy, caps in raw_lo.items():
        strategy = str(strategy or "").strip().lower()
        if strategy not in ("cost", "capability", "function"):
            errors.append(f"learned_overrides 策略非法：{strategy!r}")
            continue
        if not isinstance(caps, dict):
            continue
        table: dict[str, dict] = {}
        for cap, entry in caps.items():
            cap = str(cap or "").strip().lower()
            if not cap or not isinstance(entry, dict):
                continue
            model = str(entry.get("model") or "").strip()
            if not model or model not in allowed:
                errors.append(f"learned_overrides {strategy}/{cap} 含未配置模型：{model!r}")
                continue
            row = {"model": model, "function": str(entry.get("function") or "").strip().lower(),
                   "source": str(entry.get("source") or "manual"), "learned_at": entry.get("learned_at"),
                   "evidence": entry.get("evidence") if isinstance(entry.get("evidence"), dict) else None}
            table[cap] = row
        if table:
            learned[strategy] = table
    for stage in STAGES:
        if not cost["peak"].get(stage) and not cost["offpeak"].get(stage):
            errors.append(f"价格优先策略缺少 {stage} 链（高峰/低峰至少一条）")
    if not any(capability.values()):
        errors.append("能力优先策略为空（至少一个档位要有模型链）")
    doc = {
        "version": 1,
        "cost": cost,
        "capability": capability,
        "function": functions,
        "recommend": recommend,
        "learned_overrides": learned,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    return doc, errors


def save(raw: dict) -> tuple[dict, list[str]]:
    doc, errors = normalize(raw)
    if errors:
        # 只把“可修复的剔除提示”作为 warning 返回；结构错误仍保存？策略：有错误不保存，交前端修。
        return doc, errors
    _write_doc(doc)
    return doc, []


def _round3(value) -> float | None:
    """单位价统一到 3 位小数（2026-11-17 用户令）；非数字/bool/None ⇒ None（不猜价）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return round(float(value), 3)


def _recommend_price_view(candidate: str) -> tuple[float | None, float | None]:
    """候选的有效单价（入/出，元/百万 tokens）：pricebook 有效价优先，回落 capability_meta 低峰价。

    两边都拿不到 → (None, None)：该模型**价未知**，推荐链不参与排序（排到已知价之后），不猜价。
    非 CNY 报价一律折成 CNY（汇率真源 config/fx-rates.json）；无汇率 ⇒ 同样视为价未知，不猜价。
    """
    in_p = out_p = None
    try:
        offer = _gw().pricebook_offer(candidate)
        if offer is not None:
            priced = price_resolver.effective_price(offer)
            prices = priced.get("prices") or {}
            # 单位价按 3 位小数计（2026-11-17 用户令），与显示口径一致
            in_p = _round3(prices.get("input"))
            out_p = _round3(prices.get("output"))
            if in_p is not None or out_p is not None:
                # 币种以报价本身为准（pricebook 现全 CNY；priced.currency 是常量兜底，不能当唯一真源）
                price_block = offer.get("price") if isinstance(offer.get("price"), dict) else {}
                meta_block = offer.get("meta") if isinstance(offer.get("meta"), dict) else {}
                currency = str(offer.get("currency") or price_block.get("currency")
                               or meta_block.get("currency")
                               or priced.get("currency") or "CNY").strip().upper()
                if currency not in ("CNY", "RMB"):
                    in_p = _round3(price_resolver.convert_to_cny(in_p, currency)) if in_p is not None else None
                    out_p = _round3(price_resolver.convert_to_cny(out_p, currency)) if out_p is not None else None
    except Exception:
        pass
    if in_p is None and out_p is None:
        meta = (_gw().CAPABILITY_META_MODELS.get(candidate) or {}).get("price") or {}
        currency = str(meta.get("currency") or "CNY").strip().upper()
        block = meta.get("input_per_mtok") or {}
        in_p = _round3(block.get("offpeak"))
        block = meta.get("output_per_mtok") or {}
        out_p = _round3(block.get("offpeak"))
        if (in_p is not None or out_p is not None) and currency not in ("CNY", "RMB"):
            in_p = _round3(price_resolver.convert_to_cny(in_p, currency)) if in_p is not None else None
            out_p = _round3(price_resolver.convert_to_cny(out_p, currency)) if out_p is not None else None
    return in_p, out_p


def _recommend_rank(candidate: str) -> tuple[int, float]:
    """推荐排序键：(价未知=1/已知=0, 有效单价)。本地 0 元模型最优先（L0 原则）。"""
    in_p, out_p = _recommend_price_view(candidate)
    if in_p is None and out_p is None:
        return (1, 0.0)
    if in_p is None:
        return (0, out_p or 0.0)
    if out_p is None:
        return (0, in_p)
    return (0, in_p + out_p)


def _recommend_tier_rank(tier: str | None) -> int:
    """档位排序：strong → mid → cheap/未知（能力优先模式用）。"""
    return {"strong": 0, "mid": 1}.get(str(tier or "").strip().lower(), 2)


def recommend_chain(stage: str, period: str, mode: str = "") -> list[str]:
    """推荐策略：结合 pricebook 单价与 capability_meta 档位实时计算（不落盘、不猜价）。

    mode（X-DSH-Route-Mode 头，用户 2026-11-17 定）：
      - price（默认，价格优先）：同档内按有效单价升序；本地 0 元模型最优先；
        价未知的模型不参与排序、排到已知价之后；
      - capability（能力优先）：档位 strong → mid → cheap；同档内价格升序（能力相同挑便宜的）；
      - preset（预设功能）：沿用功能目录映射，但每条功能链按价格优先重排。
    覆盖层：策略文件 recommend 节（管理界面保存）非空时优先，实时计算兜底。
    """
    allowed = _allowed_models()
    doc = effective()
    # 基础池：价格/预设模式用价格优先链（同档）；能力优先模式用能力链（strong 在前）——
    # 推荐是"结合能力与单价"，能力模式必须以能力链为池（否则强模型不在 L1 链里就永远排不前）。
    if str(mode or RECOMMEND_DEFAULT_MODE).strip().lower() == "capability":
        stage_chain = _dedup_chain((doc.get("capability") or {}).get(stage), allowed)
    else:
        stage_chain = _dedup_chain((doc.get("cost") or {}).get(period, {}).get(stage), allowed) \
            or _dedup_chain((doc.get("capability") or {}).get(stage), allowed)
    stage_chain = [c for c in stage_chain if c in allowed]
    if not stage_chain:
        return []
    # 覆盖层优先（管理界面「推荐策略」标签页保存的链，按档位存）
    saved = _dedup_chain((doc.get("recommend") or {}).get(stage), allowed)
    if saved:
        return saved
    mode = str(mode or RECOMMEND_DEFAULT_MODE).strip().lower()
    if mode not in RECOMMEND_MODES:
        mode = RECOMMEND_DEFAULT_MODE
    meta = _gw().CAPABILITY_META_MODELS
    if mode == "capability":
        return sorted(stage_chain,
                      key=lambda c: (_recommend_tier_rank((meta.get(c) or {}).get("tier")),
                                     _recommend_rank(c)[1]))
    # price / preset：按价格升序（本地 0 元最优先；价未知垫底，保持相对稳定序）
    priced = sorted(stage_chain, key=_recommend_rank)
    if mode == "preset":
        # 预设功能：功能对口优先（功能目录链里有的排前），同组内再按价格
        fn_chain = set(_dedup_chain((doc.get("function") or {}).get(stage), allowed))
        return sorted(priced, key=lambda c: (0 if c in fn_chain else 1, _recommend_rank(c)[1]))
    return priced


def chain(strategy: str, stage: str, period: str, function: str = "") -> list[str]:
    """返回某策略/档位的候选链（已按 upstreams 过滤；无配置返回 []）。"""
    doc = effective()
    allowed = _allowed_models()
    if strategy == "recommend":
        return recommend_chain(stage, period, function)
    if strategy == "function":
        func = str(function or "").strip().lower()
        return _dedup_chain((doc.get("function") or {}).get(func), allowed)
    if strategy == "capability":
        table = doc.get("capability") or {}
        return _dedup_chain(table.get(stage) or table.get("L2"), allowed)
    table = doc.get("cost") or {}
    period_table = table.get(period) if isinstance(table.get(period), dict) else table
    if isinstance(period_table, dict):
        return _dedup_chain(period_table.get(stage) or period_table.get("L2"), allowed)
    return []


def public() -> dict:
    doc = effective()
    return {
        "ok": True,
        "saved": _read_doc() is not None,
        "strategies": doc,
        "learned_overrides": doc.get("learned_overrides") or {},
        "functions": function_catalog(),
        "models": sorted(_allowed_models()),
        "path": str(strategies_path()),
        "usage": {
            "cost": "model=auto-cost（价格优先）",
            "capability": "model=auto-capability（能力优先）",
            "function": "model=auto-function + 请求头 X-DSH-Route-Function: <功能key>（预设功能）",
            "recommend": "model=auto-recommend + 请求头 X-DSH-Route-Mode: price|capability|preset（默认 price）",
        },
    }


def functions_payload() -> dict:
    doc = effective()
    chains = doc.get("function") or {}
    allowed = _allowed_models()
    data = []
    seen = set()
    for item in function_catalog():
        seen.add(item["key"])
        data.append({**item, "models": _dedup_chain(chains.get(item["key"]), allowed)})
    for key, value in chains.items():
        if key in seen:
            continue
        data.append({"key": key, "label": key, "chat_compatible": True,
                     "custom": True, "models": _dedup_chain(value, allowed)})
    return {"object": "list", "data": data}


def strategies_summary() -> dict:
    doc = effective()
    return {
        "cost": {p: {s: len((doc.get("cost") or {}).get(p, {}).get(s) or []) for s in STAGES} for p in PERIODS},
        "capability": {s: len((doc.get("capability") or {}).get(s) or []) for s in STAGES},
        "function": {k: len(v or []) for k, v in (doc.get("function") or {}).items()},
        "recommend": {s: len((doc.get("recommend") or {}).get(s) or []) for s in STAGES},
        "learned_overrides": sum(len(v or {}) for v in (doc.get("learned_overrides") or {}).values()),
        "saved": _read_doc() is not None,
    }


def learned_overrides() -> dict:
    """当前 learnedOverrides（只读副本）。"""
    return dict((effective().get("learned_overrides") or {}))


def get_learned_override(strategy: str, capability: str, function: str = "",
                        stage_key: str = "") -> dict | None:
    """查 learnedOverrides：strategy + capability（Q2-3 起再按 stage_key 隔离）。

    - 行里有 stage_key 且与本次计划档位不一致 ⇒ 不命中（避免 cheap 档学到的东西
      把 strong 段按专业模型的选择抹平）；
    - 老行（无 stage_key）仍按通配命中，但返回 `legacy: true`，由调用方加守卫并暴露来源；
    - function 策略仍要求 function key 匹配。
    """
    table = (effective().get("learned_overrides") or {}).get(str(strategy or "").lower()) or {}
    row = table.get(str(capability or "").lower())
    if not isinstance(row, dict):
        return None
    if str(strategy or "").lower() == "function":
        want = str(function or "").strip().lower()
        got = str(row.get("function") or "").strip().lower()
        if want and got and want != got:
            return None
    row_stage = str(row.get("stage_key") or "").strip().lower()
    want_stage = str(stage_key or "").strip().lower()
    if row_stage and want_stage and row_stage != want_stage:
        return None
    out = dict(row)
    if not row_stage:
        out["legacy"] = True
    return out


def upsert_learned_override(strategy: str, capability: str, model: str,
                            function: str = "", source: str = "auto",
                            evidence: dict | None = None, stage_key: str = "",
                            tier: str = "", principal: str = "") -> dict:
    """写一条 learnedOverride；只允许已配置模型；返回写入后的行。

    Q2-3（2026-11-18）：新增 stage_key/tier/principal 落行，供「按档位隔离」与来源追溯；
    老调用方不传时行为不变（行里留空 = legacy 通配）。
    """
    strategy = str(strategy or "").strip().lower()
    capability = str(capability or "").strip().lower()
    model = str(model or "").strip()
    if strategy not in ("cost", "capability", "function", "recommend"):
        raise ValueError("strategy 非法")
    if not capability:
        raise ValueError("capability 为空")
    if model not in _allowed_models():
        raise ValueError("model 未配置")
    doc = effective()
    doc = json.loads(json.dumps(doc, ensure_ascii=False))  # 深拷贝
    lo = doc.setdefault("learned_overrides", {})
    table = lo.setdefault(strategy, {})
    row = {"model": model, "function": str(function or "").strip().lower(),
           "source": source, "learned_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
           "stage_key": str(stage_key or "").strip().lower(),
           "tier": str(tier or "").strip().lower(),
           "principal": str(principal or "").strip(),
           "evidence": evidence or None}
    table[capability] = row
    doc["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    # 直接写 effective 结构（不再 normalize，避免默认链缺失导致拒绝自动学习）
    _write_doc(doc)
    return row


def remove_learned_override(strategy: str, capability: str) -> bool:
    doc = effective()
    doc = json.loads(json.dumps(doc, ensure_ascii=False))
    lo = doc.get("learned_overrides") or {}
    table = lo.get(str(strategy or "").lower()) or {}
    if str(capability or "").lower() not in table:
        return False
    table.pop(str(capability or "").lower(), None)
    if not table:
        lo.pop(str(strategy or "").lower(), None)
    doc["learned_overrides"] = lo
    doc["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    _write_doc(doc)
    return True
