#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""价格同步解析单元测试：不联网、不读配置、不依赖真实时钟。

覆盖：
  - DS 官方中文价格表（峰/谷 × 两模型）解析；
  - 供应商C billing_expr 解析（base 系数 / hour 乘数 / 分组倍率）与按量倍率换算；
  - 供应商D价格页解析（时段价三件套 / 一口价 / 模型 id 前缀串行防护）；
  - 单模型缺失或结构异常 ⇒ 记 absent（三件套），不拖垮同页其他模型（2026-11-19 口径）。

运行：
    cd <网关树根>
    python3 -m unittest tests.test_price_sync -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import price_sync as ps  # noqa: E402

DS_PAGE = """
<html><body>
<p>百万tokens输入 （缓存命中） 空闲时段 0.02元 0.15元 高峰时段 0.04元 0.30元</p>
<p>百万tokens输入 （缓存未命中） 空闲时段 1元 4.5元 高峰时段 2元 9.0元</p>
<p>百万tokens输出 空闲时段 4元 13.5元 高峰时段 8元 27.0元</p>
</body></html>
"""

SF_PAGE = """
<html><body>
<span>org/Model_A3</span>
<b>费用发生时段: 0点～2点/8点～24点 ¥ 2.00</b>
<b>费用发生时段: 0点～2点/8点～24点 ¥ 8.00</b>
<b>费用发生时段: 0点～2点/8点～24点 ¥ 0.04</b>
<b>费用发生时段: 2点～8点 ¥ 1.00</b>
<b>费用发生时段: 2点～8点 ¥ 4.00</b>
<b>费用发生时段: 2点～8点 ¥ 0.02</b>
<span>org/Model_B2 ¥ 0.80 ¥ 2.80 ¥ 0.23</span>
<span>org/Model_B1 ¥ 8.00 ¥ 28.00 ¥ 2.00</span>
<span>org/Model_C1 ¥ 3.00 ¥ 12.00 -</span>
</body></html>
"""

DUOYUAN_PRICING = {
    "group_ratio": {"default": 1, "gc-chat": 0.6, "claude": 0.5},
    "data": [
        {"model_name": "model_a3", "quota_type": 0, "model_type": "text",
         "model_ratio": 37.5, "completion_ratio": 1, "enable_groups": ["default", "gc-chat"],
         "billing_expr": '(tier("base", p * 1 + c * 4 + cr * 0.02)) * '
                         '(hour("Asia/Shanghai") >= 14 && hour("Asia/Shanghai") < 18 ? 2 : 1) * '
                         '(hour("Asia/Shanghai") >= 9 && hour("Asia/Shanghai") < 12 ? 2 : 1)'},
        {"model_name": "model_b2", "quota_type": 0, "model_type": "text",
         "model_ratio": 0.4, "completion_ratio": 3.5, "enable_groups": ["default", "gc-chat"]},
        {"model_name": "model_d1", "quota_type": 0, "model_type": "text",
         "model_ratio": 10, "completion_ratio": 5, "enable_groups": ["default"]},
    ],
}
DUOYUAN_RATIO = {"data": {"cache_ratio": {"model_b2": 0.25}, "create_cache_ratio": {}}}


class TestDeepseekParse(unittest.TestCase):
    def test_peak_offpeak_two_models(self):
        offers = {o["model_id"]: o for o in ps.parse_deepseek_page(ps.strip_html(DS_PAGE))}
        flash = offers["model_a1"]
        self.assertEqual(flash["price"]["input"], {"peak": 2.0, "offpeak": 1.0})
        self.assertEqual(flash["price"]["cache_hit"], {"peak": 0.04, "offpeak": 0.02})
        self.assertEqual(flash["price"]["output"], {"peak": 8.0, "offpeak": 4.0})
        pro = offers["model_a5"]
        self.assertEqual(pro["price"]["input"], {"peak": 9.0, "offpeak": 4.5})
        self.assertEqual(pro["price"]["output"], {"peak": 27.0, "offpeak": 13.5})
        self.assertTrue(flash["meta"]["comparable"])

    def test_missing_section_raises(self):
        with self.assertRaises(ps.AdapterError):
            ps.parse_deepseek_page("百万tokens输入 （缓存未命中） 空闲时段 1元")


