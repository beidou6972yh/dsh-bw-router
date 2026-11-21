#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一显示规则单测：`供应商/模型标签/¥入/出`（用户 2026-11-17 定）。

不联网、不读账本；只验格式与「缺价不猜价」的口径：
  - 两侧价齐全 ⇒ 三段式带 `¥入/出`（两个数，缓存价不进 label）；
  - 任一侧缺价 ⇒ 退回两段式 `供应商/模型标签`，不写 0、不写半边价；
  - provider/label 缺失 ⇒ `?` 占位，段数恒定便于机器解析；
  - 0 元是**显式配置**（本地/免费），必须原样显示 `¥0/0`，不得被吞成无价。

运行：
    cd <网关树根>
    python3 -m unittest tests.test_display_label -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as router  # noqa: E402


class TestDisplayLabel(unittest.TestCase):
    def test_three_segments_with_two_prices(self):
        self.assertEqual(router.display_label("provider_c", "Model_B2", 0.8, 2.8),
                         "provider_c/Model_B2/¥0.800/2.800")
        self.assertEqual(router.display_label("provider_d", "Model_A3", 2, 8),
                         "provider_d/Model_A3/¥2.000/8.000")

    def test_cache_price_not_in_label(self):
        """label 只放入/出两个数；缓存价留给比价表。"""
        label = router.display_label("provider_a", "Flash", 1, 4)
        self.assertEqual(label.count("¥"), 1)
        self.assertEqual(label.split("/¥")[1], "1.000/4.000")

    def test_missing_price_falls_back_to_two_segments(self):
        for pin, pout in ((None, 4), (1, None), (None, None), ("1", 4), (True, 4)):
            with self.subTest(pin=pin, pout=pout):
                self.assertEqual(router.display_label("provider_i", "Qwen4-Max", pin, pout),
                                 "provider_i/Qwen4-Max")

    def test_explicit_zero_is_kept(self):
        self.assertEqual(router.display_label("provider_b", "model_b3", 0, 0),
                         "provider_b/model_b3/¥0.000/0.000")

    def test_placeholders_keep_segment_count(self):
        self.assertEqual(router.display_label(None, None, 1, 2), "?/?/¥1.000/2.000")
        self.assertEqual(router.display_label("", "  ", None, None), "?/?")

    def test_payloads_carry_display_label(self):
        caps = router.capabilities_payload()
        self.assertTrue(caps["models"])
        for entry in caps["models"]:
            label = entry.get("display_label")
            self.assertIsInstance(label, str, entry["id"])
            self.assertTrue(label.startswith(f"{entry['provider'] or '?'}/"), entry["id"])
        prices = router.price_catalog_payload()
        for row in prices["models"]:
            self.assertIn("display_label", row)
        models = router.models_payload()
        for row in models["data"]:
            if "/" in row["id"] and not row["id"].startswith("auto"):
                self.assertIn("display_label", row)


if __name__ == "__main__":
    unittest.main()
