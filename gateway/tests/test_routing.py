#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""路由决策单元测试：不联网、不读写账本、不依赖真实时钟。

期望值来自**当前部署的配置**（config/routing.json ＋ upstreams.json），
由 ``tests/config_ref.py`` 现场推导；用例里不再写死上游 id / 模型名，
所以同一套用例在脱敏样例配置与任何一方的真实配置下都能跑（跨侧交付）。

运行：
    cd <网关树根>            # 树根需含 main.py 与 config/routing.json、upstreams.json
    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import main as router  # noqa: E402
import config_ref as cfg  # noqa: E402  （期望值推导器：只读配置，不 import main）


def make_features(**kwargs) -> router.Features:
    base = dict(
        est_input_tokens=100,
        chars=220,
        message_count=2,
        image_count=0,
        has_image=False,
        has_tools=False,
        max_tokens=512,
        has_system=False,
    )
    base.update(kwargs)
    return router.Features(**base)


# 由配置推导的夹具（全部现场算，不写死任何上游/模型名）：
#   TEXT_MODEL       —— 第一个"有视觉能力"的候选（无图请求也必然可用）
#   NO_VISION_MODEL  —— 第一个 vision=false 的候选（图片请求应判 model_no_vision）
#   SMALL_CTX_MODEL  —— context_window 最小的候选（构造上下文溢出）
#   BIG_CTX_MODEL    —— context_window 最大的候选（大窗口仍应放行）
#   UNIQUE_MODEL_ID  —— 只在一个上游声明过的模型名（裸模型名兼容用）
TEXT_MODEL = cfg.vision_candidates()[0]
NO_VISION_MODEL = cfg.no_vision_candidates()[0]
SMALL_CTX_MODEL = min(
    (c for c in cfg.CANDIDATES if cfg.context_window_of(c)),
    key=lambda c: cfg.context_window_of(c),
)
BIG_CTX_MODEL = max(
    (c for c in cfg.CANDIDATES if cfg.context_window_of(c)),
    key=lambda c: cfg.context_window_of(c),
)
_UNIQUE: dict[str, list[str]] = {}
for _cand in cfg.CANDIDATES:
    _UNIQUE.setdefault(cfg.split_candidate(_cand)[1], []).append(_cand)
UNIQUE_MODEL_ID = next(m for m, cands in _UNIQUE.items() if len(cands) == 1)
UNIQUE_CANDIDATE = next(c for c in cfg.CANDIDATES if c == f"{cfg.split_candidate(c)[0]}/{UNIQUE_MODEL_ID}")


# ---------------------------------------------------------------------------
# Token 估算
# ---------------------------------------------------------------------------


class TestTokenEstimate(unittest.TestCase):
    def test_ascii_chars(self):
        feats = router.extract_features({"messages": [{"role": "user", "content": "a" * 220}]})
        self.assertEqual(feats.est_input_tokens, 100)  # 220 / 2.2

    def test_chinese_chars(self):
        feats = router.extract_features({"messages": [{"role": "user", "content": "字" * 110}]})
        self.assertEqual(feats.est_input_tokens, 50)  # 110 / 2.2

    def test_image_uses_fixed_cost_not_data_url_length(self):
        data_url = "data:image/png;base64," + "A" * 20000
        payload = {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "这图里是什么？"},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ]
        }
        feats = router.extract_features(payload)
        self.assertTrue(feats.has_image)
        self.assertEqual(feats.image_count, 1)
        # 字符数不含 data URL，只按 1000 token 固定成本
        self.assertLess(feats.chars, 100)
        self.assertEqual(feats.est_input_tokens, 1000 + 4)  # 7 字符 / 2.2 向上取整

    def test_tools_chars_counted(self):
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "读取文件",
                    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
                },
            }
        ]
        payload = {
            "messages": [{"role": "user", "content": "hi"}],
            "tools": tools,
            "tool_choice": "auto",
        }
        feats = router.extract_features(payload)
        self.assertTrue(feats.has_tools)
        self.assertGreater(feats.est_input_tokens, 2)

    def test_max_completion_tokens_alias(self):
        feats = router.extract_features(
            {"messages": [{"role": "user", "content": "hi"}], "max_completion_tokens": 4096}
        )
        self.assertEqual(feats.max_tokens, 4096)

    def test_system_message_flag(self):
        feats = router.extract_features(
            {"messages": [{"role": "system", "content": "x"}, {"role": "user", "content": "y"}]}
        )
        self.assertTrue(feats.has_system)
        self.assertEqual(feats.message_count, 2)

    def test_completions_prompt(self):
        feats = router.extract_features({"prompt": "a" * 220}, completions=True)
        self.assertEqual(feats.est_input_tokens, 100)
        self.assertEqual(feats.message_count, 1)


