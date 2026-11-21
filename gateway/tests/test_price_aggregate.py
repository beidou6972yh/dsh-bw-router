#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""1.0.3.3 T2：`price_aggregate()` 聚合视图回归（2026-11-21 遗留复核 #4）。

背景：1.0.3.2 现场曾记录 `/v1/route/prices?model=` 抛
`TypeError: '<' not supported between instances of 'float' and 'dict'`。
1.0.3.3 只读复核判定：**该报错来自旧构建日志**，当前 `_sort_input()` 恒返回 float，
代码路径不可触发；但 `?model=` 聚合视图此前**没有任何用例覆盖**，故补本文件锁死行为。

判据（本文件即判据）：
1. `view` 非法回退 effective，不抛错；
2. 未收录模型返回 count=0 + note，不猜价；
3. offer 的 input 为 dict（peak/offpeak）与 float 混排时**排序键恒 float**、不抛 TypeError；
4. `_offer_view` 异常时该行降级为"价格结构不可用"，整体不崩；
5. dict/float 混排按 min(peak, offpeak) 与 float 统一比较。

配置无关、不写盘、不起端口（run-tests 两段均应收同一失败集合）。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw  # noqa: E402


def _offer(oid: str, model_id: str) -> dict:
    return {"id": oid, "provider": "prov", "model_id": model_id,
            "display": model_id.upper(), "meta": {}}


class PriceAggregateCase(unittest.TestCase):
    def test_unknown_model_returns_empty_with_note(self):
        out = gw.price_aggregate("no-such/family-xyz")
        self.assertEqual(out["count"], 0)
        self.assertEqual(out["offers"], [])
        self.assertIn("pricebook", out["note"])

    def test_invalid_view_falls_back_to_effective(self):
        out = gw.price_aggregate("no-such/family-xyz", view="not-a-view")
        self.assertEqual(out["view"], "effective")

    def test_mixed_float_and_dict_input_sorts_without_type_error(self):
        """核心回归：float(3.0) 与 dict(peak=2/offpeak=1) 混排必须按 1.0 < 3.0 排。"""
        node = {"family": "fam", "offers": [_offer("a", "m-float"), _offer("b", "m-dict")]}

        def fake_view(offer, view, group):
            if offer["id"] == "a":
                return {"currency": "CNY", "prices": {"input": 3.0, "output": 1.0}}
            return {"currency": "CNY",
                    "prices": {"input": {"peak": 2.0, "offpeak": 1.0}, "output": 1.0}}

        with mock.patch.object(gw, "pricebook_family", return_value=node), \
                mock.patch.object(gw, "_offer_view", side_effect=fake_view):
            out = gw.price_aggregate("fam", view="list")

        self.assertEqual(out["count"], 2)
        self.assertEqual([row["id"] for row in out["offers"]], ["b", "a"])
        self.assertEqual(out["offers"][0]["display_label"], "prov/M-DICT")  # 分段价不带价段（不猜价）

    def test_all_dict_inputs_sort_by_min(self):
        node = {"family": "fam", "offers": [_offer("a", "m1"), _offer("b", "m2")]}

        def fake_view(offer, view, group):
            if offer["id"] == "a":
                return {"currency": "CNY",
                        "prices": {"input": {"peak": 5.0, "offpeak": 4.0}, "output": 1.0}}
            return {"currency": "CNY",
                    "prices": {"input": {"peak": 3.0, "offpeak": 0.5}, "output": 1.0}}

        with mock.patch.object(gw, "pricebook_family", return_value=node), \
                mock.patch.object(gw, "_offer_view", side_effect=fake_view):
            out = gw.price_aggregate("fam", view="effective")

        self.assertEqual([row["id"] for row in out["offers"]], ["b", "a"])

    def test_offer_view_error_degrades_row_not_whole_payload(self):
        node = {"family": "fam", "offers": [_offer("a", "m1")]}

        with mock.patch.object(gw, "pricebook_family", return_value=node), \
                mock.patch.object(gw, "_offer_view", side_effect=RuntimeError("boom")):
            out = gw.price_aggregate("fam")

        self.assertEqual(out["count"], 1)
        self.assertEqual(out["offers"][0]["pricing"]["note"], "价格结构不可用")

    def test_pricebook_offer_path_normalizes_node(self):
        """`pricebook_family` 未命中但 `pricebook_offer` 命中时，也得给出 family 视图。"""
        offer = _offer("solo", "m-solo")
        offer["family"] = "fam-solo"

        with mock.patch.object(gw, "pricebook_family", return_value=None), \
                mock.patch.object(gw, "pricebook_offer", return_value=offer):
            out = gw.price_aggregate("prov/m-solo")

        self.assertEqual(out["count"], 1)
        self.assertEqual(out["family"], "fam-solo")


if __name__ == "__main__":
    unittest.main(verbosity=2)
