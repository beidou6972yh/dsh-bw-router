#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""价格同步 P1：抓取公开价目 → 归一化 pricebook → 自检（默认只读，不写任何文件）。

口径（v1.0, 2026-11-16 与用户对齐）：
  - 只读公开页/公开 API，不带任何密钥；默认 dry-run；仅当显式给 --out 才落盘。
  - 抓不到就报错，不猜价（沿用网关"没有就是 null"原则）。
  - 单位：元/百万 tokens；结构保留 "base × 峰谷乘数 × 分组倍率 × 活动折率"，不压平成两个数。
  - 覆盖三家可公开核价的源：DS 官方（HTML 价格表）、供应商C（/api/pricing 的 billing_expr）、
    供应商D（/pricing 服务端渲染 HTML）。火山方舟/积分制平台走手工价目（P2 再接）。

运行：
    python3 scripts/price_sync.py --dry-run        # 抓取 + 打印归一化结果（默认动作）
    python3 scripts/price_sync.py --check          # 与 2026-11-16 已核报价逐项比对（CI 用）
    python3 scripts/price_sync.py --json           # 输出 pricebook JSON 到 stdout
    python3 scripts/price_sync.py --out config/pricebook.json   # 落盘（需显式给 --out）

降级口径：供应商C ratio_config 仅影响"按量模型"的缓存价；被 429 时记 degraded，
         该两项自检标 SKIP（不猜价、不判失败），其余项照常比对。
退出码：0 全绿（SKIP 不影响）；2 有抓取失败或自检不一致；3 参数错误。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

UA = "Mozilla/5.0 (compatible; wb-price-sync/1.0; +local)"
TIMEOUT = 25

DS_URL = "https://docs.provider-a.example.com/zh-cn/quick_start/pricing"
DUOYUAN_PRICING = "https://api.provider-c.example.com/api/pricing"
DUOYUAN_RATIO = "https://api.provider-c.example.com/api/ratio_config"
SF_URL = "https://provider_d.cn/pricing"

TZ_CN = timezone(timedelta(hours=8))


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_DIR = ROOT / "数据"
DUOYUAN_RATIO_SNAPSHOT = SNAPSHOT_DIR / "provider_c-ratio.snapshot.json"
SUPPLEMENTS_PATH = ROOT / "config" / "price-supplements.json"

DEGRADED: list[str] = []
SNAPSHOTS: list[str] = []


class AdapterError(RuntimeError):
    """抓取/解析失败：上层标 stale，不写假数。"""


def log(msg: str) -> None:
    print(f"[price-sync] {msg}", file=sys.stderr)


def fetch(url: str, retries: int = 3, backoff: float = 1.5) -> str:
    """GET + 对 429/5xx 做有限重试（尊重 Retry-After）；其余错误直接转 AdapterError。"""
    last: Exception | None = None
    for attempt in range(max(1, retries)):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
                charset = resp.headers.get_content_charset() or "utf-8"
                return raw.decode(charset, errors="replace")
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                delay = backoff * (attempt + 1)
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                if retry_after and str(retry_after).isdigit():
                    delay = min(float(retry_after), 8.0)
                log(f"GET {url} → HTTP {exc.code}，{delay:.1f}s 后重试（{attempt + 1}/{retries}）")
                time.sleep(delay)
                continue
            raise AdapterError(f"GET {url} 失败: {exc}") from exc
        except Exception as exc:  # noqa: BLE001 - 网络/解码异常统一处理
            last = exc
            if attempt < retries - 1:
                time.sleep(backoff * (attempt + 1))
                continue
            raise AdapterError(f"GET {url} 失败: {exc}") from exc
    raise AdapterError(f"GET {url} 失败: {last}")