# ---------------------------------------------------------------------------
# 复杂度分级
# ---------------------------------------------------------------------------


class TestClassify(unittest.TestCase):
    def test_simple_is_l1(self):
        self.assertEqual(router.classify(make_features()), "L1")

    def test_input_boundary_l1_then_l2(self):
        self.assertEqual(router.classify(make_features(est_input_tokens=3999)), "L1")
        self.assertEqual(router.classify(make_features(est_input_tokens=4000)), "L2")

    def test_max_tokens_boundary(self):
        self.assertEqual(router.classify(make_features(max_tokens=2000)), "L1")
        self.assertEqual(router.classify(make_features(max_tokens=2001)), "L2")

    def test_tools_push_l2(self):
        self.assertEqual(router.classify(make_features(has_tools=True)), "L2")

    def test_image_is_l3(self):
        self.assertEqual(router.classify(make_features(has_image=True, image_count=1)), "L3")

    def test_big_input_boundary(self):
        self.assertEqual(router.classify(make_features(est_input_tokens=32000)), "L2")
        self.assertEqual(router.classify(make_features(est_input_tokens=32001)), "L3")

    def test_big_output_is_l3(self):
        self.assertEqual(router.classify(make_features(max_tokens=16000)), "L2")
        self.assertEqual(router.classify(make_features(max_tokens=16001)), "L3")


# ---------------------------------------------------------------------------
# 时段
# ---------------------------------------------------------------------------


class TestPeriod(unittest.TestCase):
    def test_peak_windows(self):
        self.assertEqual(router.current_period(datetime(2026, 11, 9, 10, 0)), "peak")  # 周一
        self.assertEqual(router.current_period(datetime(2026, 11, 9, 11, 59)), "peak")
        self.assertEqual(router.current_period(datetime(2026, 11, 9, 14, 0)), "peak")
        self.assertEqual(router.current_period(datetime(2026, 11, 9, 17, 59)), "peak")

    def test_boundaries_are_exclusive(self):
        self.assertEqual(router.current_period(datetime(2026, 11, 9, 8, 59)), "offpeak")
        self.assertEqual(router.current_period(datetime(2026, 11, 9, 12, 0)), "offpeak")
        self.assertEqual(router.current_period(datetime(2026, 11, 9, 18, 0)), "offpeak")

    def test_weekend_is_offpeak(self):
        self.assertEqual(router.current_period(datetime(2026, 11, 7, 10, 0)), "offpeak")  # 周六
        self.assertEqual(router.current_period(datetime(2026, 11, 8, 15, 0)), "offpeak")  # 周日

    def test_utc_input_converted_to_shanghai(self):
        # 01:00 UTC = 09:00 上海 -> 高峰
        self.assertEqual(router.current_period(datetime(2026, 11, 9, 1, 0, tzinfo=timezone.utc)), "peak")
        # 04:00 UTC = 12:00 上海 -> 低峰
        self.assertEqual(router.current_period(datetime(2026, 11, 9, 4, 0, tzinfo=timezone.utc)), "offpeak")


# ---------------------------------------------------------------------------
# 候选链
# ---------------------------------------------------------------------------


