#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""hint 提示头（契约 v1.0）单元测试：不联网、不读写账本、不依赖真实时钟。

覆盖（派工单 M2 验收判据 1）：
- 合法 / 非法（坏 base64 / 非法 JSON / 非对象 / 错主版本 / 超长头 / reason 违纪）hint；
- model 缺失 / 不在能力清单 / 不可用（熔断、无视觉、上下文溢出）；
- tier 非法 / tier 链全不可用；
- 无 hint 回归（账本默认字段、计数零污染）；
- 能力清单结构（契约 §4）、账本字段（契约 §5）、灰度两模式、confirm 结构存在性计数（§8 附注 A）。

运行（在网关树根，需含 main.py 与 config/routing.json、upstreams.json）：
    cd <网关树根>
    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import base64
import json
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as router  # noqa: E402

# 样例配置对齐（跨侧交付）：把「期望的上游 / 模型 / 档位链」改为从当前部署的配置
# 现场推导。config_ref 只读 config/routing.json 与 upstreams.json，**不 import main**——
# 期望值与被测件各自独立解析配置，断言才不会退化成"用被测件的加载器算期望"。
sys.path.insert(0, str(Path(__file__).resolve().parent))
import config_ref as cfg  # noqa: E402


def first_usable_from_config(chain, circuit_ids=(), has_image=False,
                             est_input_tokens=100, max_tokens=512):
    """从配置推导「链内首个可用候选」（与 main 决策期检查同口径，但不 import 它）。

    规则全部来自配置声明：上游在 ``circuit_ids`` 里 → 跳过（熔断）；含图且该模型
    ``vision: false`` → 跳过（无视觉）；``est_input_tokens + max_tokens`` 超过
    ``context_window × 1.05`` → 跳过（上下文溢出，阈值同 ``main.candidate_supported``）。
    返回 None＝按配置全不可用。

    **不计 AFP 额度闸门**：闸门读的是外部活快照（采集器随时改写），不属于"配置声明的事实"，
    所以本 oracle 只按配置元数据判可用性；用例侧统一在 setUp 里关掉
    ``router.AFP_GATE_ACTIVE`` 把这条外部状态隔离掉，两边口径才对得上。
    """
    blocked = set(circuit_ids or ())
    for candidate in chain:
        up_id, _model = cfg.split_candidate(candidate)
        if up_id in blocked:
            continue
        spec = cfg.candidate_spec(candidate)
        if has_image and spec.get("vision") is False:
            continue
        window = cfg.context_window_of(candidate)
        if isinstance(window, int) and window > 0:
            if est_input_tokens + max(0, max_tokens) > window * 1.05:
                continue
        return candidate
    return None


#: 本文件用例沿用 make_parsed() 的默认档「high」（契约档位名固定为 low/mid/high）。
HINT_TIER = "high"
if HINT_TIER not in cfg.hint_tier_names():
    raise RuntimeError(f"配置 hint.tiers 缺少 {HINT_TIER!r} 档：现有 {cfg.hint_tier_names()}")

#: 期望的档位链（main 启动时按能力集剔除未声明模型；config_ref 同口径）。
HINT_TIER_CHAIN: list[str] = cfg.hint_tier(HINT_TIER)
if not HINT_TIER_CHAIN:
    raise RuntimeError(f"配置 hint.tiers[{HINT_TIER!r}] 生效链为空，无法构造 hint 决策用例")

#: 原生产配置里「高档首耗上游的旗舰模型」的角色＝「档内首个可用模型」（真名随配置而变）。
HINT_MODEL = first_usable_from_config(HINT_TIER_CHAIN)
if HINT_MODEL is None:
    raise RuntimeError(f"档位链 {HINT_TIER!r} 在默认特征下没有可用候选：{HINT_TIER_CHAIN}")

#: 配置声明 ``vision: false`` 的候选（图片请求不可用＝model_no_vision）；优先取档位链内的。
NO_VISION_CANDIDATES: list[str] = cfg.no_vision_candidates()
if not NO_VISION_CANDIDATES:
    raise RuntimeError("配置上游里没有任何 vision:false 的候选，无法构造无视觉用例")
NO_VISION_MODEL = next(
    (c for c in HINT_TIER_CHAIN if c in NO_VISION_CANDIDATES), NO_VISION_CANDIDATES[0])

#: 上下文窗口最小的候选（原用例写死 est=2_000_000，这里按配置现算）。
_WINDOWED = [(cfg.context_window_of(c), c) for c in cfg.CANDIDATES]
MIN_CONTEXT_WINDOW = min(w for w, _c in _WINDOWED if isinstance(w, int) and w > 0)
OVERFLOW_MODEL = next(c for w, c in _WINDOWED if w == MIN_CONTEXT_WINDOW)
#: 恰好越过 main 的溢出阈值（need > context_window × 1.05）。
OVERFLOW_INPUT_TOKENS = int(MIN_CONTEXT_WINDOW * 1.05) + 1


def b64(obj) -> str:
    return base64.b64encode(json.dumps(obj, ensure_ascii=False).encode("utf-8")).decode("ascii")


def make_hint(**overrides) -> dict:
    # 默认 model/tier 由配置推导（原夹具默认「旗舰模型」的角色＝档内首个可用模型）
    doc = {"v": 1, "tier": HINT_TIER, "model": HINT_MODEL,
           "stage": "execute", "session": "s-8f21c3", "reason": "complex-logic"}
    doc.update(overrides)
    return doc


def make_parsed(**kwargs) -> router.ParsedHint:
    base = dict(ok=True, error=None, tier=HINT_TIER, model=HINT_MODEL,
                stage="execute", session="s-8f21c3", reason="complex-logic", confirm=None,
                incomplete_missing=[])
    base.update(kwargs)
    return router.ParsedHint(**base)


def make_features(**kwargs) -> router.Features:
    base = dict(
        est_input_tokens=100, chars=220, message_count=2, image_count=0, has_image=False,
        has_tools=False, max_tokens=512, has_system=False,
    )
    base.update(kwargs)
    return router.Features(**base)


def state_map(circuit_ids=()) -> dict:
    """隔离的上游状态表：不碰进程内真实 STATE。"""
    result = {}
    for upstream in router.UPSTREAMS:
        st = router.UpstreamState(upstream)
        if upstream.id in circuit_ids:
            st.circuit_until = time.time() + 3600.0
        result[upstream.id] = st
    return result


# ---------------------------------------------------------------------------
# 解析：合法 / 非法
# ---------------------------------------------------------------------------


