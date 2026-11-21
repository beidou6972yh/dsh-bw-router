#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""样例配置对齐层（跨侧交付 v1.1d3 · 用例期望值推导器）。

为什么有这个模块
----------------
原用例把生产环境的「上游 id / 模型名」写死在断言里（如 ``up-x/model-y``），
一旦换成样例配置（``up-a/up-b/up-c/up-d/local-lan``）就必然批量失败——失败原因不是代码坏了，
而是**断言里写的是旧配置**。本模块把「期望值」改为从**当前部署的配置**现场推导：

* 期望值来源：``config/routing.json`` 与 ``upstreams.json``（直接读盘解析，不经 main 的加载器）；
* 被测对象：``main.build_candidates`` / ``build_hint_decision`` / ``capabilities_payload`` … 的运行时行为。

两边独立解析，所以断言仍然检验真实行为：**配置声明了什么，运行时就该按规则产出什么**。
同一套用例在匿名样例配置、以及多份结构不同的真实配置下都能跑，且断言不会退化成"自己抄自己"。

设计约束
--------
* 只读：本模块不写文件、不改 ``main`` 的任何状态（用例要改状态请自己 setUp/tearDown）。
* 不 import ``main``：避免循环依赖，也避免"用被测件的加载器算期望"。
* 只提供**规则级**推导（哪张表、哪个键、怎么去重/剔除），不复制 main 的决策算法细节。

用例里的用法
------------
::

    sys.path.insert(0, str(Path(__file__).resolve().parent))   # tests/ 目录
    import config_ref as cfg

    self.assertEqual(router.build_candidates("auto", "L1", "peak", feats),
                     cfg.expected_chain("auto", "L1", "peak"))

术语
----
* **候选（candidate）**：配置里的 ``"<上游 id>/<模型名>"``。模型名可再含 ``/``（如 ``vendor/nested-model``），
  切分规则＝**只在第一个 ``/`` 处切**，与 ``main.split_candidate`` 一致。
