#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B1 边界纪律（1.0.3.2 T2）单元测试：plan 只读字段 / 同轮换模记账 / discipline 只读聚合。

配置无关：不读 pricebook；写盘只写 /tmp（monkeypatch annotations_path）；
不联网、不起端口；不依赖真实时钟（turn 状态每次 setUp 清空）。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw  # noqa: E402  （导入即完成 router_plan.set_gateway）
import router_plan  # noqa: E402


class B1HelperCase(unittest.TestCase):
    """纯函数层：开关/策略/同轮判定。"""

    def setUp(self):
        self._saved = os.environ.get(router_plan.B1_ENV)
        router_plan._TURN_STATE.clear()

    def tearDown(self):
        router_plan._TURN_STATE.clear()
        if self._saved is None:
            os.environ.pop(router_plan.B1_ENV, None)
        else:
            os.environ[router_plan.B1_ENV] = self._saved

    def test_switch_default_on_and_off_values(self):
        os.environ.pop(router_plan.B1_ENV, None)
        self.assertTrue(router_plan.b1_enabled())
        for raw in ("0", "false", "no", "off"):
            os.environ[router_plan.B1_ENV] = raw
            self.assertFalse(router_plan.b1_enabled(), raw)
        for raw in ("1", "true", "yes", "on"):
            os.environ[router_plan.B1_ENV] = raw
            self.assertTrue(router_plan.b1_enabled(), raw)

    def test_boundary_policy_shape(self):
        policy = router_plan.boundary_policy()
        self.assertEqual(policy["switch_on"], ["new_user_message", "context_rebuild"])
        self.assertTrue(policy["tool_turns_frozen"])

    def test_same_turn_tool_switch_is_violation(self):
        ctx = {"turn_id": "t-b1-1", "tool_turn": True}
        self.assertIsNone(router_plan._discipline_check(ctx, "up/a", "p1", "s1"))
        violation = router_plan._discipline_check(ctx, "up/b", "p1", "s2")
        self.assertIsInstance(violation, dict)
        self.assertEqual(violation["rule"], "same_turn_model_frozen")
        self.assertEqual(violation["prev_model"], "up/a")
        self.assertEqual(violation["model"], "up/b")

    def test_same_model_is_not_violation(self):
        ctx = {"turn_id": "t-b1-2", "tool_turn": True}
        router_plan._discipline_check(ctx, "up/a", "p1", "s1")
        self.assertIsNone(router_plan._discipline_check(ctx, "up/a", "p1", "s2"))

    def test_new_message_allows_switch(self):
        router_plan._discipline_check({"turn_id": "t-b1-3", "tool_turn": False},
                                      "up/a", "p1", "s1")
        self.assertIsNone(router_plan._discipline_check(
            {"turn_id": "t-b1-3", "tool_turn": False}, "up/b", "p1", "s1"))

    def test_context_rebuild_allows_switch(self):
        router_plan._discipline_check({"turn_id": "t-b1-4", "tool_turn": True},
                                      "up/a", "p1", "s1")
        self.assertIsNone(router_plan._discipline_check(
            {"turn_id": "t-b1-4", "tool_turn": True, "context_rebuilt": True},
            "up/b", "p1", "s2"))

    def test_turn_state_isolated_between_turns(self):
        router_plan._discipline_check({"turn_id": "t-b1-5a", "tool_turn": True},
                                      "up/a", "p1", "s1")
        self.assertIsNone(router_plan._discipline_check(
            {"turn_id": "t-b1-5b", "tool_turn": True}, "up/b", "p1", "s1"))

    def test_switch_off_disables_check(self):
        os.environ[router_plan.B1_ENV] = "0"
        ctx = {"turn_id": "t-b1-6", "tool_turn": True}
        router_plan._discipline_check(ctx, "up/a", "p1", "s1")
        self.assertIsNone(router_plan._discipline_check(ctx, "up/b", "p1", "s1"))

    def test_exempt_reason_is_recorded(self):
        """治理/守门导致的换模：仍记录，但带 exempt，判据只看非豁免计数。"""
        ctx = {"turn_id": "t-b1-7", "tool_turn": True}
        router_plan._discipline_check(ctx, "up/a", "p1", "s1")
        violation = router_plan._discipline_check(
            {"turn_id": "t-b1-7", "tool_turn": True, "exempt": "context_governor"},
            "up/b", "p1", "s2")
        self.assertIsInstance(violation, dict)
        self.assertEqual(violation["exempt"], "context_governor")

    def test_unknown_exempt_reason_is_ignored(self):
        ctx = router_plan._clean_turn_ctx({"turn_id": "t1", "tool_turn": True,
                                           "exempt": "whatever"})
        self.assertEqual(ctx["exempt"], "")


