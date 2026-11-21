#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""价格解析（price_resolver）单元测试：不联网、不读配置、时钟显式传入。

覆盖：
  - 峰谷判定：DS 官方工作日上午高峰/午后低谷/周末低谷/节假日豁免；
  - 供应商D：02–08 优惠时段；
  - 供应商C：hour 乘数（且不判星期，周末同时段仍 ×2）+ 分组倍率；
  - 活动折率生效/过期；
  - best_case / estimate_cost / compare（估算价默认排除）。

运行：
    cd <网关树根>
    python3 -m unittest tests.test_price_resolver -v
"""

from __future__ import annotations

import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import price_resolver as pr  # noqa: E402
import price_sync as ps  # noqa: E402

TZ = timezone(timedelta(hours=8))
MON_PEAK = datetime(2026, 11, 16, 10, 30, tzinfo=TZ)      # 周一 高峰段
MON_OFFPEAK = datetime(2026, 11, 16, 12, 30, tzinfo=TZ)   # 周一 午后低谷
SAT_PEAK_HOUR = datetime(2026, 11, 21, 10, 30, tzinfo=TZ)  # 周六 同一小时
MON_DAWN = datetime(2026, 11, 16, 3, 0, tzinfo=TZ)        # 周一 03:00（硅基优惠段）

DS_PAGE = """
百万tokens输入 （缓存命中） 空闲时段 0.02元 0.15元 高峰时段 0.04元 0.30元
百万tokens输入 （缓存未命中） 空闲时段 1元 4.5元 高峰时段 2元 9.0元
百万tokens输出 空闲时段 4元 13.5元 高峰时段 8元 27.0元
"""

SF_PAGE = """
org/Model_A3
费用发生时段: 0点～2点/8点～24点 ¥ 2.00
费用发生时段: 0点～2点/8点～24点 ¥ 8.00
费用发生时段: 0点～2点/8点～24点 ¥ 0.04
费用发生时段: 2点～8点 ¥ 1.00
费用发生时段: 2点～8点 ¥ 4.00
费用发生时段: 2点～8点 ¥ 0.02
"""

DUOYUAN_PRICING = {
    "group_ratio": {"default": 1, "gc-chat": 0.6},
    "data": [{"model_name": "model_a3", "quota_type": 0, "model_type": "text",
              "model_ratio": 37.5, "completion_ratio": 1,
              "enable_groups": ["default", "gc-chat"],
              "billing_expr": '(tier("base", p * 1 + c * 4 + cr * 0.02)) * '
                              '(hour("Asia/Shanghai") >= 14 && hour("Asia/Shanghai") < 18 ? 2 : 1) * '
                              '(hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 12 ? 2 : 1)'}],
}


def offers() -> dict[str, dict]:
    ds = {o["model_id"]: o for o in ps.parse_deepseek_page(ps.strip_html(DS_PAGE))}
    sf = {o["provider"]: o for o in ps.parse_provider_d_page(ps.strip_html(SF_PAGE),
                                                              {"org/Model_A3": "x"})}
    dyx = {o["provider"]: o for o in ps.parse_provider_c_docs(
        DUOYUAN_PRICING, {"data": {}}, {"model_a3": "x"})}
    for provider, offer in (("provider_a", ds["model_a1"]),
                            ("provider_d", sf["provider_d"]),
                            ("provider_c", dyx["provider_c"])):
        offer["id"] = f"{provider}/model_a1"
    return {"ds": ds["model_a1"], "sf": sf["provider_d"], "dyx": dyx["provider_c"]}


class TestEffectivePrice(unittest.TestCase):
    def setUp(self):
        self.o = offers()

    def test_ds_peak_offpeak_weekend(self):
        self.assertEqual(pr.effective_price(self.o["ds"], MON_PEAK)["prices"],
                         {"input": 2.0, "cache_hit": 0.04, "output": 8.0})
        self.assertEqual(pr.effective_price(self.o["ds"], MON_OFFPEAK)["prices"],
                         {"input": 1.0, "cache_hit": 0.02, "output": 4.0})
        # 周末同一小时 → 官方低谷
        self.assertEqual(pr.effective_price(self.o["ds"], SAT_PEAK_HOUR)["prices"]["input"], 1.0)

    def test_ds_holiday_exemption(self):
        holidays = {date(2026, 11, 16)}
        prices = pr.effective_price(self.o["ds"], MON_PEAK, holidays=holidays)["prices"]
        self.assertEqual(prices["input"], 1.0)

    def test_provider_d_offpeak_window(self):
        self.assertEqual(pr.effective_price(self.o["sf"], MON_DAWN)["prices"],
                         {"input": 1.0, "cache_hit": 0.02, "output": 4.0})
        self.assertEqual(pr.effective_price(self.o["sf"], MON_PEAK)["prices"],
                         {"input": 2.0, "cache_hit": 0.04, "output": 8.0})

    def test_provider_c_multiplier_and_group(self):
        self.assertEqual(pr.effective_price(self.o["dyx"], MON_PEAK)["prices"]["input"], 2.0)
        self.assertEqual(pr.effective_price(self.o["dyx"], MON_OFFPEAK)["prices"]["input"], 1.0)
        # 表达式不判星期：周六同时段仍 ×2
        self.assertEqual(pr.effective_price(self.o["dyx"], SAT_PEAK_HOUR)["prices"]["input"], 2.0)
        gc = pr.effective_price(self.o["dyx"], MON_OFFPEAK, group="gc-chat")["prices"]
        self.assertAlmostEqual(gc["input"], 0.6, places=6)
        self.assertAlmostEqual(gc["cache_hit"], 0.012, places=6)
        self.assertAlmostEqual(gc["output"], 2.4, places=6)

    def test_activity_factor_and_expiry(self):
        import copy
        offer = copy.deepcopy(self.o["dyx"])
        offer["rules"]["activity"] = {"factor": 0.85, "until": "2026-12-31", "source": "user"}
        self.assertAlmostEqual(
            pr.effective_price(offer, MON_OFFPEAK)["prices"]["input"], 0.85, places=6)
        offer["rules"]["activity"]["until"] = "2026-11-01"
        self.assertAlmostEqual(
            pr.effective_price(offer, MON_OFFPEAK)["prices"]["input"], 1.0, places=6)

    def test_best_case(self):
        best = pr.best_case(self.o["dyx"])["prices"]
        self.assertEqual(best, {"input": 1.0, "cache_hit": 0.02, "output": 4.0})
        best_gc = pr.best_case(self.o["dyx"], group="gc-chat")["prices"]
        self.assertAlmostEqual(best_gc["input"], 0.6, places=6)

    def test_list_price_keeps_blocks(self):
        listed = pr.list_price(self.o["ds"])
        self.assertEqual(listed["prices"]["input"], {"peak": 2.0, "offpeak": 1.0})


class TestCostAndCompare(unittest.TestCase):
    def setUp(self):
        self.o = offers()
        self.book = {"models": {"f": {"offers": [self.o["ds"], self.o["sf"], self.o["dyx"]]}}}

    def test_estimate_cost(self):
        prices = {"input": 1.0, "cache_hit": 0.02, "output": 4.0}
        # 2026-11-17 金额口径：成本估算保留 3 位小数（原 8 位；0.004612 → 0.005）
        self.assertEqual(pr.estimate_cost(prices, 2000, 800, 0.3), 0.005)

    def test_compare_order_and_group(self):
        rows = pr.compare(self.book, "f", at=MON_OFFPEAK, group="gc-chat")
        self.assertEqual(rows[0]["provider"], "provider_c")
        self.assertLess(rows[0]["cost"], rows[1]["cost"])

    def test_compare_excludes_estimated(self):
        import copy
        est = copy.deepcopy(self.o["ds"])
        est["id"], est["provider"] = "provider_i/x", "provider_i"
        est["meta"] = {"estimated": True, "comparable": False}
        book = {"models": {"f": {"offers": [self.o["ds"], est]}}}
        self.assertEqual(len(pr.compare(book, "f", at=MON_OFFPEAK)), 1)
        self.assertEqual(len(pr.compare(book, "f", at=MON_OFFPEAK, include_estimated=True)), 2)


if __name__ == "__main__":
    unittest.main()

class TestUnitPriceThreeDecimals(unittest.TestCase):
    """2026-11-17 用户令：单位价（¥/百万 token）按小数点后 3 位计。"""

    def test_effective_price_values_rounded_to_3(self):
        offer = {"id": "x", "price": {"input": {"offpeak": 2.0}, "output": {"offpeak": 8.0},
                                      "cache_hit": {"offpeak": 0.023456}}}
        prices = pr.effective_price(offer)["prices"]
        for key, value in prices.items():
            with self.subTest(key=key):
                self.assertEqual(round(value, 3), value, f"{key} 必须 ≤3 位小数")
        self.assertEqual(prices["cache_hit"], 0.023)

    def test_expr_price_values_rounded_to_3(self):
        offer = {"id": "y", "price": {"base": {"input": 1.0, "output": 4.0, "cache_hit": 0.02468}}}
        prices = pr.effective_price(offer)["prices"]
        self.assertEqual(prices["cache_hit"], 0.025)
        self.assertEqual(prices["input"], 1.0)

    def test_best_and_list_views_are_3_decimals(self):
        offer = {"id": "z", "price": {"input": {"peak": 2.0, "offpeak": 1.0},
                                      "output": {"peak": 8.0, "offpeak": 4.0}}}
        best = pr.best_case(offer)["prices"]
        for value in best.values():
            self.assertEqual(round(value, 3), value)
        # list_price 保留峰谷两档结构（值是 {peak,offpeak} 块），逐档核对 3 位
        listed = pr.list_price(offer)["prices"]
        for key, block in listed.items():
            with self.subTest(key=key):
                self.assertIsInstance(block, dict, "list 视图应保留两档结构")
                for period, value in block.items():
                    self.assertEqual(round(value, 3), value, f"{key}.{period} 必须 ≤3 位小数")
