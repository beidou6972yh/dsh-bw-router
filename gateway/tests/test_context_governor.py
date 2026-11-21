#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R4/R5 上下文治理（1.0.3.2 T1 · M1 估算器/预算/判定）单元测试。

口径（设计定稿 D1–D5）：
- 只做加法：`CHARS_PER_TOKEN` 与 `est_input_tokens` 不动；保守估算只走新函数；
- `Features.as_dict()` 永远 8 键（账本 features 块历史结构不变）；
- 预算每轮现算、无缓存；窗口只读 upstreams.json；
- 开关：`off`＝旧行为、`shadow`＝旧判定+观测、`enforce`＝预算判定。

配置无关：用当前配置里任一带 `context_window` 的候选；无则跳过相关用例。
"""

from __future__ import annotations

import json
import math
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw  # noqa: E402


def _candidate_with_window() -> tuple[str, str, int] | None:
    for upstream in gw.UPSTREAMS:
        for model_id in upstream.models:
            spec = upstream.model_spec(model_id)
            window = spec.get("context_window")
            if isinstance(window, int) and window > 0:
                return upstream.id, model_id, window
    return None


class CJKSplitCase(unittest.TestCase):
    def test_split_counts_cjk_and_ascii(self):
        cjk, other = gw._text_char_split("中文abc")
        self.assertEqual((cjk, other), (2, 3))

    def test_extract_features_keeps_chars_and_adds_split(self):
        payload = {"messages": [{"role": "user", "content": "你好 hello"}],
                   "tools": [{"type": "function", "function": {"name": "f"}}]}
        feats = gw.extract_features(payload)
        self.assertGreater(feats.cjk_chars, 0)
        self.assertGreater(feats.other_chars, 0)
        self.assertEqual(feats.chars, feats.cjk_chars + feats.other_chars)
        # 旧估算口径一字不动
        self.assertEqual(feats.est_input_tokens,
                         math.ceil(feats.chars / gw.CHARS_PER_TOKEN)
                         + feats.image_count * gw.IMAGE_TOKENS)

    def test_as_dict_keeps_eight_keys(self):
        feats = gw.extract_features({"messages": [{"role": "user", "content": "中文"}]})
        self.assertEqual(set(feats.as_dict()),
                         {"est_input_tokens", "chars", "message_count", "image_count",
                          "has_image", "has_tools", "max_tokens", "has_system"})


class EstimateCase(unittest.TestCase):
    def test_conservative_estimate_values(self):
        feats = gw.Features(cjk_chars=1000)
        self.assertEqual(gw.context_tokens_estimate(feats), 1000)
        feats = gw.Features(other_chars=4000)
        self.assertEqual(gw.context_tokens_estimate(feats), 1000)
        feats = gw.Features(image_count=1)
        self.assertEqual(gw.context_tokens_estimate(feats), 1000)

    def test_degrade_to_cjk_when_no_split(self):
        # 没有拆分数据（手工构造 chars）⇒ 按全 CJK，宁严不松
        feats = gw.Features(chars=1000)
        self.assertEqual(gw.context_tokens_estimate(feats), 1000)


class BudgetCase(unittest.TestCase):
    def test_budget_vector(self):
        cases = {8192: 6553, 32768: 26214, 98304: 78643, 131072: 104857,
                 262144: 209715, 1048576: 838860}
        for window, expect in cases.items():
            budget = gw.context_budget(window, 0)
            self.assertEqual(budget["budget"], expect, window)
            self.assertLessEqual(budget["budget"], window)
            # 纯函数：同参数两次完全一致
            self.assertEqual(budget, gw.context_budget(window, 0))

    def test_output_reserve_reduces_input_cap(self):
        budget = gw.context_budget(32768, 8192)
        self.assertEqual(budget["input_cap"], budget["budget"] - 8192)


class VerdictCase(unittest.TestCase):
    def setUp(self):
        found = _candidate_with_window()
        if not found:
            self.skipTest("当前配置无带 context_window 的候选")
        self.upstream_id, self.model_id, self.window = found
        self.params = gw.ctx_gov_params()

    def test_unknown_window_is_unknown_and_passes(self):
        verdict = gw.context_verdict("no-such-upstream", "no-such-model",
                                     gw.Features(cjk_chars=10))
        self.assertEqual(verdict["band"], "unknown")
        self.assertEqual(verdict["kind"], "no_window")

    def test_boundary_pass_and_reject(self):
        budget = gw.context_budget(self.window, 0, self.params)
        cap = budget["input_cap"]
        base = gw.Features(cjk_chars=cap)
        self.assertEqual(gw.context_tokens_estimate(base, self.params), cap)
        verdict = gw.context_verdict(self.upstream_id, self.model_id, base, self.params)
        self.assertEqual(verdict["band"], "pass", verdict)
        over = gw.Features(cjk_chars=cap + 1)
        verdict = gw.context_verdict(self.upstream_id, self.model_id, over, self.params)
        self.assertEqual(verdict["band"], "reject")
        self.assertEqual(verdict["kind"], "input_overflow")

    def test_budget_too_small_is_unknown(self):
        params = json.loads(json.dumps(self.params))
        params["min_budget_tokens"] = 10 ** 9
        verdict = gw.context_verdict(self.upstream_id, self.model_id,
                                     gw.Features(cjk_chars=1), params)
        self.assertEqual(verdict["band"], "unknown")
        self.assertEqual(verdict["kind"], "budget_too_small")


class ModeCase(unittest.TestCase):
    def setUp(self):
        found = _candidate_with_window()
        if not found:
            self.skipTest("当前配置无带 context_window 的候选")
        self.upstream_id, self.model_id, self.window = found
        self._saved = os.environ.get(gw.CTX_GOV_ENV)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(gw.CTX_GOV_ENV, None)
        else:
            os.environ[gw.CTX_GOV_ENV] = self._saved

    def test_mode_env_and_defaults(self):
        os.environ[gw.CTX_GOV_ENV] = "enforce"
        self.assertEqual(gw.ctx_gov_params()["mode"], "enforce")
        os.environ[gw.CTX_GOV_ENV] = "bogus"
        self.assertEqual(gw.ctx_gov_params()["mode"], "off")
        os.environ.pop(gw.CTX_GOV_ENV, None)
        self.assertIn(gw.ctx_gov_params()["mode"], ("shadow", "enforce", "off"))

    def test_off_and_shadow_keep_legacy_decision(self):
        # 旧口径：est+max_tokens > 1.05×window ⇒ 拒
        over = gw.Features(est_input_tokens=math.ceil(self.window * 1.06))
        for mode in ("off", "shadow"):
            os.environ[gw.CTX_GOV_ENV] = mode
            ok, why = gw.candidate_supported(self.upstream_id, self.model_id, over)
            self.assertFalse(ok, mode)
            self.assertIn("context_overflow", why)
        # 旧口径内 ⇒ 放行
        os.environ[gw.CTX_GOV_ENV] = "shadow"
        ok, _ = gw.candidate_supported(self.upstream_id, self.model_id,
                                       gw.Features(est_input_tokens=100))
        self.assertTrue(ok)

    def test_enforce_uses_conservative_estimate(self):
        os.environ[gw.CTX_GOV_ENV] = "enforce"
        # est_input_tokens 很小但保守估算超预算 ⇒ enforce 必须拒（证明用的是新估算）
        feats = gw.Features(est_input_tokens=1, cjk_chars=self.window)
        ok, why = gw.candidate_supported(self.upstream_id, self.model_id, feats)
        self.assertFalse(ok, why)
        self.assertIn("context_overflow:input_overflow", why)
        # 旧字段 est_input_tokens 被忽略（新口径）；小请求仍放行
        ok, _ = gw.candidate_supported(self.upstream_id, self.model_id,
                                       gw.Features(est_input_tokens=10 ** 9, cjk_chars=10))
        self.assertTrue(ok)


if __name__ == "__main__":
    unittest.main(verbosity=2)