def strip_html(html: str) -> str:
    text = re.sub(r"<script\b[^>]*>.*?</script>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<style\b[^>]*>.*?</style>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    return re.sub(r"\s+", " ", text).strip()


def num(raw: str) -> float:
    try:
        return float(raw)
    except (TypeError, ValueError) as exc:
        raise AdapterError(f"价格不是数字: {raw!r}") from exc


def _nums(block: str, n: int, what: str) -> list[float]:
    found = [num(x) for x in re.findall(r"([0-9]+(?:\.[0-9]+)?)元", block)]
    if len(found) < n:
        raise AdapterError(f"{what}: 期望 {n} 个价格，实际 {found}")
    return found[:n]


# ---------------------------------------------------------------------------
# Adapter: DS 官方（中文价格表，峰/谷各一列 × 模型两列）
# ---------------------------------------------------------------------------

def fetch_deepseek() -> list[dict]:
    return parse_deepseek_page(strip_html(fetch(DS_URL)))


def parse_deepseek_page(text: str) -> list[dict]:
    blocks = {}
    for key, heading in (("cache_hit", "（缓存命中）"),
                         ("input", "（缓存未命中）"),
                         ("output", "百万tokens输出")):
        idx = text.find(heading)
        if idx < 0:
            raise AdapterError(f"DS 官方页缺少段落: {heading}")
        blocks[key] = _nums(text[idx: idx + 260], 4, f"DS {heading}")

    def bound(values: list[float], i: int) -> tuple[float, float]:
        # 页面顺序：空闲(flash, pro) 高峰(flash, pro)
        return values[2 + i], values[0 + i]  # (peak, offpeak)

    offers = []
    for i, (model_id, display) in enumerate((("model_a1", "Model_A3"),
                                             ("model_a5", "Model_A5"))):
        price = {}
        for key in ("input", "cache_hit", "output"):
            peak, offpeak = bound(blocks[key], i)
            price[key] = {"peak": peak, "offpeak": offpeak}
        offers.append({
            "provider": "provider_a", "model_id": model_id, "display": display,
            "billing": "per_token", "price": price,
            "rules": {"schedule": {"kind": "peak_windows", "weekdays": [1, 2, 3, 4, 5],
                                   "windows": [["09:00", "12:00"], ["14:00", "18:00"]],
                                   "holidays_off": True},
                      "group_ratio": None, "activity": None},
            "meta": {"kind": "cash", "estimated": False, "comparable": True, "confidence": 0.99,
                     "source": {"type": "web", "url": DS_URL, "parser": "deepseek-cny-v1"}},
        })
    return offers


# ---------------------------------------------------------------------------
# Adapter: 供应商C（billing_expr 解析；按量模型走 model_ratio×2）
# ---------------------------------------------------------------------------

_EXPR_P = re.compile(r"\bp\s*\*\s*([0-9.]+)")
_EXPR_C = re.compile(r"\bc\s*\*\s*([0-9.]+)")
_EXPR_CR = re.compile(r"\bcr\s*\*\s*([0-9.]+)")
_EXPR_CC = re.compile(r"\bcc\s*\*\s*([0-9.]+)")
_MULT = re.compile(
    r'hour\("Asia/Shanghai"\)\s*>=\s*(\d+)\s*&&\s*hour\("Asia/Shanghai"\)\s*<\s*(\d+)\s*\?\s*([0-9.]+)\s*:\s*1'
)


def _parse_billing_expr(expr: str) -> dict:
    m_in, m_out = _EXPR_P.search(expr), _EXPR_C.search(expr)
    if not m_in or not m_out:
        raise AdapterError(f"billing_expr 解析失败: {expr}")
    base = {"input": num(m_in.group(1)), "output": num(m_out.group(1))}
    m_cr = _EXPR_CR.search(expr)
    if m_cr:
        base["cache_hit"] = num(m_cr.group(1))
    m_cc = _EXPR_CC.search(expr)
    if m_cc:
        base["cache_create"] = num(m_cc.group(1))
    multipliers = [{"when": f"hour in [{int(a)},{int(b)})", "factor": num(f)}
                   for a, b, f in _MULT.findall(expr)]
    return {"base": base, "multipliers": multipliers,
            "weekday_guard": "weekday" in expr.lower()}


def _load_ratio_snapshot() -> dict | None:
    """本地快照兜底：只读、带 generated_at 标注；不存在/坏了就当没有。"""
    try:
        doc = json.loads(DUOYUAN_RATIO_SNAPSHOT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(doc.get("data"), dict):
        return None
    stamp = doc.get("generated_at") or doc.get("snapshot_of") or "未知时间"
    SNAPSHOTS.append(f"provider_c:ratio_config@{stamp}")
    return doc


def _parse_provider_c_ratio_config(ratio_doc: dict) -> dict:
    data = ratio_doc.get("data") or {}
    return {
        "cache_ratio": data.get("cache_ratio") or {},
        "cache_create_ratio": data.get("create_cache_ratio") or {},
    }


def fetch_provider_c(wanted: dict[str, str]) -> list[dict]:
    pricing = json.loads(fetch(DUOYUAN_PRICING))
    ratio_doc: dict = {"data": {}}
    try:
        time.sleep(0.5)  # 同一站点两次请求留间隔，避免 429
        ratio_doc = json.loads(fetch(DUOYUAN_RATIO, retries=3, backoff=2.0))
    except AdapterError as exc:
        # ratio_config 只影响"按量模型"的缓存价；billing_expr 模型不受影响。
        # 先回落本地快照（带抓取时间，明确标注），再退到 degraded（不猜价）。
        snapshot = _load_ratio_snapshot()
        if snapshot is not None:
            ratio_doc = snapshot
            log(f"provider_c ratio_config 不可用，改用本地快照（实时性以快照时间戳为准）: {exc}")
        else:
            DEGRADED.append("provider_c:ratio_config")
            log(f"provider_c ratio_config 暂不可用（按量模型缓存价缺失，不猜价）: {exc}")
    return parse_provider_c_docs(pricing, ratio_doc, wanted)


def parse_provider_c_docs(pricing: dict, ratio_doc: dict,
                        wanted: dict[str, str]) -> list[dict]:
    ratios = _parse_provider_c_ratio_config(ratio_doc)
    group_ratio = pricing.get("group_ratio") or {}
    rows = {row["model_name"]: row for row in pricing.get("data") or []}
    offers = []
    for model_id, display in wanted.items():
        row = rows.get(model_id)
        if not row:
            log(f"provider_c 未上架: {model_id}（记 absent，不猜价）")
            offers.append({"provider": "provider_c", "model_id": model_id, "display": display,
                           "billing": "absent", "price": None, "rules": {},
                           "meta": {"kind": "cash", "estimated": False, "comparable": False,
                                    "confidence": 0.0,
                                    "source": {"type": "api", "url": DUOYUAN_PRICING,
                                               "parser": "provider_c-billing-expr-v1"},
                                    "note": "站内未上架"}})
            continue
        groups = [g for g in row.get("enable_groups") or [] if g in group_ratio] or ["default"]
        expr = row.get("billing_expr")
        if expr:
            parsed = _parse_billing_expr(expr)
            offers.append({
                "provider": "provider_c", "model_id": model_id, "display": display,
                "billing": "expr",
                "price": {"base": parsed["base"]},
                "rules": {"schedule": {"kind": "multipliers",
                                       "multipliers": parsed["multipliers"],
                                       "weekday_guard": parsed["weekday_guard"]},
                          "multipliers": parsed["multipliers"],
                          "weekday_guard": parsed["weekday_guard"],
                          "group_ratio": {g: group_ratio[g] for g in groups},
                          "activity": None},
                "meta": {"kind": "cash", "estimated": False, "comparable": True,
                         "confidence": 0.95,
                         "source": {"type": "api", "url": f"{DUOYUAN_PRICING}#billing_expr",
                                    "parser": "provider_c-billing-expr-v1"}},
            })
            continue
        # 按量：1 倍率 = 2.00 元/M（quota_per_unit=500000、汇率 1）
        ratio = num(str(row.get("model_ratio"))) * 2.0
        comp = row.get("completion_ratio") or 1.0
        cache = ratios["cache_ratio"].get(model_id)
        price = {"base": {"input": round(ratio, 6),
                          "output": round(ratio * float(comp), 6)}}
        if cache is not None:
            price["base"]["cache_hit"] = round(ratio * float(cache), 6)
        offers.append({
            "provider": "provider_c", "model_id": model_id, "display": display,
            "billing": "per_token",
            "price": {"input": {"flat": price["base"]["input"]},
                      "output": {"flat": price["base"]["output"]},
                      **({"cache_hit": {"flat": price["base"]["cache_hit"]}}
                         if "cache_hit" in price["base"] else {})},
            "rules": {"schedule": {"kind": "flat"},
                      "group_ratio": {g: group_ratio[g] for g in groups},
                      "activity": None},
            "meta": {"kind": "cash", "estimated": False, "comparable": True, "confidence": 0.9,
                     "source": {"type": "api", "url": DUOYUAN_PRICING,
                                "parser": "provider_c-model-ratio-v1"}},
        })
    return offers


# ---------------------------------------------------------------------------
# Adapter: 供应商D（/pricing SSR HTML：模型 + 时段块 + ¥价）
# ---------------------------------------------------------------------------

SF_MODELS = {
    "org/Model_A3": "Model_A3",
    "org/Model_A5": "Model_A5",
    "org/Model_B2": "Model_B2",
    "org/Model_B1": "Model_B1",
    "org/Model_C1": "Model_C1",
    # 2026-11-19 补：其余 4 个供应商D未定价模型（页面若未列则记 absent，不猜价）
    "org/Model_G1": "Model_G1",
    "org/Model_H1": "Model_H1",
    "org/model_i1": "model_i1",
    "org/model_i2": "model_i2",
}
_PRICE_TOKEN = re.compile(r"(?:费用发生时段\s*[：:]\s*([0-9点～/、\s-]+?))?\s*¥\s*([0-9]+(?:\.[0-9]+)?)")


_SF_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.\-]*/[A-Za-z0-9][A-Za-z0-9_.\-]*")


def _sf_block(text: str, model_id: str) -> str:
    """取模型 id 之后、下一个模型 id 之前的片段（防 '-Flash' 前缀串行与下一行价格渗入）。"""
    m = re.search(re.escape(model_id) + r"(?![A-Za-z0-9_.\-/])", text)
    if not m:
        raise AdapterError(f"供应商D价格页找不到模型: {model_id}")
    start = m.end()
    nxt = _SF_ID.search(text, start)
    end = nxt.start() if nxt else min(len(text), start + 800)
    return text[start:end]


def fetch_provider_d(wanted: dict[str, str]) -> list[dict]:
    return parse_provider_d_page(strip_html(fetch(SF_URL)), wanted)


def parse_provider_d_page(text: str, wanted: dict[str, str]) -> list[dict]:
    """逐模型解析；单个模型不在页面/结构异常 ⇒ 记 absent，不拖垮其他模型（2026-11-19）。"""
    offers = []
    for model_id, display in wanted.items():
        absent = {"provider": "provider_d", "model_id": model_id, "display": display,
                  "billing": "absent", "price": None, "rules": {},
                  "meta": {"kind": "cash", "estimated": False, "comparable": False,
                           "confidence": 0.0,
                           "source": {"type": "web", "url": SF_URL,
                                      "parser": "provider_d-pricing-v1"},
                           "note": "页面未列/未解析到价格（不猜价）"}}
        try:
            block = _sf_block(text, model_id)
            tokens = [(period.strip() if period else "", num(price_raw))
                      for period, price_raw in _PRICE_TOKEN.findall(block)]
            if not tokens:
                raise AdapterError(f"供应商D {model_id}: 未解析到价格")
            periods = [p for p, _ in tokens if p]
            if not periods:
                if len(tokens) < 2:
                    raise AdapterError(f"供应商D {model_id}: 价格项不足 {tokens}")
                inp, out = tokens[0][1], tokens[1][1]
                cache = tokens[2][1] if len(tokens) >= 3 else None
                price = {"input": {"flat": inp}, "output": {"flat": out}}
                if cache is not None:
                    price["cache_hit"] = {"flat": cache}
                rules = {"schedule": {"kind": "flat"}, "group_ratio": None, "activity": None}
            else:
                # 时段分组：第一组=主时段（入/出/缓），第二组=优惠时段（入/出/缓）
                buckets: list[tuple[str, list[float]]] = []
                for p, v in tokens:
                    if buckets and buckets[-1][0] == p:
                        buckets[-1][1].append(v)
                    else:
                        buckets.append((p, [v]))
                if len(buckets) < 2 or len(buckets[0][1]) < 2 or len(buckets[1][1]) < 2:
                    raise AdapterError(f"供应商D {model_id}: 时段价结构异常 {buckets}")
                main, off = buckets[0], buckets[1]

                def pack(vals: list[float]) -> dict:
                    out = {"input": vals[0], "output": vals[1]}
                    if len(vals) >= 3:
                        out["cache_hit"] = vals[2]
                    return out

                price = {k: {"peak": pack(main[1])[k], "offpeak": pack(off[1])[k]}
                         for k in ("input", "output")}
                m_pack, o_pack = pack(main[1]), pack(off[1])
                if "cache_hit" in m_pack and "cache_hit" in o_pack:
                    price["cache_hit"] = {"peak": m_pack["cache_hit"],
                                          "offpeak": o_pack["cache_hit"]}
                rules = {"schedule": {"kind": "hour_offpeak",
                                      "offpeak_hours": [[2, 8]], "weekday_guard": False,
                                      "label": f"优惠时段 {off[0]}；其余 {main[0]}"},
                         "group_ratio": None, "activity": None}
        except AdapterError as exc:
            log(str(exc))
            offers.append(absent)
            continue
        offers.append({
            "provider": "provider_d", "model_id": model_id, "display": display,
            "billing": "per_token", "price": price, "rules": rules,
            "meta": {"kind": "cash", "estimated": False, "comparable": True, "confidence": 0.95,
                     "source": {"type": "web", "url": SF_URL, "parser": "provider_d-pricing-v1"}},
        })
    return offers


# ---------------------------------------------------------------------------
# 归一化：把三家 offer 落到同一批 family 下
# ---------------------------------------------------------------------------

FAMILIES = {
    "model_a3": {
        "provider_a": "model_a1",
        "provider_c": "model_a3",
        "provider_d": "org/Model_A3",
    },
    "model_a5": {
        "provider_a": "model_a5",
        "provider_c": "model_a5",
        "provider_d": "org/Model_A5",
    },
    "model_b2": {"provider_c": "model_b2", "provider_d": "org/Model_B2"},
    "model_b1": {"provider_c": "model_b1", "provider_d": "org/Model_B1"},
    "model_d2": {"provider_c": "model_d2"},
    "model_c1": {"provider_d": "org/Model_C1"},
    # 2026-11-19 按配置补未定价模型：先从公开源补能核到的
    "model_e1": {"provider_c": "model_e1"},
    "model_e2": {"provider_c": "model_e2"},
    "model_d1": {"provider_c": "model_d1"},
    "model_g1": {"provider_d": "org/Model_G1"},
    "model_h1": {"provider_d": "org/Model_H1"},
    "model_i1": {"provider_d": "org/model_i1"},
    "model_i2": {"provider_d": "org/model_i2"},
}


# ---------------------------------------------------------------------------
# supplements（2026-11-21 L5 单源化）：抓不到的事实（缓存价、别名）由人工补记，
# 在生成/离线合并时并入 pricebook —— 价格只有一个真源（pricebook.json）。
# 读不到/坏 JSON ⇒ 按空处理（自证会报 legacy_drift，不会静默丢价）。
# ---------------------------------------------------------------------------

def load_supplements() -> dict:
    """读 config/price-supplements.json；缺失/坏结构 ⇒ {}（只告警，不中断抓取）。"""
    try:
        doc = json.loads(SUPPLEMENTS_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as exc:  # noqa: BLE001
        log(f"price-supplements 读取失败（按空处理）: {exc}")
        return {}
    return doc if isinstance(doc, dict) else {}


def apply_supplements(book: dict, supp: dict | None = None) -> dict:
    """把补记合并进 pricebook（原地修改并返回 book）。

    - ``candidates.<candidate>.price_patch``：按键合并进对应 offer 的 price（如 cache_hit）；
      出处写进 ``offer.meta.supplement``，可审计；
    - ``aliases``：只做**派生层**别名映射（不复制 offer —— 复制会改 display_label）；
    - 结果另记 ``book.supplements``（aliases/applied/merged_at），供网关自证与人工复核。
    """
    supp = supp if supp is not None else load_supplements()
    index: dict[str, tuple[str, dict]] = {}
    for family, node in (book.get("models") or {}).items():
        for offer in (node or {}).get("offers") or []:
            if isinstance(offer, dict):
                index[f"{offer.get('provider')}/{offer.get('model_id')}"] = (family, offer)

    applied: list[dict] = []
    for candidate, spec in ((supp.get("candidates") or {}) if isinstance(supp, dict) else {}).items():
        spec = spec if isinstance(spec, dict) else {}
        hit = index.get(candidate)
        patch = spec.get("price_patch") if isinstance(spec.get("price_patch"), dict) else {}
        if hit is None:
            applied.append({"candidate": candidate, "family": None, "status": "missing_offer",
                            "keys": sorted(patch), "source": spec.get("source")})
            log(f"supplements: pricebook 无该 offer，跳过 {candidate}（不猜价）")
            continue
        family, offer = hit
        price = offer.setdefault("price", {})
        for key, block in patch.items():
            price[key] = block
        offer.setdefault("meta", {})["supplement"] = {
            "source": spec.get("source"),
            "confidence": spec.get("confidence"),
            "reviewed_at": spec.get("reviewed_at"),
            "keys": sorted(patch),
        }
        applied.append({"candidate": candidate, "family": family, "status": "applied",
                        "keys": sorted(patch), "source": spec.get("source")})

    aliases = supp.get("aliases") if isinstance(supp, dict) else None
    if not isinstance(aliases, dict):
        aliases = {}
    book["supplements"] = {
        "aliases": aliases,
        "applied": applied,
        "merged_at": datetime.now(TZ_CN).isoformat(timespec="seconds"),
    }
    return book


def build_pricebook() -> dict:
    started = time.time()
    errors = []
    DEGRADED.clear()
    SNAPSHOTS.clear()

    ds, dyx, sf = [], [], []
    try:
        ds = fetch_deepseek()
    except AdapterError as exc:
        errors.append(("provider_a", str(exc)))
        log(f"provider_a 抓取失败: {exc}")
    try:
        dyx = fetch_provider_c(
            {m: m for m in ("model_a3", "model_a5", "model_b2",
                            "model_b1", "model_d2",
                            "model_e1", "model_e2", "model_d1")})
    except AdapterError as exc:
        errors.append(("provider_c", str(exc)))
        log(f"provider_c 抓取失败: {exc}")
    try:
        sf = fetch_provider_d(SF_MODELS)
    except AdapterError as exc:
        errors.append(("provider_d", str(exc)))
        log(f"provider_d 抓取失败: {exc}")

    by_provider = {"provider_a": ds, "provider_c": dyx, "provider_d": sf}
    models: dict[str, dict] = {}
    for family, wanted in FAMILIES.items():
        offers = []
        for provider, model_id in wanted.items():
            for offer in by_provider.get(provider) or []:
                if offer["model_id"] == model_id:
                    item = dict(offer)
                    item["id"] = f"{provider}/{model_id}"
                    item["family"] = family
                    item["meta"]["source"]["fetched_at"] = datetime.now(TZ_CN).isoformat(
                        timespec="seconds")
                    offers.append(item)
        models[family] = {"family": family,
                          "offers": offers,
                          "missing": [p for p in wanted if not any(
                              o["provider"] == p for o in offers)]}
    book = {
        "schema": "wb-pricebook/1",
        "currency": "CNY",
        "generated_at": datetime.now(TZ_CN).isoformat(timespec="seconds"),
        "elapsed_s": round(time.time() - started, 2),
        "rules": {"peak_rule": "DS 官方/方舟：工作日 09-12、14-18；供应商D：优惠时段 02-08",
                  "tz": "Asia/Shanghai"},
        "models": models,
        "degraded": list(DEGRADED),
        "snapshots": list(SNAPSHOTS),
        "errors": [{"provider": p, "error": e} for p, e in errors],
    }
    return apply_supplements(book)


# ---------------------------------------------------------------------------
# 自检：与 2026-11-16 已核报价逐项比对
# ---------------------------------------------------------------------------

def price_value(offer: dict, key: str):
    """统一取价：expr 报价看 base，按量报价看 flat。"""
    price = offer.get("price") or {}
    if "base" in price:
        return (price["base"] or {}).get(key)
    block = price.get(key) or {}
    if isinstance(block, dict) and "flat" in block:
        return block["flat"]
    return None


def offer_of(book: dict, family: str, provider: str) -> dict:
    for offer in book["models"].get(family, {}).get("offers") or []:
        if offer["provider"] == provider:
            return offer
    raise AssertionError(f"pricebook 缺 offer: {family}/{provider}")


def check(book: dict) -> int:
    checks: list[tuple[str, object, object, str]] = []
    degraded = set(book.get("degraded") or [])

    def add(label, got, want, skip_reason: str | None = None):
        if got is None and skip_reason and skip_reason in degraded:
            checks.append((label, got, want, "SKIP"))
            return
        checks.append((label, got, want, ""))

    o = offer_of(book, "model_a3", "provider_a")
    add("DS官方 flash 输入峰值", o["price"]["input"]["peak"], 2.0)
    add("DS官方 flash 输入谷值", o["price"]["input"]["offpeak"], 1.0)
    add("DS官方 flash 缓存峰值", o["price"]["cache_hit"]["peak"], 0.04)
    add("DS官方 flash 输出峰值", o["price"]["output"]["peak"], 8.0)
    add("DS官方 flash 输出谷值", o["price"]["output"]["offpeak"], 4.0)

    o = offer_of(book, "model_a5", "provider_a")
    add("DS官方 v4pro 输入峰值", o["price"]["input"]["peak"], 9.0)
    add("DS官方 v4pro 输出峰值", o["price"]["output"]["peak"], 27.0)

    o = offer_of(book, "model_a3", "provider_c")
    add("多元 flash base 输入", o["price"]["base"]["input"], 1.0)
    add("多元 flash base 缓存", o["price"]["base"]["cache_hit"], 0.02)
    add("多元 flash base 输出", o["price"]["base"]["output"], 4.0)
    add("多元 flash 乘数个数", len(o["rules"]["multipliers"]), 2)
    add("多元 flash 乘数因子", sorted({m["factor"] for m in o["rules"]["multipliers"]}), [2.0])
    add("多元 flash 默认分组", o["rules"]["group_ratio"].get("default"), 1.0)
    add("多元 flash 国产分组", o["rules"]["group_ratio"].get("gc-chat"), 0.6)

    o = offer_of(book, "model_b2", "provider_c")
    add("多元 glm-flash 输入", price_value(o, "input"), 0.8)
    add("多元 glm-flash 输出", price_value(o, "output"), 2.8)
    add("多元 glm-flash 缓存", price_value(o, "cache_hit"), 0.2, "provider_c:ratio_config")

    o = offer_of(book, "model_d2", "provider_c")
    add("多元 kimi 输入", price_value(o, "input"), 13.0)
    add("多元 kimi 输出", price_value(o, "output"), 68.0)
    add("多元 kimi 缓存", price_value(o, "cache_hit"), 1.3, "provider_c:ratio_config")

    o = offer_of(book, "model_a3", "provider_d")
    add("硅基 flash 主时段输入", o["price"]["input"]["peak"], 2.0)
    add("硅基 flash 主时段输出", o["price"]["output"]["peak"], 8.0)
    add("硅基 flash 主时段缓存", o["price"]["cache_hit"]["peak"], 0.04)
    add("硅基 flash 优惠时段输入", o["price"]["input"]["offpeak"], 1.0)
    add("硅基 flash 优惠时段输出", o["price"]["output"]["offpeak"], 4.0)
    add("硅基 flash 优惠时段缓存", o["price"]["cache_hit"]["offpeak"], 0.02)

    o = offer_of(book, "model_b2", "provider_d")
    add("硅基 glm-flash 输入", o["price"]["input"]["flat"], 0.8)
    add("硅基 glm-flash 输出", o["price"]["output"]["flat"], 2.8)
    add("硅基 glm-flash 缓存", o["price"]["cache_hit"]["flat"], 0.23)

    o = offer_of(book, "model_c1", "provider_d")
    add("硅基 model_c1 输入", o["price"]["input"]["flat"], 3.0)
    add("硅基 model_c1 输出", o["price"]["output"]["flat"], 12.0)

    failed, skipped = 0, 0
    for label, got, want, mark in checks:
        if mark == "SKIP":
            skipped += 1
            print(f"  SKIP  {label}: 依赖源降级（{book.get('degraded')}），不猜价")
            continue
        ok = got == want
        failed += 0 if ok else 1
        print(f"  {'PASS' if ok else 'FAIL'}  {label}: got={got!r} want={want!r}")
    total = len(checks) - skipped
    print(f"\n自检 {total - failed}/{total} 通过；SKIP {skipped} 项；抓取错误 {len(book['errors'])} 条")
    for err in book["errors"]:
        print(f"  ERROR {err['provider']}: {err['error']}")
    return 0 if failed == 0 and not book["errors"] else 2


# ---------------------------------------------------------------------------
# 打印
# ---------------------------------------------------------------------------

def summarize(book: dict) -> None:
    def fmt_price(offer: dict) -> str:
        price = offer.get("price")
        if not price:
            return f"{offer.get('billing')}（无价）"
        if "base" in price:
            base = price["base"]
            rule = " ×".join(f"{m['when']}@{m['factor']}"
                              for m in offer["rules"].get("multipliers") or [])
            grp = ",".join(f"{k}={v}" for k, v in (offer["rules"].get("group_ratio") or {}).items())
            return (f"base 入{base['input']} 缓{base.get('cache_hit', '-')} 出{base['output']}"
                    f" | 乘数[{rule or '-'}] | 分组[{grp or '-'}]")
        parts = []
        for key, block in price.items():
            if isinstance(block, dict) and "flat" in block:
                parts.append(f"{key}={block['flat']}")
            elif isinstance(block, dict):
                parts.append(f"{key}=峰{block.get('peak')}/谷{block.get('offpeak')}")
        return " ".join(parts)

    print(f"pricebook {book['schema']} @ {book['generated_at']}（{book['elapsed_s']}s）")
    if book.get("snapshots"):
        print(f"快照兜底: {book['snapshots']}")
    for family, node in book["models"].items():
        print(f"\n■ {family}")
        for offer in node["offers"]:
            print(f"  - {offer['provider']}/{offer['model_id']}: {fmt_price(offer)}")
        if node["missing"]:
            print(f"  缺: {node['missing']}")


def merge_supplements_offline(args) -> int:
    """不抓外网：在现有 pricebook 上合并 supplements，写到 --out（默认 config/pricebook.json）。

    S7 打包时用它把补记并入发布物；S1–S6 期间只对 --out /tmp 副本演练，不动生产 pricebook。
    """
    src = Path(args.from_path) if args.from_path else (ROOT / "config" / "pricebook.json")
    try:
        book = json.loads(src.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        log(f"离线合并底稿读取失败: {src}: {exc}")
        return 2
    apply_supplements(book)
    supp = book.get("supplements") or {}
    applied = supp.get("applied") or []
    ok = [a for a in applied if a.get("status") == "applied"]
    print(f"supplements 合并：applied {len(ok)}/{len(applied)}；aliases {len(supp.get('aliases') or {})}")
    for item in applied:
        print(f"  {item.get('status'):<13} {item.get('candidate')} keys={item.get('keys')}")
    out = Path(args.out) if args.out else (ROOT / "config" / "pricebook.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(book, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"已写入 {out}（未抓外网，generated_at 保持底稿值）")
    return 0 if len(ok) == len(applied) else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="价格同步 P1（默认只读）")
    parser.add_argument("--dry-run", action="store_true", help="抓取并打印（默认动作）")
    parser.add_argument("--check", action="store_true", help="与已核报价逐项自检")
    parser.add_argument("--json", action="store_true", help="输出 pricebook JSON")
    parser.add_argument("--out", metavar="PATH", help="落盘路径（不给则不写）")
    parser.add_argument("--merge-supplements", action="store_true",
                        help="离线：在现有 pricebook 上合并 supplements（不抓外网）")
    parser.add_argument("--from", dest="from_path", metavar="PATH",
                        help="离线合并底稿（默认 config/pricebook.json）")
    args = parser.parse_args(argv)

    if args.merge_supplements:
        return merge_supplements_offline(args)

    book = build_pricebook()
    if args.json:
        print(json.dumps(book, ensure_ascii=False, indent=2))
    else:
        summarize(book)

    rc = 0
    if args.check:
        print("\n== 自检（对 2026-11-16 已核报价）==")
        rc = check(book)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(book, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        log(f"已写入 {args.out}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
