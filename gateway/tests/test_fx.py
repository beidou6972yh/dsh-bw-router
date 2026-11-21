#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""金额口径（CNY / 3 位小数）与汇率换算单元测试（2026-11-17 用户令第 2、3 条）。

覆盖：
  - estimate_cost 保留 3 位小数（原 8 位）；
  - fx_rate：CNY/RMB 恒 1.0；USDCNY 读数；null / 缺键 / 缺文件 / 坏 JSON / 非正数 / 非数字 ⇒ None（不猜价）；
  - convert_to_cny：非 CNY × 汇率 → 3 位；无汇率 ⇒ None；CNY 原值 → 3 位；非数字/NaN/bool ⇒ None；
  - router_plan._price_for：pricebook 与 capability_meta 两条分支 cost 均 3 位；USD+汇率 → 折 CNY 3 位；
    USD 无汇率 ⇒ known=False、cost=None（不猜价）；
  - router_strategies._recommend_price_view：非 CNY 报价（pricebook 与 capability_meta 两路）按汇率折算；
    缺汇率 ⇒ (None, None) 视为价未知垫底。
不读真实配置、不联网：汇率一律用临时文件注入。

运行：cd <网关树根> && python3 -m unittest tests.test_fx -v
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import price_resolver as pr  # noqa: E402
import router_plan  # noqa: E402
import router_strategies as rstrat  # noqa: E402


class _StubGateway:
    """router_plan/router_strategies 需要的最小网关替身。"""

    def __init__(self, offer: dict | None = None, meta: dict | None = None):
        self.offer = offer
        self.CAPABILITY_META_MODELS = meta or {}

    def pricebook_offer(self, candidate: str):
        return self.offer


def _usd_offer(in_p: float, out_p: float) -> dict:
    """一个显式标 USD 的 pricebook offer（模拟未来的美元报价）。"""
    return {"id": "u/m", "provider": "u", "currency": "USD",
            "price": {"input": {"offpeak": in_p}, "output": {"offpeak": out_p}}}


