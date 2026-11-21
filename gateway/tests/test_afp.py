#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AFP 感知分流单元测试：不联网、不碰真实额度文件。

覆盖：
- 快照解析：三窗口取最紧 / 单窗口 / used>limit 下夹 0 / 结构坏 / 无时间戳 / 过期；
- 闸门判定：耗尽跳过 / 超余额跳过 / 小额放行 / 中额放行 / 非限额上游放行 /
  闸门未激活放行 / 快照缺失放行（保守＝维持现状）；
- 429 短熔断：note_failure(429) 按 afp.breaker_429_seconds（默认 300s < 600s）；
  带重置时刻 cooldown 时精确冷却（夹 1min~6h）；402/5xx 仍 600s；
- 重置时刻解析：未来 / 过期 / 缺失；
- 账本 afp_est 字段：激活记值 / 未激活 None；
- 快照文件缓存：mtime 变更才重读 / 文件缺失 None。

期望值/上游 id 一律从当前部署的配置推导（经 tests/config_ref.py），不在用例里写死生产名。

运行：
    cd <网关树根>            # 树根需含 main.py 与 config/routing.json、upstreams.json
    python3 -m unittest discover -s tests -p 'test_afp.py' -v
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config_ref as cfg  # noqa: E402

import main as router  # noqa: E402

# 闸门盯的上游 id 从配置推导（原用例把某个生产上游名写死在夹具里）；
# 另一个已配置上游用于"非限额上游放行"的对照。
GATE_UPSTREAM = cfg.afp_upstream() or cfg.UPSTREAM_IDS[0]
OTHER_UPSTREAM = next(u for u in cfg.UPSTREAM_IDS if u != GATE_UPSTREAM)


def snap_doc(h5=(2991.7, 10000), d7=(3267.5, 35000), d30=(22000.0, 100000),
             collected=None) -> dict:
    """构造 quota-snapshot.json 形态的文档；collected 默认=当前时刻（新鲜）。"""
    if collected is None:
        collected = datetime.now(router.TZ).isoformat(timespec="seconds")
    doc = {"collected_at": collected, "plan": "Example Plan",
           "afp": {}}
    if h5 is not None:
        doc["afp"]["h5"] = {"used": h5[0], "limit": h5[1], "pct": 0, "reset": "x分钟后重置"}
    if d7 is not None:
        doc["afp"]["d7"] = {"used": d7[0], "limit": d7[1], "pct": 0, "reset": "x天后重置"}
    if d30 is not None:
        doc["afp"]["d30"] = {"used": d30[0], "limit": d30[1], "pct": 0, "reset": "x天后重置"}
    return doc


class gate_active:
    """上下文管理器：临时激活闸门＋注入快照（不碰真实 quota-snapshot.json）。"""

    def __init__(self, snap=None, rate=0.001321, reserve=0.1, min_charge=1.0):
        self.snap = snap
        self.saved = {}
        self.override = {
            "AFP_GATE_ACTIVE": True,
            "AFP_UPSTREAM_ID": GATE_UPSTREAM,
            "AFP_RATE_PER_TOKEN": rate,
            "AFP_RESERVE": reserve,
            "AFP_MIN_CHARGE": min_charge,
        }

    def __enter__(self):
        for k, v in self.override.items():
            self.saved[k] = getattr(router, k)
            setattr(router, k, v)
        self.saved["_snap_fn"] = router.afp_snapshot
        router.afp_snapshot = lambda now_ts=None: self.snap
        return self

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            if k == "_snap_fn":
                router.afp_snapshot = v
            else:
                setattr(router, k, v)
        return False