class TestRouting(unittest.TestCase):
    def test_peak_l1_chain_matches_config(self):
        """高峰 L1：候选链＝routes.peak.L1 的声明链（原语义：链头先耗包月额度、高峰不固定某家）。

        原用例写死"某个上游打头、没有另一个上游"，那只是某一份具体配置的事实；匿名样例
        配置里两者都不在，所以断言改成**与配置声明逐项一致**——它检验的仍是同一件事：
        运行时按"时段＋档位"取对那张表、剔除未声明候选、保序去重。
        """
        cands = router.build_candidates("auto", "L1", "peak", make_features())
        self.assertEqual(cands, cfg.routes_chain("peak", "L1"))
        self.assertEqual(cands[0], cfg.declared_routes("peak", "L1")[0])
        self.assertGreaterEqual(len(cands), 2)

    def test_offpeak_l1_chain_matches_config(self):
        """低峰 L1：候选链＝routes.offpeak.L1 的声明链（原语义：低峰走另一套排序）。"""
        cands = router.build_candidates("auto", "L1", "offpeak", make_features())
        self.assertEqual(cands, cfg.routes_chain("offpeak", "L1"))
        self.assertEqual(cands[:2], cfg.keep_routable(cfg.declared_routes("offpeak", "L1"))[:2])

    def test_peak_l3_chain_matches_config(self):
        """高逻辑（L3）高峰：候选链＝routes.peak.L3 的声明链（强模型打头）。"""
        cands = router.build_candidates("auto", "L3", "peak", make_features(est_input_tokens=40000))
        self.assertEqual(cands, cfg.routes_chain("peak", "L3"))
        self.assertEqual(cands[:2], cfg.keep_routable(cfg.declared_routes("peak", "L3"))[:2])

    def test_offpeak_l3_chain_matches_config(self):
        """低峰 L3：候选链＝routes.offpeak.L3 的声明链。

        峰谷分档的意义在这里：两张表只要配置里不同，产出的链就必须不同
        （下表这段断言是"配置真的分了两档"的承重判据，配置相同则自动跳过比较）。
        """
        peak = router.build_candidates("auto", "L3", "peak", make_features(est_input_tokens=40000))
        offpeak = router.build_candidates("auto", "L3", "offpeak", make_features(est_input_tokens=40000))
        self.assertEqual(offpeak, cfg.routes_chain("offpeak", "L3"))
        if cfg.routes_chain("peak", "L3") != cfg.routes_chain("offpeak", "L3"):
            self.assertNotEqual(peak, offpeak, "配置里峰谷两档不同，运行时却给出同一条链")

    def test_image_route_wins_over_stage(self):
        """含图时走 image 表而不是 L1/L2/L3 表：链＝routes[period].image 的声明链。"""
        feats = make_features(has_image=True, image_count=1, est_input_tokens=2000)
        cands = router.build_candidates("auto", "L3", "peak", feats)
        self.assertEqual(cands, cfg.routes_chain("peak", "L3", has_image=True))
        self.assertEqual(cands, cfg.keep_routable(cfg.declared_routes("peak", "image")))
        self.assertGreaterEqual(len(cands), 2)
        for cand in cands:
            up_id, model_id = router.split_candidate(cand)
            spec = router.UPSTREAM_MAP[up_id].model_spec(model_id)
            self.assertTrue(spec.get("vision"), f"{cand} 不支持图片")
            self.assertTrue(router.candidate_supported(up_id, model_id, feats)[0])

    def test_auto_fast_uses_fast_strategy_chain(self):
        """auto-fast 走 strategies.fast（不分时段），与策略链声明一致。"""
        cands = router.build_candidates("auto-fast", "L2", "peak", make_features())
        self.assertEqual(cands, cfg.strategy_chain("fast", "peak", "L2"))
        self.assertEqual(cands[0], cfg.expected_chain("auto-fast", "L2", "peak")[0])

    def test_auto_strong_l3_uses_strong_strategy_chain(self):
        """strong=能力优先：链＝strategies.strong[period].L3 的声明链。"""
        cands = router.build_candidates("auto-strong", "L3", "peak", make_features(est_input_tokens=40000))
        self.assertEqual(cands, cfg.expected_chain("auto-strong", "L3", "peak"))
        self.assertEqual(cands, cfg.declared_strategy_chain("strong", "peak", "L3"))

    def test_auto_strong_l3_offpeak_uses_offpeak_subtable(self):
        """strong 低峰：取时段子表 strategies.strong.offpeak，不落到 default 扁平表。"""
        cands = router.build_candidates("auto-strong", "L3", "offpeak", make_features(est_input_tokens=40000))
        self.assertEqual(cands, cfg.expected_chain("auto-strong", "L3", "offpeak"))
        declared_offpeak = (cfg.STRATEGIES["strong"]["offpeak"]).get("L3")
        self.assertIsNotNone(declared_offpeak, "样例/真实配置应声明 strategies.strong.offpeak.L3")
        self.assertEqual(cands, cfg.keep_routable(declared_offpeak))

    def test_retry_after_parsed_and_clamped(self):
        self.assertEqual(router.parse_retry_after({"Retry-After": "1800"}), 1800.0)
        self.assertEqual(router.parse_retry_after({"retry-after": "10"}), 60.0)      # 下限 60s
        self.assertEqual(router.parse_retry_after({"Retry-After": "999999"}), 21600.0)  # 上限 6h
        self.assertIsNone(router.parse_retry_after({}))
        self.assertIsNone(router.parse_retry_after(None))

    def test_note_failure_uses_retry_after_cooldown(self):
        st = router.UpstreamState(router.UPSTREAM_MAP[cfg.UPSTREAM_IDS[0]])
        now = router.time.time()
        st.note_failure(429, "quota", now, cooldown=1800)
        ok, why = st.allow(now + 100)
        self.assertFalse(ok, why)                 # 冷却中
        ok2, _ = st.allow(now + 1900)
        self.assertTrue(ok2)                      # 到点自动放回

    def test_unknown_model_returns_empty(self):
        self.assertEqual(router.build_candidates("gpt-9-turbo", "L1", "peak", make_features()), [])

    def test_unknown_upstream_prefix_returns_empty(self):
        self.assertEqual(router.build_candidates("nope/does-not-exist", "L1", "peak", make_features()), [])

    def test_passthrough_upstream_model(self):
        """显式 "<上游>/<模型>" 直接透传：条件是该上游确实已配置（否则空链）。"""
        cands = router.build_candidates(TEXT_MODEL, "L3", "peak", make_features())
        self.assertEqual(cands, [TEXT_MODEL])

    def test_split_candidate_keeps_nested_slash(self):
        """切分只在第一个 "/" 处断开（模型名允许再含 "/"）；纯函数，用中性样例。"""
        self.assertEqual(
            router.split_candidate("up-x/vendor/model-y"),
            ("up-x", "vendor/model-y"),
        )

    def test_bare_real_model_alias(self):
        """裸真实模型名（只在一个上游声明过）→ 归一到 "<该上游>/<模型>"。"""
        self.assertEqual(
            router.build_candidates(UNIQUE_MODEL_ID, "L1", "peak", make_features()),
            [UNIQUE_CANDIDATE],
        )

    def test_all_candidates_are_configured(self):
        for period in ("peak", "offpeak"):
            for stage in ("L1", "L2", "L3"):
                for feats in (
                    make_features(),
                    make_features(has_image=True, image_count=1),
                ):
                    for cand in router.build_candidates("auto", stage, period, feats):
                        up_id, model_id = router.split_candidate(cand)
                        self.assertIn(up_id, router.UPSTREAM_MAP)
                        self.assertTrue(router.UPSTREAM_MAP[up_id].model_spec(model_id))

    def test_capability_rejects_vision_on_text_model(self):
        """上游声明 vision=false 的模型，图片请求必须判 model_no_vision。"""
        feats = make_features(has_image=True, image_count=1)
        up_id, model_id = router.split_candidate(NO_VISION_MODEL)
        self.assertIs(cfg.candidate_spec(NO_VISION_MODEL).get("vision"), False)
        ok, why = router.candidate_supported(up_id, model_id, feats)
        self.assertFalse(ok)
        self.assertEqual(why, "model_no_vision")

    def test_vision_model_supports_vision(self):
        """上游声明 vision=true 的模型，图片请求应放行（原语义：按文档更正视觉能力）。"""
        feats = make_features(has_image=True, image_count=1)
        up_id, model_id = router.split_candidate(TEXT_MODEL)
        self.assertIs(cfg.candidate_spec(TEXT_MODEL).get("vision"), True)
        self.assertTrue(router.candidate_supported(up_id, model_id, feats)[0])

    def test_context_overflow_rejected(self):
        """需求 token 超出上游声明的 context_window → context_overflow；
        大窗口模型在同样需求下仍然可用（窗口值全部从 upstreams.json 现算，不写死）。"""
        small_ctx = cfg.context_window_of(SMALL_CTX_MODEL)
        big_ctx = cfg.context_window_of(BIG_CTX_MODEL)
        self.assertGreater(big_ctx, small_ctx)
        need = int(small_ctx * 1.1)                      # 超过 1.05 容忍带
        feats = make_features(est_input_tokens=need, max_tokens=0)
        ok, why = router.candidate_supported(*cfg.split_candidate(SMALL_CTX_MODEL), feats)
        self.assertFalse(ok)
        self.assertIn("context_overflow", why)
        self.assertTrue(router.candidate_supported(*cfg.split_candidate(BIG_CTX_MODEL), feats)[0])

    def test_passthrough_unknown_model_allowed(self):
        """已配置上游下的未声明模型＝透传（能力未知默认放行）。"""
        self.assertTrue(
            router.candidate_supported(cfg.UPSTREAM_IDS[0], "some-new-model", make_features())[0])