class TestParseHint(unittest.TestCase):
    def test_no_header_returns_none(self):
        self.assertIsNone(router.parse_hint_header(None))

    def test_empty_header_invalid(self):
        parsed = router.parse_hint_header("   ")
        self.assertIsNotNone(parsed)
        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.error, "empty")

    def test_oversize_header_invalid(self):
        big = base64.b64encode(b"x" * (router.HINT_MAX_HEADER_BYTES + 1)).decode()
        parsed = router.parse_hint_header(big)
        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.error, "oversize")

    def test_bad_base64_invalid(self):
        parsed = router.parse_hint_header("!!!not-base64!!!")
        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.error, "bad_base64")

    def test_bad_json_invalid(self):
        raw = base64.b64encode(b"{not json").decode()
        parsed = router.parse_hint_header(raw)
        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.error, "bad_json")

    def test_json_array_invalid(self):
        raw = base64.b64encode(b"[1,2,3]").decode()
        parsed = router.parse_hint_header(raw)
        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.error, "not_object")

    def test_wrong_major_version_invalid(self):
        for bad in ({"v": 2}, {"v": 0}, {"v": "1"}, {}):
            parsed = router.parse_hint_header(b64(bad))
            self.assertFalse(parsed.ok, bad)
            self.assertEqual(parsed.error, "version_mismatch", bad)

    def test_valid_full_hint(self):
        parsed = router.parse_hint_header(b64(make_hint()))
        self.assertTrue(parsed.ok, parsed.error)
        self.assertEqual(parsed.tier, HINT_TIER)
        self.assertEqual(parsed.model, HINT_MODEL)
        self.assertEqual(parsed.stage, "execute")
        self.assertEqual(parsed.session, "s-8f21c3")
        self.assertEqual(parsed.reason, "complex-logic")
        self.assertIsNone(parsed.confirm)
        self.assertEqual(parsed.incomplete_missing, [])

    def test_urlsafe_base64_accepted(self):
        raw = base64.urlsafe_b64encode(json.dumps(make_hint()).encode()).decode()
        parsed = router.parse_hint_header(raw)
        self.assertTrue(parsed.ok)

    def test_missing_padding_accepted(self):
        raw = b64(make_hint()).rstrip("=")
        parsed = router.parse_hint_header(raw)
        self.assertTrue(parsed.ok)

    def test_reason_over_64_chars_invalidates_whole_hint(self):
        parsed = router.parse_hint_header(b64(make_hint(reason="r" * 65)))
        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.error, "reason_discipline")

    def test_reason_exactly_64_chars_ok(self):
        parsed = router.parse_hint_header(b64(make_hint(reason="r" * 64)))
        self.assertTrue(parsed.ok)

    def test_non_string_reason_invalid(self):
        parsed = router.parse_hint_header(b64(make_hint(reason=123)))
        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.error, "reason_discipline")

    def test_whitespace_tier_treated_as_missing(self):
        parsed = router.parse_hint_header(b64(make_hint(tier="   ")))
        self.assertTrue(parsed.ok)
        self.assertIsNone(parsed.tier)

    def test_long_stage_dropped_but_hint_ok(self):
        parsed = router.parse_hint_header(b64(make_hint(stage="s" * 65)))
        self.assertTrue(parsed.ok)
        self.assertIsNone(parsed.stage)

    def test_long_session_dropped_but_hint_ok(self):
        parsed = router.parse_hint_header(b64(make_hint(session="s" * 129)))
        self.assertTrue(parsed.ok)
        self.assertIsNone(parsed.session)

    def test_unknown_extra_fields_tolerated(self):
        """契约 §6：增加可选字段＝兼容升级。未知字段忽略，不作废 hint。"""
        parsed = router.parse_hint_header(b64(make_hint(future_field={"x": 1}, another="y")))
        self.assertTrue(parsed.ok)

    def test_minimal_hint_tier_only(self):
        parsed = router.parse_hint_header(b64({"v": 1, "tier": "low"}))
        self.assertTrue(parsed.ok)
        self.assertEqual(parsed.tier, "low")
        self.assertIsNone(parsed.model)

    def test_parse_never_raises_on_garbage(self):
        for raw in ("\x00\x01", "eyJ2Ijoxfffffffff", "====", "e30=", "{}", "null", "12345"):
            parsed = router.parse_hint_header(raw)
            self.assertIsNotNone(parsed)  # 返回 ParsedHint（ok 可能为 False），绝不抛异常


# ---------------------------------------------------------------------------
# confirm 结构存在性计数（§8 附注 A：不拦截、不报错、不二次回问）
# ---------------------------------------------------------------------------


class TestConfirm(unittest.TestCase):
    def test_confirm_complete(self):
        confirm = {"goal": "g", "done": "d", "next": "n", "why": "w", "ctx": "c"}
        parsed = router.parse_hint_header(b64(make_hint(confirm=confirm)))
        self.assertTrue(parsed.ok)
        self.assertEqual(parsed.incomplete_missing, [])
        self.assertEqual(parsed.confirm, confirm)

    def test_confirm_missing_keys_counted_not_blocked(self):
        parsed = router.parse_hint_header(b64(make_hint(confirm={"goal": "g"})))
        self.assertTrue(parsed.ok)  # 缺项不拦截
        self.assertEqual(parsed.incomplete_missing, ["done", "next", "why", "ctx"])

    def test_confirm_non_object_counts_all_missing(self):
        parsed = router.parse_hint_header(b64(make_hint(confirm="oops")))
        self.assertTrue(parsed.ok)
        self.assertEqual(parsed.incomplete_missing, list(router.HINT_CONFIRM_KEYS))

    def test_no_confirm_no_incomplete(self):
        parsed = router.parse_hint_header(b64(make_hint()))
        self.assertTrue(parsed.ok)
        self.assertEqual(parsed.incomplete_missing, [])


# ---------------------------------------------------------------------------
# 能力清单（契约 §4）
# ---------------------------------------------------------------------------