class TestParseSnapshot(unittest.TestCase):
    def test_three_windows_min_avail(self):
        snap, why = router._afp_parse_snapshot(snap_doc(), time.time())
        self.assertEqual(why, "ok")
        # min(10000-2991.7, 35000-3267.5, 100000-22000) = 7008.3
        self.assertAlmostEqual(snap["min_avail"], 7008.3, places=1)
        self.assertEqual(set(snap["windows"]), {"h5", "d7", "d30"})

    def test_single_window(self):
        snap, why = router._afp_parse_snapshot(snap_doc(d7=None, d30=None), time.time())
        self.assertEqual(why, "ok")
        self.assertAlmostEqual(snap["min_avail"], 10000 - 2991.7, places=1)

    def test_used_over_limit_clamped_zero(self):
        # 周额度打穿（2026-11-12 实况：used 超 limit）⇒ 最紧余额=0
        snap, why = router._afp_parse_snapshot(
            snap_doc(d7=(35200.0, 35000)), time.time())
        self.assertEqual(why, "ok")
        self.assertEqual(snap["min_avail"], 0.0)

    def test_no_windows(self):
        _, why = router._afp_parse_snapshot(snap_doc(h5=None, d7=None, d30=None), time.time())
        self.assertEqual(why, "no_windows")

    def test_bad_doc(self):
        _, why = router._afp_parse_snapshot({"afp": "not-a-dict"}, time.time())
        self.assertEqual(why, "bad_doc")
        _, why = router._afp_parse_snapshot([1, 2], time.time())
        self.assertEqual(why, "bad_doc")

    def test_stale_timestamp(self):
        old = (datetime.now(router.TZ) - timedelta(hours=3)).isoformat(timespec="seconds")
        _, why = router._afp_parse_snapshot(snap_doc(collected=old), time.time())
        self.assertEqual(why, "stale")

    def test_no_timestamp_is_stale(self):
        doc = snap_doc()
        doc.pop("collected_at")
        _, why = router._afp_parse_snapshot(doc, time.time())
        self.assertEqual(why, "stale")

    def test_bad_timestamp_is_stale(self):
        _, why = router._afp_parse_snapshot(snap_doc(collected="not-a-date"), time.time())
        self.assertEqual(why, "stale")

    def test_limit_zero_window_ignored(self):
        snap, why = router._afp_parse_snapshot(
            snap_doc(h5=(0, 0), d7=None, d30=None), time.time())
        self.assertEqual(why, "no_windows")


class TestGateCheck(unittest.TestCase):
    def test_gate_inactive_always_allows(self):
        # 未激活（默认 import 状态受生产配置影响，显式置 False 验证语义）
        saved = router.AFP_GATE_ACTIVE
        router.AFP_GATE_ACTIVE = False
        try:
            for est in (0, 700, 100000, 10**9):
                ok, why = router.afp_gate_check(GATE_UPSTREAM, est)
                self.assertTrue(ok)
                self.assertEqual(why, "")
        finally:
            router.AFP_GATE_ACTIVE = saved

    def test_snapshot_missing_allows(self):
        with gate_active(snap=None):
            ok, why = router.afp_gate_check(GATE_UPSTREAM, 10**9)
            self.assertTrue(ok)
            self.assertEqual(why, "")

    def test_exhausted_skips(self):
        with gate_active(snap={"min_avail": 0.0, "windows": {}, "collected_at": "x"}):
            ok, why = router.afp_gate_check(GATE_UPSTREAM, 700)
            self.assertFalse(ok)
            self.assertEqual(why, "afp_exhausted")

    def test_big_request_over_balance_skips(self):
        # avail=450：reserve 10% ⇒ 有效阈值 405；est=150000tok×0.001321=198.15… 用 400000tok→528.4
        with gate_active(snap={"min_avail": 450.0, "windows": {}, "collected_at": "x"}):
            ok, why = router.afp_gate_check(GATE_UPSTREAM, 400000)
            self.assertFalse(ok)
            self.assertEqual(why, "afp_would_exceed")
            # 15 万 tokens（≈198 AFP）< 405 ⇒ 放行
            ok2, why2 = router.afp_gate_check(GATE_UPSTREAM, 150000)
            self.assertTrue(ok2)
            self.assertEqual(why2, "")

    def test_small_request_always_allowed_when_avail(self):
        # avail 只剩 2 AFP：小额（est 700tok→0.925 AFP ≤ min_charge 1.0）仍放行（月包吃满）
        with gate_active(snap={"min_avail": 2.0, "windows": {}, "collected_at": "x"}):
            ok, why = router.afp_gate_check(GATE_UPSTREAM, 700)
            self.assertTrue(ok)
            self.assertEqual(why, "")

    def test_other_upstream_untouched(self):
        with gate_active(snap={"min_avail": 0.0, "windows": {}, "collected_at": "x"}):
            ok, why = router.afp_gate_check(OTHER_UPSTREAM, 10**9)
            self.assertTrue(ok)
            self.assertEqual(why, "")

    def test_exact_boundary(self):
        # est 恰好等于 avail×(1-reserve)：规格口径「超……的请求跳过」，等于不跳
        avail = 1000.0
        est_tok = int(avail * 0.9 / 0.001321)  # est == 900.0（浮点近似）
        with gate_active(snap={"min_avail": avail, "windows": {}, "collected_at": "x"}):
            ok, why = router.afp_gate_check(GATE_UPSTREAM, est_tok)
            self.assertTrue(ok, why)

    def test_min_charge_boundary(self):
        # est 恰好 = min_charge（1.0 AFP ⇒ 757 tokens）⇒ 小额放行
        with gate_active(snap={"min_avail": 1.5, "windows": {}, "collected_at": "x"}):
            ok, why = router.afp_gate_check(GATE_UPSTREAM, 757)
            self.assertTrue(ok)


