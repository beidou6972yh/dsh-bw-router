#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""价格解析（Price Resolver）：把 pricebook 的报价算成"此刻真实价 / 最优价 / 单次成本"。

设计口径（2026-11-16 与用户对齐，见 261116.DSH.模型网关-价格接入与性价比路由设计）：
  - pricebook 保留 "base/峰谷块 × 峰谷乘数 × 分组倍率 × 活动折率"，本模块是唯一换算出口；
  - 所有时段判断一律 Asia/Shanghai；节假日表可由调用方注入；默认不猜价；
  - 三种视图：list（刊例，原样返回）/ effective（当前时刻真实价）/ best_case（最优时段+最优分组）；
  - 本模块只读、无网络、无副作用，便于单测与被 main.py 引入。

币种口径（2026-11-17 用户令第 2、3 条）：
  - 计划/成本金额一律人民币（CNY）且**保留 3 位小数**（estimate_cost / convert_to_cny）；
  - 非 CNY 报价走 convert_to_cny()，汇率真源 config/fx-rates.json（键名 <币种>CNY，如 USDCNY）；
  - **缺文件 / 缺币种键 / 汇率非正数 ⇒ 返回 None（不猜价）**，调用方须把该模型视为“价未知”。

价格结构两种（见 scripts/price_sync.py 产出）：
  per_token: {"input":{"peak":2,"offpeak":1}, "cache_hit":{...}, "output":{...}}
  expr:      {"base":{"input":1,"cache_hit":0.02,"output":4}}
