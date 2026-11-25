#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""1.0.3.10 #5：价格三态必须单一真源。

现网缺陷：main.price_state_of 与 router_plan._price_state_for 各判一遍，
口径可能漂移。本测试要求两条路径都委托同一个共享模块 price_state.py。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class TestPriceStateSingleSource(unittest.TestCase):
    def test_shared_module_is_single_source(self):
        import price_state
        self.assertEqual(price_state.state_of("provider_b/llama-x", None, {}), "local")
        self.assertEqual(price_state.state_of("ds/deepseek", "deepseek",
                         {"input_per_mtok": 1}), "priced")
        self.assertEqual(price_state.state_of("ds/deepseek", "deepseek", {}), "unpriced")

    def test_main_delegates_to_shared(self):
        import main
        import price_state
        cases = [("provider_b/llama-x", None, {}),
                 ("ds/deepseek", "deepseek", {"input_per_mtok": 1}),
                 ("ds/deepseek", "deepseek", {})]
        for c, p, b in cases:
            self.assertEqual(main.price_state_of(c, p, b),
                             price_state.state_of(c, p, b), (c, p, b))

    def test_router_plan_delegates_to_shared(self):
        import router_plan
        import price_state
        cases = [{"id": "provider_b/llama-x", "provider": None},
                 {"id": "ds/deepseek", "provider": "deepseek",
                  "price": {"input_per_mtok": 1}},
                 {"id": "ds/deepseek", "provider": "deepseek"}]
        for info in cases:
            self.assertEqual(router_plan._price_state_for(info),
                             price_state.state_of(info.get("id"), info.get("provider"),
                                                  info.get("price", {})), info)


if __name__ == "__main__":
    unittest.main()