class TestQuotaResetParse(unittest.TestCase):
    def test_future_resets(self):
        future = (datetime.now(router.TZ) + timedelta(minutes=90)).strftime("%Y-%m-%d %H:%M:%S")
        body = ('{"error":{"code":"AccountQuotaExceeded","message":"You have exceeded the '
                f'weekly usage quota. It will reset at {future} +0800 CST."}}').encode()
        secs = router.parse_quota_reset_seconds(body)
        self.assertIsNotNone(secs)
        self.assertTrue(85 * 60 <= secs <= 91 * 60, secs)

    def test_far_future_clamped_6h(self):
        future = (datetime.now(router.TZ) + timedelta(days=4)).strftime("%Y-%m-%d %H:%M:%S")
        body = f"It will reset at {future} +0800 CST".encode()
        self.assertEqual(router.parse_quota_reset_seconds(body), 6 * 3600)

    def test_past_returns_none(self):
        past = (datetime.now(router.TZ) - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")
        body = f"reset at {past}".encode()
        self.assertIsNone(router.parse_quota_reset_seconds(body))

    def test_no_match_returns_none(self):
        self.assertIsNone(router.parse_quota_reset_seconds(b'{"error":{"code":"x"}}'))
        self.assertIsNone(router.parse_quota_reset_seconds(b""))
        self.assertIsNone(router.parse_quota_reset_seconds(None))


class TestNoteFailure429(unittest.TestCase):
    def _state(self) -> router.UpstreamState:
        up = router.Upstream(id="test-up", label="t", base_url="http://127.0.0.1:1",
                             api_key_env="X", max_rpm=10)
        return router.UpstreamState(up)

    def test_429_uses_short_breaker(self):
        saved = router.AFP_429_BREAKER_SECONDS
        router.AFP_429_BREAKER_SECONDS = 300.0
        try:
            st = self._state()
            now = time.time()
            st.note_failure(429, "HTTP 429", now)
            self.assertAlmostEqual(st.circuit_until, now + 300, delta=1)
            ok, why = st.allow(now + 1)
            self.assertFalse(ok)
            self.assertIn("circuit_open", why)
        finally:
            router.AFP_429_BREAKER_SECONDS = saved

    def test_429_cooldown_overrides(self):
        st = self._state()
        now = time.time()
        st.note_failure(429, "HTTP 429", now, cooldown=3600.0)
        self.assertAlmostEqual(st.circuit_until, now + 3600, delta=1)

    def test_429_cooldown_clamped_low(self):
        st = self._state()
        now = time.time()
        st.note_failure(429, "HTTP 429", now, cooldown=5.0)  # 低于 1min 下限 → 夹 60
        self.assertAlmostEqual(st.circuit_until, now + 60, delta=1)

    def test_402_still_default_600(self):
        st = self._state()
        now = time.time()
        st.note_failure(402, "HTTP 402", now)
        self.assertAlmostEqual(st.circuit_until, now + router.BREAKER_SECONDS, delta=1)

    def test_500_still_default_600(self):
        st = self._state()
        now = time.time()
        st.note_failure(500, "HTTP 500", now)
        self.assertAlmostEqual(st.circuit_until, now + router.BREAKER_SECONDS, delta=1)


class TestLedgerAfpField(unittest.TestCase):
    def _entry(self, **kw):
        feats = router.Features(est_input_tokens=12345)
        return router.make_ledger_entry(
            req_id="r", virtual_model="auto", features=feats, stage="L2", period="offpeak",
            candidates=[f"{GATE_UPSTREAM}/label-model"], chosen=None, reason="x",
            attempts=[{"upstream": GATE_UPSTREAM, "model": "label-model",
                       "status": None, "ms": 0, "error": "skip:afp_exhausted"}],
            usage=None, final_status="failed", now=datetime.now(router.TZ), **kw)

    def test_afp_est_recorded(self):
        entry = self._entry(afp_est=16.3)
        self.assertEqual(entry["afp_est"], 16.3)
        self.assertEqual(entry["attempts"][0]["error"], "skip:afp_exhausted")

    def test_afp_est_default_none(self):
        self.assertIsNone(self._entry()["afp_est"])

    def test_est_tokens_conversion(self):
        saved = router.AFP_RATE_PER_TOKEN
        router.AFP_RATE_PER_TOKEN = 0.001321
        try:
            self.assertEqual(router.afp_est_tokens(150000), 198.15)
        finally:
            router.AFP_RATE_PER_TOKEN = saved


class TestSnapshotFileCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "quota-snapshot.json"
        self.saved = (router.AFP_QUOTA_PATH, router.AFP_STALE_AFTER)
        router.AFP_QUOTA_PATH = self.path
        router.AFP_STALE_AFTER = 7200.0
        router.afp_reset_cache()

    def tearDown(self):
        router.AFP_QUOTA_PATH, router.AFP_STALE_AFTER = self.saved
        router.afp_reset_cache()
        self.tmp.cleanup()

    def test_missing_file_none(self):
        self.assertIsNone(router.afp_snapshot())

    def test_read_and_mtime_cache(self):
        self.path.write_text(json.dumps(snap_doc()), encoding="utf-8")
        snap1 = router.afp_snapshot()
        self.assertIsNotNone(snap1)
        self.assertAlmostEqual(snap1["min_avail"], 7008.3, places=1)
        # 覆写（mtime 变）→ 重读新值
        self.path.write_text(json.dumps(snap_doc(h5=(9999.0, 10000))), encoding="utf-8")
        snap2 = router.afp_snapshot()
        self.assertAlmostEqual(snap2["min_avail"], 1.0, places=1)

    def test_stale_file_none(self):
        old = (datetime.now(router.TZ) - timedelta(hours=8)).isoformat(timespec="seconds")
        self.path.write_text(json.dumps(snap_doc(collected=old)), encoding="utf-8")
        self.assertIsNone(router.afp_snapshot())

    def test_bad_json_none(self):
        self.path.write_text("not json", encoding="utf-8")
        self.assertIsNone(router.afp_snapshot())


class TestStatsShape(unittest.TestCase):
    def test_afp_stats_keys(self):
        stats = router.afp_stats()
        for key in ("enabled", "active", "upstream", "rate_per_token",
                    "gate_skipped", "gate_allowed", "est_afp_sum",
                    "snapshot_stale", "snapshot_missing"):
            self.assertIn(key, stats)

    def test_stats_payload_has_afp(self):
        payload = router.stats_payload()
        self.assertIn("afp", payload)


if __name__ == "__main__":
    unittest.main()
