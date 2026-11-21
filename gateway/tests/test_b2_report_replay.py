#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B2 复盘报告 + 回放（1.0.3.2 T4）单元测试。

配置无关：不读 pricebook；annotations/ledger 路径 monkeypatch 到 /tmp；
回放用 build_plan 生成的内存 plan 状态；全程不写生产数据、不联网、不起端口。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw  # noqa: E402
import router_plan  # noqa: E402


class _TmpJsonl:
    """临时 JSONL 文件夹具。"""

    def __init__(self, prefix: str):
        self.dir = tempfile.mkdtemp(prefix=prefix)
        self.path = Path(self.dir) / "data.jsonl"

    def write(self, rows):
        with self.path.open("w", encoding="utf-8") as fp:
            for row in rows:
                fp.write(json.dumps(row, ensure_ascii=False) + "\n")

    def cleanup(self):
        try:
            self.path.unlink()
        except OSError:
            pass
        try:
            os.rmdir(self.dir)
        except OSError:
            pass


class ReportCase(unittest.TestCase):
    def setUp(self):
        self.ann = _TmpJsonl("b2-ann-")
        self.led = _TmpJsonl("b2-led-")
        self._orig_ann = router_plan.annotations_path
        self._orig_ledger = gw.LEDGER_PATH
        router_plan.annotations_path = lambda: self.ann.path  # type: ignore[assignment]
        gw.LEDGER_PATH = self.led.path  # type: ignore[assignment]

    def tearDown(self):
        router_plan.annotations_path = self._orig_ann  # type: ignore[assignment]
        gw.LEDGER_PATH = self._orig_ledger  # type: ignore[assignment]
        self.ann.cleanup()
        self.led.cleanup()

    def test_empty_files_give_zero_totals(self):
        report = router_plan.report("7d", "model")
        self.assertTrue(report["ok"])
        self.assertEqual(report["mode"], "read_only")
        self.assertEqual(report["annotations"]["totals"]["stages"], 0)
        self.assertEqual(report["ledger"]["totals"]["requests"], 0)
        self.assertFalse(report["partial"])

    def test_aggregates_annotations_and_ledger(self):
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        old = time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(time.time() - 10 * 86400))
        self.ann.write([
            {"at": now, "plan_id": "p1", "stage_id": "s1", "model_key": "up/a",
             "capability": "reasoning", "stage_key": "l1",
             "estimate": {"input_tokens": 100, "output_tokens": 50,
                          "cost_micro": 0.5, "unknown_pricing": False},
             "estimate_delta": {"actual_input_tokens": 200, "actual_output_tokens": 60,
                                "actual_cost": 0.8}},
            {"at": now, "plan_id": "p1", "stage_id": "s2", "model_key": "up/b",
             "capability": "coding", "stage_key": "l2",
             "estimate": {"input_tokens": 300, "output_tokens": 80,
                          "cost_micro": 1.5, "unknown_pricing": True},
             "estimate_delta": None},
            {"at": old, "plan_id": "p-old", "stage_id": "s1", "model_key": "up/a",
             "estimate": {"input_tokens": 9999, "output_tokens": 1, "cost_micro": 9.9}},
        ])
        self.led.write([
            {"ts": now, "chosen": "up/a", "stage": "L1",
             "features": {"est_input_tokens": 120}, "usage": {"prompt_tokens": 240,
                                                              "completion_tokens": 60},
             "final_status": "ok_stream"},
            {"ts": now, "chosen": "up/b", "stage": "L2",
             "features": {"est_input_tokens": 300}, "usage": {"prompt_tokens": 600,
                                                              "completion_tokens": 10},
             "final_status": "ok"},
            {"ts": old, "chosen": "up/a", "stage": "L1",
             "features": {"est_input_tokens": 1}, "usage": {"prompt_tokens": 1},
             "final_status": "ok"},
        ])
        report = router_plan.report("7d", "model")
        ann = report["annotations"]["totals"]
        self.assertEqual(ann["stages"], 2)            # 旧行被 range 过滤
        self.assertEqual(ann["with_usage"], 1)
        self.assertEqual(ann["planned_input_tokens"], 400)
        self.assertEqual(ann["actual_input_tokens"], 200)
        self.assertEqual(ann["unknown_pricing"], 1)
        self.assertEqual(ann["planned_cost"], 2.0)
        self.assertEqual(ann["actual_cost"], 0.8)
        self.assertEqual(ann["cost_delta"], -1.2)
        led = report["ledger"]["totals"]
        self.assertEqual(led["requests"], 2)
        self.assertEqual(led["ok"], 2)
        self.assertEqual(led["prompt_tokens"], 840)
        self.assertEqual(led["token_ratio"], round(840 / 420, 3))
        self.assertIn("up/a", report["annotations"]["groups"])

    def test_group_by_stage(self):
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        self.ann.write([{"at": now, "plan_id": "p", "stage_id": "s1", "model_key": "up/a",
                         "capability": "coding", "stage_key": "l2", "estimate": {"input_tokens": 1},
                         "estimate_delta": None}])
        report = router_plan.report("7d", "stage")
        self.assertEqual(report["group"], "stage")
        self.assertIn("coding", report["annotations"]["groups"])


