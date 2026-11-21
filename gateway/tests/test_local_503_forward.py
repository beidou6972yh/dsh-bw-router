#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""网关级集成测试：宿主上报接口 ＋ 本地 503 结构化错误（契约 v1.1-d2 §4.3／§4.4）。

只测 main.py 的接线行为（不联网、不起监听端口、不写生产账本）：
- POST /v1/route/occupancy/report：单条/数组/部分拒收/坏 JSON/旧字段兼容；
- GET  /v1/route/occupancy：host_view 宿主视角两列分开、gpu 只在 fresh 上报时非 null、
  显存字段只输出 mem_used_mib；
- _forward：本地 503 ⇒ 不重试同宿主、不裸 503、默认不转云、`X-Route-Wait-Local` 只重试一次；
  账本记 local_failure／local_fallback（raw 只进账本）。

运行：
    cd <网关根目录>            # 本仓库根（含 main.py / config/ / upstreams.json）
    python3 -m unittest discover -s tests -p 'test_local_503_forward.py' -v

期望值推导：云端上游/候选不再写死历史生产名，一律经 tests/config_ref.py 从当前部署的
config/routing.json + upstreams.json 推导（本文件顶部 CLOUD_UPSTREAM / CLOUD_CANDIDATE）。
"""

from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as router  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config_ref as cfg  # noqa: E402

LOCAL_ID = "fake-local"
LOCAL_ID2 = "fake-local2"
HOST_ID = "host-a"
LOCAL_MODEL = "decider_d"
LOCAL_TIER = "cheap"          # _register_local 里自建夹具声明的档位（虚构夹具，故意不取真实配置）

# 「云端候选」＝当前部署里一个**真实已配置的云端上游候选**，全部从样例配置推导：
#   * _forward 的本地 503 分支要查 STATE / UPSTREAM_MAP（写死的历史上游名在样例配置里
#     根本不存在 ⇒ setUp 直接 KeyError，整个用例类崩塌）；
#   * cloud_fallback_suggestion 只认「候选链里、上游非本地、档位相容（tier 相同或
#     任一侧未知）」的候选，所以云端候选必须真的能与本地夹具同档兜底。
if not cfg.CLOUD_UPSTREAM_IDS:
    raise RuntimeError("样例配置里没有云端（https）上游，本用例的「云端候选」无从推导")
CLOUD_UPSTREAM = cfg.CLOUD_UPSTREAM_IDS[0]


def _pick_cloud_candidate(upstream_id: str) -> str:
    """在该云端上游的已声明候选里挑第一个「档位与本地夹具相容」的；都不相容则取首个。

    档位相容是 cloud_fallback_suggestion 的既有口径（tier 相同或任一侧未知），
    仅影响「建议值」是否被填上，不改变被测逻辑。
    """
    own = [c for c in cfg.CANDIDATES if cfg.split_candidate(c)[0] == upstream_id]
    if not own:
        raise RuntimeError(f"样例配置的云端上游 {upstream_id} 未声明任何模型")
    for candidate in own:
        tier = cfg.candidate_spec(candidate).get("tier")
        if tier is None or tier == LOCAL_TIER:
            return candidate
    return own[0]


CLOUD_CANDIDATE = _pick_cloud_candidate(CLOUD_UPSTREAM)
CLOUD_MODEL = cfg.split_candidate(CLOUD_CANDIDATE)[1]

VRAM_BODY = json.dumps({
    "error": {"message": "显存不足 12594/9279，驱逐 0，无需让位", "type": "insufficient_vram"}
}, ensure_ascii=False).encode("utf-8")


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------

def _register_local(up_id: str = LOCAL_ID) -> None:
    """注册一个「本地（私有 base_url）」上游到路由表，供 _forward 走本地分支。"""
    upstream = router.Upstream(
        id=up_id, label=f"本地测试 {up_id}", base_url="http://127.0.0.1:4000/v1",
        api_key_env="FAKE_LOCAL_KEY", max_rpm=1000,
        models={LOCAL_MODEL: {"label": "本地 18B", "context_window": 262144,
                              "max_tokens": 8192, "tier": LOCAL_TIER, "vision": False}},
    )
    router.UPSTREAMS.append(upstream)
    router.UPSTREAM_MAP[up_id] = upstream
    router.STATE[up_id] = router.UpstreamState(upstream)


def _unregister_local(up_id: str = LOCAL_ID) -> None:
    router.UPSTREAMS[:] = [u for u in router.UPSTREAMS if u.id != up_id]
    router.UPSTREAM_MAP.pop(up_id, None)
    router.STATE.pop(up_id, None)


class _StubUpstream:
    """替换 call_upstream：按队列回放 (status, body, headers)，记录实际打过的候选。"""

    def __init__(self, *replies: tuple[int, bytes, dict]):
        self.replies = list(replies)
        self.calls: list[tuple[str, str]] = []

    def __call__(self, upstream, model_id, payload, stream, endpoint):
        self.calls.append((upstream.id, model_id))
        status, body, headers = self.replies.pop(0) if self.replies else (500, b"{}", {})
        return router.UpstreamResult(status, headers, body, None, None, 7, "http://stub/v1")


class _FakeHandler:
    """只实现 _forward / _do_post 用到的成员，不开 socket、不落盘。"""

    def __init__(self, headers: dict | None = None, body: bytes = b""):
        self.headers = headers or {}
        self.body = body
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

    # 直接借真实实现（只用 _read_body/_send_json/_send_error_json/_ledger 等已被本类覆盖的成员）
    _do_post = router.RouterHandler._do_post
    _handle_occupancy_report = router.RouterHandler._handle_occupancy_report
    _forward = router.RouterHandler._forward

    # -- 请求体 / 账本 ------------------------------------------------------
    def _read_body(self) -> bytes:
        return self.body

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


def _ctx(payload: dict | None = None) -> dict:
    body = payload or {"model": "auto", "messages": [{"role": "user", "content": "你好"}]}
    return {
        "req_id": "req-test", "virtual_model": "auto",
        "features": router.extract_features(body),
        "stage": "L1", "period": "offpeak", "reason": "测试", "hint": {"present": False},
    }


class _LocalCase(unittest.TestCase):
    """本地 503 用例公共夹具：注册本地上游、隔离宿主上报状态、替换上游调用。"""

    def setUp(self) -> None:
        router.local_unavail.reset_state()
        router.occ_host.reset_state()
        self._old_occ_file = os.environ.get("ROUTER_OCCUPANCY_FILE")
        os.environ["ROUTER_OCCUPANCY_FILE"] = str(
            Path(__file__).resolve().parent / "__no_such_occupancy__.json")
        self._old_local_ids = router.local_upstream_ids
        self._old_host_id = router.local_host_id
        router.local_upstream_ids = lambda: {LOCAL_ID, LOCAL_ID2}      # type: ignore[assignment]
        router.local_host_id = lambda up_id: HOST_ID                   # type: ignore[assignment]
        # 云端上游状态隔离：上个用例打出来的熔断/RPM 不带到下一个用例
        self._cloud_id = CLOUD_UPSTREAM        # 真实已配置的云端上游（详见文件顶部推导）
        self._old_cloud_state = router.STATE.get(self._cloud_id)
        router.STATE[self._cloud_id] = router.UpstreamState(router.UPSTREAM_MAP[self._cloud_id])

    def tearDown(self) -> None:
        router.local_unavail.reset_state()
        router.occ_host.reset_state()
        router.local_upstream_ids = self._old_local_ids                # type: ignore[assignment]
        router.local_host_id = self._old_host_id                       # type: ignore[assignment]
        if self._old_cloud_state is None:
            router.STATE.pop(self._cloud_id, None)
        else:
            router.STATE[self._cloud_id] = self._old_cloud_state
        if self._old_occ_file is None:
            os.environ.pop("ROUTER_OCCUPANCY_FILE", None)
        else:
            os.environ["ROUTER_OCCUPANCY_FILE"] = self._old_occ_file

    def _patch_call(self, stub: _StubUpstream) -> None:
        self._old_call = router.call_upstream
        router.call_upstream = stub                                     # type: ignore[assignment]

    def _run_forward(self, handler: _FakeHandler, candidates: list[str], payload: dict | None = None,
                     stream: bool = False) -> int:
        return handler._forward(payload or {"model": "auto",
                                            "messages": [{"role": "user", "content": "你好"}]},
                                candidates, _ctx(payload), stream, False)


# ---------------------------------------------------------------------------
# ① 宿主上报接口（POST /v1/route/occupancy/report）
# ---------------------------------------------------------------------------

class _ReportBase(unittest.TestCase):
    """上报/视图用例公共夹具（不含测试方法，避免子类重复跑父类用例）。"""

    def setUp(self) -> None:
        router.occ_host.reset_state()
        router.local_unavail.reset_state()
        self._old_occ_file = os.environ.get("ROUTER_OCCUPANCY_FILE")
        os.environ["ROUTER_OCCUPANCY_FILE"] = str(
            Path(__file__).resolve().parent / "__no_such_occupancy__.json")

    def tearDown(self) -> None:
        router.occ_host.reset_state()
        if self._old_occ_file is None:
            os.environ.pop("ROUTER_OCCUPANCY_FILE", None)
        else:
            os.environ["ROUTER_OCCUPANCY_FILE"] = self._old_occ_file

    @staticmethod
    def _report(**over) -> dict:
        now_ms = int(time.time() * 1000)
        base = {"host_id": HOST_ID, "model": LOCAL_MODEL, "loaded": True,
                "active_requests": 0, "last_active_ts": now_ms - 1000,
                "gpu_util": 0.42, "mem_used_mib": 12594, "preemptible": True,
                "reported_at": now_ms}
        base.update(over)
        return base

    def _post(self, body: bytes) -> tuple[_FakeHandler, tuple[int, str]]:
        handler = _FakeHandler(body=body)
        result = handler._do_post("/v1/route/occupancy/report")
        return handler, result


class OccupancyReportRouteCase(_ReportBase):
    """上报接口：单条/数组/部分拒收/坏体/旧字段兼容。"""

    def test_single_report_accepted(self):
        handler, (status, note) = self._post(json.dumps(self._report()).encode("utf-8"))
        self.assertEqual(status, 200)
        self.assertEqual(note, "occupancy_report")
        payload = handler.sent[-1][2]
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["accepted"], 1)
        self.assertEqual(payload["rejected"], [])
        self.assertEqual(payload["stored"], 1)

    def test_reports_array_partial_reject_still_200(self):
        body = {"reports": [self._report(), self._report(model="deep-7b"),
                            {"host_id": HOST_ID}]}          # 第 3 条缺必填 ⇒ 拒收
        handler, (status, _note) = self._post(json.dumps(body).encode("utf-8"))
        payload = handler.sent[-1][2]
        self.assertEqual(status, 200)
        self.assertEqual(payload["accepted"], 2)
        self.assertEqual(len(payload["rejected"]), 1)
        self.assertEqual(payload["rejected"][0]["index"], 2)
        self.assertEqual(payload["stored"], 2)

    def test_bad_json_is_400(self):
        _handler, (status, note) = self._post(b"{not json")
        self.assertEqual((status, note), (400, "report_bad_json"))

    def test_empty_body_is_400(self):
        _handler, (status, note) = self._post(b"")
        self.assertEqual((status, note), (400, "report_empty"))

    def test_non_object_body_is_400(self):
        _handler, (status, note) = self._post(b"123")
        self.assertEqual((status, note), (400, "report_bad_shape"))

    def test_stale_report_accepted_but_not_fresh(self):
        stale = self._report(reported_at=int(time.time() * 1000) - 31_000)
        handler, (status, _note) = self._post(json.dumps(stale).encode("utf-8"))
        self.assertEqual(status, 200)
        self.assertEqual(handler.sent[-1][2]["accepted"], 1)
        view = router.occ_host.snapshot()
        self.assertEqual(view["fresh_count"], 0)
        self.assertEqual(view["stale_count"], 1)
        self.assertEqual(view["items"][0]["stale"], True)

    def test_legacy_mem_used_mb_collected_as_mib(self):
        body = self._report()
        body.pop("mem_used_mib")
        body["mem_used_mb"] = 12594                        # 一个版本期的兼容读入
        handler, _result = self._post(json.dumps(body).encode("utf-8"))
        self.assertEqual(handler.sent[-1][2]["accepted"], 1)
        view = router.occ_host.snapshot()
        entry = view["items"][0]
        self.assertEqual(entry["mem_used_mib"], 12594)
        self.assertIn("mem_used_mb→mem_used_mib", entry["compat"])
        self.assertNotIn('"mem_used_mb"', json.dumps(view, ensure_ascii=False))

    def test_preemptible_conflict_flagged(self):
        body = self._report(active_requests=2, preemptible=True)
        self._post(json.dumps(body).encode("utf-8"))
        entry = router.occ_host.snapshot()["items"][0]
        self.assertIn("preemptible_conflict", entry["conflicts"])
        self.assertEqual(entry["active_requests"], 2)      # 冲突以 active_requests 为准


class OccupancyViewMergeCase(_ReportBase):
    """GET /v1/route/occupancy：宿主视角单独一列、gpu 只看 fresh。"""

    def test_host_view_column_not_merged_into_by_model(self):
        self._post(json.dumps(self._report(active_requests=3)).encode("utf-8"))
        payload = router.occupancy_payload()
        # 网关视角：没有真实在飞请求 ⇒ by_model 空（宿主视角 3 个不混进来）
        self.assertEqual(payload["by_model"], [])
        host_view = payload["host_view"]
        self.assertEqual(len(host_view["items"]), 1)
        self.assertEqual(host_view["items"][0]["active_requests"], 3)
        self.assertEqual(host_view["items"][0]["host_id"], HOST_ID)
        self.assertIn("两列", host_view["note"])

    def test_gpu_filled_only_by_fresh_report(self):
        self._post(json.dumps(self._report()).encode("utf-8"))
        gpu = router.occupancy_payload()["gpu"]
        self.assertEqual(gpu["reported_by"], "host")
        self.assertEqual(gpu["mem_used_mib"], 12594)
        self.assertEqual(gpu["host_id"], HOST_ID)
        self.assertTrue(gpu["fresh"])
        self.assertNotIn("mem_used_mb", gpu)

    def test_gpu_null_when_stale(self):
        stale = self._report(reported_at=int(time.time() * 1000) - 40_000)
        self._post(json.dumps(stale).encode("utf-8"))
        payload = router.occupancy_payload()
        self.assertIsNone(payload["gpu"]["mem_used_mib"])
        self.assertEqual(payload["host_view"]["stale_count"], 1)


# ---------------------------------------------------------------------------
# ② 本地 503 ⇒ 结构化错误 / 不同宿主重试 / 不转云 / 等卸载重试一次
# ---------------------------------------------------------------------------

class Local503ForwardCase(_LocalCase):
    """_forward 的 §4.4 行为（本地候选回 503 时）。"""

    def setUp(self) -> None:
        super().setUp()
        _register_local(LOCAL_ID)
        _register_local(LOCAL_ID2)
        self._old_wait = router.local_unavail.wait_for_retry_ready

    def tearDown(self) -> None:
        _unregister_local(LOCAL_ID)
        _unregister_local(LOCAL_ID2)
        router.local_unavail.wait_for_retry_ready = self._old_wait    # type: ignore[assignment]
        super().tearDown()

    def _forward(self, candidates, replies, headers=None) -> _FakeHandler:
        stub = _StubUpstream(*replies)
        self._patch_call(stub)
        handler = _FakeHandler(headers=headers)
        self._run_forward(handler, candidates)
        return handler

    def test_cloud_candidate_is_real_configured_upstream(self):
        """前置自检：云端候选必须是当前配置里真实声明、可路由、已进路由表的云端上游候选。

        为什么必须真实存在：_forward 的本地 503 分支要查 STATE / UPSTREAM_MAP，候选不
        真实就没法走到「默认不转云 / 允许转云」的分支；cloud_fallback_suggestion 又只认
        候选链里、非本地、档位相容的候选。全部断言落在 config_ref（读配置）与 main 的
        加载结果上，期望值不是从被测函数回抄的。
        """
        self.assertIn(CLOUD_UPSTREAM, cfg.UPSTREAM_IDS)
        self.assertNotIn(CLOUD_UPSTREAM, cfg.LOCAL_UPSTREAM_IDS)       # 确实是云端而非本地
        self.assertEqual(cfg.split_candidate(CLOUD_CANDIDATE)[0], CLOUD_UPSTREAM)
        self.assertTrue(cfg.is_declared_model(CLOUD_CANDIDATE))        # upstreams.json 已声明
        self.assertTrue(cfg.is_routable(CLOUD_CANDIDATE))              # build_candidates 不会剔除
        self.assertIn(CLOUD_UPSTREAM, router.UPSTREAM_MAP)             # main 启动时已加载
        self.assertIn(CLOUD_UPSTREAM, router.STATE)                    # _forward 能查到状态
        # cloud_fallback_suggestion 的既有口径：tier 相同或任一侧未知（夹具档位＝LOCAL_TIER）
        self.assertIn(cfg.candidate_spec(CLOUD_CANDIDATE).get("tier"), (None, LOCAL_TIER))
        self.assertEqual(router.UPSTREAM_MAP[LOCAL_ID].model_spec(LOCAL_MODEL).get("tier"),
                         LOCAL_TIER)                                   # 夹具与推导口径一致

    def test_local_503_returns_structured_error_not_bare(self):
        stub = _StubUpstream((503, VRAM_BODY, {}))
        self._patch_call(stub)
        handler = _FakeHandler()
        status = self._run_forward(handler, [f"{LOCAL_ID}/{LOCAL_MODEL}"])
        self.assertEqual(status, 503)
        _kind, sent_status, body = handler.sent[-1]
        self.assertEqual(sent_status, 503)
        error = body["error"]
        self.assertEqual(error["type"], "local_unavailable")
        self.assertEqual(error["code"], "local_vram_insufficient")
        self.assertEqual(error["model"], f"{LOCAL_ID}/{LOCAL_MODEL}")
        self.assertEqual(error["host_id"], HOST_ID)
        self.assertEqual(error["need_mib"], 12594)
        self.assertEqual(error["free_mib"], 9279)
        self.assertIs(error["retryable"], False)
        self.assertIn("fallback", error)
        self.assertEqual(len(stub.calls), 1)              # 同宿主不重试

    def test_card_busy_keeps_contract_code_and_reason(self):
        """契约 §4.4.2 固定 code；§4.4.5 用 reason 区分「卡被占满」。"""
        busy = json.dumps({"error": {"message": "GPU is busy: queue full"}}).encode("utf-8")
        stub = _StubUpstream((503, busy, {}))
        self._patch_call(stub)
        handler = _FakeHandler()
        status = self._run_forward(handler, [f"{LOCAL_ID}/{LOCAL_MODEL}"])
        self.assertEqual(status, 503)
        error = handler.sent[-1][2]["error"]
        self.assertEqual(error["code"], "local_vram_insufficient")
        self.assertEqual(error["reason"], "card_busy")
        self.assertIsNone(error["need_mib"])
        self.assertIsNone(error["free_mib"])
        self.assertEqual(handler.ledger["local_failure"]["reason"], "card_busy")

    def test_ledger_records_local_failure_and_raw(self):
        stub = _StubUpstream((503, VRAM_BODY, {}))
        self._patch_call(stub)
        handler = _FakeHandler()
        self._run_forward(handler, [f"{LOCAL_ID}/{LOCAL_MODEL}"])
        entry = handler.ledger
        assert entry is not None
        self.assertEqual(entry["final_status"], "local_unavailable")
        self.assertEqual(entry["local_fallback"], "local_unavailable")
        self.assertEqual(entry["local_failure"]["code"], "local_vram_insufficient")
        self.assertIn("显存不足", entry["local_failure"]["raw"])
        self.assertEqual(entry["attempts"][-1]["local"]["need_mib"], 12594)

    def test_other_local_host_still_tried_after_failure(self):
        """同宿主短路≠全本地短路：换宿主（host_id 不同）仍可试。"""
        router.local_host_id = lambda up_id: (HOST_ID if up_id == LOCAL_ID else "host-b")
        stub = _StubUpstream((503, VRAM_BODY, {}), (200, b'{"ok":1}', {}))
        self._patch_call(stub)
        handler = _FakeHandler()
        status = self._run_forward(handler, [f"{LOCAL_ID}/{LOCAL_MODEL}",
                                             f"{LOCAL_ID2}/{LOCAL_MODEL}"])
        self.assertEqual(status, 200)
        self.assertEqual([c[0] for c in stub.calls], [LOCAL_ID, LOCAL_ID2])
        _kind, sent_status, raw = handler.sent[-1]
        self.assertEqual(sent_status, 200)
        self.assertEqual(raw, b'{"ok":1}')

    def test_default_does_not_fall_back_to_cloud(self):
        stub = _StubUpstream((503, VRAM_BODY, {}), (200, b'{"ok":1}', {}))
        self._patch_call(stub)
        handler = _FakeHandler()
        status = self._run_forward(handler, [f"{LOCAL_ID}/{LOCAL_MODEL}", CLOUD_CANDIDATE])
        self.assertEqual(status, 503)
        self.assertEqual(len(stub.calls), 1)              # 云端候选一次都没打
        self.assertEqual(handler.sent[-1][2]["error"]["fallback"], CLOUD_CANDIDATE)
        self.assertEqual(handler.ledger["local_fallback"], "local_unavailable")

    def test_allow_cloud_header_continues_to_cloud(self):
        stub = _StubUpstream((503, VRAM_BODY, {}), (200, b'{"ok":1}', {}))
        self._patch_call(stub)
        handler = _FakeHandler(headers={"X-Route-Allow-Cloud": "1"})
        status = self._run_forward(handler, [f"{LOCAL_ID}/{LOCAL_MODEL}", CLOUD_CANDIDATE])
        self.assertEqual(status, 200)
        self.assertEqual([c[0] for c in stub.calls], [LOCAL_ID, CLOUD_UPSTREAM])
        self.assertEqual(handler.ledger["local_fallback"], "local_unavailable→cloud")

    def test_wait_local_retries_once_when_ready(self):
        calls: list[dict] = []

        def _ready(host_id, model, seconds, since_ms, prev_mem_mib=None):
            calls.append({"host_id": host_id, "model": model, "seconds": seconds})
            return True, {"reported_at": since_ms + 1000, "mem_used_mib": 4096}

        router.local_unavail.wait_for_retry_ready = _ready        # type: ignore[assignment]
        stub = _StubUpstream((503, VRAM_BODY, {}), (200, b'{"ok":2}', {}))
        self._patch_call(stub)
        handler = _FakeHandler(headers={"X-Route-Wait-Local": "5"})
        status = self._run_forward(handler, [f"{LOCAL_ID}/{LOCAL_MODEL}"])
        self.assertEqual(status, 200)
        self.assertEqual(len(stub.calls), 2)                       # 只重试一次
        self.assertEqual(calls[0]["seconds"], 5.0)
        self.assertIs(handler.ledger["attempts"][-2]["local"]["wait_local"]["ready"], True)

    def test_wait_local_timeout_returns_same_error(self):
        def _never(host_id, model, seconds, since_ms, prev_mem_mib=None):
            return False, None

        router.local_unavail.wait_for_retry_ready = _never          # type: ignore[assignment]
        stub = _StubUpstream((503, VRAM_BODY, {}), (200, b'{"ok":2}', {}))
        self._patch_call(stub)
        handler = _FakeHandler(headers={"X-Route-Wait-Local": "20"})
        status = self._run_forward(handler, [f"{LOCAL_ID}/{LOCAL_MODEL}"])
        self.assertEqual(status, 503)
        self.assertEqual(len(stub.calls), 1)
        self.assertIs(handler.ledger["attempts"][-1]["local"]["wait_local"]["ready"], False)
        self.assertEqual(handler.sent[-1][2]["error"]["code"], "local_vram_insufficient")

    def test_wait_local_default_off_never_waits(self):
        def _boom(*args, **kwargs):
            raise AssertionError("默认关：不得调用等待逻辑")

        router.local_unavail.wait_for_retry_ready = _boom            # type: ignore[assignment]
        stub = _StubUpstream((503, VRAM_BODY, {}))
        self._patch_call(stub)
        handler = _FakeHandler()
        status = self._run_forward(handler, [f"{LOCAL_ID}/{LOCAL_MODEL}"])
        self.assertEqual(status, 503)
        self.assertNotIn("wait_local", handler.ledger["attempts"][-1]["local"])

    def test_wait_local_header_capped_at_20s(self):
        seen: list[float] = []

        def _never(host_id, model, seconds, since_ms, prev_mem_mib=None):
            seen.append(seconds)
            return False, None

        router.local_unavail.wait_for_retry_ready = _never            # type: ignore[assignment]
        stub = _StubUpstream((503, VRAM_BODY, {}))
        self._patch_call(stub)
        handler = _FakeHandler(headers={"X-Route-Wait-Local": "999"})
        self._run_forward(handler, [f"{LOCAL_ID}/{LOCAL_MODEL}"])
        self.assertEqual(seen, [20.0])

    def test_non_local_503_keeps_old_behaviour(self):
        """非本地候选回 503 ⇒ 老行为（502 汇总，不套 local_unavailable 结构化体）。"""
        stub = _StubUpstream((503, b'{"error":"boom"}', {}))
        self._patch_call(stub)
        handler = _FakeHandler()
        status = self._run_forward(handler, [CLOUD_CANDIDATE])
        self.assertEqual(status, 502)
        self.assertEqual(handler.sent[-1][2]["code"], "all_upstreams_failed")
        self.assertNotIn("local_failure", handler.ledger)


class FileChannelCase(unittest.TestCase):
    """契约 §4.3 通道①：LAN 未通期宿主写 json、网关按 mtime 轮询（≤30s），形状不变。"""

    def setUp(self) -> None:
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "occupancy-host.json"
        self._old_env = os.environ.get("ROUTER_OCCUPANCY_FILE")
        os.environ["ROUTER_OCCUPANCY_FILE"] = str(self.path)
        router.occ_host.reset_state()

    def tearDown(self) -> None:
        router.occ_host.reset_state()
        if self._old_env is None:
            os.environ.pop("ROUTER_OCCUPANCY_FILE", None)
        else:
            os.environ["ROUTER_OCCUPANCY_FILE"] = self._old_env
        self.tmp.cleanup()

    def _write(self, doc: dict) -> None:
        self.path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")

    def _report(self, **over) -> dict:
        now_ms = int(time.time() * 1000)
        base = {"host_id": HOST_ID, "model": LOCAL_MODEL, "loaded": True,
                "active_requests": 0, "last_active_ts": now_ms - 500,
                "gpu_util": 0.2, "mem_used_mib": 5000, "preemptible": False,
                "reported_at": now_ms}
        base.update(over)
        return base

    def test_file_report_flows_into_occupancy_payload(self):
        self._write({"reports": [self._report()]})
        payload = router.occupancy_payload()
        items = payload["host_view"]["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["host_id"], HOST_ID)
        self.assertEqual(payload["host_view"]["sources"][0]["name"], "file")
        self.assertEqual(payload["gpu"]["mem_used_mib"], 5000)

    def test_mtime_unchanged_not_reingested(self):
        self._write({"report": self._report()})
        self.assertIsNotNone(router.occ_host.poll_file())        # 首轮读入
        self.assertIsNone(router.occ_host.poll_file())           # mtime 未变 ⇒ 不重复
        self.assertEqual(router.occ_host.snapshot()["rejected_total"], 0)

    def test_new_mtime_reads_new_values(self):
        self._write({"report": self._report(mem_used_mib=5000)})
        router.occ_host.poll_file()
        self._write({"report": self._report(mem_used_mib=7777,
                                            reported_at=int(time.time() * 1000) + 1000)})
        os.utime(self.path, (time.time() + 5, time.time() + 5))
        router.occ_host.poll_file()
        entry = router.occ_host.snapshot()["items"][0]
        self.assertEqual(entry["mem_used_mib"], 7777)

    def test_bad_json_does_not_break_gateway_view(self):
        self.path.write_text("{oops", encoding="utf-8")
        payload = router.occupancy_payload()
        self.assertEqual(payload["host_view"]["items"], [])
        self.assertEqual(payload["windows"]["active_30s"], 0)
        self.assertIsNone(payload["gpu"]["mem_used_mib"])


class LedgerShapeCase(unittest.TestCase):
    """账本形状：非本地请求零新增键（与历史逐字节一致）。"""

    def test_no_local_keys_without_local_failure(self):
        ctx = _ctx()
        entry = router.make_ledger_entry(
            req_id="req-1", virtual_model="auto", features=ctx["features"], stage="L1",
            period="offpeak", candidates=[CLOUD_CANDIDATE], chosen=None,
            reason="r", attempts=[], usage=None, final_status="failed")
        self.assertNotIn("local_failure", entry)
        self.assertNotIn("local_fallback", entry)

    def test_local_failure_requires_cloud_flag_for_cloud_attribution(self):
        fake = {"info": {"code": "local_vram_insufficient", "reason": "vram_insufficient",
                         "need_mib": 1, "free_mib": 0, "evidence": "body", "raw": "x"},
                "host_id": "h1"}
        attempts = [{"upstream": LOCAL_ID, "model": LOCAL_MODEL, "status": 503},
                    {"upstream": CLOUD_UPSTREAM, "model": CLOUD_MODEL, "status": 200}]
        blocked = router.local_ledger_fields(fake, False, attempts, {LOCAL_ID})
        allowed = router.local_ledger_fields(fake, True, attempts, {LOCAL_ID})
        self.assertEqual(blocked["local_fallback"], "local_unavailable")
        self.assertEqual(allowed["local_fallback"], "local_unavailable→cloud")
        self.assertIsNone(router.local_ledger_fields(None, True, attempts, {LOCAL_ID}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