# ---------------------------------------------------------------------------
# 熔断 / 限频
# ---------------------------------------------------------------------------


class TestBreaker(unittest.TestCase):
    def _state(self, max_rpm: int = 50) -> router.UpstreamState:
        upstream = router.Upstream(
            id="t",
            label="test",
            base_url="http://127.0.0.1:1/v1",
            api_key_env="T_KEY",
            max_rpm=max_rpm,
            models={},
        )
        return router.UpstreamState(upstream)

    def test_402_opens_600s(self):
        st = self._state()
        st.note_failure(402, "HTTP 402", now=1000.0)
        ok, why = st.allow(1000.0)
        self.assertFalse(ok)
        self.assertIn("circuit_open", why)
        self.assertLessEqual(st.snapshot(1000.0)["circuit"]["remaining_s"], 600)
        self.assertTrue(st.allow(1601.0)[0])  # 600 秒后恢复

    def test_429_and_5xx_open_circuit(self):
        for status in (429, 500, 503):
            st = self._state()
            st.note_failure(status, f"HTTP {status}", now=100.0)
            self.assertFalse(st.allow(100.0)[0], status)

    def test_401_opens_3600s(self):
        st = self._state()
        st.note_failure(401, "HTTP 401", now=1000.0)
        self.assertFalse(st.allow(1000.0)[0])
        self.assertFalse(st.allow(2000.0)[0])
        self.assertTrue(st.allow(4601.0)[0])

    def test_connection_error_opens(self):
        st = self._state()
        st.note_failure(0, "ConnectionError", now=50.0)
        self.assertFalse(st.allow(50.0)[0])

    def test_success_resets_circuit(self):
        st = self._state()
        st.note_failure(500, "HTTP 500", now=100.0)
        st.note_success(120)
        ok, why = st.allow(101.0)
        self.assertTrue(ok, why)
        self.assertEqual(st.snapshot(101.0)["circuit"]["failures"], 0)

    def test_client_400_does_not_open_circuit(self):
        st = self._state()
        st.note_failure(400, "HTTP 400", now=10.0, count=False)
        self.assertTrue(st.allow(10.0)[0])
        snap = st.snapshot(10.0)
        self.assertFalse(snap["circuit"]["open"])
        self.assertEqual(snap["rejected"], 1)
        self.assertEqual(snap["failures"], 0)

    def test_missing_key_no_breaker(self):
        st = self._state()
        st.note_failure(-1, "missing_key:T_KEY", now=10.0)
        self.assertTrue(st.allow(10.0)[0])

    def test_rpm_sliding_window(self):
        st = self._state(max_rpm=2)
        st.note_call(100.0)
        st.note_call(110.0)
        ok, why = st.allow(120.0)
        self.assertFalse(ok)
        self.assertIn("rpm_limit", why)
        self.assertTrue(st.allow(161.0)[0])  # 100s 的记录已滑出窗口

    def test_rpm_window_prunes(self):
        st = self._state(max_rpm=2)
        for ts in (0.0, 10.0, 20.0, 70.0):
            st.note_call(ts)
        snap = st.snapshot(81.0)
        self.assertEqual(snap["rpm_1m"], 1)  # 只有 70s 那条在窗口内


