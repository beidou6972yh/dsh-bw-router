#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Q2-3：learnedOverride 的档位隔离 / 来源字段 / 能力守卫 / 忽略开关（不联网、不写生产配置）。"""
from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import router_strategies as rstrat  # noqa: E402
import router_plan  # noqa: E402


class LearnedOverrideTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="learned-test-")
        Path(self.tmp, "config").mkdir(parents=True)
        self.fake = types.SimpleNamespace(BASE_DIR=self.tmp)
        self._old = rstrat._GATEWAY
        rstrat.set_gateway(self.fake)
        rstrat._CACHE.update(key=None, doc=None)
        (Path(self.tmp, "config", "router-strategies.json")).write_text(json.dumps({
            "version": 1, "cost": {"L1": ["a/x"]}, "capability": {"L1": ["a/x"]},
            "function": {}, "learned_overrides": {}
        }), encoding="utf-8")
        self._orig_allowed = rstrat._allowed_models
        rstrat._allowed_models = lambda: {"a/x", "b/y"}

    def tearDown(self):
        rstrat._allowed_models = self._orig_allowed
        rstrat.set_gateway(self._old)

    def test_exact_stage_only(self):
        rstrat.upsert_learned_override("cost", "reasoning", "a/x",
                                       stage_key="cheap", tier="cheap", principal="k1")
        self.assertIsNotNone(rstrat.get_learned_override("cost", "reasoning", stage_key="cheap"))
        self.assertIsNone(rstrat.get_learned_override("cost", "reasoning", stage_key="strong"))

    def test_legacy_row_is_marked(self):
        doc = json.loads(Path(self.tmp, "config", "router-strategies.json").read_text())
        doc["learned_overrides"] = {"cost": {"reasoning": {"model": "a/x"}}}
        Path(self.tmp, "config", "router-strategies.json").write_text(json.dumps(doc))
        rstrat._CACHE.update(key=None, doc=None)
        row = rstrat.get_learned_override("cost", "reasoning", stage_key="strong")
        self.assertIsNotNone(row)
        self.assertTrue(row.get("legacy"))

    def test_upsert_persists_provenance(self):
        row = rstrat.upsert_learned_override("function", "coding", "a/x", function="coding",
                                             stage_key="strong", tier="strong", principal="k2")
        self.assertEqual(row["stage_key"], "strong")
        self.assertEqual(row["tier"], "strong")
        self.assertEqual(row["principal"], "k2")

    def test_counter_key_has_stage(self):
        a = router_plan._counter_key("cost", "cheap", "reasoning", "")
        b = router_plan._counter_key("cost", "strong", "reasoning", "")
        self.assertNotEqual(a, b)

    def test_guard_rejects_non_vision_and_downgrade(self):
        text_model = {"modality": ["text"], "tier": "strong", "context_window": 100000}
        self.assertEqual(router_plan._override_guard(text_model, "vision", 100,
                                                     {"stage_key": "strong"}, "strong"),
                         "capability_unmet")
        cheap = {"modality": ["text", "vision"], "tier": "cheap", "context_window": 100000}
        self.assertEqual(router_plan._override_guard(cheap, "reasoning", 100,
                                                     {"legacy": True}, "L3", chain_tier="strong"),
                         "tier_mismatch")
        self.assertIsNone(router_plan._override_guard(text_model, "reasoning", 100, {}, "strong"))


if __name__ == "__main__":
    unittest.main()
