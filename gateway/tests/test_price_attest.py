#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""L5 单源化（1.0.3.1 S1）单元测试：派生折叠 / 别名 / 类型垫片 / 开关回退 / 自证负载。

设计约束（与 run-tests.sh 两段口径一致）：
- **配置无关**：全部用合成 offer/集合，不读 config/pricebook.json —— 第一段临时树没有 pricebook，
  两段 `Ran` 数必须相等（run-tests.sh 会把不等判成 exit 5）；
- 不联网、不起端口、不写盘；不触发 stall-notify（打桩 `ROUTER_PRICE_NOTIFY=0`）；
- 注入 `CAPABILITY_META_MODELS` 的用例一律 setUp/tearDown 还原。

覆盖（15 例）：
1–4  值集合折叠（单值/两值/>2 值/空集）
5–8  offer 派生（flat / 两档 / expr 乘数 / 坏报价）
9–10 别名解析（链式 / 环终止）
11–12 类型垫片（沿用 legacy 表示 / 数值不同不垫）
13–14 单源开关（默认开、0 回退 meta）
15   自证负载结构（attest 开关）

运行：python3 -m unittest discover -s tests -p 'test_price_attest.py' -v
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw  # noqa: E402

PRICE_KEYS = ("input_per_mtok", "output_per_mtok", "cache_hit_input_per_mtok")


class FoldSetsCase(unittest.TestCase):
    """值集合 → 两档块的折叠规则。"""

    def test_single_value_folds_to_equal_slots(self):
        folded, errors = gw._fold_price_sets({"input": {2.0}, "output": {8.0}})
        self.assertEqual(folded["input"], {"peak": 2, "offpeak": 2})
        self.assertEqual(folded["output"], {"peak": 8, "offpeak": 8})
        self.assertEqual(errors, [])

    def test_two_values_maps_max_to_peak(self):
        folded, errors = gw._fold_price_sets({"input": {1.0, 2.0}})
        self.assertEqual(folded["input"], {"peak": 2, "offpeak": 1})
        self.assertEqual(errors, [])

    def test_three_values_is_error_not_hard_folded(self):
        folded, errors = gw._fold_price_sets({"input": {1.0, 2.0, 3.0}})
        self.assertIsNone(folded["input"])
        self.assertTrue(any("input" in item for item in errors), errors)

    def test_empty_sets_fold_to_none(self):
        folded, errors = gw._fold_price_sets({})
        for key in ("input", "output", "cache_hit"):
            self.assertIsNone(folded[key])
        self.assertEqual(errors, [])


class DeriveFromOfferCase(unittest.TestCase):
    """offer → capability 价格块（与生产同一采样/折叠实现）。"""

    def test_flat_offer_folds_both_slots(self):
        offer = {"billing": "per_token",
                 "price": {"input": {"flat": 9.0}, "output": {"flat": 30.0}},
                 "rules": {}}
        block, errors = gw._derive_block_from_offer(offer)
        self.assertIsNotNone(block)
        self.assertEqual(block["input_per_mtok"], {"peak": 9, "offpeak": 9})
        self.assertEqual(block["output_per_mtok"], {"peak": 30, "offpeak": 30})
        self.assertIsNone(block["cache_hit_input_per_mtok"])
        self.assertEqual(errors, [])

    def test_two_tier_offer_keeps_peak_offpeak(self):
        offer = {"billing": "per_token",
                 "price": {"input": {"peak": 2.0, "offpeak": 1.0},
                           "output": {"peak": 8.0, "offpeak": 4.0},
                           "cache_hit": {"peak": 0.04, "offpeak": 0.02}},
                 "rules": {"schedule": {"kind": "peak_windows",
                                        "weekdays": [1, 2, 3, 4, 5],
                                        "windows": [["09:00", "12:00"], ["14:00", "18:00"]],
                                        "holidays_off": True}}}
        block, errors = gw._derive_block_from_offer(offer)
        self.assertEqual(block["input_per_mtok"], {"peak": 2, "offpeak": 1})
        self.assertEqual(block["output_per_mtok"], {"peak": 8, "offpeak": 4})
        self.assertEqual(block["cache_hit_input_per_mtok"], {"peak": 0.04, "offpeak": 0.02})
        self.assertEqual(errors, [])

    def test_expr_offer_uses_multipliers(self):
        multipliers = [{"when": "hour in [14,18)", "factor": 2.0},
                       {"when": "hour in [9,12)", "factor": 2.0}]
        offer = {"billing": "expr",
                 "price": {"base": {"input": 1.0, "output": 4.0}},
                 "rules": {"schedule": {"kind": "multipliers", "multipliers": multipliers,
                                        "weekday_guard": False},
                           "multipliers": multipliers, "weekday_guard": False}}
        block, errors = gw._derive_block_from_offer(offer)
        self.assertEqual(block["input_per_mtok"], {"peak": 2, "offpeak": 1})
        self.assertEqual(block["output_per_mtok"], {"peak": 8, "offpeak": 4})
        self.assertEqual(errors, [])

    def test_bad_offer_returns_none(self):
        block, errors = gw._derive_block_from_offer({"billing": "per_token", "price": {}, "rules": {}})
        self.assertIsNone(block)
        self.assertTrue(errors)


