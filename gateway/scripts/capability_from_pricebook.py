#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""capability_meta 与 pricebook 对齐（P1 收尾）：给所有候选补 capability_meta 条目与两档价。

口径（2026-11-16）：
  - capability_meta 是"两档价（peak/offpeak）"契约，无法表达一口价/订阅价；
    因此只有 pricebook 里能推出两档的 offer（per_token 两档 / expr 带小时乘数）才填数，
    一口价/积分/免费模型一律写 **null 块**（不猜价），另用 price_note 说明真实价在 pricebook；
  - 不改已有条目的非价格字段（tier/modality/context_window 等保持原样）；
  - 输出前备份 config/routing.json 到 config/backup-<ts>-routing.json。

运行：
    python3 scripts/capability_from_pricebook.py --dry-run   # 只打印差异
    python3 scripts/capability_from_pricebook.py --write     # 写回 routing.json（需约定）
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROUTING = ROOT / "config" / "routing.json"
UPSTREAMS = ROOT / "upstreams.json"
PRICEBOOK = ROOT / "config" / "pricebook.json"

NULL_BLOCK = {"peak": None, "offpeak": None}


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def null_price() -> dict:
    return {"currency": "CNY",
            "input_per_mtok": dict(NULL_BLOCK),
            "output_per_mtok": dict(NULL_BLOCK),
            "cache_hit_input_per_mtok": None}


def offer_blocks(offer: dict) -> tuple[dict, dict, dict | None] | None:
    """从 offer 推两档价；推不出（一口价/缺字段）⇒ None（写 null 块）。"""
    if not isinstance(offer, dict) or offer.get("billing") in (None, "absent"):
        return None
    price = offer.get("price") or {}
    if "base" in price:
        base = price["base"]
        if base.get("input") is None or base.get("output") is None:
            return None
        sched = (offer.get("rules") or {}).get("schedule") or {}
        factors = [m.get("factor") for m in sched.get("multipliers") or []]
        peak_factor = max([f for f in factors if isinstance(f, (int, float))] or [1])
        peak = {"peak": round(base["input"] * peak_factor, 6),
                "offpeak": round(base["input"], 6)}
        out = {"peak": round(base["output"] * peak_factor, 6),
               "offpeak": round(base["output"], 6)}
        cache = None
        if base.get("cache_hit") is not None:
            cache = {"peak": round(base["cache_hit"] * peak_factor, 6),
                     "offpeak": round(base["cache_hit"], 6)}
        return peak, out, cache
    inp = price.get("input")
    out = price.get("output")
    if not (isinstance(inp, dict) and isinstance(out, dict)):
        return None
    if "peak" not in inp or "offpeak" not in inp or "peak" not in out or "offpeak" not in out:
        return None  # 一口价（flat）无法表达为两档
    if inp.get("peak") is None or inp.get("offpeak") is None:
        return None
    if out.get("peak") is None or out.get("offpeak") is None:
        return None
    cache = None
    cb = price.get("cache_hit")
    if isinstance(cb, dict) and cb.get("peak") is not None and cb.get("offpeak") is not None:
        cache = {"peak": cb["peak"], "offpeak": cb["offpeak"]}
    return ({"peak": inp["peak"], "offpeak": inp["offpeak"]},
            {"peak": out["peak"], "offpeak": out["offpeak"]}, cache)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="capability_meta ← pricebook 对齐")
    parser.add_argument("--write", action="store_true", help="写回 routing.json")
    parser.add_argument("--dry-run", action="store_true", help="只打印差异（默认）")
    args = parser.parse_args(argv)

    routing = load_json(ROUTING)
    upstreams = load_json(UPSTREAMS)
    pricebook = load_json(PRICEBOOK) if PRICEBOOK.exists() else {"models": {}}

    offers = {}
    for node in (pricebook.get("models") or {}).values():
        for offer in node.get("offers") or []:
            offers[f"{offer.get('provider')}/{offer.get('model_id')}"] = offer

    cm = routing.setdefault("capability_meta", {})
    models = cm.setdefault("models", {})
    changed, added = [], []

    for upstream in upstreams.get("upstreams") or []:
        uid = upstream["id"]
        for model_id, spec in (upstream.get("models") or {}).items():
            candidate = f"{uid}/{model_id}"
            entry = models.get(candidate)
            if entry is None:
                entry = {"provider": uid,
                         "tier": spec.get("tier"),
                         "modality": ["text", "vision"] if spec.get("vision") else ["text"]}
                models[candidate] = entry
                added.append(candidate)
            blocks = offer_blocks(offers.get(candidate))
            if blocks is None and candidate not in offers:
                # 无报价源：已有"真两档价"（peak>0 且 peak>offpeak）则原样保留；
                # 其余（一口价/订阅/0 元）一律 null——两档契约表达不了，不猜价。
                cur = entry.get("price") or {}
                ci = (cur.get("input_per_mtok") or {})
                co = (cur.get("output_per_mtok") or {})
                keep = (isinstance(ci.get("peak"), (int, float))
                        and isinstance(ci.get("offpeak"), (int, float))
                        and isinstance(co.get("peak"), (int, float))
                        and isinstance(co.get("offpeak"), (int, float))
                        and ci["peak"] > 0 and co["peak"] > 0
                        and ci["peak"] > ci["offpeak"] and co["peak"] > co["offpeak"])
                if keep:
                    continue
            if blocks is None:
                new_price = null_price()
                note = ("价格在 pricebook（一口价/订阅/免费，两档契约不适用）"
                        if candidate in offers else "未报价（pricebook 未收录）")
            else:
                inp, out, cache = blocks
                new_price = {"currency": "CNY",
                             "input_per_mtok": inp,
                             "output_per_mtok": out,
                             "cache_hit_input_per_mtok": cache}
                note = "价格来源：pricebook 两档价（生成物）"
            # 本地上游保持显式 0 元，不被覆盖
            if uid == "provider_b":
                continue
            if entry.get("price") != new_price:
                entry["price"] = new_price
                changed.append(candidate)
            entry["price_source"] = note

    # 清理不再存在的候选（避免 extra 条目）
    alive = {f"{u['id']}/{m}" for u in upstreams.get("upstreams") or []
             for m in (u.get("models") or {})}
    for stale in [c for c in models if c not in alive]:
        models.pop(stale, None)
        changed.append(f"-{stale}")

    print(f"新增 {len(added)} 条，改动 {len(changed)} 条（候选总数 {len(models)}）")
    for name in added:
        print("  +", name)
    for name in changed:
        if name in models:
            price = models[name]["price"]
            print(f"  ~ {name}: in={price['input_per_mtok']} out={price['output_per_mtok']}")

    if args.write:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = ROUTING.with_name(f"backup-{stamp}-routing.json")
        shutil.copy2(ROUTING, backup)
        ROUTING.write_text(json.dumps(routing, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
        print(f"已写回 {ROUTING}（备份 {backup.name}）")
    else:
        print("dry-run：未写盘（加 --write 落盘）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