# ---------------------------------------------------------------------------
# 字段剥离 / 响应头 / 账本
# ---------------------------------------------------------------------------


class TestStripAndLedger(unittest.TestCase):
    def test_strip_only_existing_fields(self):
        body = {"model": "x", "messages": [], "stream": True, "tools": [], "temperature": 0.2}
        self.assertEqual(router.pick_strip_fields(body), [])
        body["stream_options"] = {"include_usage": True}
        body["reasoning_effort"] = "high"
        self.assertEqual(router.pick_strip_fields(body), ["stream_options", "reasoning_effort"])

    def test_core_fields_never_stripped(self):
        for name in ("model", "messages", "stream", "temperature", "top_p", "max_tokens", "tools"):
            self.assertNotIn(name, router.STRIP_FIELDS)

    def test_ascii_reason_is_ascii(self):
        feats = make_features(has_image=True, image_count=2, has_tools=True)
        primary = cfg.CANDIDATES[0]
        reason = router.ascii_reason(feats, "L3", "offpeak", primary)
        reason.encode("latin-1")  # HTTP header 必须能编码
        self.assertTrue(reason.isascii())
        self.assertIn(primary, reason)

    def test_chinese_reason_mentions_primary(self):
        feats = make_features()
        primary = cfg.CANDIDATES[0]
        reason = router.build_reason(feats, "L1", "offpeak", primary, 3)
        self.assertIn("低峰L1", reason)
        self.assertIn(primary, reason)
        self.assertIn("2 个备选", reason)
        self.assertNotIn("\n", reason)

    def test_ledger_entry_has_no_content(self):
        secret_text = "这是绝不能进账本的请求正文 13800138000"
        feats = router.extract_features({"messages": [{"role": "user", "content": secret_text}]})
        entry = router.make_ledger_entry(
            req_id="req-1",
            virtual_model="auto",
            features=feats,
            stage="L1",
            period="offpeak",
            candidates=[cfg.CANDIDATES[0]],
            chosen=cfg.CANDIDATES[0],
            reason="低峰L1",
            attempts=[{"upstream": cfg.split_candidate(cfg.CANDIDATES[0])[0],
                       "model": cfg.split_candidate(cfg.CANDIDATES[0])[1],
                       "status": 200, "ms": 1700, "error": None}],
            usage={"prompt_tokens": 10, "completion_tokens": 2},
            final_status="ok",
        )
        dumped = json.dumps(entry, ensure_ascii=False)
        self.assertNotIn(secret_text, dumped)
        self.assertNotIn("13800138000", dumped)
        for key in ("ts", "req_id", "virtual_model", "stage", "period", "candidates", "chosen", "reason", "attempts", "usage", "final_status"):
            self.assertIn(key, entry)
        self.assertEqual(entry["features"]["est_input_tokens"], feats.est_input_tokens)
        self.assertNotIn("content", entry["features"])