class TestCapabilities(unittest.TestCase):
    """2026-11-13：models 改为对象列表（v2），过渡期另带 models_legacy。

    旧的平铺结构仍可用 ROUTER_CAPABILITIES_V2=0 取回（见
    tests/test_capabilities_occupancy.py::CapabilitiesV2Case）。
    """

    def test_shape_matches_contract(self):
        caps = router.capabilities_payload()
        self.assertEqual(set(caps.keys()),
                         {"v", "tiers", "models", "models_legacy", "defaults", "limits"})
        self.assertEqual(caps["v"], 1)
        self.assertEqual(caps["limits"], {"hint_max_bytes": 8192})
        self.assertEqual(caps["defaults"], {"tier": "mid"})
        self.assertEqual(set(caps["tiers"].keys()), {"low", "mid", "high"})

    def test_tier_chains_subset_of_models(self):
        caps = router.capabilities_payload()
        model_ids = {m["id"] for m in caps["models"]}
        for name, chain in caps["tiers"].items():
            self.assertTrue(chain, name)
            for cand in chain:
                self.assertIn(cand, model_ids, f"tier {name} 的 {cand} 必须在 models 里")

    def test_models_all_configured_upstream_models(self):
        caps = router.capabilities_payload()
        expected = {f"{u.id}/{m}" for u in router.UPSTREAMS for m in u.models}
        self.assertEqual({m["id"] for m in caps["models"]}, expected)
        for entry in caps["models"]:
            up_id, model_id = router.split_candidate(entry["id"])
            self.assertIn(up_id, router.UPSTREAM_MAP)
            self.assertTrue(router.UPSTREAM_MAP[up_id].model_spec(model_id))


# ---------------------------------------------------------------------------
# 档位覆盖决策
# ---------------------------------------------------------------------------


class TestHintDecision(unittest.TestCase):
    def setUp(self):
        # 2026-11-12 AFP 闸门：本类断言「配置档位链里候选」的可用性，必须与真实额度快照解耦
        #（生产额度快照会被采集器随时改写，avail=0 时对应上游会被闸门跳过）。
        # 期望值一律从 config_ref 推导，不再写死生产上游/模型名。
        self._gate = router.AFP_GATE_ACTIVE
        router.AFP_GATE_ACTIVE = False

    def tearDown(self):
        router.AFP_GATE_ACTIVE = self._gate

    def test_model_in_capability_and_usable_wins(self):
        """hint 模型在能力清单且决策期可用 → 直用。

        原断言写死某条生产上游的旗舰模型 id；现期望值＝配置推导出的
        「档内首个可用模型」（HINT_MODEL）。
        """
        decision = router.build_hint_decision(make_parsed(), make_features(), state_map())
        self.assertEqual(decision["candidates"][0], HINT_MODEL)
        self.assertEqual(decision["fallback"], 0)
        self.assertEqual(decision["reason"], "ok")
        self.assertEqual(decision["would_choose"], HINT_MODEL)
        self.assertEqual(decision["would_fallback"], 0)

    def test_model_first_then_tier_chain_as_fallback(self):
        """候选链 = [hint model] + 档位链（去重）；两段都由配置推导，不写死上游名。"""
        decision = router.build_hint_decision(make_parsed(), make_features(), state_map())
        self.assertEqual(decision["candidates"],
                         cfg.hint_chain_with_model(HINT_MODEL, HINT_TIER))

    def test_model_unavailable_falls_to_tier(self):
        """hint 模型所在上游熔断 → 按 tier 选档。

        期望值：candidates＝配置档位完整链；would_choose＝按链序跳过该上游后的首个可用项
        （原写死档内第二项的生产 id，现由 first_usable_from_config 从配置推导）。
        """
        hint_upstream, _hint_model_id = cfg.split_candidate(HINT_MODEL)
        decision = router.build_hint_decision(
            make_parsed(), make_features(), state_map(circuit_ids=(hint_upstream,)))
        self.assertEqual(decision["fallback"], 1)
        self.assertEqual(decision["reason"], "model_unavailable")
        self.assertEqual(decision["candidates"], cfg.hint_tier(HINT_TIER))
        self.assertEqual(decision["would_choose"],
                         first_usable_from_config(cfg.hint_tier(HINT_TIER),
                                                  circuit_ids=(hint_upstream,)))
        self.assertIn(HINT_MODEL, decision["candidates"])

    def test_model_without_vision_not_usable_for_image_request(self):
        """含图请求：hint 模型无视觉 → 不可用，回落到档位链里首个有视觉的候选。

        原写死「某条无视觉旗舰 → 某条有视觉强模型」；现要求 hint 模型**确实**是配置声明的
        ``vision: false``（链头若有视觉就显式换一个 no-vision 候选），期望 would_choose
        ＝配置链内首个 vision:true 且上下文够用的候选。
        """
        feats = make_features(has_image=True, image_count=1)
        model = HINT_MODEL if HINT_MODEL in NO_VISION_CANDIDATES else NO_VISION_MODEL
        self.assertIn(model, cfg.no_vision_candidates(), "hint 模型必须是配置声明的无视觉候选")
        decision = router.build_hint_decision(make_parsed(model=model), feats, state_map())
        self.assertEqual(decision["fallback"], 1)
        self.assertEqual(decision["reason"], "model_unavailable")
        self.assertEqual(decision["would_choose"],
                         first_usable_from_config(cfg.hint_tier(HINT_TIER), has_image=True,
                                                  est_input_tokens=feats.est_input_tokens,
                                                  max_tokens=feats.max_tokens))

    def test_model_context_overflow_not_usable(self):
        """输入超出模型上下文窗口 → 不可用（原写死 est=2_000_000，现按配置窗口现算）。"""
        window = cfg.context_window_of(OVERFLOW_MODEL)
        self.assertEqual(window, MIN_CONTEXT_WINDOW)
        self.assertGreater(OVERFLOW_INPUT_TOKENS + 0, window * 1.05)  # 确实越过溢出阈值
        feats = make_features(est_input_tokens=OVERFLOW_INPUT_TOKENS, max_tokens=0)
        decision = router.build_hint_decision(
            make_parsed(model=OVERFLOW_MODEL), feats, state_map())
        self.assertEqual(decision["reason"], "model_unavailable")
        self.assertEqual(decision["fallback"], 1)

    def test_model_unknown_falls_to_tier(self):
        """不在能力清单的 model 名（故意不存在的 id）→ 按档位链走（链头由配置推导）。"""
        decision = router.build_hint_decision(
            make_parsed(model="nope/does-not-exist"), make_features(), state_map())
        self.assertEqual(decision["fallback"], 1)
        self.assertEqual(decision["reason"], "model_unknown")
        self.assertEqual(decision["candidates"][0], HINT_TIER_CHAIN[0])

    def test_model_missing_uses_tier(self):
        """没有 model 只有 tier=low → 用 low 档完整链（原写死链，现取配置链）。"""
        low_chain = cfg.hint_tier("low")
        self.assertTrue(low_chain, "配置 hint.tiers.low 不能为空")
        decision = router.build_hint_decision(
            make_parsed(model=None, tier="low"), make_features(), state_map())
        self.assertEqual(decision["reason"], "model_missing")
        self.assertEqual(decision["fallback"], 1)
        self.assertEqual(decision["candidates"], low_chain)

    def test_tier_invalid_falls_to_default(self):
        decision = router.build_hint_decision(
            make_parsed(tier="ultra", model=None), make_features(), state_map())
        self.assertIsNone(decision["candidates"])
        self.assertEqual(decision["reason"], "tier_invalid")
        self.assertEqual(decision["fallback"], 1)
        self.assertIsNone(decision["would_choose"])

    def test_tier_chain_all_circuit_open(self):
        """low 档链上全部上游都熔断 → 无候选可选（熔断集合从配置链里的上游 id 推导）。"""
        low_chain = cfg.hint_tier("low")
        low_upstreams = tuple(dict.fromkeys(cfg.split_candidate(c)[0] for c in low_chain))
        self.assertTrue(low_upstreams, "配置 hint.tiers.low 不能为空")
        decision = router.build_hint_decision(
            make_parsed(model=None, tier="low"), make_features(),
            state_map(circuit_ids=low_upstreams))
        self.assertEqual(decision["reason"], "model_missing")
        self.assertIsNone(decision["would_choose"])
        self.assertEqual(decision["would_fallback"], 1)

    def test_unknown_upstream_model_not_usable(self):
        decision = router.build_hint_decision(
            make_parsed(model="ghost/model"), make_features(), state_map())
        self.assertEqual(decision["reason"], "model_unknown")


