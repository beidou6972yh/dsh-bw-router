#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""1.0.3.9 钉选（stage_models）单元测试：三路钉选生效 / 键归一 / fail-open / 零差异 / 不落盘。

对应 2026-11-24 19:04 修复：POST /router/plan 的 stage_models 请求级钉选，
优先级高于 learnedOverride，且不写盘、不影响其他会话。

配置无关：候选模型从**本树已注册模型**动态取（生产树与公开脱敏树都能跑）。
不写盘、不起端口。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw  # noqa: E402  （导入即完成 router_plan.set_gateway）
import router_plan  # noqa: E402

PAYLOAD = {"task": "写一句话说明模型路由", "max_stages": 3}


def _pick_candidates(n: int = 3) -> list[str]:
	"""从已注册上游里取 n 个互不相同的 (upstream/model) 候选。"""
	out: list[str] = []
	for up_id in sorted(gw.UPSTREAM_MAP):
		for model_id in sorted(gw.UPSTREAM_MAP[up_id].models):
			key = f"{up_id}/{model_id}"
			if key not in out:
				out.append(key)
			if len(out) >= n:
				return out
	raise unittest.SkipTest("本树注册模型不足 3 个，钉选用例无法构造")


PIN_A, PIN_B, PIN_C = _pick_candidates(3)


def _keys(plan):
	return [s["model"]["key"] for s in plan["stages"]]


class PinHelpersCase(unittest.TestCase):
	def test_registered_candidates_exist(self):
		"""钉选用例依赖的三路模型必须真已注册，否则用例本身失真。"""
		for key in (PIN_A, PIN_B, PIN_C):
			up, mid = gw.split_candidate(key)
			self.assertIn(up, gw.UPSTREAM_MAP, key)
			self.assertIn(mid, gw.UPSTREAM_MAP[up].models, key)

	def test_stage_models_is_allowed_key(self):
		"""stage_models 必须在白名单里，否则会被 ignored_keys 吞掉。"""
		self.assertIn("stage_models", router_plan.ALLOWED_PLAN_KEYS)


class PinAppliedCase(unittest.TestCase):
	def test_no_pin_is_zero_diff(self):
		"""不传 stage_models ⇒ 与基线逐段一致（钉选默认零差异）。"""
		base, st = router_plan.build_plan(dict(PAYLOAD))
		self.assertEqual(st, 200, base)
		with_none, st2 = router_plan.build_plan({**PAYLOAD, "stage_models": None})
		self.assertEqual(st2, 200, with_none)
		self.assertEqual(_keys(base), _keys(with_none))
		self.assertFalse(with_none.get("stage_models_skipped"))

	def test_three_way_pin_takes_effect(self):
		"""三路钉选 ⇒ 三段 model_key 就是钉选值，且打上 pinned 标记与审计来源。"""
		plan, st = router_plan.build_plan(
			{**PAYLOAD, "stage_models": {"s1": PIN_A, "s2": PIN_B, "s3": PIN_C}})
		self.assertEqual(st, 200, plan)
		self.assertEqual(_keys(plan), [PIN_A, PIN_B, PIN_C])
		self.assertFalse(plan.get("stage_models_skipped"))
		self.assertEqual([s.get("pinned") for s in plan["stages"]], [True, True, True])
		# 审计痕：learned_override.stages[].source 应标 session_pin，区别于学习型覆盖
		ov = (plan.get("learned_override") or {}).get("stages") or []
		self.assertEqual([x.get("source") for x in ov], ["session_pin"] * 3)
		self.assertEqual([x.get("learned_at") for x in ov], [None, None, None])

	def test_pin_survives_replan(self):
		"""同一钉选连出两次计划结果一致 ⇒ 不再「弹回」策略链首位。"""
		payload = {**PAYLOAD, "stage_models": {"s1": PIN_A, "s2": PIN_B, "s3": PIN_C}}
		first, _ = router_plan.build_plan(dict(payload))
		second, _ = router_plan.build_plan(dict(payload))
		self.assertEqual(_keys(first), _keys(second))
		self.assertEqual(_keys(second), [PIN_A, PIN_B, PIN_C])

	def test_numeric_keys_equivalent(self):
		"""1-based 数字键与 sN 键等价。"""
		a, sa = router_plan.build_plan(
			{**PAYLOAD, "stage_models": {"1": PIN_A, "2": PIN_B, "3": PIN_C}})
		b, sb = router_plan.build_plan(
			{**PAYLOAD, "stage_models": {"s1": PIN_A, "s2": PIN_B, "s3": PIN_C}})
		self.assertEqual((sa, sb), (200, 200))
		self.assertEqual(_keys(a), _keys(b))

	def test_partial_pin_keeps_other_stages(self):
		"""只钉 s2 ⇒ 另两段仍按策略链，且不报错。"""
		base, _ = router_plan.build_plan(dict(PAYLOAD))
		plan, st = router_plan.build_plan({**PAYLOAD, "stage_models": {"s2": PIN_B}})
		self.assertEqual(st, 200, plan)
		keys = _keys(plan)
		self.assertEqual(keys[1], PIN_B)
		self.assertEqual(keys[0], _keys(base)[0])
		self.assertEqual(keys[2], _keys(base)[2])