# ---------------------------------------------------------------------------
# 只读接口数据结构
# ---------------------------------------------------------------------------


class TestConfigAlignment(unittest.TestCase):
    """用例与网关必须读**同一份**配置，否则期望值是从另一份过期配置算出来的。"""

    def test_config_ref_matches_runtime_config(self):
        report = cfg.parity_report(router)
        self.assertTrue(report["routes"], "config_ref 与 main.CONFIG 的 routes 不一致")
        self.assertTrue(report["strategies"], "config_ref 与 main.CONFIG 的 strategies 不一致")
        self.assertTrue(report["virtual_models"], "config_ref 与 main.CONFIG 的 virtual_models 不一致")
        self.assertTrue(report["hint"], "config_ref 与 main.CONFIG 的 hint 不一致")
        self.assertTrue(report["capability_meta"], "config_ref 与 main.CONFIG 的 capability_meta 不一致")
        self.assertTrue(report["upstream_ids"], "config_ref 与 main.UPSTREAMS 的上游 id 序列不一致")

    def test_config_reference_is_not_empty(self):
        """脱敏样例/真实配置都必须给出可用夹具，避免断言在空集上空跑。"""
        self.assertTrue(cfg.UPSTREAM_IDS)
        self.assertTrue(cfg.CANDIDATES)
        self.assertTrue(cfg.vision_candidates())
        self.assertTrue(cfg.no_vision_candidates())
        for period in cfg.PERIODS:
            for stage in cfg.STAGES:
                self.assertTrue(cfg.routes_chain(period, stage), f"routes.{period}.{stage} 为空")


class TestPayloads(unittest.TestCase):
    def test_health_shape(self):
        payload = router.health_payload()
        self.assertTrue(payload["ok"])
        self.assertGreaterEqual(payload["uptime"], 0)
        ids = [u["id"] for u in payload["upstreams"]]
        self.assertEqual(ids, cfg.payload_upstream_ids())
        for item in payload["upstreams"]:
            self.assertIn(item["state"], ("ok", "circuit_open", "rate_limited"))
            self.assertIn("circuit", item)
            self.assertIn("last_error", item)

    def test_models_shape(self):
        payload = router.models_payload()
        ids = [m["id"] for m in payload["data"]]
        for virtual in cfg.virtual_model_ids():
            self.assertIn(virtual, ids)
        for item in payload["data"]:
            self.assertEqual(item["object"], "model")

    def test_public_config_has_no_secret_values(self):
        payload = router.public_config()
        dumped = json.dumps(payload, ensure_ascii=False)
        for upstream in payload["upstreams"]:
            self.assertIsInstance(upstream["has_key"], bool)
            self.assertNotIn("api_key", upstream)  # 只有 api_key_env，没有 api_key
        self.assertIn("secrets_loaded_keys", payload)
        self.assertNotIn("Bearer ", dumped)


if __name__ == "__main__":
    unittest.main(verbosity=2)