# ---------------------------------------------------------------------------
# 灰度两模式 + 结果口径（与响应头同源）
# ---------------------------------------------------------------------------


class TestHintOutcome(unittest.TestCase):
    def setUp(self):
        # 决策期可用性断言不能依赖活的额度快照（生产额度文件会被采集器随时改写，
        # 打穿时对应上游会被 AFP 闸门跳过 → 决策结果随外部状态漂移）。同 TestHintDecision。
        self._gate = router.AFP_GATE_ACTIVE
        router.AFP_GATE_ACTIVE = False

    def tearDown(self):
        router.AFP_GATE_ACTIVE = self._gate

    def _hctx(self, mode="execute", **parsed_kwargs):
        parsed = make_parsed(**parsed_kwargs)
        hctx = router.build_hint_ctx(parsed, "auto")
        hctx["decision"] = router.build_hint_decision(parsed, make_features(), state_map())
        hctx["mode"] = mode
        return hctx

    def test_execute_mode_hint_model_chosen(self):
        """execute 档实际选了 hint 模型（期望模型＝配置推导的 HINT_MODEL）→ ok。"""
        hctx = self._hctx(mode="execute")
        fallback, reason = router.hint_outcome(HINT_MODEL, hctx)
        self.assertEqual(fallback, 0)
        self.assertEqual(reason, "ok")

    def test_execute_mode_model_failed_at_call_time(self):
        """execute 档实际选的是档位链里**另一个**候选（≠ hint 模型）→ model_failed。

        原写死某条生产 id（档内第二项）；现从配置档位链取一个
        与 HINT_MODEL 不同的候选，并断言它确实存在。
        """
        hctx = self._hctx(mode="execute")
        other = next((c for c in HINT_TIER_CHAIN if c != HINT_MODEL), None)
        self.assertIsNotNone(other, "档位链需要 ≥2 个不同候选才能构造调用期失败用例")
        fallback, reason = router.hint_outcome(other, hctx)
        self.assertEqual(fallback, 1)
        self.assertEqual(reason, "model_failed")

    def test_record_mode_never_honors(self):
        hctx = self._hctx(mode="record")
        fallback, reason = router.hint_outcome("label/model-alpha", hctx)
        self.assertEqual(fallback, 1)
        self.assertEqual(reason, "record_only")

    def test_invalid_hint_outcome(self):
        parsed = router.parse_hint_header("garbage!!!")
        hctx = router.build_hint_ctx(parsed, "auto")
        fallback, reason = router.hint_outcome("label/model-alpha", hctx)
        self.assertEqual(fallback, 1)
        self.assertEqual(reason, "hint_invalid")

    def test_explicit_model_not_overridden(self):
        hctx = self._hctx(mode="execute")
        hctx["virtual"] = False  # 请求体显式指定了 upstream/model
        fallback, reason = router.hint_outcome("label/model-alpha", hctx)
        self.assertEqual(fallback, 1)
        self.assertEqual(reason, "explicit_model")

    def test_no_hint_returns_none(self):
        self.assertEqual(router.hint_outcome("x", None), (None, None))
        self.assertEqual(router.hint_outcome("x", {"present": False}), (None, None))


# ---------------------------------------------------------------------------
# 账本字段（契约 §5）
# ---------------------------------------------------------------------------