class _FxFixture(unittest.TestCase):
    """临时汇率文件夹具：默认走注入文件，tearDown 还原模块全局并清缓存。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="fx-test-")
        self.tmp = Path(self._tmp.name)
        self._orig_path = pr.FX_RATES_PATH
        pr.clear_fx_cache()

    def tearDown(self):
        pr.FX_RATES_PATH = self._orig_path
        pr.clear_fx_cache()
        self._tmp.cleanup()

    def _use_fx(self, doc, name: str = "fx-rates.json") -> Path:
        path = self.tmp / name
        path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        pr.FX_RATES_PATH = path
        pr.clear_fx_cache()
        return path


class TestEstimateCost(_FxFixture):
    def test_estimate_cost_rounds_to_3_decimals(self):
        """验收同款算式：{'input':1.0,'output':4.0}, 12345, 678 → 0.015（原 0.015057）。"""
        cost = pr.estimate_cost({"input": 1.0, "output": 4.0}, 12345, 678)
        self.assertEqual(cost, 0.015)
        self.assertEqual(cost, round(cost, 3), "成本估算必须 3 位小数封顶")

    def test_estimate_cost_with_cache_3_decimals(self):
        prices = {"input": 1.0, "cache_hit": 0.02, "output": 4.0}
        cost = pr.estimate_cost(prices, 2000, 800, 0.3)
        self.assertEqual(cost, 0.005)
        self.assertEqual(cost, round(cost, 3))


class TestFxRate(_FxFixture):
    def test_cny_and_rmb_are_identity(self):
        self.assertEqual(pr.fx_rate("CNY"), 1.0)
        self.assertEqual(pr.fx_rate("cny"), 1.0)
        self.assertEqual(pr.fx_rate("RMB"), 1.0)

    def test_reads_usdcny(self):
        self._use_fx({"updated_at": "2026-11-17", "USDCNY": 7.12})
        self.assertEqual(pr.fx_rate("USD"), 7.12)
        self.assertEqual(pr.fx_rate("usd"), 7.12)

    def test_null_rate_returns_none(self):
        self._use_fx({"updated_at": "2026-11-17", "USDCNY": None})
        self.assertIsNone(pr.fx_rate("USD"))

    def test_missing_key_returns_none(self):
        self._use_fx({"updated_at": "2026-11-17", "EURCNY": 7.9})
        self.assertIsNone(pr.fx_rate("USD"), "只有 EUR 汇率时 USD 必须视为无汇率")

    def test_missing_file_returns_none(self):
        pr.FX_RATES_PATH = self.tmp / "nope.json"
        pr.clear_fx_cache()
        self.assertIsNone(pr.fx_rate("USD"))

    def test_bad_json_returns_none(self):
        path = self.tmp / "bad.json"
        path.write_text("{not json", encoding="utf-8")
        pr.FX_RATES_PATH = path
        pr.clear_fx_cache()
        self.assertIsNone(pr.fx_rate("USD"))

    def test_non_positive_or_non_numeric_returns_none(self):
        for bad in (0, -1, "7.12", True, None):
            with self.subTest(rate=bad):
                self._use_fx({"USDCNY": bad}, name=f"fx-{str(bad)}.json")
                self.assertIsNone(pr.fx_rate("USD"))

    def test_empty_currency_returns_none(self):
        self._use_fx({"USDCNY": 7.12})
        for bad in (None, "", "   "):
            self.assertIsNone(pr.fx_rate(bad))

    def test_rate_is_rounded_to_3_decimals(self):
        """用户令第 2 条定稿：汇率取 3 位小数（超过 3 位的按 3 位生效，不做隐式全精度）。"""
        self._use_fx({"USDCNY": 7.123456}, name="fx-6dp.json")
        self.assertEqual(pr.fx_rate("USD"), 7.123, "6 位汇率必须收敛到 3 位")
        self.assertEqual(pr.convert_to_cny(1.0, "USD"), 7.123)
        self.assertEqual(pr.convert_to_cny(2.0, "USD"), 14.246)
        # 真实当日报价（2026-11-17 主源 6.679257 / ECB 6.6665）按 3 位取整
        self._use_fx({"USDCNY": 6.679257}, name="fx-today.json")
        self.assertEqual(pr.fx_rate("USD"), 6.679)
        self._use_fx({"USDCNY": 6.6665}, name="fx-ecb.json")
        self.assertEqual(pr.fx_rate("USD"), 6.667)


class TestConvertToCny(_FxFixture):
    def test_usd_with_rate_to_cny_3_decimals(self):
        self._use_fx({"updated_at": "2026-11-17", "USDCNY": 7.12})
        self.assertEqual(pr.convert_to_cny(1.0, "USD"), 7.12)
        self.assertEqual(pr.convert_to_cny(4.0, "USD"), 28.48)
        value = pr.convert_to_cny(1.23456, "USD")
        self.assertEqual(value, round(1.23456 * 7.12, 3))
        self.assertEqual(value, round(value, 3), "换算结果必须 3 位小数封顶")

    def test_usd_without_rate_returns_none(self):
        self._use_fx({"updated_at": "2026-11-17", "USDCNY": None})
        self.assertIsNone(pr.convert_to_cny(1.0, "USD"), "缺汇率必须 None，不猜价")

    def test_usd_missing_key_returns_none(self):
        self._use_fx({"updated_at": "2026-11-17", "EURCNY": 7.9})
        self.assertIsNone(pr.convert_to_cny(1.0, "USD"))

    def test_usd_missing_file_returns_none(self):
        pr.FX_RATES_PATH = self.tmp / "nope.json"
        pr.clear_fx_cache()
        self.assertIsNone(pr.convert_to_cny(1.0, "USD"))

    def test_cny_amount_rounded_to_3(self):
        self._use_fx({"USDCNY": 7.12})
        self.assertEqual(pr.convert_to_cny(1.23456, "CNY"), 1.235)
        self.assertEqual(pr.convert_to_cny(0.015057, "CNY"), 0.015)

    def test_bad_amount_or_currency_returns_none(self):
        self._use_fx({"USDCNY": 7.12})
        for bad in ("1.0", None, True, float("nan"), float("inf")):
            with self.subTest(amount=bad):
                self.assertIsNone(pr.convert_to_cny(bad, "USD"))
        self.assertIsNone(pr.convert_to_cny(1.0, ""), "空币种不得默认按 CNY 猜")
        self.assertIsNone(pr.convert_to_cny(1.0, None))


class TestRouterPlanMoney(_FxFixture):
    def setUp(self):
        super().setUp()
        self._orig_gw = router_plan._GATEWAY
        router_plan.set_gateway(_StubGateway())

    def tearDown(self):
        router_plan._GATEWAY = self._orig_gw
        super().tearDown()

    @staticmethod
    def _info(currency: str) -> dict:
        return {"id": "u/m", "price": {
            "currency": currency,
            "input_per_mtok": {"offpeak": 1.0},
            "output_per_mtok": {"offpeak": 4.0}}}

    def test_meta_cny_cost_3_decimals(self):
        got = router_plan._price_for(self._info("CNY"), 12345, 678, "offpeak")
        self.assertTrue(got["known"])
        self.assertEqual(got["currency"], "CNY")
        self.assertEqual(got["cost"], 0.015)
        self.assertEqual(got["cost"], round(got["cost"], 3))

    def test_meta_usd_with_rate_converts_to_cny(self):
        self._use_fx({"updated_at": "2026-11-17", "USDCNY": 7.12})
        got = router_plan._price_for(self._info("USD"), 12345, 678, "offpeak")
        self.assertTrue(got["known"])
        self.assertEqual(got["currency"], "CNY", "换算后币种口径必须是 CNY")
        self.assertEqual(got["cost"], round(0.015057 * 7.12, 3))
        self.assertIn("USD→CNY", got["notice"])

    def test_meta_usd_without_rate_is_unknown(self):
        self._use_fx({"updated_at": "2026-11-17", "USDCNY": None})
        got = router_plan._price_for(self._info("USD"), 12345, 678, "offpeak")
        self.assertFalse(got["known"], "无汇率必须视为价未知，不得猜价")
        self.assertIsNone(got["cost"])
        self.assertEqual(got["currency"], "USD")
        self.assertEqual(got["unconverted_currency"], "USD")

    def test_pricebook_branch_cost_3_decimals(self):
        router_plan.set_gateway(_StubGateway(offer={
            "id": "u/m", "provider": "u",
            "price": {"input": {"offpeak": 1.0}, "output": {"offpeak": 4.0}}}))
        got = router_plan._price_for(self._info("CNY"), 12345, 678, "offpeak")
        self.assertTrue(got["known"])
        self.assertEqual(got["source"], "pricebook")
        self.assertEqual(got["currency"], "CNY")
        self.assertEqual(got["cost"], 0.015)


class TestRecommendPriceView(_FxFixture):
    def setUp(self):
        super().setUp()
        self._orig_gw = rstrat._GATEWAY

    def tearDown(self):
        rstrat._GATEWAY = self._orig_gw
        super().tearDown()

    def _gw(self, offer=None, meta=None):
        rstrat._GATEWAY = _StubGateway(offer=offer, meta=meta)

    def test_meta_cny_unchanged(self):
        self._gw(meta={"u/m": {"price": {
            "currency": "CNY",
            "input_per_mtok": {"offpeak": 2.0},
            "output_per_mtok": {"offpeak": 4.0}}}})
        self.assertEqual(rstrat._recommend_price_view("u/m"), (2.0, 4.0))

    def test_meta_usd_with_rate_converts(self):
        self._use_fx({"updated_at": "2026-11-17", "USDCNY": 7.12})
        self._gw(meta={"u/m": {"price": {
            "currency": "USD",
            "input_per_mtok": {"offpeak": 2.0},
            "output_per_mtok": {"offpeak": 4.0}}}})
        self.assertEqual(rstrat._recommend_price_view("u/m"), (14.24, 28.48))

    def test_meta_usd_without_rate_is_unknown(self):
        self._use_fx({"updated_at": "2026-11-17", "USDCNY": None})
        self._gw(meta={"u/m": {"price": {
            "currency": "USD",
            "input_per_mtok": {"offpeak": 2.0},
            "output_per_mtok": {"offpeak": 4.0}}}})
        self.assertEqual(rstrat._recommend_price_view("u/m"), (None, None),
                         "缺汇率 ⇒ 价未知（垫底不猜价）")

    def test_pricebook_usd_with_rate_converts(self):
        self._use_fx({"updated_at": "2026-11-17", "USDCNY": 7.12})
        self._gw(offer=_usd_offer(2.0, 4.0))
        self.assertEqual(rstrat._recommend_price_view("u/m"), (14.24, 28.48))

    def test_pricebook_usd_without_rate_is_unknown(self):
        self._use_fx({"updated_at": "2026-11-17", "USDCNY": None})
        self._gw(offer=_usd_offer(2.0, 4.0))
        self.assertEqual(rstrat._recommend_price_view("u/m"), (None, None))

    def test_pricebook_cny_unchanged(self):
        self._gw(offer={"id": "u/m", "provider": "u",
                        "price": {"input": {"offpeak": 2.0}, "output": {"offpeak": 4.0}}})
        self.assertEqual(rstrat._recommend_price_view("u/m"), (2.0, 4.0))


if __name__ == "__main__":
    unittest.main()