* **已声明模型（declared model）**：``upstreams.json`` 里该上游 ``models`` 下确实有这一项。
* **可路由（routable）**：上游 id 已声明且模型段非空——``main.build_candidates`` 的剔除规则。
* **能力集（capability set）**：``<上游>/<模型>`` 全集——``main.HINT_CAPABILITY_SET`` 的口径。
"""

from __future__ import annotations

import json
from pathlib import Path

# ---------------------------------------------------------------------------
# 配置读盘（只读一次，模块级常量）
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[1]

CONFIG_PATH = ROOT / "config" / "routing.json"
UPSTREAMS_PATH = ROOT / "upstreams.json"


def _read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fp:
        return json.load(fp)


ROUTING: dict = _read_json(CONFIG_PATH)
UPSTREAMS_DOC: dict = _read_json(UPSTREAMS_PATH)

UPSTREAMS_BY_ID: dict[str, dict] = {
    str(u["id"]): u for u in (UPSTREAMS_DOC.get("upstreams") or [])
}
UPSTREAM_IDS: list[str] = list(UPSTREAMS_BY_ID)

#: {("up-a", "model-fast-0731"): {...spec...}}
MODEL_SPECS: dict[tuple[str, str], dict] = {
    (uid, str(mid)): dict(spec or {})
    for uid, u in UPSTREAMS_BY_ID.items()
    for mid, spec in (u.get("models") or {}).items()
}

#: 全部已声明候选，顺序＝upstreams.json 声明顺序（承载能力清单/档位链的口径）
CANDIDATES: list[str] = [f"{uid}/{mid}" for uid, mid in MODEL_SPECS]
CANDIDATE_SET = set(CANDIDATES)

PERIODS: tuple[str, ...] = ("peak", "offpeak")
STAGES: tuple[str, ...] = ("L1", "L2", "L3")
IMAGE_KEY = "image"

VIRTUAL_MODELS: dict = dict(ROUTING.get("virtual_models") or {})
ROUTES: dict = dict(ROUTING.get("routes") or {})
STRATEGIES: dict = dict(ROUTING.get("strategies") or {})
HINT: dict = dict(ROUTING.get("hint") or {})
AFP: dict = dict(ROUTING.get("afp") or {})
CAPABILITY_META: dict = dict(ROUTING.get("capability_meta") or {})
CAPABILITY_META_MODELS: dict = {
    str(k): v for k, v in (CAPABILITY_META.get("models") or {}).items() if isinstance(v, dict)
}

# 本地（私有/局域网）上游判定：base_url 用明文 http 的视作本地，https 视作云端。
# 样例配置里 local-lan 是唯一 http 上游；换配置时上游改名/换端口，这条规则同样成立。
LOCAL_UPSTREAM_IDS: list[str] = [
    uid for uid, u in UPSTREAMS_BY_ID.items()
    if str(u.get("base_url") or "").lower().startswith("http://")
]
CLOUD_UPSTREAM_IDS: list[str] = [uid for uid in UPSTREAM_IDS if uid not in LOCAL_UPSTREAM_IDS]


# ---------------------------------------------------------------------------
# 候选切分 / 过滤（规则级，与 main 文档口径一致）
# ---------------------------------------------------------------------------


def split_candidate(candidate: str) -> tuple[str, str]:
    """``"<上游>/<模型>"`` → (上游, 模型)；只在第一个 ``/`` 处切（模型名可再含 ``/``）。"""
    if "/" in candidate:
        up_id, model = candidate.split("/", 1)
        return up_id, model
    return candidate, ""


def is_declared_model(candidate: str) -> bool:
    """该候选是否是 upstreams.json 里**已声明**的 upstream/model 组合。"""
    up_id, model = split_candidate(candidate)
    return bool(model) and (up_id, model) in MODEL_SPECS


def is_routable(candidate: str) -> bool:
    """main.build_candidates 的剔除规则：上游已声明 且 模型段非空（不要求模型也声明）。"""
    up_id, model = split_candidate(candidate)
    return bool(model) and up_id in UPSTREAMS_BY_ID


def _dedup(items) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items or []:
        text = str(item).strip()
        if text and text not in seen:
            seen.add(text)
            out.append(text)
    return out


def keep_routable(chain) -> list[str]:
    """按 main.build_candidates 口径：去重（保序）+ 只留可路由候选。"""
    return [c for c in _dedup(chain) if is_routable(c)]


def keep_capability(chain) -> list[str]:
    """按 main 启动时的 hint 档位口径：去重（保序）+ 只留已声明模型。"""
    return [c for c in _dedup(chain) if c in CANDIDATE_SET]


# ---------------------------------------------------------------------------
# routes 表（balanced 策略）
# ---------------------------------------------------------------------------


def declared_routes(period: str, key: str) -> list[str]:
    """原样读 ``routes[period][key]``；没有该键 → []（不猜、不回落）。"""
    period_table = ROUTES.get(period) or {}
    if not isinstance(period_table, dict):
        return []
    return list(period_table.get(key) or [])


def routes_chain(period: str, stage: str, has_image: bool = False) -> list[str]:
    """``routes`` 表按 main 的查表顺序取链：含图走 ``image`` 键，否则走 ``L1/L2/L3``。

    只做「取声明的链 + 剔除不可路由项」，不复制决策算法。
    """
    key = IMAGE_KEY if has_image else stage
    chain = declared_routes(period, key)
    if not chain:  # main: table.get(key) or table.get(stage)
        chain = declared_routes(period, stage)
    return keep_routable(chain)


# ---------------------------------------------------------------------------
# strategies 表（fast / strong 等）
# ---------------------------------------------------------------------------


def declared_strategy_chain(strategy: str, period: str | None, stage: str,
                            has_image: bool = False) -> list[str]:
    """按 main 的查表顺序取 ``strategies[strategy]`` 的链。

    支持两种写法：
    * 扁平（fast）：``strategies.fast`` 直接就是链；
    * 分时段（strong）：``strategies.strong.peak.L3`` → ``.L3`` → 扁平 ``.L3`` → ``.default``。
    """
    node = STRATEGIES.get(strategy)
    if node is None:
        return []
    key = IMAGE_KEY if has_image else stage
    if isinstance(node, list):  # 扁平策略（如 fast）
        return list(node)
    if not isinstance(node, dict):
        return []
    by_period = node.get(period) if period else None
    if isinstance(by_period, dict):
        chain = by_period.get(key) or by_period.get(stage)
        if chain:
            return list(chain)
    return list(node.get(key) or node.get(stage) or node.get("default") or [])


def strategy_chain(strategy: str, period: str | None, stage: str,
                   has_image: bool = False) -> list[str]:
    """同 :func:`declared_strategy_chain`，但按 build_candidates 口径剔除不可路由项。"""
    return keep_routable(declared_strategy_chain(strategy, period, stage, has_image))


# ---------------------------------------------------------------------------
# 虚拟模型 → 期望候选链（build_candidates 的配置侧推导）
# ---------------------------------------------------------------------------


def strategy_of(virtual_model: str) -> str | None:
    """``virtual_models[<名字>].strategy``；未配置的虚拟模型 → None。"""
    item = VIRTUAL_MODELS.get(virtual_model)
    if isinstance(item, dict):
        return str(item.get("strategy") or "") or None
    return None


def expected_chain(virtual_model: str, stage: str, period: str,
                   has_image: bool = False) -> list[str]:
    """``main.build_candidates(virtual_model, stage, period, feats)`` 的期望值。

    - ``strategy == "balanced"``（样例里的 ``auto``）→ 查 ``routes[period]``；
    - ``strategy == "fast"``（``auto-fast``）→ 查 ``strategies.fast``（不分时段）；
    - 其它（``strong``）→ 查 ``strategies.<strategy>``，时段优先、再回落 ``default``。

    未配置的虚拟模型返回 ``[]``（main 同样返回 ``[]``）。
    """
    strategy = strategy_of(virtual_model)
    if not strategy:
        return []
    if strategy == "balanced":
        return routes_chain(period, stage, has_image)
    if strategy == "fast":
        return strategy_chain("fast", period, stage, has_image)
    return strategy_chain(strategy, period, stage, has_image)


def chain_head(virtual_model: str, stage: str, period: str, has_image: bool = False) -> str | None:
    """链头（主选）；链为空 → None。"""
    chain = expected_chain(virtual_model, stage, period, has_image)
    return chain[0] if chain else None


def payload_upstream_ids() -> list[str]:
    """按 upstreams.json 声明顺序的上游 id（/health 的 upstreams 列表口径）。"""
    return list(UPSTREAM_IDS)


def virtual_model_ids() -> list[str]:
    """声明的虚拟模型 id（/v1/models 的 data 口径）。"""
    return list(VIRTUAL_MODELS)


# ---------------------------------------------------------------------------
# hint 档位（tiers）
# ---------------------------------------------------------------------------


def hint_mode() -> str:
    """``hint.mode``（record / execute）。"""
    return str(HINT.get("mode") or "").strip().lower()


def hint_default_tier() -> str | None:
    return (str(HINT.get("default_tier")) if HINT.get("default_tier") else None)


def hint_tier(tier: str) -> list[str]:
    """``hint.tiers[<tier>]`` 的**生效**链：启动时按能力集剔除未声明模型（main 同口径）。"""
    tiers = HINT.get("tiers") or {}
    return keep_capability(tiers.get(tier) or [])


def hint_tier_names() -> list[str]:
    return list((HINT.get("tiers") or {}).keys())


def hint_chain_with_model(model: str, tier: str) -> list[str]:
    """hint 决策「直用模型」时的候选链：``[model] + tier 链（去掉重复）``。"""
    return [model] + [c for c in hint_tier(tier) if c != model]


# ---------------------------------------------------------------------------
# 能力 / 视觉 / 上下文 / 价格（capability_meta → upstreams 回落）
# ---------------------------------------------------------------------------


def candidate_spec(candidate: str) -> dict:
    """upstreams.json 里的模型元数据；未声明 → {}。"""
    up_id, model = split_candidate(candidate)
    return dict(MODEL_SPECS.get((up_id, model)) or {})


def capability_entry(candidate: str) -> dict:
    """``capability_meta.models[<candidate>]``；没有 → {}。"""
    return dict(CAPABILITY_META_MODELS.get(candidate) or {})


def modality_of(candidate: str) -> list[str]:
    """能力清单里的 modality：capability_meta 优先，缺项回落 upstreams 的 ``vision``。

    与 ``main.capability_model_entry`` 的取数优先级一致（meta → upstreams → 空）。
    """
    meta = capability_entry(candidate)
    raw = meta.get("modality")
    if isinstance(raw, list) and raw:
        return [str(x) for x in raw]
    spec = candidate_spec(candidate)
    if "vision" in spec:
        return ["text", "vision"] if spec.get("vision") else ["text"]
    return []


def vision_candidates() -> list[str]:
    """上游声明 ``vision: true`` 的候选（图片请求可用）。"""
    return [c for c in CANDIDATES if candidate_spec(c).get("vision") is True]


def no_vision_candidates() -> list[str]:
    """上游声明 ``vision: false`` 的候选（图片请求不可用＝model_no_vision）。"""
    return [c for c in CANDIDATES if candidate_spec(c).get("vision") is False]


def context_window_of(candidate: str) -> int | None:
    """上游声明的上下文窗口；未声明 → None（不设限）。"""
    value = candidate_spec(candidate).get("context_window")
    return int(value) if isinstance(value, int) else None


def max_tokens_of(candidate: str) -> int | None:
    value = candidate_spec(candidate).get("max_tokens")
    return int(value) if isinstance(value, int) else None


def price_of(candidate: str) -> dict | None:
    """``capability_meta.models[<c>].price``；未报价 → None。"""
    price = capability_entry(candidate).get("price")
    return dict(price) if isinstance(price, dict) else None


def priced_candidates() -> list[str]:
    """capability_meta 里**已填价格数字**的候选（input/output 的 peak 都是正数）。"""
    out: list[str] = []
    for candidate in CANDIDATES:
        price = price_of(candidate) or {}
        inp = (price.get("input_per_mtok") or {}).get("peak") if isinstance(price.get("input_per_mtok"), dict) else None
        outp = (price.get("output_per_mtok") or {}).get("peak") if isinstance(price.get("output_per_mtok"), dict) else None
        if isinstance(inp, (int, float)) and inp > 0 and isinstance(outp, (int, float)) and outp > 0:
            out.append(candidate)
    return out


def unpriced_candidates() -> list[str]:
    """未填价格的候选（price 数字必须是 null，不能猜 0）。"""
    priced = set(priced_candidates())
    return [c for c in CANDIDATES if c not in priced]


# ---------------------------------------------------------------------------
# AFP（额度闸门）
# ---------------------------------------------------------------------------


def afp_upstream() -> str | None:
    """``afp.upstream``（额度闸门盯的上游 id）。"""
    value = AFP.get("upstream")
    return str(value) if value else None


def afp_enabled() -> bool:
    return bool(AFP.get("enabled"))


# ---------------------------------------------------------------------------
# 自检：配置与运行时是否同一份（供用例断言）
# ---------------------------------------------------------------------------


def parity_report(router_module) -> dict:
    """比对「本模块读到的配置」与「main 启动时加载的配置」是否一致。

    用例把它断言成相等，就能保证：期望值不是从另一份过期配置算出来的。
    """
    return {
        "routes": ROUTING.get("routes") == router_module.CONFIG.get("routes"),
        "strategies": ROUTING.get("strategies") == router_module.CONFIG.get("strategies"),
        "virtual_models": ROUTING.get("virtual_models") == router_module.CONFIG.get("virtual_models"),
        "hint": ROUTING.get("hint") == router_module.CONFIG.get("hint"),
        "capability_meta": ROUTING.get("capability_meta") == router_module.CONFIG.get("capability_meta"),
        "upstream_ids": UPSTREAM_IDS == [u.id for u in router_module.UPSTREAMS],
        "config_path": str(CONFIG_PATH),
        "upstreams_path": str(UPSTREAMS_PATH),
    }
