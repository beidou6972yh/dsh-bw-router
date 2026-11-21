#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""上游 400/413/422 换下一候选（2026-11-14 热修单）网关级测试。

背景：官方 400 属「该上游特有拒收」（免费对照实证：同请求体打免费池/移动云/本地
9/9 全 200）⇒ `_forward` 不再把 400/413/422 当「参数问题」打断候选链，而是
换下一候选继续试；全部候选都 4xx 才回 400。

只测 main.py 的 `_forward` 接线行为（不联网、不起监听端口、不写生产账本）：
- ① A 恒 400 + B 正常 ⇒ 最终 200，A 记 400、B 成功，账本 `bad_request_fallbacks` 标换上游；
- ② 全候选恒 400 ⇒ 仍回 400（不凭空 200），账本逐候选记 400；
- ③ 400 且有可剥字段 ⇒ 剥字段同上游重试成功 ⇒ 不换上游（原行为不变）；
- ④ 新序列「A 400 → B 502」⇒ 回 502（末位失败性质决定错误类别，不误回 400）；
- ⑤ 413 同样换候选；⑥ 无 4xx 的普通失败链账本无 `bad_request_fallbacks` 键（结构兼容）；
- ⑦ 400 换候选不计熔断（同候选连吃 400 不进熔断口径）。

运行：
    cd <网关树根>            # 树根需含 main.py 与 config/routing.json、upstreams.json
    python3 -m unittest tests.test_bad_request_fallback -v
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as router  # noqa: E402

UP_A = "stub-a"   # 恒 400
UP_B = "stub-b"   # 正常
UP_C = "stub-c"   # 恒 400（第三候选）
MODEL = "model_a1"


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------

def _register(up_id: str) -> None:
    """注册一个桩上游到路由表（base_url 私网占位，实际请求被替身拦截）。"""
    upstream = router.Upstream(
        id=up_id, label=f"桩 {up_id}", base_url="http://127.0.0.1:9/v1",
        api_key_env="FAKE_STUB_KEY", max_rpm=10000,
        models={MODEL: {"label": "桩模型", "context_window": 262144,
                        "max_tokens": 8192, "tier": "cheap", "vision": False}},
    )
    router.UPSTREAMS.append(upstream)
    router.UPSTREAM_MAP[up_id] = upstream
    router.STATE[up_id] = router.UpstreamState(upstream)


def _unregister(up_id: str) -> None:
    router.UPSTREAMS[:] = [u for u in router.UPSTREAMS if u.id != up_id]
    router.UPSTREAM_MAP.pop(up_id, None)
    router.STATE.pop(up_id, None)


class _StubUpstream:
    """替换 call_upstream：按 (upstream_id → 状态码) 回放，记录实际打过的候选。"""

    def __init__(self, plan: dict[str, list[int]]):
        self.plan = {k: list(v) for k, v in plan.items()}
        self.calls: list[tuple[str, str]] = []
        self.payloads: list[dict] = []

    def __call__(self, upstream, model_id, payload, stream, endpoint):
        self.calls.append((upstream.id, model_id))
        self.payloads.append(json.loads(json.dumps(payload)))
        status = self.plan.get(upstream.id, [500]).pop(0) if self.plan.get(upstream.id) else 500
        body = json.dumps({"error": {"message": f"stub {status}", "type": "invalid_request_error"
                                     if status in (400, 413, 422) else "upstream_error"}}).encode()
        return router.UpstreamResult(status, {}, body, None, None, 7, "http://stub/v1")


