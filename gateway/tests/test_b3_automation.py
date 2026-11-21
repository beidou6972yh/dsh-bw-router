#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B3 自动化档位（1.0.3.2 T3）单元测试：映射表 / plan 只读 automation 块 / 默认 L1 零差异 / 非法值。

配置无关、不写盘、不起端口。
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw  # noqa: E402  （导入即完成 router_plan.set_gateway）
import router_plan  # noqa: E402

PAYLOAD = {"task": "写一句话说明模型路由", "max_stages": 2}


class AutomationMappingCase(unittest.TestCase):
    def test_levels_are_one_to_one(self):
        levels = router_plan.automation_levels()
        self.assertEqual(levels["default"], "L1")
        self.assertEqual(levels["advanced_entry"], "strategy")
        keys = [item["level"] for item in levels["levels"]]
        self.assertEqual(keys, ["L1", "L2", "L3"])
        labels = [item["label"] for item in levels["levels"]]
        self.assertEqual(labels, ["严格", "知会", "草稿"])
        self.assertEqual(len(set(keys)), 3)

    def test_normalize_aliases(self):
        for raw, want in (("L2", "L2"), ("l2", "L2"), ("知会", "L2"),
                          ("L1", "L1"), ("L3", "L3"), ("草稿", "L3")):
            self.assertEqual(router_plan._normalize_automation_level(raw), want, raw)
        for raw in (None, "", "L9", "全自动", True):
            self.assertIsNone(router_plan._normalize_automation_level(raw), raw)


class AutomationPlanCase(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get(router_plan.B3_ENV)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(router_plan.B3_ENV, None)
        else:
            os.environ[router_plan.B3_ENV] = self._saved

    def test_plan_without_level_has_no_automation_block(self):
        os.environ.pop(router_plan.B3_ENV, None)
        plan, status = router_plan.build_plan(dict(PAYLOAD))
        self.assertEqual(status, 200, plan)
        self.assertNotIn("automation", plan)

    def test_plan_L2_has_expected_flags(self):
        os.environ.pop(router_plan.B3_ENV, None)
        plan, status = router_plan.build_plan({**PAYLOAD, "automation_level": "L2"})
        self.assertEqual(status, 200, plan)
        automation = plan.get("automation") or {}
        self.assertEqual(automation.get("level"), "L2")
        self.assertEqual(automation.get("label"), "知会")
        self.assertFalse(automation.get("confirm_required"))
        self.assertTrue(automation.get("auto_execute"))
        self.assertFalse(automation.get("draft"))
        self.assertEqual(automation.get("advanced_entry"), "strategy")
        # 档位不改变选模结果：model 与不带档位时一致
        base, _ = router_plan.build_plan(dict(PAYLOAD))
        self.assertEqual([s["model"]["key"] for s in plan["stages"]],
                         [s["model"]["key"] for s in base["stages"]])

    def test_explicit_L1_returns_block_but_keeps_current_semantics(self):
        os.environ.pop(router_plan.B3_ENV, None)
        plan, status = router_plan.build_plan({**PAYLOAD, "automation_level": "L1"})
        self.assertEqual(status, 200, plan)
        automation = plan.get("automation") or {}
        self.assertEqual(automation.get("level"), "L1")
        self.assertTrue(automation.get("confirm_required"))
        self.assertFalse(automation.get("auto_execute"))

    def test_invalid_level_is_400(self):
        os.environ.pop(router_plan.B3_ENV, None)
        body, status = router_plan.build_plan({**PAYLOAD, "automation_level": "全自动"})
        self.assertEqual(status, 400)
        self.assertEqual(body.get("code"), "bad_automation_level")
        self.assertEqual(body.get("allowed"), ["L1", "L2", "L3"])

    def test_disabled_switch_ignores_level(self):
        os.environ[router_plan.B3_ENV] = "0"
        plan, status = router_plan.build_plan({**PAYLOAD, "automation_level": "L2"})
        self.assertEqual(status, 200, plan)
        self.assertNotIn("automation", plan)
        body, status = router_plan.build_plan({**PAYLOAD, "automation_level": "全自动"})
        self.assertEqual(status, 200, body)
        self.assertNotIn("automation", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