class AliasCase(unittest.TestCase):
    """别名只在派生层解析（不复制 offer）。"""

    def test_alias_chain_resolution(self):
        aliases = {"a/x": "b/y", "b/y": "c/z"}
        self.assertEqual(gw.resolve_price_candidate("a/x", aliases), "c/z")

    def test_alias_cycle_terminates(self):
        cycle = {"a/x": "b/y", "b/y": "a/x"}
        resolved = gw.resolve_price_candidate("a/x", cycle)
        self.assertIsInstance(resolved, str)
        self.assertIn(resolved, cycle)          # 环上任意点都行，关键是不无限循环
        self.assertEqual(gw.resolve_price_candidate("plain/model", cycle), "plain/model")


class TypeShimCase(unittest.TestCase):
    """双写期类型垫片：值不变，仅沿用 legacy 的 int/float 表示。"""

    def test_shim_adopts_legacy_representation(self):
        derived = {"currency": "CNY", "input_per_mtok": {"peak": 0, "offpeak": 0}}
        legacy = {"currency": "CNY", "input_per_mtok": {"peak": 0.0, "offpeak": 0.0}}
        out = gw._shim_number_types(derived, legacy)
        self.assertEqual(out["input_per_mtok"], {"peak": 0.0, "offpeak": 0.0})
        self.assertIsInstance(out["input_per_mtok"]["peak"], float)

    def test_shim_keeps_derived_when_value_differs(self):
        derived = {"currency": "CNY", "input_per_mtok": {"peak": 6, "offpeak": 3}}
        legacy = {"currency": "CNY", "input_per_mtok": {"peak": 5, "offpeak": 4}}
        out = gw._shim_number_types(derived, legacy)
        self.assertEqual(out["input_per_mtok"], {"peak": 6, "offpeak": 3})
        self.assertIsInstance(out["input_per_mtok"]["peak"], int)