class TestUpstreamAParse(unittest.TestCase):
    def test_billing_expr(self):
        offers = {o["model_id"]: o for o in
                  ps.parse_provider_c_docs(DUOYUAN_PRICING, DUOYUAN_RATIO,
                                         {"model_a3": "x"})}
        o = offers["model_a3"]
        self.assertEqual(o["billing"], "expr")
        self.assertEqual(o["price"]["base"], {"input": 1.0, "cache_hit": 0.02, "output": 4.0})
        self.assertEqual([m["factor"] for m in o["rules"]["multipliers"]], [2.0, 2.0])
        self.assertFalse(o["rules"]["weekday_guard"])
        self.assertEqual(o["rules"]["group_ratio"], {"default": 1, "gc-chat": 0.6})

    def test_per_token_ratio(self):
        offers = {o["model_id"]: o for o in
                  ps.parse_provider_c_docs(DUOYUAN_PRICING, DUOYUAN_RATIO,
                                         {"model_b2": "x", "model_d1": "x"})}
        glm = offers["model_b2"]
        self.assertEqual(ps.price_value(glm, "input"), 0.8)       # 0.4 × 2
        self.assertEqual(ps.price_value(glm, "output"), 2.8)      # 0.8 × 3.5
        self.assertEqual(ps.price_value(glm, "cache_hit"), 0.2)   # 0.8 × 0.25
        kimi = offers["model_d1"]
        self.assertEqual(ps.price_value(kimi, "input"), 20.0)     # 10 × 2
        self.assertEqual(ps.price_value(kimi, "output"), 100.0)   # 20 × 5

    def test_absent_model_is_not_priced(self):
        offers = {o["model_id"]: o for o in
                  ps.parse_provider_c_docs(DUOYUAN_PRICING, DUOYUAN_RATIO, {"model_c2": "x"})}
        self.assertEqual(offers["model_c2"]["billing"], "absent")
        self.assertIsNone(offers["model_c2"]["price"])


class TestUpstreamBParse(unittest.TestCase):
    def test_periodic_prices(self):
        offers = {o["model_id"]: o for o in
                  ps.parse_provider_d_page(ps.strip_html(SF_PAGE),
                                            {"org/Model_A3": "x"})}
        o = offers["org/Model_A3"]
        self.assertEqual(o["price"]["input"], {"peak": 2.0, "offpeak": 1.0})
        self.assertEqual(o["price"]["output"], {"peak": 8.0, "offpeak": 4.0})
        self.assertEqual(o["price"]["cache_hit"], {"peak": 0.04, "offpeak": 0.02})

    def test_flat_prices_and_prefix_collision(self):
        """Model_B1 不得串到 Model_B2 的价格（前缀陷阱）。"""
        offers = {o["model_id"]: o for o in
                  ps.parse_provider_d_page(ps.strip_html(SF_PAGE), {
                      "org/Model_B2": "x",
                      "org/Model_B1": "x",
                      "org/Model_C1": "x"})}
        flash = offers["org/Model_B2"]
        self.assertEqual(ps.price_value(flash, "input"), 0.8)
        self.assertEqual(ps.price_value(flash, "cache_hit"), 0.23)
        full = offers["org/Model_B1"]
        self.assertEqual(ps.price_value(full, "input"), 8.0)
        self.assertEqual(ps.price_value(full, "output"), 28.0)
        qwen = offers["org/Model_C1"]
        self.assertEqual(ps.price_value(qwen, "input"), 3.0)
        self.assertEqual(ps.price_value(qwen, "output"), 12.0)

    def test_unknown_model_recorded_absent(self):
        """页面未列到 / 结构解析不到 ⇒ 记 absent（不猜价），且不污染同页其他模型。

        2026-11-19 口径（``scripts/price_sync.py:334-335/389-392``）：单个模型不在页面
        或结构异常只记 absent，**不再抛 AdapterError 拖垮整批**。
        absent 三件套＝``billing == "absent"``、``price is None``、``meta.confidence == 0.0``。
        """
        offers = {o["model_id"]: o for o in
                  ps.parse_provider_d_page(ps.strip_html(SF_PAGE),
                                            {"nope/none": "x",
                                             "org/Model_C1": "x"})}
        absent = offers["nope/none"]
        self.assertEqual(absent["billing"], "absent")
        self.assertIsNone(absent["price"])
        self.assertEqual(absent["meta"]["confidence"], 0.0)
        self.assertEqual(absent["rules"], {})
        # absent 不污染同页已知模型：org/Model_C1 仍正常解析（billing=per_token）
        known = offers["org/Model_C1"]
        self.assertEqual(known["billing"], "per_token")
        self.assertEqual(ps.price_value(known, "input"), 3.0)
        self.assertEqual(ps.price_value(known, "output"), 12.0)


if __name__ == "__main__":
    unittest.main()