class TestHintLedgerFields(unittest.TestCase):
    def setUp(self):
        # 同 TestHintOutcome：账本 hint_would_choose 断言依赖决策可用性，必须与活的
        # 额度快照解耦（额度打穿时对应上游被 AFP 闸门跳过会让本类变成环境依赖的假红）。
        self._gate = router.AFP_GATE_ACTIVE
        router.AFP_GATE_ACTIVE = False

    def tearDown(self):
        router.AFP_GATE_ACTIVE = self._gate

    def test_no_hint_zero_fields(self):
        fields = router.hint_ledger_fields("label/model-alpha", None)
        self.assertEqual(fields["hint"], 0)
        self.assertIsNone(fields["fallback"])
        self.assertIsNone(fields["tier"])
        self.assertIsNone(fields["model_requested"])
        self.assertEqual(fields["model_chosen"], "label/model-alpha")

    def test_invalid_hint_fields(self):
        parsed = router.parse_hint_header("garbage!!!")
        hctx = router.build_hint_ctx(parsed, "auto")
        fields = router.hint_ledger_fields("label/model-alpha", hctx)
        self.assertEqual(fields["hint"], 0)
        self.assertEqual(fields["hint_error"], "bad_base64")
        self.assertEqual(fields["fallback"], 1)
        self.assertEqual(fields["hint_reason"], "hint_invalid")

    def test_valid_hint_fields_execute(self):
        """execute 档 + hint 模型被采用 → 账本字段全对齐（期望值从配置推导）。"""
        parsed = make_parsed()
        hctx = router.build_hint_ctx(parsed, "auto")
        hctx["mode"] = "execute"
        hctx["decision"] = router.build_hint_decision(parsed, make_features(), state_map())
        fields = router.hint_ledger_fields(HINT_MODEL, hctx)
        self.assertEqual(fields["hint"], 1)
        self.assertEqual(fields["tier"], HINT_TIER)
        self.assertEqual(fields["model_requested"], HINT_MODEL)
        self.assertEqual(fields["model_chosen"], HINT_MODEL)
        self.assertEqual(fields["fallback"], 0)
        self.assertEqual(fields["hint_reason"], "ok")
        self.assertEqual(fields["hint_stage"], "execute")
        self.assertEqual(fields["session"], "s-8f21c3")
        self.assertEqual(fields["hint_mode"], "execute")

    def test_record_mode_fields_with_would_choose(self):
        """record 灰度：只记「若执行会怎么选」——would_choose 期望值＝配置推导的 HINT_MODEL。

        第二个参数 chosen 只是"实际选中的模型标签"（record 下不进配置判定，纯透传记录），
        故保留任意 id 不影响本用例检验的行为。
        """
        parsed = make_parsed()
        hctx = router.build_hint_ctx(parsed, "auto")
        hctx["mode"] = "record"
        hctx["decision"] = router.build_hint_decision(parsed, make_features(), state_map())
        fields = router.hint_ledger_fields("label/model-alpha", hctx)
        self.assertEqual(fields["hint_mode"], "record")
        self.assertEqual(fields["fallback"], 1)
        self.assertEqual(fields["hint_reason"], "record_only")
        self.assertEqual(fields["hint_would_choose"], HINT_MODEL)
        self.assertEqual(fields["hint_would_fallback"], 0)
        self.assertNotIn("hint_would_choose", router.hint_ledger_fields("x", None))

    def test_incomplete_confirm_recorded(self):
        parsed = router.parse_hint_header(
            b64(make_hint(confirm={"goal": "g"})))
        hctx = router.build_hint_ctx(parsed, "auto")
        self.assertTrue(hctx["ok"])  # 缺项不拦截
        fields = router.hint_ledger_fields("label/model-alpha", hctx)
        self.assertTrue(fields["hint_incomplete"])
        self.assertEqual(fields["hint_incomplete_missing"], ["done", "next", "why", "ctx"])

    def test_ledger_entry_defaults_have_hint_fields(self):
        """无 hint 回归：既有 make_ledger_entry 调用（不传 hint_fields）也带完整 hint 字段。"""
        entry = router.make_ledger_entry(
            req_id="req-1", virtual_model="auto", features=make_features(),
            stage="L1", period="offpeak", candidates=["label/model-alpha"],
            chosen="label/model-alpha", reason="低峰L1", attempts=[],
            usage=None, final_status="ok")
        for key in ("hint", "hint_error", "tier", "model_requested", "model_chosen",
                    "fallback", "hint_stage", "session"):
            self.assertIn(key, entry)
        self.assertEqual(entry["hint"], 0)

    def test_ledger_never_contains_reason_field_body(self):
        """reason 超长违纪时整头作废，违纪原文绝不落账本。"""
        bad_reason = "用户想让我干坏事1234567890abcdefghij" * 10  # 300 字符，>64
        parsed = router.parse_hint_header(b64(make_hint(reason=bad_reason)))
        self.assertFalse(parsed.ok)
        hctx = router.build_hint_ctx(parsed, "auto")
        fields = router.hint_ledger_fields("x", hctx)
        dumped = json.dumps(fields, ensure_ascii=False)
        self.assertNotIn("用户想让我干坏事", dumped)


# ---------------------------------------------------------------------------
# 账本 applied 列（跨侧口径 2026-11-12：execute 且 decision.candidates 被采用 → 1）
# ---------------------------------------------------------------------------


class TestHintApplied(unittest.TestCase):
    def test_no_hint_applied_zero(self):
        self.assertEqual(router.hint_applied(None), 0)
        self.assertEqual(router.hint_applied({"present": False, "ok": False}), 0)

    def test_invalid_hint_applied_zero(self):
        parsed = router.parse_hint_header("garbage!!!")
        hctx = router.build_hint_ctx(parsed, "auto")
        fields = router.hint_ledger_fields("label/model-alpha", hctx)
        self.assertEqual(fields["applied"], 0)
        self.assertEqual(fields["fallback"], 1)  # 判定回落照记，与 applied 解耦

    def test_execute_and_executed_applied_one(self):
        parsed = make_parsed()
        hctx = router.build_hint_ctx(parsed, "auto")
        hctx["mode"] = "execute"
        hctx["decision"] = router.build_hint_decision(parsed, make_features(), state_map())
        hctx["executed"] = True
        fields = router.hint_ledger_fields(HINT_MODEL, hctx)
        self.assertEqual(fields["applied"], 1)
        self.assertEqual(fields["hint_mode"], "execute")

    def test_execute_without_executed_applied_zero(self):
        """execute 档但决策没被执行（如显式 model 透传、决策无候选）→ applied=0。"""
        parsed = make_parsed()
        hctx = router.build_hint_ctx(parsed, "auto")
        hctx["mode"] = "execute"
        hctx["executed"] = False
        self.assertEqual(router.hint_ledger_fields("label/model-alpha", hctx)["applied"], 0)

    def test_record_mode_applied_zero_even_if_flag_leaks(self):
        """record 恒 0：判定回落（fallback=1/record_only）不等于已执行。"""
        parsed = make_parsed()
        hctx = router.build_hint_ctx(parsed, "auto")
        hctx["mode"] = "record"
        hctx["decision"] = router.build_hint_decision(parsed, make_features(), state_map())
        hctx["executed"] = True  # 防御：即便标记误置，record 也不算生效
        fields = router.hint_ledger_fields("label/model-alpha", hctx)
        self.assertEqual(fields["applied"], 0)
        self.assertEqual(fields["fallback"], 1)
        self.assertEqual(fields["hint_reason"], "record_only")

    def test_ledger_entry_carries_applied_default(self):
        entry = router.make_ledger_entry(
            req_id="req-a", virtual_model="auto", features=make_features(),
            stage="L1", period="offpeak", candidates=["label/model-alpha"],
            chosen="label/model-alpha", reason="低峰L1", attempts=[],
            usage=None, final_status="ok")
        self.assertIn("applied", entry)
        self.assertEqual(entry["applied"], 0)


# ---------------------------------------------------------------------------
# 计数器
# ---------------------------------------------------------------------------