class _FakeHandler:
    """只实现 _forward 用到的成员，不开 socket、不落盘。"""

    def __init__(self) -> None:
        self.headers: dict = {}          # 本地通道开关头（默认全关）
        self.sent: list[tuple] = []
        self.ledger: dict | None = None

    # -- 响应工具 ----------------------------------------------------------
    def _send_json(self, status: int, obj: dict) -> int:
        self.sent.append(("json", status, obj))
        return status

    def _send_raw_json(self, status: int, raw: bytes, headers: dict) -> int:
        self.sent.append(("raw", status, raw))
        return status

    def _send_error_json(self, status: int, message: str,
                         err_type: str = "invalid_request_error", code: str | None = None) -> int:
        self.sent.append(("error", status, {"message": message, "type": err_type, "code": code}))
        return status

    def _relay_stream(self, res, headers):
        self.sent.append(("stream", headers))
        return 10, None, None

    def _router_headers(self, req_id: str, decision: str, ctx: dict) -> dict:
        return {"X-Router-Decision": decision}

    _forward = router.RouterHandler._forward

    def _ledger(self, ctx, candidates, chosen, attempts, usage, final_status,
                local_fields=None, bad_request_fallbacks=None) -> None:
        """走真实 make_ledger_entry（只跳过落盘），保证测的是账本字段本身。"""
        self.ledger = router.make_ledger_entry(
            req_id=ctx["req_id"], virtual_model=ctx["virtual_model"], features=ctx["features"],
            stage=ctx["stage"], period=ctx["period"], candidates=candidates, chosen=chosen,
            reason=ctx["reason"], attempts=attempts, usage=usage, final_status=final_status,
            hint_fields=router.hint_ledger_fields(chosen, ctx.get("hint")),
            afp_est=ctx.get("afp_est"), local_fields=local_fields,
            bad_request_fallbacks=bad_request_fallbacks)


def _ctx(payload: dict) -> dict:
    return {
        "req_id": "req-test", "virtual_model": "auto",
        "features": router.extract_features(payload),
        "stage": "L1", "period": "offpeak", "reason": "测试", "hint": {"present": False},
    }


