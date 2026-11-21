#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""网关入口可选鉴权（ROUTER_API_KEY）单元测试：不联网、不起服务、不写盘。

覆盖（派工单验收判据 1：设 / 不设 / 错 key 各一例起）：
- 不设（未设 / 空串 / 纯空白）⇒ 鉴权关闭、恒放行，reason=disabled（历史行为零变化）；
- 设 ⇒ Authorization: Bearer <key> 放行（scheme 大小写不敏感、首尾空白容忍），/health 豁免；
- 错 key ⇒ 拒绝并给出机器可读 reason（缺头 / 非 Bearer / 带错 key / 前缀 key / 等长错 key）；
- 判定函数是纯函数：不因入参怪异抛异常；返回值里绝不出现密钥原文。

运行：
    cd <网关树根>            # 树根需含 main.py 与 config/routing.json、upstreams.json
    python3 -m unittest tests.test_auth -v
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as router  # noqa: E402

KEY = "test-router-key-9f3c1a7d"


class AuthEnvMixin(unittest.TestCase):
    """环境变量隔离：每个用例前后还原 ROUTER_API_KEY，避免污染其它测试。"""

    def setUp(self) -> None:
        self._saved = os.environ.get(router.AUTH_ENV)
        os.environ.pop(router.AUTH_ENV, None)

    def tearDown(self) -> None:
        if self._saved is None:
            os.environ.pop(router.AUTH_ENV, None)
        else:
            os.environ[router.AUTH_ENV] = self._saved

    def set_key(self, value: str) -> None:
        os.environ[router.AUTH_ENV] = value

    def verdict(self, path: str, authorization: str | None) -> dict:
        """按当前环境变量走真实取值路径（router_api_key + check_gate_auth）。"""
        return router.check_gate_auth(path, authorization, router.router_api_key())


class AuthDisabledCase(AuthEnvMixin):
    """例 1：不设 ROUTER_API_KEY ⇒ 鉴权关闭、行为与历史一致。"""

    def test_unset_key_disables_auth_everywhere(self):
        self.assertEqual(router.router_api_key(), "")
        self.assertFalse(router.auth_enabled())
        for path in ("/v1/models", "/v1/chat/completions", "/router/stats", "/", "/health"):
            for auth in (None, "", "Bearer whatever", "Basic abc"):
                v = self.verdict(path, auth)
                self.assertTrue(v["allowed"], f"{path} auth={auth!r} 应放行")
                self.assertFalse(v["enabled"])
                self.assertEqual(v["reason"], "disabled")

    def test_blank_key_equals_unset(self):
        """空串/纯空白视作未设置（保守：不因配了个空值就把自己锁死）。"""
        for blank in ("", "   ", "\t\n"):
            self.set_key(blank)
            self.assertEqual(router.router_api_key(), "")
            self.assertFalse(router.auth_enabled())
            self.assertTrue(self.verdict("/v1/models", None)["allowed"])

    def test_key_whitespace_is_trimmed(self):
        """配置里带首尾空白不算错（strip 后比较）。"""
        self.set_key(f"  {KEY}  ")
        self.assertEqual(router.router_api_key(), KEY)
        self.assertTrue(self.verdict("/v1/models", f"Bearer {KEY}")["allowed"])


class AuthEnabledValidCase(AuthEnvMixin):
    """例 2：设了 key，正确凭证放行。"""

    def setUp(self) -> None:
        super().setUp()
        self.set_key(KEY)

    def test_valid_bearer_allowed(self):
        v = self.verdict("/v1/models", f"Bearer {KEY}")
        self.assertTrue(v["enabled"])
        self.assertTrue(v["allowed"])
        self.assertEqual(v["reason"], "ok")

    def test_scheme_case_insensitive_and_whitespace_tolerant(self):
        """RFC 7235：scheme 大小写不敏感；多余空白容忍。"""
        for auth in (f"bearer {KEY}", f"BEARER {KEY}", f"Bearer   {KEY}  ", f" Bearer {KEY}"):
            v = self.verdict("/v1/chat/completions", auth)
            self.assertTrue(v["allowed"], f"auth={auth!r} 应放行")

    def test_health_exempt_even_without_header(self):
        v = self.verdict("/health", None)
        self.assertTrue(v["allowed"])
        self.assertEqual(v["reason"], "exempt")
        self.assertTrue(self.verdict("/health", "Bearer wrong")["allowed"])


class AuthEnabledRejectCase(AuthEnvMixin):
    """例 3：设了 key，错 key / 缺头 / 非 Bearer 一律拒绝且原因明确。"""

    def setUp(self) -> None:
        super().setUp()
        self.set_key(KEY)

    def test_wrong_key_rejected(self):
        for auth in (f"Bearer {'x' * len(KEY)}", "Bearer wrong-key", f"Bearer {KEY}x"):
            v = self.verdict("/v1/models", auth)
            self.assertFalse(v["allowed"], f"auth={auth!r} 应拒绝")
            self.assertEqual(v["reason"], "invalid_key")

    def test_missing_or_malformed_header_reasons(self):
        cases = {
            None: "missing_authorization",
            "": "missing_authorization",
            "   ": "missing_authorization",
            KEY: "bad_scheme",                      # 没有 Bearer 前缀
            "Basic dXNlcjpwYXNz": "bad_scheme",
            "Bearer": "bad_scheme",                 # 空 token
            "Bearer    ": "bad_scheme",
        }
        for auth, reason in cases.items():
            v = self.verdict("/v1/models", auth)
            self.assertFalse(v["allowed"], f"auth={auth!r} 应拒绝")
            self.assertEqual(v["reason"], reason, f"auth={auth!r}")

    def test_reasons_documented_and_no_secret_leak(self):
        """reason 都在 AUTH_REASONS 里有中文说明，且返回值不含密钥原文。"""
        all_reasons = {"disabled", "exempt", "ok", "missing_authorization",
                       "bad_scheme", "invalid_key"}
        self.assertEqual(set(router.AUTH_REASONS), all_reasons)
        for auth in (None, f"Bearer {KEY}", "Bearer wrong"):
            payload = json.dumps(self.verdict("/v1/models", auth), ensure_ascii=False)
            self.assertNotIn(KEY, payload)

    def test_check_is_pure(self):
        """纯函数：连续调用不改变环境/状态，怪异入参不抛异常。"""
        before = os.environ.get(router.AUTH_ENV)
        for auth in ("Bearer \x00ä", "\n", "Bearer\t" + KEY, "Bearer " + KEY + "\n"):
            v = router.check_gate_auth("/v1/models", auth, KEY)
            self.assertIn("allowed", v)
        self.assertEqual(os.environ.get(router.AUTH_ENV), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