class TestHintCounters(unittest.TestCase):
    def test_no_header_no_counter(self):
        before = router.hint_stats()
        hctx = router.build_hint_ctx(None, "auto")
        self.assertEqual(hctx, {"present": False, "ok": False})
        self.assertEqual(router.hint_stats(), before)

    def test_invalid_hint_counts(self):
        before = router.hint_stats()
        router.build_hint_ctx(router.parse_hint_header("!!!"), "auto")
        after = router.hint_stats()
        self.assertEqual(after["received"], before["received"] + 1)
        self.assertEqual(after["invalid"], before["invalid"] + 1)

    def test_valid_and_incomplete_counted(self):
        before = router.hint_stats()
        router.build_hint_ctx(router.parse_hint_header(
            b64(make_hint(confirm={"goal": "g"}))), "auto")
        after = router.hint_stats()
        self.assertEqual(after["valid"], before["valid"] + 1)
        self.assertEqual(after["incomplete"], before["incomplete"] + 1)

    def test_stats_payload_contains_hint_block(self):
        stats = router.stats_payload()
        self.assertIn("hint", stats)
        for key in ("mode", "contract_version", "received", "valid", "invalid",
                    "executed", "record_only", "honored", "fallback", "incomplete"):
            self.assertIn(key, stats["hint"])
        self.assertIn(router.HINT_MODE, ("record", "execute"))


# ---------------------------------------------------------------------------
# hint 模型可用性（决策期检查）
# ---------------------------------------------------------------------------


class TestHintModelUsable(unittest.TestCase):
    def setUp(self):
        # 2026-11-12 AFP 闸门：与真实额度快照解耦（同 TestHintDecision）
        self._gate = router.AFP_GATE_ACTIVE
        router.AFP_GATE_ACTIVE = False

    def tearDown(self):
        router.AFP_GATE_ACTIVE = self._gate

    def test_usable_model(self):
        """配置里已声明、上游健康、无视觉/上下文约束的模型 → 可用（真名随配置）。"""
        ok, why = router.hint_model_usable(HINT_MODEL, make_features(), state_map())
        self.assertTrue(ok, why)

    def test_circuit_open_not_usable(self):
        """该模型上游熔断 → 不可用（熔断的 upstream id 从候选名 split 出来，不写死）。"""
        upstream_id, _model_id = cfg.split_candidate(HINT_MODEL)
        ok, why = router.hint_model_usable(
            HINT_MODEL, make_features(), state_map(circuit_ids=(upstream_id,)))
        self.assertFalse(ok)
        self.assertIn("circuit_open", why)

    def test_unknown_upstream_not_usable(self):
        ok, why = router.hint_model_usable("ghost/model", make_features(), state_map())
        self.assertFalse(ok)
        self.assertEqual(why, "unknown_upstream")

    def test_vision_mismatch_not_usable(self):
        """含图请求 + 配置声明 vision:false 的模型 → model_no_vision（先断言它确实 no-vision）。"""
        self.assertIn(NO_VISION_MODEL, cfg.no_vision_candidates(),
                      "选出的模型必须是配置声明 vision:false 的候选")
        ok, why = router.hint_model_usable(NO_VISION_MODEL,
                                           make_features(has_image=True, image_count=1),
                                           state_map())
        self.assertFalse(ok)
        self.assertEqual(why, "model_no_vision")


# ---------------------------------------------------------------------------
# 换挡守门（接口单 v1.0：X-DSH-Check / checkSwitch）
# ---------------------------------------------------------------------------


def make_check(prev: dict | None = None, **next_overrides) -> dict:
    """构造 X-DSH-Check 的 {prev, next} 结构。"""
    nxt = {"session": "s-8f21c3", "contextTokens": 10000, "goalHash": "goal-aaa",
           "ctxId": "ctx-111",
           "check": {"goal": "写周报", "done": "收集了材料", "next": "生成初稿",
                     "why": "上下文变长", "ctx": "上下文标识"}}
    nxt.update(next_overrides)
    return {"prev": prev, "next": nxt}


def make_prev(**overrides) -> dict:
    prev = {"tier": "mid", "model": "alpha/A2", "contextTokens": 10000,
            "goalHash": "goal-aaa", "ctxId": "ctx-111"}
    prev.update(overrides)
    return prev


class TestParseCheckHeader(unittest.TestCase):
    def test_no_header_returns_none(self):
        self.assertIsNone(router.parse_check_header(None))

    def test_valid_full_check(self):
        doc = make_check(make_prev())
        parsed = router.parse_check_header(b64(doc))
        self.assertTrue(parsed.ok, parsed.error)
        self.assertEqual(parsed.prev["tier"], "mid")
        self.assertEqual(parsed.next["goalHash"], "goal-aaa")

    def test_bad_base64_bypass(self):
        parsed = router.parse_check_header("!!!")
        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.error, "bad_base64")

    def test_bad_json_bypass(self):
        parsed = router.parse_check_header(base64.b64encode(b"{oops").decode())
        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.error, "bad_json")

    def test_missing_next_bypass(self):
        parsed = router.parse_check_header(b64({"prev": make_prev()}))
        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.error, "no_next")

    def test_prev_optional(self):
        parsed = router.parse_check_header(b64({"next": make_check()["next"]}))
        self.assertTrue(parsed.ok)
        self.assertIsNone(parsed.prev)

    def test_oversize_bypass(self):
        doc = make_check(make_prev(), pad="x" * 12000)
        parsed = router.parse_check_header(b64(doc))
        self.assertFalse(parsed.ok)
        self.assertEqual(parsed.error, "oversize")

    def test_parse_never_raises(self):
        for raw in ("\x00", "e30=", "[]", "null", "===="):
            parsed = router.parse_check_header(raw)
            self.assertIsNotNone(parsed)