"""

from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

TZ_CN = timezone(timedelta(hours=8))

PRICE_KEYS = ("input", "cache_hit", "output", "cache_create")

# 汇率真源（只读）：config/fx-rates.json，形如 {"updated_at":"2026-11-17","USDCNY":7.12}
# 键名规则 <币种>CNY；值为 null / 缺失 ⇒ 未取到当日汇率，不猜价。
FX_RATES_PATH = Path(__file__).resolve().parent / "config" / "fx-rates.json"
_FX_CACHE: dict[str, tuple] = {}


def at_cn(at: datetime | None = None) -> datetime:
    if at is None:
        return datetime.now(TZ_CN)
    if at.tzinfo is None:
        return at.replace(tzinfo=TZ_CN)
    return at.astimezone(TZ_CN)


def _minute_of_day(at: datetime) -> int:
    return at.hour * 60 + at.minute


def _hhmm(text: str) -> int:
    hour, minute = str(text).split(":")
    return int(hour) * 60 + int(minute)


class PriceBookError(RuntimeError):
    """结构不对/缺字段：调用方应降级，不得把异常价当真。"""


def _num(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PriceBookError(f"价格不是数字: {value!r}")
    return float(value)


def _base_of(offer: dict) -> tuple[dict, bool]:
    """返回 (base, has_blocks)。has_blocks=True 表示是峰谷块结构。"""
    price = offer.get("price")
    if not isinstance(price, dict):
        raise PriceBookError(f"offer 无 price: {offer.get('id')}")
    if "base" in price:
        return {k: _num(v) for k, v in (price["base"] or {}).items()}, False
    base, has_blocks = {}, False
    for key in PRICE_KEYS:
        block = price.get(key)
        if not isinstance(block, dict):
            continue
        if "flat" in block:
            base[key] = _num(block["flat"])
        elif "peak" in block or "offpeak" in block:
            base[key] = {"peak": block.get("peak"), "offpeak": block.get("offpeak")}
            has_blocks = True
    if not base:
        raise PriceBookError(f"offer 无有效价格: {offer.get('id')}")
    return base, has_blocks


def _schedule(offer: dict) -> dict:
    rules = offer.get("rules") or {}
    sched = rules.get("schedule")
    if isinstance(sched, dict):
        return sched
    if rules.get("multipliers"):
        return {"kind": "multipliers", "multipliers": rules["multipliers"],
                "weekday_guard": bool(rules.get("weekday_guard"))}
    return {"kind": "flat"}


def _group_ratio(offer: dict, group: str | None) -> float:
    ratios = (offer.get("rules") or {}).get("group_ratio") or {}
    if not ratios:
        return 1.0
    if group and group in ratios:
        return _num(ratios[group])
    return _num(ratios.get("default", 1.0))


def _activity_factor(offer: dict, at: datetime) -> float:
    activity = (offer.get("rules") or {}).get("activity")
    if not isinstance(activity, dict):
        return 1.0
    until = activity.get("until")
    if until:
        try:
            if at.date() > date.fromisoformat(str(until)):
                return 1.0
        except ValueError:
            return 1.0
    factor = activity.get("factor")
    return _num(factor) if factor is not None else 1.0


def _is_peak(offer: dict, at: datetime, holidays: set[date] | None) -> bool:
    sched = _schedule(offer)
    kind = sched.get("kind")
    if kind == "peak_windows":
        if sched.get("holidays_off", True) and holidays and at.date() in holidays:
            return False
        weekdays = sched.get("weekdays") or [1, 2, 3, 4, 5]
        if at.isoweekday() not in weekdays:
            return False
        minute = _minute_of_day(at)
        for start, end in sched.get("windows") or []:
            if _hhmm(start) <= minute < _hhmm(end):
                return True
        return False
    if kind == "hour_offpeak":
        if sched.get("weekday_guard") and at.isoweekday() > 5:
            return True  # 周末视为非优惠段
        hour = at.hour
        for start, end in sched.get("offpeak_hours") or []:
            if int(start) <= hour < int(end):
                return False
        return True
    return False


def _multiplier(offer: dict, at: datetime) -> float:
    sched = _schedule(offer)
    if sched.get("kind") != "multipliers":
        return 1.0
    if sched.get("weekday_guard") and at.isoweekday() > 5:
        return 1.0
    factor = 1.0
    for item in sched.get("multipliers") or []:
        when = str(item.get("when") or "")
        try:
            # 形如 "hour in [9,12)"
            part = when.split("[", 1)[1].split(")", 1)[0]
            start, end = (int(x) for x in part.split(",", 1))
        except (IndexError, ValueError):
            continue
        if start <= at.hour < end:
            factor *= _num(item.get("factor", 1.0))
    return factor


def period_of(offer: dict, at: datetime | None = None,
              holidays: set[date] | None = None) -> str:
    """此刻的计价时段标签：peak / offpeak / flat / expr（含乘数时给出乘数值）。"""
    at = at_cn(at)
    sched = _schedule(offer)
    kind = sched.get("kind")
    if kind == "multipliers":
        mult = _multiplier(offer, at)
        return f"expr×{mult:g}"
    if kind == "flat":
        return "flat"
    return "peak" if _is_peak(offer, at, holidays) else "offpeak"


def effective_price(offer: dict, at: datetime | None = None, group: str | None = None,
                    holidays: set[date] | None = None) -> dict:
    """当前时刻真实价（含峰谷/乘数/分组/活动）。返回 入/缓/出 三个数。"""
    at = at_cn(at)
    base, has_blocks = _base_of(offer)
    period = period_of(offer, at, holidays)
    factor = _multiplier(offer, at) * _group_ratio(offer, group) * _activity_factor(offer, at)
    out = {}
    for key, value in base.items():
        if has_blocks and isinstance(value, dict):
            chosen = value.get(period) if period in ("peak", "offpeak") else None
            if chosen is None:
                chosen = value.get("offpeak", value.get("peak"))
            out[key] = round(_num(chosen) * factor, 3)
        else:
            out[key] = round(_num(value) * factor, 3)
    return {"currency": "CNY", "period": period,
            "prices": {k: out[k] for k in PRICE_KEYS if k in out},
            "factor": round(factor, 6), "offer": offer.get("id")}


def list_price(offer: dict) -> dict:
    """刊例视图：原样返回价格结构（UI 展示"低/峰"两列用）。"""
    base, has_blocks = _base_of(offer)
    if not has_blocks:
        return {"currency": "CNY", "period": "flat",
                "prices": {k: v for k, v in base.items() if not isinstance(v, dict)}}
    return {"currency": "CNY", "period": "peak/offpeak",
            "prices": {k: v for k, v in base.items() if isinstance(v, dict)}}


def best_case(offer: dict, group: str | None = None) -> dict:
    """最优视图：最低时段 + 指定分组 + 活动生效。用于"最优渠道"比价。"""
    base, has_blocks = _base_of(offer)
    sched = _schedule(offer)
    if has_blocks:
        mult = 1.0
    elif sched.get("kind") == "multipliers":
        mult = min([1.0] + [_num(m.get("factor", 1.0)) for m in sched.get("multipliers") or []])
    else:
        mult = 1.0
    factor = mult * _group_ratio(offer, group)
    out = {}
    for key, value in base.items():
        if has_blocks and isinstance(value, dict):
            candidates = [v for v in (value.get("peak"), value.get("offpeak")) if v is not None]
            out[key] = round(min(_num(v) for v in candidates) * factor, 3) if candidates else None
        else:
            out[key] = round(_num(value) * factor, 3)
    return {"currency": "CNY", "period": "best",
            "prices": {k: v for k, v in out.items() if v is not None},
            "factor": round(factor, 6), "offer": offer.get("id")}


def clear_fx_cache() -> None:
    """清掉汇率文件的内容缓存（测试或汇率文件被外部改写后调用）。"""
    _FX_CACHE.clear()


def _load_fx_doc(path: Path | str | None = None) -> dict:
    """读汇率文件；缺文件/坏 JSON/非对象 ⇒ 返回 {}（等于“没有汇率”，不抛异常）。"""
    target = Path(path) if path is not None else Path(FX_RATES_PATH)
    try:
        stamp = target.stat()
        key = str(target)
        cached = _FX_CACHE.get(key)
        if cached is not None and cached[0] == (stamp.st_mtime_ns, stamp.st_size):
            return cached[1]
        with target.open("r", encoding="utf-8") as fp:
            doc = json.load(fp)
        doc = doc if isinstance(doc, dict) else {}
        _FX_CACHE[key] = ((stamp.st_mtime_ns, stamp.st_size), doc)
        return doc
    except Exception:
        return {}


def fx_rate(currency: str | None, path: Path | str | None = None) -> float | None:
    """1 单位 currency 折 CNY 的汇率。CNY/RMB ⇒ 1.0；缺文件/缺键/非正数 ⇒ None（不猜价）。

    口径（2026-11-17 用户令第 2 条定稿）：汇率**取 3 位小数**（`round(rate, 3)`）。
    于是「汇率」与「换算结果」都是 3 位口径，可复算、可对账；手工往 fx-rates.json
    写了更多位时同样按 3 位生效，不做隐式全精度。
    """
    cur = str(currency or "").strip().upper()
    if not cur:
        return None
    if cur in ("CNY", "RMB"):
        return 1.0
    raw = _load_fx_doc(path).get(f"{cur}CNY")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    try:
        rate = float(raw)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(rate) or rate <= 0:
        return None
    return round(rate, 3)


def convert_to_cny(amount, currency: str | None,
                   path: Path | str | None = None) -> float | None:
    """把 amount 折成 CNY 并保留 3 位小数；非数字/缺汇率/汇率非法 ⇒ None（不猜价）。

    注意：currency 为空**不**默认按 CNY 处理（缺信息就返回 None），调用方须先归一化币种。
    """
    if isinstance(amount, bool) or not isinstance(amount, (int, float)):
        return None
    try:
        value = float(amount)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(value):
        return None
    rate = fx_rate(currency, path=path)
    if rate is None:
        return None
    return round(value * rate, 3)


def estimate_cost(prices: dict, tokens_in: int, tokens_out: int,
                  cache_rate: float = 0.0) -> float:
    """单次调用成本（元，3 位小数）。cache_rate=输入中命中缓存的比例；缺缓存价时按未命中价计。"""
    cache_rate = max(0.0, min(1.0, float(cache_rate)))
    p_in = _num(prices.get("input", 0.0))
    p_cache = _num(prices.get("cache_hit", prices.get("input", 0.0)))
    p_out = _num(prices.get("output", 0.0))
    miss = tokens_in / 1_000_000.0 * (1.0 - cache_rate) * p_in
    hit = tokens_in / 1_000_000.0 * cache_rate * p_cache
    return round(miss + hit + tokens_out / 1_000_000.0 * p_out, 3)


def family_offers(book: dict, family: str) -> list[dict]:
    node = (book.get("models") or {}).get(family) or {}
    return list(node.get("offers") or [])


def compare(book: dict, family: str, at: datetime | None = None, group: str | None = None,
            tokens_in: int = 2000, tokens_out: int = 800, cache_rate: float = 0.3,
            include_estimated: bool = False) -> list[dict]:
    """同 family 跨供应商比价：按单次成本升序；默认排除估算价（积分制）。"""
    rows = []
    for offer in family_offers(book, family):
        meta = offer.get("meta") or {}
        if offer.get("billing") == "absent" or not offer.get("price"):
            continue
        if meta.get("estimated") and not include_estimated:
            continue
        price = effective_price(offer, at=at, group=group)
        cost = estimate_cost(price["prices"], tokens_in, tokens_out, cache_rate)
        rows.append({"offer": offer.get("id"), "provider": offer.get("provider"),
                     "period": price["period"], "factor": price["factor"],
                     "prices": price["prices"], "cost": cost,
                     "estimated": bool(meta.get("estimated")),
                     "comparable": bool(meta.get("comparable", True))})
    return sorted(rows, key=lambda r: r["cost"])