class ReplayCase(unittest.TestCase):
    def setUp(self):
        self.ann = _TmpJsonl("b2-replay-")
        self._orig_ann = router_plan.annotations_path
        router_plan.annotations_path = lambda: self.ann.path  # type: ignore[assignment]
        self.payload = {"task": "写一句话说明模型路由", "max_stages": 2}

    def tearDown(self):
        router_plan.annotations_path = self._orig_ann  # type: ignore[assignment]
        self.ann.cleanup()

    def test_replay_recent_plan_is_read_only(self):
        plan, status = router_plan.build_plan(dict(self.payload))
        self.assertEqual(status, 200, plan)
        body, status = router_plan.replay({"plan_id": plan["plan_id"],
                                           "settings": {"strategy": "cost"}})
        self.assertEqual(status, 200, body)
        self.assertTrue(body["ok"])
        self.assertFalse(body["executed"])
        self.assertEqual(body["writes"], 0)
        self.assertEqual(body["upstream_calls"], 0)
        self.assertEqual(len(body["stages"]), len(plan["stages"]))
        self.assertFalse(body["partial"])
        for stage in body["stages"]:
            self.assertIn("original_model", stage)
            self.assertIn("replayed_model", stage)
            self.assertIn("changed", stage)

    def test_replay_expired_plan_is_404(self):
        body, status = router_plan.replay({"plan_id": "plan-not-exist-xxxx"})
        self.assertEqual(status, 404)
        self.assertFalse(body["ok"])
        self.assertEqual(body["code"], "plan_state_expired")

    def test_replay_expired_plan_with_annotations_is_partial(self):
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        self.ann.write([{"at": now, "plan_id": "plan-expired-1", "stage_id": "s1",
                         "capability": "coding", "model_key": "up/a"}])
        body, status = router_plan.replay({"plan_id": "plan-expired-1"})
        self.assertEqual(status, 200, body)
        self.assertTrue(body["partial"])
        self.assertEqual(body["stages"][0]["original_model"], "up/a")
        self.assertIsNone(body["stages"][0]["replayed_model"])

    def test_replay_rejects_bad_settings(self):
        body, status = router_plan.replay({"plan_id": "p", "settings": {"strategy": "bogus"}})
        self.assertEqual(status, 400)
        self.assertEqual(body["code"], "bad_strategy")
        body, status = router_plan.replay({"plan_id": "p",
                                           "settings": {"automation_level": "全自动"}})
        self.assertEqual(status, 400)
        self.assertEqual(body["code"], "bad_automation_level")

    def test_replay_requires_plan_id(self):
        body, status = router_plan.replay({})
        self.assertEqual(status, 400)
        self.assertEqual(body["code"], "missing_plan_id")


if __name__ == "__main__":
    unittest.main(verbosity=2)