class TestCheckSwitch(unittest.TestCase):
    """接口单 §五 三条真机验收对应的逻辑分支（每条断言 action/reason/contextRatio/missing）。"""

    def test_acceptance_1_normal_switch_allowed(self):
        """验收 1：同会话正常换挡 → 放行（目标/约束不变）。"""
        verdict = router.check_switch(make_prev(), make_check()["next"])
        self.assertEqual(verdict["action"], "allow")
        self.assertEqual(verdict["reason"], "ok")
        self.assertEqual(verdict["contextRatio"], 1.0)
        self.assertEqual(verdict["missing"], 0)

    def test_acceptance_2_context_cliff_falls_back(self):
        """验收 2：上下文断崖（如摘要压缩后）→ 拦，回落上一档。"""
        nxt = make_check(make_prev(contextTokens=10000), contextTokens=5000)["next"]
        verdict = router.check_switch(make_prev(contextTokens=10000), nxt)
        self.assertEqual(verdict["action"], "fallback")
        self.assertEqual(verdict["reason"], "context_cliff")
        self.assertEqual(verdict["contextRatio"], 0.5)
        self.assertEqual(verdict["missing"], 0)
        self.assertEqual(verdict["prev_tier"], "mid")
        self.assertEqual(verdict["prev_model"], "alpha/A2")

    def test_acceptance_3_goal_drift_falls_back(self):
        """验收 3：目标漂移（换挡时目标指纹变）→ 拦，回落上一档。"""
        nxt = make_check(make_prev(goalHash="goal-aaa"), goalHash="goal-bbb")["next"]
        verdict = router.check_switch(make_prev(goalHash="goal-aaa"), nxt)
        self.assertEqual(verdict["action"], "fallback")
        self.assertEqual(verdict["reason"], "goal_drift")
        self.assertEqual(verdict["contextRatio"], 1.0)
        self.assertEqual(verdict["missing"], 0)

    def test_ctx_id_changed_falls_back(self):
        verdict = router.check_switch(make_prev(ctxId="ctx-111"),
                                      make_check(make_prev(ctxId="ctx-111"),
                                                 ctxId="ctx-222")["next"])
        self.assertEqual(verdict["action"], "fallback")
        self.assertEqual(verdict["reason"], "ctx_changed")

    def test_goal_drift_wins_over_cliff_and_ctx(self):
        """多条同时命中：reason 取信息量最大者（goal_drift > context_cliff > ctx_changed）。"""
        nxt = make_check(make_prev(goalHash="a", ctxId="x", contextTokens=10000),
                         goalHash="b", ctxId="y", contextTokens=100)["next"]
        verdict = router.check_switch(make_prev(goalHash="a", ctxId="x", contextTokens=10000), nxt)
        self.assertEqual(verdict["reason"], "goal_drift")

    def test_cliff_wins_over_ctx_changed(self):
        nxt = make_check(make_prev(ctxId="x", contextTokens=10000),
                         ctxId="y", contextTokens=100)["next"]
        verdict = router.check_switch(make_prev(ctxId="x", contextTokens=10000), nxt)
        self.assertEqual(verdict["reason"], "context_cliff")

    def test_ratio_boundary_exactly_08_allowed(self):
        """接口单 §四：低于 0.8 才拦（0.8 本身放行）。"""
        nxt = make_check(make_prev(contextTokens=10000), contextTokens=8000)["next"]
        verdict = router.check_switch(make_prev(contextTokens=10000), nxt)
        self.assertEqual(verdict["action"], "allow")
        self.assertEqual(verdict["contextRatio"], 0.8)

    def test_ratio_just_below_threshold_blocked(self):
        nxt = make_check(make_prev(contextTokens=10000), contextTokens=7999)["next"]
        verdict = router.check_switch(make_prev(contextTokens=10000), nxt)
        self.assertEqual(verdict["action"], "fallback")
        self.assertEqual(verdict["reason"], "context_cliff")
        self.assertAlmostEqual(verdict["contextRatio"], 0.7999)

    def test_ratio_growing_context_allowed(self):
        """上下文变长（ratio>1）＝正常积累，放行。"""
        nxt = make_check(make_prev(contextTokens=10000), contextTokens=50000)["next"]
        verdict = router.check_switch(make_prev(contextTokens=10000), nxt)
        self.assertEqual(verdict["action"], "allow")
        self.assertEqual(verdict["contextRatio"], 5.0)

    def test_missing_check_items_counted_not_blocked(self):
        """对表五项有空 → allow_with_count（缺项数进账本，不拦不回问）。"""
        nxt = make_check(make_prev(), check={"goal": "写周报", "done": ""})["next"]
        verdict = router.check_switch(make_prev(), nxt)
        self.assertEqual(verdict["action"], "allow_with_count")
        self.assertEqual(verdict["reason"], "check_missing")
        self.assertEqual(verdict["missing"], 4)  # done 空串 + next/why/ctx 缺

    def test_missing_check_all_empty_counts_five(self):
        verdict = router.check_switch(make_prev(), make_check(make_prev(), check={})["next"])
        self.assertEqual(verdict["action"], "allow_with_count")
        self.assertEqual(verdict["missing"], 5)

    def test_missing_non_string_values_counted(self):
        nxt = make_check(make_prev(), check={"goal": "g", "done": None, "next": 3,
                                             "why": "  ", "ctx": "c"})["next"]
        verdict = router.check_switch(make_prev(), nxt)
        self.assertEqual(verdict["missing"], 3)  # None / 数字 / 空白串都算缺

    def test_missing_plus_fallback_records_both(self):
        """缺项＋回落同时出现：action=fallback（拦优先），missing 照记（只记不判）。"""
        nxt = make_check(make_prev(goalHash="a"), goalHash="b",
                         check={"goal": "g"})["next"]
        verdict = router.check_switch(make_prev(goalHash="a"), nxt)
        self.assertEqual(verdict["action"], "fallback")
        self.assertEqual(verdict["reason"], "goal_drift")
        self.assertEqual(verdict["missing"], 4)

    def test_no_prev_is_new_session(self):
        verdict = router.check_switch(None, make_check()["next"])
        self.assertEqual(verdict["action"], "new_session")
        self.assertEqual(verdict["reason"], "no_prev")

    def test_prev_without_tier_or_model_is_new_session(self):
        """prev 无档位可回落（tier/model 都空）＝非换挡。"""
        verdict = router.check_switch({"contextTokens": 100, "goalHash": "a", "ctxId": "x"},
                                      make_check()["next"])
        self.assertEqual(verdict["action"], "new_session")

    def test_prev_with_only_tier_usable(self):
        verdict = router.check_switch({"tier": "low"}, make_check()["next"])
        self.assertEqual(verdict["action"], "allow")
        self.assertEqual(verdict["prev_tier"], "low")
        self.assertIsNone(verdict["prev_model"])

    def test_missing_tokens_no_ratio_no_cliff(self):
        """contextTokens 缺失 → ratio=None，不判崖（缺数据不判）。"""
        nxt = make_check(make_prev(contextTokens=10000), contextTokens=None)["next"]
        verdict = router.check_switch(make_prev(contextTokens=10000), nxt)
        self.assertIsNone(verdict["contextRatio"])
        self.assertEqual(verdict["action"], "allow")

    def test_prev_tokens_missing_no_ratio(self):
        nxt = make_check()["next"]
        verdict = router.check_switch({"tier": "mid", "contextTokens": 0}, nxt)
        self.assertIsNone(verdict["contextRatio"])

    def test_hash_missing_on_one_side_not_judged(self):
        """指纹单侧缺失 → 不判漂移（宁放行不误拦）。"""
        nxt = make_check(make_prev(goalHash=None), goalHash="goal-zzz")["next"]
        verdict = router.check_switch(make_prev(goalHash=None), nxt)
        self.assertEqual(verdict["action"], "allow")

    def test_non_positive_tokens_ignored(self):
        nxt = make_check(make_prev(contextTokens=10000), contextTokens=-5)["next"]
        verdict = router.check_switch(make_prev(contextTokens=10000), nxt)
        self.assertIsNone(verdict["contextRatio"])

    def test_threshold_configurable(self):
        """断崖阈值可配（接口单 §四）：调到 0.5 后 0.6 不再判断崖。"""
        original = router.GUARD_CONTEXT_RATIO_MIN
        try:
            router.GUARD_CONTEXT_RATIO_MIN = 0.5
            nxt = make_check(make_prev(contextTokens=10000), contextTokens=6000)["next"]
            verdict = router.check_switch(make_prev(contextTokens=10000), nxt)
            self.assertEqual(verdict["action"], "allow")
            nxt2 = make_check(make_prev(contextTokens=10000), contextTokens=4000)["next"]
            self.assertEqual(router.check_switch(make_prev(contextTokens=10000), nxt2)["reason"],
                             "context_cliff")
        finally:
            router.GUARD_CONTEXT_RATIO_MIN = original


