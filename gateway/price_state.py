"""价格三态单一真源（1.0.3.10 · #5）。

local＝本地零价；priced＝有真实单价；unpriced＝待用户录入（绝不当免费）。
main.price_state_of 与 router_plan._price_state_for 一律委托本模块，
消除「/v1/route/prices 与出计划各判一遍」的口径漂移。

从 main.py 原样迁入，判定逻辑零改动（遵守第一原则：不改数据/边界/结果）。
"""
from __future__ import annotations


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
    if pid in LOCAL_PROVIDER_IDS:
        return True
    head = cid.split("/", 1)[0] if cid else ""
    return head in LOCAL_PROVIDER_IDS


def state_of(candidate: str, provider: str | None, block) -> str:
    """价格三态：先看本地车道，再看有无真实数字；没填价绝不返回免费。"""
    pid = str(provider or "").strip()
    cid = str(candidate or "")
    if _is_local_provider(pid, cid):
        return "local"
    return "priced" if _price_has_number(block) else "unpriced"