class PinFailOpenCase(unittest.TestCase):
	def test_unregistered_model_is_skipped_not_fatal(self):
		"""未注册模型 ⇒ 记 skipped，该段回落策略链，计划仍 200（fail-open）。"""
		base, _ = router_plan.build_plan(dict(PAYLOAD))
		plan, st = router_plan.build_plan(
			{**PAYLOAD, "stage_models": {"s1": "no-such-upstream/no-such-model"}})
		self.assertEqual(st, 200, plan)
		skipped = plan.get("stage_models_skipped") or []
		self.assertEqual(len(skipped), 1)
		self.assertEqual(skipped[0]["reason"], "model_unregistered")
		self.assertEqual(_keys(plan)[0], _keys(base)[0])

	def test_bad_stage_id_is_skipped(self):
		plan, st = router_plan.build_plan({**PAYLOAD, "stage_models": {"zzz": PIN_A}})
		self.assertEqual(st, 200, plan)
		skipped = plan.get("stage_models_skipped") or []
		self.assertEqual([s["reason"] for s in skipped], ["bad_stage_id"])
		self.assertNotIn(PIN_A, _keys(plan))

	def test_bad_shape_is_skipped(self):
		for bad in (["s1", PIN_A], "s1=xx", 42):
			plan, st = router_plan.build_plan({**PAYLOAD, "stage_models": bad})
			self.assertEqual(st, 200, (bad, plan))
			skipped = plan.get("stage_models_skipped") or []
			self.assertEqual([s["reason"] for s in skipped], ["bad_shape"], bad)

	def test_blank_value_is_ignored_silently(self):
		plan, st = router_plan.build_plan({**PAYLOAD, "stage_models": {"s1": "   "}})
		self.assertEqual(st, 200, plan)
		self.assertFalse(plan.get("stage_models_skipped"))


class PinIsolationCase(unittest.TestCase):
	def test_pin_does_not_persist(self):
		"""钉选是请求级：带钉选出完计划后，不带钉选的计划应回到基线。"""
		router_plan.build_plan({**PAYLOAD, "stage_models": {"s1": PIN_A, "s2": PIN_B, "s3": PIN_C}})
		after, st = router_plan.build_plan(dict(PAYLOAD))
		self.assertEqual(st, 200, after)
		base, _ = router_plan.build_plan(dict(PAYLOAD))
		self.assertEqual(_keys(after), _keys(base))

	def test_pin_beats_learned_override(self):
		"""钉选优先级高于 learnedOverride：显式选择说了算。"""
		original = router_plan._learned_override
		try:
			router_plan._learned_override = lambda *a, **k: {"model": PIN_C, "hits": 99}
			plan, st = router_plan.build_plan({**PAYLOAD, "stage_models": {"s1": PIN_A}})
			self.assertEqual(st, 200, plan)
			self.assertEqual(_keys(plan)[0], PIN_A)
		finally:
			router_plan._learned_override = original


if __name__ == "__main__":
	unittest.main(verbosity=2)
