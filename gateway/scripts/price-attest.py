#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""L5 单源自证 CLI（只读，零副作用）。

做什么：调用 ``main.price_attest_snapshot()``，输出 27 个候选的价格来源覆盖与双写等价性：
  - coverage：每个候选的来源类别（offer / offer+supplement / alias / local），unsourced 应为 0；
  - legacy  ：派生块 vs capability_meta 旧值的数值差（双写期守护，drift 应为 0）；
  - orphan_offers：pricebook 有、upstreams 已无的报价（信息项，不计红）；
  - source  ：pricebook 的 schema / generated_at / sha256 / 补记条数。

边界：只读 config/pricebook.json、config/price-supplements.json、config/routing.json、upstreams.json；
      不写盘、不起服务、不改任何生产状态。与 ``/health.price_consistency``（ROUTER_PRICE_ATTEST=1）
      是同一份实现。

用法：
    python3 scripts/price-attest.py            # 人读摘要；exit 0=consistent / 1=mismatch / 2=错误
    python3 scripts/price-attest.py --json     # 机器可读（完整快照）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

import main as gw  # noqa: E402  （只读导入：不启动服务）


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="L5 单源自证（只读）")
    parser.add_argument("--json", action="store_true", help="输出完整快照 JSON")
    args = parser.parse_args(argv)

    try:
        snapshot = gw.price_attest_snapshot()
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(snapshot, ensure_ascii=False, indent=2))
    else:
        coverage = snapshot.get("coverage") or {}
        legacy = snapshot.get("legacy") or {}
        source = snapshot.get("source") or {}
        print(f"status        : {snapshot.get('status')}")
        print(f"candidates    : {coverage.get('candidates')}（derived {coverage.get('derived')}）")
        print(f"classes       : {json.dumps(coverage.get('classes') or {}, ensure_ascii=False)}")
        print(f"unsourced     : {coverage.get('unsourced')} {coverage.get('unsourced_ids') or ''}")
        print(f"legacy_drift  : {legacy.get('drift')}（type_shim_rows {legacy.get('type_shim_rows')}："
              f"{legacy.get('type_shim_ids') or ''}）")
        print(f"fold_errors   : {len(snapshot.get('fold_errors') or [])}")
        print(f"orphan_offers : {len(snapshot.get('orphan_offers') or [])}")
        print(f"pricebook     : {source.get('generated_at')} sha256={(source.get('sha256') or '')[:16]} "
              f"supplements_aliases={source.get('supplements_aliases')}")
        print(f"period        : {snapshot.get('period')}  checked_at={snapshot.get('checked_at')}")
    return 0 if snapshot.get("status") == "consistent" else 1


if __name__ == "__main__":
    sys.exit(main())
