#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""上下文治理结构化错误 + 本地输入上限（1.0.3.2 T1 · M2/M3-lite）单元测试。

不联网、不起端口、不写盘；配置无关（本地上游/窗口从当前配置取，缺则跳过）。
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw  # noqa: E402


def _local_candidate() -> tuple[str, str, int] | None:
    local_ids = set()
    try:
        local_ids = gw.local_upstream_ids()
    except Exception:
        return None
    for upstream in gw.UPSTREAMS:
        if upstream.id not in local_ids:
            continue
        for model_id in upstream.models:
            spec = upstream.model_spec(model_id)
            window = spec.get("context_window")
            if isinstance(window, int) and window > 0:
                return upstream.id, model_id, window
    return None


class RejectInfoCase(unittest.TestCase):
    def test_finds_first_reject_attempt(self):
        attempts = [
            {"upstream": "u", "model": "a", "status": 200, "ctx_gov": {"band": "pass"}},
            {"upstream": "u", "model": "b", "status": None,
             "ctx_gov": {"band": "reject", "kind": "input_overflow", "window": 98304}},
        ]
        info = gw.context_reject_info(attempts)
        self.assertIsInstance(info, dict)
        self.assertEqual(info["kind"], "input_overflow")

    def test_no_reject_returns_none(self):
        self.assertIsNone(gw.context_reject_info([]))
        self.assertIsNone(gw.context_reject_info([{"status": 200, "ctx_gov": {"band": "pass"}}]))


class ErrorBodyCase(unittest.TestCase):
    def test_default_400_shape(self):
        info = {"kind": "input_overflow", "window": 98304, "budget": 78643,
                "reserved": 19661, "need": 83042, "est": 83042, "out": 0,
                "input_cap": 78643}
        body = gw.context_error_body(info, {"error": {"structured": True, "status": 400,
                                                      "allow_413": False}})
        self.assertEqual(body["error"]["code"], "context_window_exceeded")
        self.assertEqual(body["error"]["status"], 400)
        self.assertEqual(body["error"]["type"], "invalid_request_error")
        self.assertEqual(body["context"]["window"], 98304)
        self.assertEqual(body["context"]["budget"], 78643)
        self.assertIn("83042", body["error"]["message"])
        self.assertEqual([opt["id"] for opt in body["options"]],
                         ["compact_context", "raise_window", "enable_trim"])

    def test_allow_413_switch(self):
        body = gw.context_error_body({"kind": "input_overflow", "window": 1, "budget": 1,
                                      "need": 2},
                                     {"error": {"status": 400, "allow_413": True}})
        self.assertEqual(body["error"]["status"], 413)

    def test_kind_specific_messages(self):
        base = {"window": 262144, "budget": 209715, "reserved": 52429,
                "need": 300000, "est": 300000, "out": 0, "input_cap": 209715}
        local = gw.context_error_body({**base, "kind": "local_input_cap"})
        self.assertIn("本地", local["error"]["message"])
        reserve = gw.context_error_body({**base, "kind": "output_reserve",
                                         "out": 300000, "budget": 1000})
        self.assertIn("max_tokens", reserve["error"]["message"])


class LocalCapVerdictCase(unittest.TestCase):
    def setUp(self):
        found = _local_candidate()
        if not found:
            self.skipTest("当前配置无带窗口的本地上游")
        self.upstream_id, self.model_id, self.window = found
        self._saved = os.environ.get(gw.CTX_GOV_ENV)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(gw.CTX_GOV_ENV, None)
        else:
            os.environ[gw.CTX_GOV_ENV] = self._saved

    def test_local_cap_only_when_enabled(self):
        params = json.loads(json.dumps(gw.ctx_gov_params()))
        params["local"] = {"mode": "off", "input_ratio": 0.25}
        feats = gw.Features(cjk_chars=self.window)      # est = window（远超 25%）
        verdict = gw.context_verdict(self.upstream_id, self.model_id, feats, params)
        self.assertNotEqual(verdict.get("kind"), "local_input_cap")
        params["local"] = {"mode": "enforce", "input_ratio": 0.25}
        verdict = gw.context_verdict(self.upstream_id, self.model_id, feats, params)
        self.assertEqual(verdict["band"], "reject")
        self.assertEqual(verdict["kind"], "local_input_cap")

    def test_local_cap_is_input_only_not_need(self):
        # 输入本身不超 25%，但 max_tokens 很大 —— 不应触发 local_input_cap（仅输入口径）
        params = json.loads(json.dumps(gw.ctx_gov_params()))
        params["local"] = {"mode": "enforce", "input_ratio": 0.25}
        feats = gw.Features(cjk_chars=max(1, self.window // 10), max_tokens=self.window * 10)
        verdict = gw.context_verdict(self.upstream_id, self.model_id, feats, params)
        self.assertNotEqual(verdict.get("kind"), "local_input_cap")


class ContextErrorDetectCase(unittest.TestCase):
    """规则 6-lite 触发判据：只有 4xx + 上下文类关键词才算。"""

    def test_detects_common_english_keywords(self):
        self.assertTrue(gw.is_context_error(400, b'{"error":{"code":"context_length_exceeded"}}'))
        self.assertTrue(gw.is_context_error(422, "maximum context length is 8192"))
        self.assertTrue(gw.is_context_error(413, "too many tokens"))

    def test_detects_chinese_keywords(self):
        self.assertTrue(gw.is_context_error(400, "上下文长度超出限制"))
        self.assertTrue(gw.is_context_error(400, "超出上下文窗口"))

    def test_non_context_or_non_4xx_is_false(self):
        self.assertFalse(gw.is_context_error(400, b'{"error":{"code":"invalid_request"}}'))
        self.assertFalse(gw.is_context_error(500, "context window exploded"))
        self.assertFalse(gw.is_context_error(0, "context_length_exceeded"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