class B1PlanFieldCase(unittest.TestCase):
    """plan 输出：开关开 ⇒ 每段有 boundary_policy；关 ⇒ 无新字段（零差异）。"""

    def setUp(self):
        self._saved = os.environ.get(router_plan.B1_ENV)
        self.payload = {"task": "写一句话说明模型路由", "max_stages": 2}

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(router_plan.B1_ENV, None)
        else:
            os.environ[router_plan.B1_ENV] = self._saved

    def test_plan_stages_have_boundary_policy_when_enabled(self):
        os.environ.pop(router_plan.B1_ENV, None)
        plan, status = router_plan.build_plan(dict(self.payload))
        self.assertEqual(status, 200, plan)
        stages = plan.get("stages") or []
        self.assertTrue(stages)
        for stage in stages:
            self.assertEqual(stage.get("boundary_policy"),
                             {"switch_on": ["new_user_message", "context_rebuild"],
                              "tool_turns_frozen": True})

    def test_plan_stages_omit_boundary_policy_when_disabled(self):
        os.environ[router_plan.B1_ENV] = "0"
        plan, status = router_plan.build_plan(dict(self.payload))
        self.assertEqual(status, 200, plan)
        for stage in plan.get("stages") or []:
            self.assertNotIn("boundary_policy", stage)


class B1DisciplineReportCase(unittest.TestCase):
    """discipline 只读聚合（写盘只到 /tmp）。"""

    def setUp(self):
        self._saved_env = os.environ.get(router_plan.B1_ENV)
        os.environ.pop(router_plan.B1_ENV, None)
        self.tmpdir = tempfile.mkdtemp(prefix="b1-report-")
        self.path = Path(self.tmpdir) / "annotations.jsonl"
        self._orig_path = router_plan.annotations_path
        router_plan.annotations_path = lambda: self.path  # type: ignore[assignment]

    def tearDown(self):
        router_plan.annotations_path = self._orig_path  # type: ignore[assignment]
        if self._saved_env is None:
            os.environ.pop(router_plan.B1_ENV, None)
        else:
            os.environ[router_plan.B1_ENV] = self._saved_env
        try:
            self.path.unlink()
        except OSError:
            pass
        try:
            os.rmdir(self.tmpdir)
        except OSError:
            pass

    def _write(self, rows):
        with self.path.open("w", encoding="utf-8") as fp:
            for row in rows:
                fp.write(json.dumps(row, ensure_ascii=False) + "\n")

    def test_report_counts_and_items(self):
        now = __import__("time").strftime("%Y-%m-%dT%H:%M:%S%z")
        self._write([
            {"at": now, "plan_id": "p1", "stage_id": "s1", "model_key": "up/a"},
            {"at": now, "plan_id": "p1", "stage_id": "s2", "model_key": "up/b",
             "discipline_violation": {"turn_id": "t1", "rule": "same_turn_model_frozen",
                                      "prev_model": "up/a", "model": "up/b",
                                      "plan_id": "p1", "stage_id": "s2"}},
        ])
        report = router_plan.discipline_report("7d")
        self.assertTrue(report["ok"])
        self.assertEqual(report["annotations"], 2)
        self.assertEqual(report["violations"], 1)
        self.assertEqual(report["non_exempt_violations"], 1)
        self.assertEqual(report["exempt_violations"], 0)
        self.assertEqual(report["items"][0]["turn_id"], "t1")
        self.assertEqual(report["rule"], "same_turn_model_frozen")

    def test_report_separates_exempt_violations(self):
        now = __import__("time").strftime("%Y-%m-%dT%H:%M:%S%z")
        self._write([{
            "at": now, "plan_id": "p", "stage_id": "s2", "model_key": "up/b",
            "discipline_violation": {"turn_id": "t2", "rule": "same_turn_model_frozen",
                                     "prev_model": "up/a", "model": "up/b",
                                     "plan_id": "p", "stage_id": "s2",
                                     "exempt": "context_governor"}}])
        report = router_plan.discipline_report("7d")
        self.assertEqual(report["violations"], 1)
        self.assertEqual(report["exempt_violations"], 1)
        self.assertEqual(report["non_exempt_violations"], 0)

    def test_report_missing_file_is_empty(self):
        report = router_plan.discipline_report("7d")
        self.assertTrue(report["ok"])
        self.assertEqual(report["annotations"], 0)
        self.assertEqual(report["violations"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
