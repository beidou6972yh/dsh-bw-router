#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""推荐策略（recommend）单元测试（2026-11-17 用户令）。

覆盖：
  - price（默认，价格优先）：本地 0 元最优先；同档按有效单价升序；价未知垫底（不猜价）；
  - capability（能力优先）：strong → mid → cheap；同档内价格升序；
  - preset（预设功能）：功能对口优先，同组内按价格；
  - 覆盖层：策略文件 recommend 节非空时优先，实时计算兜底；
  - chain("recommend", ...) 与 normalize 往返（recommend 节保存/清空）。

运行：python3 -m unittest tests.test_recommend -v（在 run-tests.sh 临时树内）
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import router_strategies as rstrat  # noqa: E402


class _FakeUpstream:
    def __init__(self, up_id: str, models: list[str]):
        self.id = up_id
        self.models = {m: {} for m in models}


class _FakeGateway:
    """最小网关替身：CAPABILITY_META_MODELS + pricebook_offer（内存价目）。"""

    BASE_DIR = str(Path(tempfile.mkdtemp(prefix="gw-test-")))
    CONFIG = {}

    UPSTREAMS = [
        _FakeUpstream("provider_b", ["model_b3", "exec-35b"]),
        _FakeUpstream("provider_a", ["model_a1", "model_a5"]),
        _FakeUpstream("provider_c", ["model_b1", "model_b2", "model_d2"]),
        _FakeUpstream("provider_i", ["dmodel"]),
    ]

    CAPABILITY_META_MODELS = {
        "provider_b/model_b3": {"tier": "cheap"},
        "provider_b/exec-35b": {"tier": "cheap"},
        "provider_a/model_a1": {"tier": "cheap"},
        "provider_a/model_a5": {"tier": "strong"},
        "provider_c/model_b1": {"tier": "strong"},
        "provider_c/model_b2": {"tier": "cheap"},
        "provider_c/model_d2": {"tier": "strong"},
        "provider_i/dmodel": {"tier": "mid"},
    }

    PRICES = {  # candidate → (input, output) 有效价，元/百万 tokens
        "provider_b/model_b3": (0.0, 0.0),
        "provider_b/exec-35b": (0.0, 0.0),
        "provider_a/model_a1": (1.0, 4.0),
        "provider_a/model_a5": (4.5, 13.5),
        "provider_c/model_b1": (8.0, 28.0),
        "provider_c/model_b2": (0.8, 2.8),
        "provider_c/model_d2": (13.0, 68.0),
        # provider_i/dmodel：价未知（不猜价）
    }

    def pricebook_offer(self, candidate: str):
        prices = self.PRICES.get(candidate)
        if prices is None:
            return None
        return {"id": candidate, "provider": candidate.split("/")[0],
                "price": {"input": {"offpeak": prices[0]}, "output": {"offpeak": prices[1]}}}


def _stage_chain():
    return ["provider_i/dmodel", "provider_a/model_a1", "provider_b/model_b3",
            "provider_a/model_a5", "provider_c/model_b1", "provider_c/model_d2",
            "provider_c/model_b2"]


