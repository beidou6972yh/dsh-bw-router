#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B5 只读兼容入口（1.0.3.2 T6）单元测试：开关 / per-key 白名单 / 响应头 / 账本标记。

不联网、不写盘（append_ledger 打桩）。
"""

from __future__ import annotations

import os
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw  # noqa: E402


class _Sink:
    def __init__(self):
        self.headers = {}

    def send_header(self, key, value):
        self.headers[key] = value


class SwitchCase(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in (gw.B5_ENV, gw.B5_KEYS_ENV)}

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_master_switch(self):
        os.environ.pop(gw.B5_ENV, None)
        self.assertFalse(gw.b5_enabled())
        for raw in ("1", "true", "on"):
            os.environ[gw.B5_ENV] = raw
            self.assertTrue(gw.b5_enabled(), raw)
        for raw in ("0", "false", ""):
            os.environ[gw.B5_ENV] = raw
            self.assertFalse(gw.b5_enabled(), raw)

    def test_per_key_allow(self):
        os.environ.pop(gw.B5_KEYS_ENV, None)
        self.assertFalse(gw.b5_key_allowed(None))
        self.assertFalse(gw.b5_key_allowed({"id": "k1"}))
        self.assertTrue(gw.b5_key_allowed({"id": "k1", "passthrough": True}))
        os.environ[gw.B5_KEYS_ENV] = "k1, k2"
        self.assertTrue(gw.b5_key_allowed({"id": "k2"}))
        self.assertFalse(gw.b5_key_allowed({"id": "k3"}))


class HeadersCase(unittest.TestCase):
    def _ctx(self, stream=False):
        return {"req_id": "req-b5", "virtual_model": "auto", "features": gw.Features(cjk_chars=1),
                "stage": "L1", "period": "offpeak", "reason": "测试", "stream": stream,
                "b5": {"mode": "passthrough", "strategy": "auto-cost"}}

    def test_b5_headers_present(self):
        handler = types.SimpleNamespace()
        headers = gw.RouterHandler._router_headers(handler, "req-b5", "up/a", self._ctx(False))
        self.assertEqual(headers["X-WB-Model"], "up/a")
        self.assertEqual(headers["X-WB-Strategy"], "auto-cost")
        self.assertEqual(headers["X-WB-Usage-Kind"], "actual")

    def test_b5_stream_usage_kind(self):
        handler = types.SimpleNamespace()
        headers = gw.RouterHandler._router_headers(handler, "req-b5", "up/a", self._ctx(True))
        self.assertEqual(headers["X-WB-Usage-Kind"], "stream")

    def test_no_b5_headers_by_default(self):
        handler = types.SimpleNamespace()
        ctx = {"req_id": "r", "virtual_model": "auto", "features": gw.Features(),
               "stage": "L1", "period": "offpeak", "reason": "x"}
        headers = gw.RouterHandler._router_headers(handler, "r", "up/a", ctx)
        self.assertNotIn("X-WB-Model", headers)

    def test_cors_exposes_b5_headers(self):
        sink = _Sink()
        gw.RouterHandler._cors(sink)
        expose = sink.headers.get("Access-Control-Expose-Headers", "")
        for name in ("X-WB-Model", "X-WB-Strategy", "X-WB-Usage-Kind"):
            self.assertIn(name, expose)


class LedgerCase(unittest.TestCase):
    def setUp(self):
        self._captured = []
        self._orig = gw.append_ledger
        gw.append_ledger = lambda entry: self._captured.append(entry)  # type: ignore[assignment]

    def tearDown(self):
        gw.append_ledger = self._orig  # type: ignore[assignment]

    def test_passthrough_flag_in_ledger(self):
        ctx = {"req_id": "r", "virtual_model": "auto", "features": gw.Features(),
               "stage": "L1", "period": "offpeak", "reason": "x",
               "b5": {"mode": "passthrough", "strategy": "auto"}}
        gw.RouterHandler._ledger(types.SimpleNamespace(), ctx, ["up/a"], "up/a",
                                 [{"upstream": "up", "model": "a", "status": 200, "ms": 1}],
                                 None, "ok")
        self.assertTrue(self._captured[0].get("passthrough"))
        self.assertEqual(self._captured[0].get("passthrough_mode"), "passthrough")


if __name__ == "__main__":
    unittest.main(verbosity=2)