class BadRequestFallbackCase(unittest.TestCase):
    """400/413/422 换下一候选：公共夹具（注册桩上游、隔离熔断状态、替换上游调用）。"""

    def setUp(self) -> None:
        for up in (UP_A, UP_B, UP_C):
            _register(up)

    def tearDown(self) -> None:
        for up in (UP_A, UP_B, UP_C):
            _unregister(up)

    def _patch_call(self, stub: _StubUpstream) -> None:
        self._old_call = router.call_upstream
        router.call_upstream = stub                                     # type: ignore[assignment]

    def _run(self, stub: _StubUpstream, candidates: list[str], payload: dict | None = None,
             stream: bool = False) -> tuple[_FakeHandler, int]:
        self._patch_call(stub)
        handler = _FakeHandler()
        body = payload or {"model": "auto", "messages": [{"role": "user", "content": "你好"}]}
        status = handler._forward(body, candidates, _ctx(body), stream, False)
        return handler, status

    def _restore_call(self) -> None:
        router.call_upstream = self._old_call                           # type: ignore[assignment]

    # ① 核心场景：A 恒 400、B 正常 ⇒ 最终 200，账本标换上游 -----------------
    def test_a400_then_b_ok_returns_200(self) -> None:
        stub = _StubUpstream({UP_A: [400, 400, 400], UP_B: [200]})
        try:
            handler, status = self._run(
                stub, [f"{UP_A}/{MODEL}", f"{UP_B}/{MODEL}"])
        finally:
            self._restore_call()
        self.assertEqual(status, 200)
        kind, code, obj = handler.sent[-1]
        self.assertEqual((kind, code), ("raw", 200))
        # attempts 两候选都在：A 记一次 400，B 成功
        statuses = [(a["upstream"], a["status"]) for a in handler.ledger["attempts"]]
        self.assertEqual(statuses, [(UP_A, 400), (UP_B, 200)])
        self.assertEqual(handler.ledger["chosen"], f"{UP_B}/{MODEL}")
        self.assertEqual(handler.ledger["final_status"], "ok")
        # 账本 fallback 标记：bad_request_fallbacks 指明换上游链
        self.assertEqual(handler.ledger["bad_request_fallbacks"], [f"{UP_A}/{MODEL}:400"])
        # A 只被打一次（无可剥字段 ⇒ 不在同上游重试，直接换 B）
        self.assertEqual(stub.calls, [(UP_A, MODEL), (UP_B, MODEL)])

    # ② 全候选恒 400 ⇒ 仍回 400，账本逐候选记 400 ---------------------------
    def test_all_400_still_returns_400(self) -> None:
        stub = _StubUpstream({UP_A: [400] * 3, UP_B: [400] * 3, UP_C: [400] * 3})
        try:
            handler, status = self._run(
                stub, [f"{UP_A}/{MODEL}", f"{UP_B}/{MODEL}", f"{UP_C}/{MODEL}"])
        finally:
            self._restore_call()
        self.assertEqual(status, 400)
        kind, code, obj = handler.sent[-1]
        self.assertEqual((kind, code, obj["code"]), ("error", 400, "upstream_bad_request"))
        statuses = [(a["upstream"], a["status"]) for a in handler.ledger["attempts"]]
        self.assertEqual(statuses, [(UP_A, 400), (UP_B, 400), (UP_C, 400)])
        self.assertEqual(handler.ledger["final_status"], "client_error")
        self.assertIsNone(handler.ledger["chosen"])
        self.assertEqual(handler.ledger["bad_request_fallbacks"],
                         [f"{UP_A}/{MODEL}:400", f"{UP_B}/{MODEL}:400", f"{UP_C}/{MODEL}:400"])

    # ③ 400 且有可剥字段 ⇒ 剥字段同上游重试成功 ⇒ 不换上游（原行为不变）-----
    def test_strip_fields_retry_same_upstream_ok(self) -> None:
        payload = {"model": "auto", "messages": [{"role": "user", "content": "你好"}],
                   "store": True}          # store ∈ strip_fields_on_4xx
        stub = _StubUpstream({UP_A: [400, 200]})
        try:
            handler, status = self._run(stub, [f"{UP_A}/{MODEL}", f"{UP_B}/{MODEL}"],
                                        payload=payload)
        finally:
            self._restore_call()
        self.assertEqual(status, 200)
        # 同上游打两次（第二次剥掉 store），从未换 B
        self.assertEqual(stub.calls, [(UP_A, MODEL), (UP_A, MODEL)])
        self.assertNotIn("store", stub.payloads[1])
        stripped = handler.ledger["attempts"][1].get("stripped")
        self.assertEqual(stripped, ["store"])
        self.assertEqual(handler.ledger["chosen"], f"{UP_A}/{MODEL}")
        # 剥字段救回＝没有换上游发生 ⇒ 账本无 bad_request_fallbacks 键
        self.assertNotIn("bad_request_fallbacks", handler.ledger)

    # ④ 新序列：A 400 → B 502 ⇒ 回 502（不误回 400）-------------------------
    def test_a400_then_b_502_returns_502(self) -> None:
        stub = _StubUpstream({UP_A: [400] * 3, UP_B: [502] * 3})
        try:
            handler, status = self._run(
                stub, [f"{UP_A}/{MODEL}", f"{UP_B}/{MODEL}"])
        finally:
            self._restore_call()
        self.assertEqual(status, 502)
        kind, code, obj = handler.sent[-1]
        self.assertEqual((kind, code, obj["code"]), ("error", 502, "all_upstreams_failed"))
        # 400 那次仍如实记进账本 fallback 链
        self.assertEqual(handler.ledger["bad_request_fallbacks"], [f"{UP_A}/{MODEL}:400"])
        self.assertEqual(handler.ledger["final_status"], "failed")

    # ⑤ 413 同样换候选 ------------------------------------------------------
    def test_413_switches_upstream(self) -> None:
        stub = _StubUpstream({UP_A: [413] * 3, UP_B: [200]})
        try:
            handler, status = self._run(
                stub, [f"{UP_A}/{MODEL}", f"{UP_B}/{MODEL}"])
        finally:
            self._restore_call()
        self.assertEqual(status, 200)
        statuses = [(a["upstream"], a["status"]) for a in handler.ledger["attempts"]]
        self.assertEqual(statuses, [(UP_A, 413), (UP_B, 200)])
        self.assertEqual(handler.ledger["bad_request_fallbacks"], [f"{UP_A}/{MODEL}:413"])

    # ⑥ 无 4xx 的普通失败链 ⇒ 账本无新键（结构兼容）-------------------------
    def test_plain_failure_chain_has_no_new_key(self) -> None:
        stub = _StubUpstream({UP_A: [502] * 3, UP_B: [200]})
        try:
            handler, status = self._run(
                stub, [f"{UP_A}/{MODEL}", f"{UP_B}/{MODEL}"])
        finally:
            self._restore_call()
        self.assertEqual(status, 200)
        self.assertNotIn("bad_request_fallbacks", handler.ledger)

    # ⑦ 400 换候选不计熔断：同一候选 A 连吃两次 400 仍被再次尝试（rejected 口径）---
    def test_400_switch_does_not_open_circuit(self) -> None:
        stub = _StubUpstream({UP_A: [400] * 3, UP_B: [200]})
        try:
            handler, status = self._run(
                stub, [f"{UP_A}/{MODEL}", f"{UP_A}/{MODEL}", f"{UP_B}/{MODEL}"])
        finally:
            self._restore_call()
        self.assertEqual(status, 200)
        st_a = router.STATE[UP_A]
        # 熔断未开（400 不计熔断）：A 仍可放行；口径＝rejected 计数、failed 不动
        allowed, why = st_a.allow(1000.0)
        self.assertTrue(allowed, why)
        self.assertEqual(st_a.failed, 0)          # 熔断口径计数：400 不计
        self.assertEqual(st_a.rejected, 2)        # 400 只记 rejected（候选链里 A 被打两次）
        self.assertEqual(st_a.circuit_until, 0.0)

    # ⑧ 流式同样受益：A 400 → B 流式 200 ------------------------------------
    def test_stream_a400_then_b_ok(self) -> None:
        stub = _StubUpstream({UP_A: [400] * 3, UP_B: [200]})
        try:
            handler, status = self._run(
                stub, [f"{UP_A}/{MODEL}", f"{UP_B}/{MODEL}"], stream=True)
        finally:
            self._restore_call()
        self.assertEqual(status, 200)
        self.assertEqual(handler.ledger["final_status"], "ok_stream")
        self.assertEqual(handler.ledger["bad_request_fallbacks"], [f"{UP_A}/{MODEL}:400"])

    # ⑨ 剥字段重试仍 400 ⇒ 换下一候选（剥完才换，同一候选最多两轮）----------
    def test_strip_retry_still_400_then_switch(self) -> None:
        payload = {"model": "auto", "messages": [{"role": "user", "content": "你好"}],
                   "store": True}
        stub = _StubUpstream({UP_A: [400, 400, 400], UP_B: [200]})
        try:
            handler, status = self._run(stub, [f"{UP_A}/{MODEL}", f"{UP_B}/{MODEL}"],
                                        payload=payload)
        finally:
            self._restore_call()
        self.assertEqual(status, 200)
        # A 打了两轮（剥字段重试一次）仍 400 ⇒ 换 B
        self.assertEqual(stub.calls, [(UP_A, MODEL), (UP_A, MODEL), (UP_B, MODEL)])
        statuses = [(a["upstream"], a["status"]) for a in handler.ledger["attempts"]]
        self.assertEqual(statuses, [(UP_A, 400), (UP_A, 400), (UP_B, 200)])
        self.assertEqual(handler.ledger["bad_request_fallbacks"], [f"{UP_A}/{MODEL}:400"])


if __name__ == "__main__":
    unittest.main()