class SwitchCase(unittest.TestCase):
    """ROUTER_PRICE_SINGLE_SOURCE 开关语义 + meta 兜底。"""

    def setUp(self):
        self._saved_env = {key: os.environ.get(key) for key in
                           (gw.PRICE_SINGLE_SOURCE_ENV, gw.PRICE_ATTEST_ENV, "ROUTER_PRICE_NOTIFY")}
        os.environ["ROUTER_PRICE_NOTIFY"] = "0"      # 测试不触发 stall-notify
        self._probe = "unit-test/l5-probe"
        self._saved_meta = dict(gw.CAPABILITY_META_MODELS)

    def tearDown(self):
        gw.CAPABILITY_META_MODELS.clear()
        gw.CAPABILITY_META_MODELS.update(self._saved_meta)
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_switch_default_on_and_off_values(self):
        os.environ.pop(gw.PRICE_SINGLE_SOURCE_ENV, None)
        self.assertTrue(gw.price_single_source_enabled())
        for raw in ("0", "false", "no", "off"):
            os.environ[gw.PRICE_SINGLE_SOURCE_ENV] = raw
            self.assertFalse(gw.price_single_source_enabled(), raw)
        for raw in ("1", "true", "yes", "on"):
            os.environ[gw.PRICE_SINGLE_SOURCE_ENV] = raw
            self.assertTrue(gw.price_single_source_enabled(), raw)

    def test_disabled_switch_keeps_meta_price(self):
        gw.CAPABILITY_META_MODELS[self._probe] = {
            "provider": "unit-test", "tier": "cheap",
            "price": {"currency": "CNY",
                      "input_per_mtok": {"peak": 5, "offpeak": 3},
                      "output_per_mtok": {"peak": 9, "offpeak": 7},
                      "cache_hit_input_per_mtok": {"peak": 0, "offpeak": 0}},
        }
        os.environ[gw.PRICE_SINGLE_SOURCE_ENV] = "0"
        entry = gw.capability_model_entry(self._probe)
        self.assertEqual(entry["price"]["input_per_mtok"], {"peak": 5, "offpeak": 3})
        self.assertEqual(entry["price"]["output_per_mtok"], {"peak": 9, "offpeak": 7})

    def test_meta_without_pricebook_source_is_null_when_switch_on(self):
        gw.CAPABILITY_META_MODELS[self._probe] = {"provider": "unit-test", "tier": "cheap"}
        os.environ[gw.PRICE_SINGLE_SOURCE_ENV] = "1"
        entry = gw.capability_model_entry(self._probe)
        self.assertIsNone(entry["price"])

    def test_attest_payload_is_self_contained(self):
        os.environ[gw.PRICE_ATTEST_ENV] = "1"
        payload = gw.price_consistency_payload()
        self.assertEqual(payload.get("mode"), "single-source")
        for key in ("status", "status_rule", "source", "coverage", "legacy",
                    "orphan_offers", "roster", "fold_errors"):
            self.assertIn(key, payload)
        coverage = payload.get("coverage") or {}
        self.assertIn("classes", coverage)
        self.assertIn("unsourced", coverage)
        self.assertIn(payload.get("status"), ("consistent", "mismatch"))


class SingleSourcePrecedenceCase(unittest.TestCase):
    """单源开启时：价格数字来自 pricebook 派生，注入的 meta 假价必须被忽略（不猜价）。"""

    def setUp(self):
        self._saved_env = {key: os.environ.get(key)
                           for key in (gw.PRICE_SINGLE_SOURCE_ENV, "ROUTER_PRICE_NOTIFY")}
        os.environ["ROUTER_PRICE_NOTIFY"] = "0"
        self._saved_meta = dict(gw.CAPABILITY_META_MODELS)

    def tearDown(self):
        gw.CAPABILITY_META_MODELS.clear()
        gw.CAPABILITY_META_MODELS.update(self._saved_meta)
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_single_source_overrides_meta_numbers_when_offer_exists(self):
        candidate = next((item for item in sorted(gw.CAPABILITY_META_MODELS)
                          if gw.pricebook_offer(item) is not None
                          and gw.resolve_price_candidate(item) == item
                          and gw._supplement_patch(item) is None), None)
        if candidate is None:
            self.skipTest("当前配置无可用 pricebook 报价（配置无关套件的主段就是这样）")
        expected, errors = gw._derive_block_from_offer(gw.pricebook_offer(candidate))
        self.assertIsNotNone(expected)
        self.assertEqual(errors, [])
        fake = {"currency": "CNY",
                "input_per_mtok": {"peak": 999, "offpeak": 999},
                "output_per_mtok": {"peak": 999, "offpeak": 999},
                "cache_hit_input_per_mtok": {"peak": 999, "offpeak": 999}}
        gw.CAPABILITY_META_MODELS[candidate] = {"price": fake}
        os.environ[gw.PRICE_SINGLE_SOURCE_ENV] = "1"
        entry = gw.capability_model_entry(candidate)
        for key in PRICE_KEYS:
            exp_block = expected.get(key)
            got_block = entry["price"].get(key)
            if isinstance(exp_block, dict):
                self.assertIsInstance(got_block, dict, key)
                self.assertEqual({slot: float(val) for slot, val in got_block.items()},
                                 {slot: float(val) for slot, val in exp_block.items()}, key)
                self.assertNotEqual(got_block.get("peak"), 999, (key, "meta 假价不得回流"))
            else:
                self.assertIsNone(got_block, key)


if __name__ == "__main__":
    unittest.main(verbosity=2)
