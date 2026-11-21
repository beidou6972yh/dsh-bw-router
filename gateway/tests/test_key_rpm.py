#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Q4-3 补测（1.0.2.8 遗留，1.0.3.2 批 A）：per-key rpm 滑动窗口防回归。

口径（main.key_rpm_check）：
- principal 不是 dict / rpm<=0 / rpm 非数字 ⇒ 不限（allowed=True, retry=0）；
- rpm=N>0 ⇒ 60s 窗口内前 N 次放行，第 N+1 次拒绝且 retry≥1；
- 窗口过期后可再放行（用 mock 时钟推进，不真等）。
不联网、不起端口、不写盘；进程内状态每个用例前清空。
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw  # noqa: E402


class KeyRpmCase(unittest.TestCase):
    def setUp(self):
        with gw._KEY_RPM_LOCK:
            gw._KEY_RPM.clear()
        self._now = 1000.0

    def tearDown(self):
        with gw._KEY_RPM_LOCK:
            gw._KEY_RPM.clear()

    def _call(self, principal):
        with mock.patch.object(gw.time, "time", lambda: self._now):
            return gw.key_rpm_check(principal)

    def test_missing_principal_is_unlimited(self):
        self.assertEqual(self._call(None), (True, 0))
        self.assertEqual(self._call({}), (True, 0))

    def test_rpm_zero_or_negative_is_unlimited(self):
        for rpm in (0, -1, "0", ""):
            self.assertEqual(self._call({"id": f"k-{rpm}", "rpm": rpm}), (True, 0), rpm)

    def test_rpm_invalid_string_is_unlimited(self):
        self.assertEqual(self._call({"id": "k-bad", "rpm": "many"}), (True, 0))

    def test_rpm_limit_blocks_after_quota(self):
        principal = {"id": "k-limit", "rpm": 2}
        self.assertEqual(self._call(principal), (True, 0))
        self.assertEqual(self._call(principal), (True, 0))
        allowed, retry = self._call(principal)
        self.assertFalse(allowed)
        self.assertGreaterEqual(retry, 1)

    def test_window_expiry_releases_quota(self):
        principal = {"id": "k-window", "rpm": 1}
        self.assertEqual(self._call(principal), (True, 0))
        self.assertFalse(self._call(principal)[0])
        self._now += gw._KEY_RPM_WINDOW + 1
        self.assertEqual(self._call(principal), (True, 0))

    def test_keys_are_isolated(self):
        a = {"id": "k-a", "rpm": 1}
        b = {"id": "k-b", "rpm": 1}
        self.assertEqual(self._call(a), (True, 0))
        self.assertEqual(self._call(b), (True, 0))
        self.assertFalse(self._call(a)[0])
        self.assertFalse(self._call(b)[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
