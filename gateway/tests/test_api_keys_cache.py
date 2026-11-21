#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Q2-2：per-client API key 的「前缀预筛 + 验证缓存」回归测试（不联网、不碰生产配置）。

覆盖：
- 冷路径一次 PBKDF2；热路径缓存命中（取 5 次最小值，<20ms）；
- 无效 token 前缀不命中 ⇒ 快速失败（<10ms），不再与合法请求同价；
- revoke / rotate 立即失效（显式清缓存）；
- 外部改 api-keys.json（mtime 变）⇒ 清缓存，旧 token 立即失效；
- ROUTER_AUTH_CACHE=0 回旧行为仍可校验。
运行：cd <网关树根> && python3 -m unittest tests.test_api_keys_cache -v
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

import api_keys  # noqa: E402


class ApiKeysCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="auth-cache-test-")
        Path(self.tmp, "config").mkdir(parents=True, exist_ok=True)
        self._old_base = api_keys.BASE_DIR
        self._old_env = os.environ.get("ROUTER_AUTH_CACHE")
        api_keys.set_base(self.tmp)
        api_keys.save({"version": 1, "required": True, "keys": []})
        api_keys.invalidate_verify()

    def tearDown(self) -> None:
        api_keys.set_base(self._old_base) if self._old_base else api_keys.set_base(ROOT)
        if self._old_env is None:
            os.environ.pop("ROUTER_AUTH_CACHE", None)
        else:
            os.environ["ROUTER_AUTH_CACHE"] = self._old_env

    def _create(self, name="t"):
        return api_keys.create(name, ["plan", "chat"], 600)

    def test_hot_path_is_fast(self):
        tok = self._create()["token"]
        t0 = time.perf_counter()
        self.assertIsNotNone(api_keys.verify("Bearer " + tok))
        cold = time.perf_counter() - t0
        # 热路径取多次最小值：宿主机调度/GC 抖动会让单次采样偶发超标，取最小值只判"缓存真的命中"，
        # 不把宿主机负载当成回归（阈值同步放宽到 20ms，仍远小于冷路径的 PBKDF2 开销）。
        hot_samples = []
        for _ in range(5):
            t0 = time.perf_counter()
            self.assertIsNotNone(api_keys.verify("Bearer " + tok))
            hot_samples.append(time.perf_counter() - t0)
        hot = min(hot_samples)
        self.assertGreater(cold, 0.05)       # 冷路径确实跑了一次 PBKDF2
        self.assertLess(hot, 0.02)           # 热路径不再跑

    def test_bad_token_fast_fail(self):
        self._create()
        t0 = time.perf_counter()
        self.assertIsNone(api_keys.verify("Bearer wb_" + "a" * 43))
        self.assertLess(time.perf_counter() - t0, 0.01)

    def test_revoke_invalidates(self):
        rec = self._create()
        self.assertIsNotNone(api_keys.verify("Bearer " + rec["token"]))
        api_keys.revoke(rec["key"]["id"])
        self.assertIsNone(api_keys.verify("Bearer " + rec["token"]))

    def test_rotate_invalidates(self):
        rec = self._create()
        self.assertIsNotNone(api_keys.verify("Bearer " + rec["token"]))
        out = api_keys.rotate(rec["key"]["id"])
        self.assertIsNone(api_keys.verify("Bearer " + rec["token"]))
        self.assertIsNotNone(api_keys.verify("Bearer " + out["token"]))

    def test_external_file_change_invalidates(self):
        rec = self._create()
        self.assertIsNotNone(api_keys.verify("Bearer " + rec["token"]))
        fp = Path(self.tmp, "config", "api-keys.json")
        raw = json.loads(fp.read_text(encoding="utf-8"))
        for k in raw["keys"]:
            if k.get("id") == rec["key"]["id"]:
                k["hash"] = "x" * 44
        fp.write_text(json.dumps(raw), encoding="utf-8")
        os.utime(fp, (time.time() + 3, time.time() + 3))
        self.assertIsNone(api_keys.verify("Bearer " + rec["token"]))

    def test_cache_off_still_verifies(self):
        os.environ["ROUTER_AUTH_CACHE"] = "0"
        tok = self._create()["token"]
        self.assertIsNotNone(api_keys.verify("Bearer " + tok))
        self.assertIsNotNone(api_keys.verify("Bearer " + tok))


if __name__ == "__main__":
    unittest.main()
