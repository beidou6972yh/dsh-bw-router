#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""上下文治理可观测（1.0.3.2 T1 · M4）单元测试：响应头 / CORS 暴露 / 账本 ctx_gov。

口径：mode=off 时账本与响应头**逐字节不变**；shadow/enforce 才出现 `ctx_gov` 与新头。
不联网、不起端口、不写盘（append_ledger 打桩捕获）。
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


def _ctx(with_gov=True):
    ctx = {
        "req_id": "req-test",
        "virtual_model": "auto",
        "features": gw.Features(cjk_chars=10),
        "stage": "L1",
        "period": "offpeak",
        "reason": "测试",
    }
    if with_gov:
        ctx["ctx_gov"] = {
            "mode": "shadow", "band": "pass", "kind": "pass",
            "window": 98304, "budget": 78643, "need": 100, "est": 100, "out": 0,
            "reserved": 19661, "input_cap": 78643, "trimmed": 0,
            "used": None, "used_kind": "est",
            "params": {"reserve_ratio": 0.2},
        }
    return ctx


class _HeaderSink:
    def __init__(self):
        self.headers = {}

    def send_header(self, key, value):
        self.headers[key] = value


class HeaderCase(unittest.TestCase):
    def test_headers_present_when_ctx_gov_exists(self):
        handler = types.SimpleNamespace()
        headers = gw.RouterHandler._router_headers(handler, "req-1", "up/a", _ctx())
        self.assertEqual(headers["X-DSH-Context-Window"], "98304")
        self.assertEqual(headers["X-DSH-Context-Budget"], "78643")
        self.assertEqual(headers["X-DSH-Context-Used"], "100")     # 无 usage ⇒ 回 est
        self.assertEqual(headers["X-DSH-Context-Used-Kind"], "est")
        self.assertEqual(headers["X-DSH-Trimmed"], "0")
        self.assertEqual(headers["X-DSH-Band"], "pass")

    def test_headers_absent_without_ctx_gov(self):
        handler = types.SimpleNamespace()
        headers = gw.RouterHandler._router_headers(handler, "req-1", "up/a", _ctx(False))
        for key in headers:
            self.assertFalse(key.startswith("X-DSH-Context-"), key)
        self.assertNotIn("X-DSH-Band", headers)

    def test_cors_exposes_context_headers(self):
        sink = _HeaderSink()
        gw.RouterHandler._cors(sink)
        expose = sink.headers.get("Access-Control-Expose-Headers", "")
        for name in ("X-DSH-Context-Window", "X-DSH-Context-Budget",
                     "X-DSH-Context-Used", "X-DSH-Context-Used-Kind",
                     "X-DSH-Trimmed", "X-DSH-Band"):
            self.assertIn(name, expose)
        self.assertIn("X-Router-Decision", expose)   # 旧头未丢


class LedgerCase(unittest.TestCase):
    def setUp(self):
        self._captured = []
        self._orig_append = gw.append_ledger
        gw.append_ledger = lambda entry: self._captured.append(entry)  # type: ignore[assignment]
        self._saved_mode = os.environ.get(gw.CTX_GOV_ENV)
        os.environ[gw.CTX_GOV_ENV] = "off"   # _ledger 本身只看 ctx，不看 mode；off 仅确保测试语境

    def tearDown(self):
        gw.append_ledger = self._orig_append  # type: ignore[assignment]
        if self._saved_mode is None:
            os.environ.pop(gw.CTX_GOV_ENV, None)
        else:
            os.environ[gw.CTX_GOV_ENV] = self._saved_mode

    def test_ledger_contains_ctx_gov(self):
        handler = types.SimpleNamespace()
        gw.RouterHandler._ledger(handler, _ctx(), ["up/a"], "up/a",
                                 [{"upstream": "up", "model": "a", "status": 200, "ms": 1}],
                                 None, "ok")
        self.assertEqual(len(self._captured), 1)
        entry = self._captured[0]
        self.assertIsInstance(entry.get("ctx_gov"), dict)
        self.assertEqual(entry["ctx_gov"]["band"], "pass")

    def test_ledger_omits_ctx_gov_when_absent(self):
        handler = types.SimpleNamespace()
        gw.RouterHandler._ledger(handler, _ctx(False), ["up/a"], "up/a",
                                 [{"upstream": "up", "model": "a", "status": 200, "ms": 1}],
                                 None, "ok")
        self.assertNotIn("ctx_gov", self._captured[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