class TestGuardIntegration(unittest.TestCase):
    def _guard(self, check_doc: dict | None) -> dict:
        parsed = (router.parse_check_header(b64(check_doc)) if check_doc is not None else None)
        return router.evaluate_guard(parsed)

    def test_evaluate_guard_none_when_no_header(self):
        self.assertEqual(self._guard(None), {"present": False})

    def test_evaluate_guard_invalid_counts(self):
        guard = self._guard({"prev": make_prev()})  # 缺 next
        self.assertTrue(guard["present"])
        self.assertFalse(guard["ok"])
        self.assertEqual(guard["reason"], "bad_check_header")
        self.assertEqual(guard["error"], "no_next")

    def test_evaluate_guard_allow(self):
        guard = self._guard(make_check(make_prev()))
        self.assertEqual(guard["action"], "allow")

    def test_apply_guard_fallback_rewrites_tier_and_model(self):
        guard = self._guard(make_check(make_prev(tier="low", model="alpha/A1"),
                                       goalHash="goal-bbb"))
        parsed = make_parsed(tier="high", model="alpha/A3")
        effective = router.apply_guard_to_hint(parsed, guard)
        self.assertEqual(effective.tier, "low")
        self.assertEqual(effective.model, "alpha/A1")
        self.assertEqual(effective.session, parsed.session)  # 其余字段保留
        self.assertEqual(effective.stage, parsed.stage)

    def test_apply_guard_no_fallback_unchanged(self):
        guard = self._guard(make_check(make_prev()))
        parsed = make_parsed()
        effective = router.apply_guard_to_hint(parsed, guard)
        self.assertEqual(effective.tier, parsed.tier)
        self.assertEqual(effective.model, parsed.model)

    def test_apply_guard_invalid_hint_unchanged(self):
        guard = self._guard(make_check(make_prev(), goalHash="goal-bbb"))
        parsed = router.parse_hint_header("!!!")  # ok=False
        effective = router.apply_guard_to_hint(parsed, guard)
        self.assertIs(effective, parsed)

    def test_apply_guard_prev_model_missing_keeps_tier_only(self):
        """prev 只有 tier 无 model → 回落 tier，model 清空（按档选）。"""
        guard = self._guard(make_check(make_prev(tier="low", model=None), goalHash="goal-bbb"))
        parsed = make_parsed(tier="high", model="alpha/A3")
        effective = router.apply_guard_to_hint(parsed, guard)
        self.assertEqual(effective.tier, "low")
        self.assertIsNone(effective.model)

    def test_guard_ledger_fields_absent(self):
        fields = router.guard_ledger_fields(None, None, {"present": False})
        self.assertFalse(fields["guard_present"])
        self.assertIsNone(fields["contextRatio"])
        self.assertIsNone(fields["missing"])

    def test_guard_ledger_fields_fallback(self):
        guard = self._guard(make_check(make_prev(tier="low", model="alpha/A1"),
                                       goalHash="goal-bbb", contextTokens=5000))
        fields = router.guard_ledger_fields("high", "alpha/A3", guard)
        self.assertTrue(fields["guard_present"])
        self.assertEqual(fields["guard_action"], "fallback")
        self.assertEqual(fields["guard_reason"], "goal_drift")
        self.assertEqual(fields["contextRatio"], 0.5)
        self.assertEqual(fields["missing"], 0)
        self.assertEqual(fields["guard_next_tier"], "high")       # 插件想要的
        self.assertEqual(fields["guard_next_model"], "alpha/A3")
        self.assertEqual(fields["guard_prev_tier"], "low")        # 回落源
        self.assertEqual(fields["guard_prev_model"], "alpha/A1")

    def test_guard_ledger_fields_bad_header(self):
        guard = self._guard({"prev": make_prev()})
        fields = router.guard_ledger_fields(None, None, guard)
        self.assertTrue(fields["guard_present"])
        self.assertEqual(fields["guard_reason"], "bad_check_header")
        self.assertEqual(fields["guard_error"], "no_next")
        self.assertIsNone(fields["guard_action"])

    def test_hint_ledger_includes_guard_block(self):
        """hctx 带 guard 块时，hint 账本字段合并守门字段（含无 hint 的情形）。"""
        guard = router.evaluate_guard(router.parse_check_header(b64(make_check(make_prev()))))
        hctx = {"present": False, "ok": False, "guard": guard,
                "raw_tier": "high", "raw_model": "alpha/A3"}
        fields = router.hint_ledger_fields("alpha/A1", hctx)
        self.assertEqual(fields["hint"], 0)  # X-DSH-Route 没带 → hint 轨无提示
        self.assertTrue(fields["guard_present"])
        self.assertEqual(fields["guard_action"], "allow")
        self.assertEqual(fields["guard_next_tier"], "high")

    def test_stats_contains_guard_counters(self):
        stats = router.stats_payload()
        for key in ("guard_allow", "guard_allow_with_count", "guard_fallback",
                    "guard_new_session", "guard_invalid"):
            self.assertIn(key, stats["hint"])

    def test_guard_counters_increment(self):
        before = router.hint_stats()
        self._guard(make_check(make_prev(tier="low"), goalHash="goal-bbb"))
        after = router.hint_stats()
        self.assertEqual(after["guard_fallback"], before["guard_fallback"] + 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
