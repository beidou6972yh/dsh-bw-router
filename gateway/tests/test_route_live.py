#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T1（1.0.3.2 · 路由运行状态可视化）`router_live.snapshot()` + `/admin/live` 路由单测。

原则：
  - **只读、不启服务**：不 bind 端口、不调上游、不写生产 `数据/`、不改 `config/*`；
  - **任意环境可跑**：账本 / 影子记录都用 tempfile 造，价格表用内存桩，不依赖生产数据；
  - 覆盖契约 §4：空账本、缺键老账本、range 回落、limit 夹取、ok 判据、partial 截断、
    成本缺失=0、roles 三层聚合、recent 新→旧、未登录 401、页面路由（200 / 500 / no-store）。
"""

from __future__ import annotations

import json
import math
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw            # noqa: E402  —— import 时 main 会把自身设为 router_plan 的网关
import admin_ui             # noqa: E402
import router_live          # noqa: E402

TZ_CN = timezone(timedelta(hours=8))


def _ts(ago_s: float = 0.0) -> str:
    """+08:00 ISO（与账本/契约同口径；`%z` 给 +0800，router_plan._epoch_of_at 能解析）。"""
    moment = datetime.now(TZ_CN) - timedelta(seconds=ago_s)
    return moment.strftime("%Y-%m-%dT%H:%M:%S%z")


def _write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fp:
        for row in rows:
            fp.write(json.dumps(row, ensure_ascii=False) + "\n")


def _row(**overrides) -> dict:
    base = {
        "ts": _ts(0),
        "req_id": "req-a",
        "virtual_model": "auto",
        "stage": "L1",
        "period": "flat",
        "candidates": ["up/a"],
        "chosen": "up/a",
        "attempts": [{"upstream": "up", "model": "a", "status": 200, "ms": 100, "error": None}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2},
        "final_status": "ok",
    }
    base.update(overrides)
    return base


class _FakeHandler:
    """最小 handler 桩：只实现 admin_ui 会调到的 4 个方法/属性。"""

    def __init__(self, host: str = "127.0.0.1:18790"):
        self.headers = {"Host": host}
        self.status = None
        self.body = b""
        self.content_type = ""
        self.extra: dict = {}
        self._head_only = False

    def _send_bytes(self, status, body, content_type, extra=None):
        self.status = status
        self.body = body
        self.content_type = content_type
        self.extra = dict(extra or {})
        return status

    def _send_json(self, status, obj):
        return self._send_bytes(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                                "application/json; charset=utf-8")

    def _send_error_json(self, status, message, err_type=None, code=None):
        return self._send_json(status, {"error": {"message": message, "type": err_type,
                                                  "code": code, "status": status}})

    def _read_body(self):
        return b""


class _LiveTestBase(unittest.TestCase):
    def setUp(self):
        router_live._reset_caches()
        self.tmp = Path(tempfile.mkdtemp(prefix="route-live-"))
        self.ledger = self.tmp / "ledger.jsonl"
        self.shadow = self.tmp / "shadow.jsonl"
        self._orig_ledger = gw.LEDGER_PATH
        self._orig_shadow = router_live._shadow_log_path
        self._orig_pricebook = gw.pricebook_offer
        self._orig_session_user = admin_ui._session_user
        self._orig_live_html = admin_ui.LIVE_HTML_FILE
        gw.LEDGER_PATH = self.ledger
        router_live._shadow_log_path = lambda: self.shadow
        _write_jsonl(self.shadow, [])   # 默认空影子记录（不读生产 数据/）

    def tearDown(self):
        gw.LEDGER_PATH = self._orig_ledger
        router_live._shadow_log_path = self._orig_shadow
        gw.pricebook_offer = self._orig_pricebook
        admin_ui._session_user = self._orig_session_user
        admin_ui.LIVE_HTML_FILE = self._orig_live_html
        router_live._reset_caches()
        shutil.rmtree(self.tmp, ignore_errors=True)


class SnapshotBasics(_LiveTestBase):
    def test_empty_ledger_gives_defaults(self):
        snap = router_live.snapshot("24h", 30)
        self.assertTrue(snap["ok"])
        self.assertEqual(snap["mode"], "read_only")
        self.assertEqual(snap["range"]["key"], "24h")
        self.assertEqual(snap["range"]["seconds"], 86400)
        self.assertIn("+08:00", snap["generated_at"])
        self.assertEqual(snap["kpi"]["requests"], 0)
        self.assertEqual(snap["kpi"]["success_rate"], 0.0)
        self.assertEqual(snap["freshness"]["rows_in_range"], 0)
        self.assertEqual(snap["freshness"]["ledger_total_rows"], 0)
        self.assertFalse(snap["freshness"]["partial"])
        self.assertEqual(snap["recent"], [])
        self.assertEqual(snap["models"], [])
        self.assertEqual([role["key"] for role in snap["roles"]], ["L1", "L2", "L3"])
        for role in snap["roles"]:
            self.assertEqual(role["requests"], 0)
            self.assertEqual(role["models"], [])
        self.assertEqual(snap["ctx"]["bands"], {"pass": 0, "reject": 0, "unknown": 0})
        # deciders 读 config/deciders.json（生产树有、临时树无）⇒ 只断言形状，不断言具体计数。
        overview = snap["deciders"]["overview"]
        self.assertEqual(set(overview), {"off", "shadow", "active"})
        for value in overview.values():
            self.assertIsInstance(value, int)

    def test_missing_file_is_not_an_exception(self):
        gw.LEDGER_PATH = self.tmp / "does-not-exist.jsonl"
        snap = router_live.snapshot("1h", 5)
        self.assertTrue(snap["ok"])
        self.assertEqual(snap["kpi"]["requests"], 0)

    def test_old_ledger_missing_keys_gives_defaults(self):
        _write_jsonl(self.ledger, [
            {"ts": _ts(10)},                                             # 只有 ts
            {"ts": _ts(20), "final_status": None, "usage": None,
             "attempts": None, "candidates": None, "stage": None,
             "chosen": None, "model_chosen": None},                      # 大量缺键
        ])
        snap = router_live.snapshot("24h", 30)
        self.assertTrue(snap["ok"])
        self.assertEqual(snap["kpi"]["requests"], 2)
        self.assertEqual(snap["kpi"]["failed"], 2)                       # 无 final_status ⇒ 不算成功
        self.assertEqual(snap["kpi"]["p50_ms"], 0)
        self.assertEqual(snap["kpi"]["cost_cny"], 0.0)
        recent = snap["recent"]
        self.assertEqual(len(recent), 2)
        for item in recent:
            self.assertEqual(item["chosen"], "")
            self.assertEqual(item["candidates"], [])
            self.assertEqual(item["attempts"], [])
            self.assertEqual(item["stage"], "")
            self.assertFalse(item["ok"])
            self.assertEqual(item["prompt_tokens"], 0)
            self.assertIsNone(item["ctx_used_pct"])
        json.dumps(snap, ensure_ascii=False, allow_nan=False)            # 不允许 NaN/Infinity

    def test_range_parse_invalid_falls_back_to_24h(self):
        self.ledger.write_text("", encoding="utf-8")
        for raw, key, seconds in (("bogus", "24h", 86400), ("", "24h", 86400),
                                  (None, "24h", 86400), ("1h", "1h", 3600),
                                  ("6H", "6h", 21600), ("7d", "7d", 604800)):
            snap = router_live.snapshot(raw, 30)
            self.assertEqual(snap["range"]["key"], key, raw)
            self.assertEqual(snap["range"]["seconds"], seconds, raw)

    def test_limit_clamped(self):
        _write_jsonl(self.ledger, [
            _row(req_id=f"req-{index:03d}", ts=_ts(index)) for index in range(150)
        ])
        self.assertEqual(len(router_live.snapshot("24h", 0)["recent"]), 1)
        self.assertEqual(len(router_live.snapshot("24h", -5)["recent"]), 1)
        self.assertEqual(len(router_live.snapshot("24h", "abc")["recent"]), 30)
        self.assertEqual(len(router_live.snapshot("24h", 999)["recent"]), 100)
        self.assertEqual(len(router_live.snapshot("24h", "7")["recent"]), 7)

    def test_ok_criterion_ok_prefix(self):
        statuses = ["ok", "ok_stream", "error", "timeout", None]
        _write_jsonl(self.ledger, [
            _row(req_id=f"req-{index}", ts=_ts(index + 1), final_status=status)
            for index, status in enumerate(statuses)
        ])
        snap = router_live.snapshot("24h", 30)
        self.assertEqual(snap["kpi"]["requests"], 5)
        self.assertEqual(snap["kpi"]["ok"], 2)
        self.assertEqual(snap["kpi"]["failed"], 3)
        self.assertEqual(snap["kpi"]["success_rate"], 0.4)


class SnapshotAggregation(_LiveTestBase):
    def test_roles_three_layers(self):
        _write_jsonl(self.ledger, [
            _row(req_id="r1", ts=_ts(50), stage="L1", chosen="up/a",
                 attempts=[{"upstream": "up", "model": "a", "status": 200, "ms": 100}]),
            _row(req_id="r2", ts=_ts(40), stage="L1", chosen="up/b", final_status="error",
                 attempts=[{"upstream": "up", "model": "b", "status": 500, "ms": 300}]),
            _row(req_id="r3", ts=_ts(30), stage="L2", chosen="up/a"),
            _row(req_id="r4", ts=_ts(20), stage="L3", chosen="up/c",
                 attempts=[{"upstream": "up", "model": "c", "status": 200, "ms": 900}]),
            _row(req_id="r5", ts=_ts(10), stage=None, chosen="up/a"),   # 缺 stage：不进泳道
        ])
        snap = router_live.snapshot("24h", 30)
        roles = {role["key"]: role for role in snap["roles"]}
        self.assertEqual([role["key"] for role in snap["roles"]], ["L1", "L2", "L3"])
        self.assertEqual(roles["L1"]["requests"], 2)
        self.assertEqual(roles["L1"]["ok"], 1)
        self.assertEqual(roles["L1"]["failed"], 1)
        self.assertEqual(roles["L1"]["share"], round(2 / 5, 4))
        self.assertEqual(roles["L1"]["label"], "轻判断")
        self.assertEqual(roles["L2"]["requests"], 1)
        self.assertEqual(roles["L3"]["requests"], 1)
        self.assertEqual(roles["L3"]["p50_ms"], 900)
        l1_models = {item["key"]: item for item in roles["L1"]["models"]}
        self.assertEqual(l1_models["up/a"]["requests"], 1)
        self.assertEqual(l1_models["up/b"]["failed"], 1)
        self.assertAlmostEqual(l1_models["up/a"]["share"], 0.5, places=4)

    def test_roles_upshift_counts_multi_attempt_or_fallback(self):
        _write_jsonl(self.ledger, [
            _row(req_id="u1", ts=_ts(30), stage="L1",
                 attempts=[{"upstream": "up", "model": "a", "status": 500, "ms": 10},
                           {"upstream": "up", "model": "b", "status": 200, "ms": 20}]),
            _row(req_id="u2", ts=_ts(20), stage="L1", fallback={"to": "up/c"}),
            _row(req_id="u3", ts=_ts(10), stage="L1"),
        ])
        roles = {role["key"]: role for role in router_live.snapshot("24h", 30)["roles"]}
        self.assertEqual(roles["L1"]["upshift"], 2)

    def test_recent_newest_first(self):
        _write_jsonl(self.ledger, [
            _row(req_id="old", ts=_ts(100)),
            _row(req_id="new", ts=_ts(10)),
            _row(req_id="mid", ts=_ts(50)),
        ])
        recent = router_live.snapshot("24h", 2)["recent"]
        self.assertEqual([item["req_id"] for item in recent], ["new", "mid"])
        epochs = [datetime.strptime(item["ts"], "%Y-%m-%dT%H:%M:%S%z").timestamp()
                  for item in recent]
        self.assertEqual(epochs, sorted(epochs, reverse=True))

    def test_ctx_bands_and_mode(self):
        _write_jsonl(self.ledger, [
            _row(req_id="c1", ts=_ts(30), ctx_gov={"mode": "shadow", "band": "pass",
                                                   "used": 50, "window": 1000}),
            _row(req_id="c2", ts=_ts(20), ctx_gov={"mode": "shadow", "band": "pass",
                                                   "used": 90, "window": 1000}),
            _row(req_id="c3", ts=_ts(10)),
        ])
        ctx = router_live.snapshot("24h", 30)["ctx"]
        self.assertEqual(ctx["mode"], "shadow")
        self.assertEqual(ctx["bands"]["pass"], 2)
        self.assertEqual(ctx["bands"]["unknown"], 1)
        self.assertEqual(ctx["p50_used_pct"], 0.05)
        first_bucket = ctx["buckets"][0]
        self.assertEqual(first_bucket["from"], 0)
        self.assertEqual(first_bucket["to"], 10)
        self.assertEqual(first_bucket["count"], 2)

    def test_models_matrix(self):
        _write_jsonl(self.ledger, [
            _row(req_id="m1", ts=_ts(20), stage="L1", chosen="up/a"),
            _row(req_id="m2", ts=_ts(10), stage="L3", chosen="up/a",
                 attempts=[{"upstream": "up", "model": "a", "status": 200, "ms": 300}]),
            _row(req_id="m2b", ts=_ts(8), stage="L3", chosen="up/a",
                 attempts=[{"upstream": "up", "model": "a", "status": 200, "ms": 300}]),
            _row(req_id="m3", ts=_ts(5), stage="L2", chosen="other/b"),
        ])
        snap = router_live.snapshot("7d", 30)
        models = {item["key"]: item for item in snap["models"]}
        self.assertEqual(models["up/a"]["requests"], 3)
        self.assertEqual(models["up/a"]["top_stage"], "L3")
        self.assertEqual(models["up/a"]["share"], round(3 / 4, 4))
        self.assertEqual(models["other/b"]["upstream"], "other")
        self.assertEqual(models["other/b"]["model"], "b")


class SnapshotCost(_LiveTestBase):
    def test_when_price_available_cost_is_computed(self):
        def fake_offer(candidate):
            if candidate == "paid/m":
                return {"id": "paid/m", "provider": "paid", "model_id": "m",
                        "price": {"base": {"input": 2.0, "output": 10.0}}}
            return None

        gw.pricebook_offer = fake_offer
        _write_jsonl(self.ledger, [
            _row(req_id="paid", ts=_ts(10), chosen="paid/m",
                 usage={"prompt_tokens": 1_000_000, "completion_tokens": 100_000}),
        ])
        snap = router_live.snapshot("24h", 30)
        self.assertEqual(snap["kpi"]["cost_cny"], 3.0)      # 2.0 + 1.0
        self.assertEqual(snap["recent"][0]["cost_cny"], 3.0)
        self.assertEqual(snap["roles"][0]["cost_cny"], 3.0)

    def test_unknown_model_cost_is_zero_not_nan(self):
        gw.pricebook_offer = lambda candidate: None     # 未知模型 / 本地免费
        _write_jsonl(self.ledger, [
            _row(req_id="unknown", ts=_ts(10), chosen="nope/unknown",
                 usage={"prompt_tokens": 123456, "completion_tokens": 789}),
        ])
        snap = router_live.snapshot("24h", 30)
        self.assertEqual(snap["kpi"]["cost_cny"], 0.0)
        self.assertEqual(snap["recent"][0]["cost_cny"], 0.0)
        for value in (snap["kpi"]["cost_cny"], snap["recent"][0]["cost_cny"]):
            self.assertFalse(math.isnan(float(value)))
        json.dumps(snap, ensure_ascii=False, allow_nan=False)

    def test_price_block_cached_per_offer_day_period(self):
        calls = {"n": 0}

        def fake_offer(candidate):
            calls["n"] += 1
            return {"id": "paid/m", "provider": "paid", "model_id": "m",
                    "price": {"base": {"input": 1.0, "output": 1.0}}}

        gw.pricebook_offer = fake_offer
        _write_jsonl(self.ledger, [
            _row(req_id="p1", ts=_ts(30), chosen="paid/m", period="offpeak"),
            _row(req_id="p2", ts=_ts(20), chosen="paid/m", period="offpeak"),
            _row(req_id="p3", ts=_ts(10), chosen="paid/m", period="offpeak"),
        ])
        snap = router_live.snapshot("24h", 30)
        self.assertEqual(snap["kpi"]["requests"], 3)
        self.assertEqual(calls["n"], 1)   # (offer_id, 日期, period) 缓存 ⇒ 3 行只查价 1 次


class SnapshotPartial(_LiveTestBase):
    def test_partial_true_when_truncation_cuts_in_range_rows(self):
        now_rows = []
        for index in range(1400):
            now_rows.append({"ts": _ts(index * 0.05), "req_id": f"req-{index}",
                             "chosen": "up/a", "stage": "L1", "period": "flat",
                             "final_status": "ok", "pad": "x" * 700})
        _write_jsonl(self.ledger, now_rows)
        self.assertGreater(self.ledger.stat().st_size, 1024 * 1024)
        snap = router_live.snapshot("1h", 5)
        self.assertTrue(snap["freshness"]["partial"])
        self.assertEqual(snap["freshness"]["ledger_total_rows"], 1400)
        self.assertGreater(snap["freshness"]["rows_in_range"], 0)
        self.assertLess(snap["freshness"]["rows_in_range"], 1400)
        self.assertTrue(any("partial" in note for note in snap["notes"]))

    def test_partial_false_when_tail_covers_whole_range(self):
        _write_jsonl(self.ledger, [_row(req_id="small", ts=_ts(5))])
        snap = router_live.snapshot("1h", 5)
        self.assertFalse(snap["freshness"]["partial"])
        self.assertEqual(snap["freshness"]["rows_in_range"], 1)
        self.assertLess(snap["freshness"]["scanned_bytes"], 1024 * 1024)


class SnapshotDeciders(_LiveTestBase):
    def test_shadow_stats_from_shadow_log(self):
        _write_jsonl(self.shadow, [
            {"ts": _ts(30), "status": "ok", "latency_ms": 100},
            {"ts": _ts(20), "status": "error", "error": "timed out", "latency_ms": 900},
            {"ts": _ts(10), "status": "parse_error", "latency_ms": 200},
        ])
        deciders = router_live.snapshot("24h", 30)["deciders"]
        shadow = deciders["shadow"]
        self.assertEqual(shadow["total"], 3)
        self.assertEqual(shadow["ok"], 1)
        self.assertEqual(shadow["error"], 2)
        self.assertEqual(shadow["timeout"], 1)
        self.assertEqual(shadow["p50_ms"], 200)
        self.assertEqual(set(deciders["overview"]), {"off", "shadow", "active"})
        self.assertIsInstance(deciders["by_strategy"], dict)


class SnapshotCache(_LiveTestBase):
    def test_result_cached_two_seconds(self):
        _write_jsonl(self.ledger, [_row(req_id="first", ts=_ts(10))])
        first = router_live.snapshot("24h", 30)
        _write_jsonl(self.ledger, [_row(req_id="second", ts=_ts(5)),
                                   _row(req_id="third", ts=_ts(4))])
        cached = router_live.snapshot("24h", 30)      # 2s 内：命中缓存
        self.assertEqual(cached["kpi"]["requests"], first["kpi"]["requests"])
        router_live._reset_caches()
        fresh = router_live.snapshot("24h", 30)
        self.assertEqual(fresh["kpi"]["requests"], 2)


class AdminRoutes(_LiveTestBase):
    def test_api_live_requires_login_401(self):
        admin_ui._session_user = lambda handler: None
        handler = _FakeHandler()
        status = admin_ui.handle(handler, "GET", "/admin/api/live", {})
        self.assertEqual(status, 401)
        payload = json.loads(handler.body.decode("utf-8"))
        self.assertEqual(payload["error"]["code"], "admin_unauthorized")

    def test_api_live_logged_in_200_json_no_store(self):
        admin_ui._session_user = lambda handler: "admin"
        _write_jsonl(self.ledger, [_row(req_id=f"r{index}", ts=_ts(index + 1))
                                   for index in range(8)])
        handler = _FakeHandler()
        status = admin_ui.handle(handler, "GET", "/admin/api/live",
                                 {"range": ["7d"], "limit": ["5"]})
        self.assertEqual(status, 200)
        payload = json.loads(handler.body.decode("utf-8"))
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["range"]["key"], "7d")
        self.assertEqual(len(payload["recent"]), 5)
        self.assertEqual(handler.extra.get("Cache-Control"), "no-store")
        self.assertIn("application/json", handler.content_type)

    def test_live_page_serves_html_200_no_store(self):
        page = self.tmp / "admin-live.html"
        page.write_text("<html><body>live</body></html>", encoding="utf-8")
        admin_ui.LIVE_HTML_FILE = page
        handler = _FakeHandler()
        status = admin_ui.handle(handler, "GET", "/admin/live", {})
        self.assertEqual(status, 200)
        self.assertEqual(handler.body.decode("utf-8"), "<html><body>live</body></html>")
        self.assertIn("text/html", handler.content_type)
        self.assertEqual(handler.extra.get("Cache-Control"), "no-store")
        self.assertEqual(admin_ui.handle(_FakeHandler(), "GET", "/admin/live/", {}), 200)

    def test_live_page_missing_html_500(self):
        admin_ui.LIVE_HTML_FILE = self.tmp / "missing-page.html"
        handler = _FakeHandler()
        status = admin_ui.handle(handler, "GET", "/admin/live", {})
        self.assertEqual(status, 500)
        payload = json.loads(handler.body.decode("utf-8"))
        self.assertEqual(payload["error"]["code"], "admin_live_html_missing")
        self.assertIn("admin-live.html 缺失", payload["error"]["message"])

    def test_live_page_rejects_non_loopback_host(self):
        page = self.tmp / "admin-live.html"
        page.write_text("<html></html>", encoding="utf-8")
        admin_ui.LIVE_HTML_FILE = page
        handler = _FakeHandler(host="evil.example.com")
        self.assertEqual(admin_ui.handle(handler, "GET", "/admin/live", {}), 403)


class ContractShape(_LiveTestBase):
    def test_contract_fields_and_types(self):
        _write_jsonl(self.ledger, [
            _row(req_id="shape", ts=_ts(10), stage="L2", chosen="up/a",
                 ctx_gov={"mode": "shadow", "band": "pass", "used": 10, "window": 1000}),
        ])
        snap = router_live.snapshot("24h", 30)
        for key in ("ok", "mode", "generated_at", "range", "gateway", "freshness", "kpi",
                    "roles", "recent", "models", "upstreams", "ctx", "deciders", "notes"):
            self.assertIn(key, snap)
        self.assertTrue(snap["ok"])
        self.assertIsInstance(snap["notes"], list)
        self.assertEqual(set(snap["range"]), {"key", "seconds", "since", "until"})
        self.assertEqual(set(snap["gateway"]),
                         {"ok", "uptime_s", "version", "host", "port"})
        self.assertEqual(set(snap["freshness"]),
                         {"ledger_total_rows", "rows_in_range", "scanned_bytes",
                          "partial", "ledger_mtime"})
        self.assertEqual(set(snap["kpi"]),
                         {"requests", "ok", "failed", "success_rate", "p50_ms", "p95_ms",
                          "prompt_tokens", "completion_tokens", "cost_cny",
                          "local_share", "cloud_share"})
        self.assertEqual(set(snap["ctx"]), {"mode", "bands", "p50_used_pct", "buckets"})
        self.assertEqual(set(snap["ctx"]["bands"]), {"pass", "reject", "unknown"})
        self.assertEqual(len(snap["ctx"]["buckets"]), 10)
        self.assertEqual(set(snap["deciders"]), {"overview", "by_strategy", "shadow"})
        self.assertEqual(set(snap["deciders"]["shadow"]),
                         {"total", "ok", "error", "timeout", "p50_ms"})
        recent = snap["recent"][0]
        for key in ("ts", "req_id", "virtual_model", "stage", "period", "candidates",
                    "chosen", "ok", "final_status", "total_ms", "attempts",
                    "prompt_tokens", "completion_tokens", "cost_cny", "ctx_band",
                    "ctx_used_pct"):
            self.assertIn(key, recent)
        role = snap["roles"][0]
        for key in ("key", "label", "desc", "requests", "ok", "failed", "p50_ms",
                    "p95_ms", "prompt_tokens", "completion_tokens", "cost_cny",
                    "share", "upshift", "models"):
            self.assertIn(key, role)
        model = snap["models"][0]
        for key in ("key", "upstream", "model", "requests", "ok", "failed", "p50_ms",
                    "p95_ms", "prompt_tokens", "completion_tokens", "cost_cny",
                    "share", "local", "top_stage"):
            self.assertIn(key, model)


if __name__ == "__main__":       # pragma: no cover
    unittest.main(verbosity=2)