class TestRecommendChain(unittest.TestCase):
    def setUp(self):
        self.gw = _FakeGateway()
        self._old = rstrat._GATEWAY
        rstrat._GATEWAY = self.gw
        rstrat._CACHE.update(key=None, doc=None)

    def tearDown(self):
        rstrat._GATEWAY = self._old

    def test_price_mode_local_first_then_cheap(self):
        """价格优先（默认）：本地 0 元最优先，之后按有效单价升序；价未知垫底不参与排序（不猜价）。"""
        rstrat._write_doc({"version": 1, "cost": {"offpeak": {"L2": _stage_chain()}}, "recommend": {}})
        got = rstrat.recommend_chain("L2", "offpeak", "price")
        self.assertEqual(got[0], "provider_b/model_b3", "本地 0 元模型必须最优先")
        self.assertEqual(got[1], "provider_c/model_b2", "0.8+2.8=3.6 次便宜")
        self.assertEqual(got[2], "provider_a/model_a1", "1.0+4.0=5.0")
        self.assertEqual(got[-1], "provider_i/dmodel", "价未知模型垫底（不猜价、不丢弃）")
        known = [c for c in got if rstrat._recommend_rank(c)[0] == 0]
        prices = [rstrat._recommend_rank(c)[1] for c in known]
        self.assertEqual(prices, sorted(prices), "已知价模型必须按单价升序")

    def test_capability_mode_strong_first(self):
        """能力优先：strong → mid → cheap；同档内价格升序。"""
        rstrat._write_doc({"version": 1, "capability": {"L2": _stage_chain()}, "recommend": {}})
        got = rstrat.recommend_chain("L2", "offpeak", "capability")
        tiers = [self.gw.CAPABILITY_META_MODELS[c].get("tier") for c in got]
        self.assertEqual(tiers, sorted(tiers, key=lambda t: rstrat._recommend_tier_rank(t)),
                         "档位必须 strong → mid → cheap")
        self.assertEqual(got[0], "provider_a/model_a5", "strong 内最便宜优先")

    def test_preset_mode_function_first(self):
        """预设功能：功能对口优先（功能链里有的排前），同组内按价格。"""
        rstrat._write_doc({"version": 1, "cost": {"offpeak": {"L2": _stage_chain()}},
                           "function": {"L2": ["provider_c/model_d2"]}, "recommend": {}})
        got = rstrat.recommend_chain("L2", "offpeak", "preset")
        self.assertEqual(got[0], "provider_c/model_d2", "功能对口排最前")
        rest = [sum(rstrat._recommend_rank(c)) for c in got[1:]]
        self.assertEqual(rest, sorted(rest), "同组内仍按价格")

    def test_saved_override_wins(self):
        """覆盖层：recommend 节非空时优先，实时计算兜底。"""
        rstrat._write_doc({"version": 1, "cost": {"offpeak": {"L2": _stage_chain()}},
                           "recommend": {"L2": ["provider_c/model_b1"]}})
        got = rstrat.chain("recommend", "L2", "offpeak")
        self.assertEqual(got, ["provider_c/model_b1"], "保存的覆盖链必须优先")

    def test_normalize_roundtrip(self):
        """normalize 往返：recommend 节保存/清空（空链=清掉覆盖层）。"""
        cap = {s: _stage_chain() for s in rstrat.STAGES}
        raw = {"cost": {"peak": cap, "offpeak": cap},
               "capability": {"L2": _stage_chain()},
               "recommend": {"L2": ["provider_c/model_b1", "provider_c/model_b1"]}}
        doc, errors = rstrat.normalize(raw)
        self.assertEqual(errors, [])
        self.assertEqual(doc["recommend"]["L2"], ["provider_c/model_b1"], "去重保序")
        doc, errors = rstrat.normalize({"cost": {"peak": cap, "offpeak": cap},
                                        "capability": {"L2": _stage_chain()},
                                        "recommend": {"L2": []}})
        self.assertEqual(errors, [])
        self.assertNotIn("L2", doc["recommend"], "空链=清掉覆盖层（回到实时计算）")

    def test_chain_recommend_no_saved(self):
        """chain("recommend", ...) 无覆盖层 → 实时计算。"""
        rstrat._write_doc({"version": 1, "cost": {"offpeak": {"L2": _stage_chain()}}, "recommend": {}})
        got = rstrat.chain("recommend", "L2", "offpeak")
        self.assertTrue(got)
        self.assertEqual(got[0], "provider_b/model_b3")

    def test_bad_mode_falls_to_default(self):
        """mode 非法 → 回默认 price。"""
        rstrat._write_doc({"version": 1, "cost": {"offpeak": {"L2": _stage_chain()}}, "recommend": {}})
        got = rstrat.recommend_chain("L2", "offpeak", "nonsense")
        self.assertEqual(got[0], "provider_b/model_b3")


if __name__ == "__main__":
    unittest.main()
