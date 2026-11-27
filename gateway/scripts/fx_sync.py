#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""汇率同步：取当日 USD→CNY，写 config/fx-rates.json（默认 dry-run，只有 --write 才落盘）。

口径（2026-11-17 约定第 2 条「如存在，则按当日汇率取小数点后3位，换算为人民币」）：
  - 只读公开汇率接口，**不带任何密钥**；默认只打印，`--write` 才写文件（写数据文件须用户下令）。
  - 汇率**保留 3 位小数**（与网关 price_resolver.fx_rate 的读取口径一致）；
  - 主源失败退备源；两源都失败 ⇒ **不写、退出码 2**（不猜价，宁可留 null）。
  - 落盘带出处：source.url / fetched_at / 交叉核对值，便于日后审计"这个数从哪来"。

两个源（都实测可用，2026-11-17）：
  主：https://open.er-api.com/v6/latest/USD        （exchangerate-api，免费无 key，每日更新）
  备：https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY   （ECB 参考汇率，工作日更新）

用法：
    python3 scripts/fx_sync.py                 # dry-run：打印将要写入的内容
    python3 scripts/fx_sync.py --write         # 落盘 config/fx-rates.json
    python3 scripts/fx_sync.py --write --out /tmp/fx.json
退出码：0 = 成功（dry 或写盘）；2 = 两源都取不到 / 汇率非法（未写盘）；3 = 参数错。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "config" / "fx-rates.json"
PRIMARY = "https://open.er-api.com/v6/latest/USD"
SECONDARY = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY"
UA = "Mozilla/5.0 (compatible; wb-fx-sync/1.0; +local)"
TIMEOUT = 20
TZ_CN = timezone(timedelta(hours=8))


def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_primary() -> tuple[float, dict]:
    doc = _get_json(PRIMARY)
    if doc.get("result") != "success":
        raise ValueError(f"primary 返回非 success：{doc.get('result')!r}")
    rate = (doc.get("rates") or {}).get("CNY")
    if not isinstance(rate, (int, float)) or isinstance(rate, bool) or rate <= 0:
        raise ValueError(f"primary 未给出合法 CNY 汇率：{rate!r}")
    return float(rate), {"url": PRIMARY, "as_of_utc": doc.get("time_last_update_utc"),
                         "provider": doc.get("provider")}


def fetch_secondary() -> tuple[float, dict]:
    doc = _get_json(SECONDARY)
    rate = (doc.get("rates") or {}).get("CNY")
    if not isinstance(rate, (int, float)) or isinstance(rate, bool) or rate <= 0:
        raise ValueError(f"secondary 未给出合法 CNY 汇率：{rate!r}")
    return float(rate), {"url": SECONDARY, "as_of_date": doc.get("date")}


def main() -> int:
    ap = argparse.ArgumentParser(description="取当日 USD→CNY 写 fx-rates.json")
    ap.add_argument("--write", action="store_true", help="真正落盘（默认只打印）")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    now = datetime.now(TZ_CN)
    errors: list[str] = []
    primary: tuple[float, dict] | None = None
    secondary: tuple[float, dict] | None = None

    try:
        primary = fetch_primary()
        print(f"[主源] USDCNY={primary[0]:.6f} as_of={primary[1].get('as_of_utc')}")
    except Exception as exc:  # noqa: BLE001 - 只记录，不抛
        errors.append(f"primary: {type(exc).__name__}: {exc}")
        print(f"[主源] 失败：{type(exc).__name__}: {exc}", file=sys.stderr)
    try:
        secondary = fetch_secondary()
        print(f"[备源] USDCNY={secondary[0]:.6f} as_of={secondary[1].get('as_of_date')}")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"secondary: {type(exc).__name__}: {exc}")
        print(f"[备源] 失败：{type(exc).__name__}: {exc}", file=sys.stderr)

    if primary is None and secondary is None:
        print("❌ 两源都取不到 ⇒ 不写盘、不猜价（保留原文件）", file=sys.stderr)
        return 2

    chosen, src = primary if primary is not None else secondary
    rate3 = round(chosen, 3)
    doc = {
        "updated_at": now.strftime("%Y-%m-%d"),
        "USDCNY": rate3,
        "source": {**src, "fetched_at": now.strftime("%Y-%m-%dT%H:%M:%S%z"),
                   "field": "rates.CNY", "rounded_to": 3},
        "note": ("USD→CNY 汇率真源（只读）。键名规则 <币种>CNY（如 USDCNY）；值为 null 或缺键＝未取到当日汇率，"
                 "换算返回 None（不猜价）。本文件由 scripts/fx_sync.py 生成；网关不自动抓取。"),
    }
    if primary is not None and secondary is not None:
        doc["cross_check"] = {"url": secondary[1]["url"], "USDCNY": round(secondary[0], 3),
                              "as_of": secondary[1].get("as_of_date"),
                              "diff_pct": round((primary[0] - secondary[0]) / secondary[0] * 100, 3)}
    if errors:
        doc["note"] += " ⚠️ 本次有源失败：" + "；".join(errors)

    text = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    if not args.write:
        print("── dry-run（未写盘；加 --write 才落）──")
        print(text)
        return 0
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"[写盘] {out} :: USDCNY={rate3}（保留 3 位）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
