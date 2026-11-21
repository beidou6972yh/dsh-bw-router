#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B4 影子判定（1.0.3.2 T5）单元测试：开关/解析/记录/汇总/失败丢弃/超限。

不联网：router_deciders._post_chat 打桩；shadow 文件与配置路径 monkeypatch 到 /tmp。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import router_shadow  # noqa: E402


class ShadowCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="b4-shadow-")
        self.log = Path(self.tmp) / "shadow.jsonl"
        self.cfg = Path(self.tmp) / "shadow_judge.json"
        self.cfg.write_text(json.dumps({"enabled": True, "decider": "decider_c",
                                        "timeout_s": 1, "max_input_tokens": 1000,
                                        "sample_rate": 1.0}), encoding="utf-8")
        self._saved = {k: os.environ.get(k) for k in (router_shadow.ENV,)}
        os.environ.pop(router_shadow.ENV, None)
        self._orig_log, self._orig_cfg = router_shadow.SHADOW_LOG, router_shadow.CONFIG_PATH
        router_shadow.SHADOW_LOG = self.log
        router_shadow.CONFIG_PATH = self.cfg
        router_shadow._CACHE.update(mtime=None, doc=None)

    def tearDown(self):
        router_shadow.SHADOW_LOG = self._orig_log
        router_shadow.CONFIG_PATH = self._orig_cfg
        router_shadow._CACHE.update(mtime=None, doc=None)
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        for path in (self.log, self.cfg):
            try:
                path.unlink()
            except OSError:
                pass
        try:
            os.rmdir(self.tmp)
        except OSError:
            pass

    def _wait(self, timeout=2.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if router_shadow._INFLIGHT["count"] == 0 and self.log.exists():
                rows = [json.loads(line) for line in self.log.read_text().splitlines() if line.strip()]
                if rows:
                    return rows
            time.sleep(0.02)
        return []

    def test_disabled_does_nothing(self):
        os.environ[router_shadow.ENV] = "0"
        self.assertFalse(router_shadow.submit("r1", {}, "L2", "offpeak", 100))
        self.assertFalse(self.log.exists())

    def test_valid_judgement_is_recorded(self):
        with mock.patch.object(router_shadow.router_deciders, "_post_chat",
                               return_value='{"simple_prob":0.8,"suggested_group":"L2","score":77}'):
            self.assertTrue(router_shadow.submit("r2", {"chars": 10}, "L2", "offpeak", 100))
            rows = self._wait()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["source"], router_shadow.SOURCE)
        self.assertEqual(row["status"], "ok")
        self.assertEqual(row["suggested_group"], "L2")
        self.assertEqual(row["simple_prob"], 0.8)
        summary = router_shadow.summary("7d")
        self.assertEqual(summary["calls"], 1)
        self.assertEqual(summary["ok_calls"], 1)
        self.assertEqual(summary["agreement"]["rate"], 1.0)

    def test_bad_output_is_discarded(self):
        with mock.patch.object(router_shadow.router_deciders, "_post_chat", return_value="nope"):
            router_shadow.submit("r3", {}, "L1", "offpeak", 10)
            rows = self._wait()
        self.assertEqual(rows[0]["status"], "bad_output")
        self.assertIn("error", rows[0])

    def test_error_is_recorded(self):
        with mock.patch.object(router_shadow.router_deciders, "_post_chat",
                               side_effect=RuntimeError("boom")):
            router_shadow.submit("r4", {}, "L1", "offpeak", 10)
            rows = self._wait()
        self.assertEqual(rows[0]["status"], "error")
        self.assertIn("boom", rows[0]["error"])

    def test_too_large_skips_model_call(self):
        with mock.patch.object(router_shadow.router_deciders, "_post_chat") as post:
            self.assertFalse(router_shadow.submit("r5", {}, "L3", "peak", 10 ** 6))
            post.assert_not_called()
        row = json.loads(self.log.read_text().splitlines()[0])
        self.assertEqual(row["status"], "too_large")


if __name__ == "__main__":
    unittest.main(verbosity=2)
