#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""occupancy_host 单元测试：逐条覆盖内部规格 v1.1-d2 §1.7 的 ①–⑭。

不联网、不起监听端口、不写生产账本、不依赖真实时钟：
- 时间一律注入 `now_ms`（基准常量 `BASE_MS`）；
- 文件通道用 `tempfile` 临时目录，经 `ROUTER_OCCUPANCY_FILE` 指过去，测完恢复环境变量。

用例与规格条目的对应：
① 必填缺失/类型错逐项 rejected（NormalizeCase.test_missing_required_field_rejected 等）
② `mem_used_mb` 兼容读入 / 两键并存以 mib 为准
③ 输出键只有 `mem_used_mib`（序列化后不含 `mem_used_mb`）
④ 29s/30s/31s 与 ±60s 未来容忍边界
⑤ 未来时间戳 > 60s ⇒ conflicts 且不 fresh
⑥ `preemptible=True & active_requests>0` ⇒ conflict
⑦ `fresh_only` 排除 stale
⑧ `gpu` 无 fresh 时 None、有 fresh 时取最大 mem
⑨ snapshot.items 排序规则
⑩ `STORE_LIMIT` 淘汰最旧 reported_at
⑪ `host_ready_for_retry` 三分支＋边界
⑫ `poll_file` mtime 未变不重复 / force / 坏 JSON 不污染存储
⑬ 文件通道 `{"reports": [...]}` 数组形状
⑭ `start_poller` 幂等且真能轮询入库

运行：
    cd <网关树根>            # 树根需含 main.py 与 config/routing.json、upstreams.json
    export ROUTER_DATA_DIR=/tmp/occ-impl-test
    python3 -m unittest tests.test_occupancy_report -v
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import occupancy_host as occ  # noqa: E402

#: 固定基准时刻（2027-01-15T16:00:00+08:00 附近），单位毫秒；避免依赖真实时钟
BASE_MS = 1_800_000_000_000

NORMALIZED_KEYS = {
    "host_id", "model", "loaded", "active_requests", "last_active_ts", "reported_at",
    "gpu_util", "mem_used_mib", "preemptible", "age_ms", "fresh", "stale",
    "conflicts", "compat", "last_active_at", "reported_at_iso",
}


def report(drop=(), **overrides) -> dict:
    """造一条合法上报；`drop` 用于删字段，`overrides` 用于覆盖/写坏字段值。"""
    data = {
        "host_id": "host-a",
        "model": "m1",
        "loaded": True,
        "active_requests": 1,
        "last_active_ts": BASE_MS - 5_000,
        "reported_at": BASE_MS,
        "gpu_util": 0.5,
        "mem_used_mib": 9000.0,
        "preemptible": False,
    }
    for key in drop:
        data.pop(key, None)
    data.update(overrides)
    return data


class BaseCase(unittest.TestCase):
    """公共底座：每个用例前后清空模块内状态，防止用例互相污染。"""

    def setUp(self) -> None:
        occ.reset_state()
        self.addCleanup(occ.reset_state)


# ---------------------------------------------------------------------------
# §1.7 ①–⑥ ＋ §1.2 normalize
# ---------------------------------------------------------------------------

class NormalizeCase(BaseCase):
    """normalize：要什么收什么、坏什么抛什么、新鲜度与冲突怎么记。"""

    def test_missing_required_field_rejected(self):
        """① 六个必填字段逐个缺失都抛 ValueError，且消息里点名字段。"""
        for field in occ.REQUIRED_FIELDS:
            with self.subTest(field=field):
                with self.assertRaises(ValueError) as ctx:
                    occ.normalize(report(drop=[field]))
                self.assertIn(field, str(ctx.exception))

    def test_type_errors_rejected(self):
        """① 类型不严格一律拒：bool 不算 int、int 不算 bool、number 不收字符串。"""
        cases = [
            ("loaded", "true"),          # 字符串不是 bool
            ("loaded", 1),               # int 不是 bool
            ("active_requests", True),   # bool 不算 int
            ("active_requests", "3"),
            ("last_active_ts", "1800000000000"),
            ("reported_at", 1_800_000_000_000.5),   # 浮点不算 int
            ("host_id", 123),
            ("model", None),
            ("gpu_util", "0.5"),
            ("mem_used_mib", "9000"),
            ("preemptible", "yes"),
        ]
        for field, bad in cases:
            with self.subTest(field=field, bad=bad):
                with self.assertRaises(ValueError) as ctx:
                    occ.normalize(report(**{field: bad}))
                self.assertIn(field, str(ctx.exception))

    def test_blank_identity_and_negative_active_rejected(self):
        """① 空白 host_id/model 与负 active_requests 都算非法（前者无法当主键）。"""
        for field in ("host_id", "model"):
            with self.subTest(field=field):
                with self.assertRaises(ValueError) as ctx:
                    occ.normalize(report(**{field: "   "}))
                self.assertIn(field, str(ctx.exception))
        with self.assertRaises(ValueError) as ctx:
            occ.normalize(report(active_requests=-1))
        self.assertIn("active_requests", str(ctx.exception))

    def test_optional_fields_default_to_none(self):
        """可选三字段整体缺失 ⇒ 全 None（不填 0、不填 "未知"），不是非法。"""
        entry = occ.normalize(report(drop=["gpu_util", "mem_used_mib", "preemptible"]), now_ms=BASE_MS)
        self.assertIsNone(entry["gpu_util"])
        self.assertIsNone(entry["mem_used_mib"])
        self.assertIsNone(entry["preemptible"])
        self.assertEqual(entry["conflicts"], [])

    def test_negative_and_nan_numeric_become_none(self):
        """§1.2 负数/NaN/Inf ⇒ None（不是非法、不当 0），bool 仍按类型错拒。"""
        for bad in (-1, -0.5, float("nan"), float("inf")):
            with self.subTest(bad=bad):
                entry = occ.normalize(report(mem_used_mib=bad, gpu_util=bad), now_ms=BASE_MS)
                self.assertIsNone(entry["mem_used_mib"])
                self.assertIsNone(entry["gpu_util"])
        with self.assertRaises(ValueError):
            occ.normalize(report(mem_used_mib=True))

    def test_mem_used_mb_compat_read(self):
        """② 只有旧字段 mem_used_mb ⇒ 读成 mem_used_mib，compat 记一条。"""
        raw = report(drop=["mem_used_mib"])
        raw["mem_used_mb"] = 8800
        entry = occ.normalize(raw, now_ms=BASE_MS)
        self.assertEqual(entry["mem_used_mib"], 8800.0)
        self.assertEqual(entry["compat"], [occ.COMPAT_LEGACY_USED])
        self.assertNotIn("mem_used_mb", entry)

    def test_mem_used_mib_wins_when_both_present(self):
        """② 两键同时出现 ⇒ 以 mem_used_mib 为准，compat 记 ignored（旧值只备核）。"""
        raw = report(mem_used_mib=1200.0)
        raw["mem_used_mb"] = 99_999
        entry = occ.normalize(raw, now_ms=BASE_MS)
        self.assertEqual(entry["mem_used_mib"], 1200.0)
        self.assertEqual(entry["compat"], [occ.COMPAT_LEGACY_IGNORED])

    def test_output_has_only_mem_used_mib_key(self):
        """③ 输出键固定，序列化后不存在 mem_used_mb 键（单位/字段名统一 MiB）。"""
        entry = occ.normalize(report(), now_ms=BASE_MS)
        self.assertEqual(set(entry), NORMALIZED_KEYS)
        # 普通上报（无兼容读入）整串序列化里压根不该出现旧字段名
        self.assertNotIn("mem_used_mb", json.dumps(entry, ensure_ascii=False))
        self.assertIn("mem_used_mib", json.dumps(entry, ensure_ascii=False))
        # 兼容读入路径同样只吐新字段名（compat 标记里出现旧名是规格要求，故只查键）
        legacy = report(drop=["mem_used_mib"])
        legacy["mem_used_mb"] = 1024
        legacy_entry = occ.normalize(legacy, now_ms=BASE_MS)
        self.assertNotIn("mem_used_mb", legacy_entry)
        self.assertEqual(set(legacy_entry), NORMALIZED_KEYS)
        self.assertEqual(json.loads(json.dumps(legacy_entry))["mem_used_mib"], 1024.0)

    def test_fresh_stale_boundaries(self):
        """④ age 边界：29s/30s fresh，31s stale；未来 -60s 仍 fresh，-60.001s 起 stale。"""
        cases = [
            (0, True), (29_000, True), (30_000, True), (30_001, False), (31_000, False),
            (-60_000, True), (-60_001, False), (-600_000, False),
        ]
        for age_ms, expect_fresh in cases:
            with self.subTest(age_ms=age_ms):
                at = BASE_MS - age_ms
                entry = occ.normalize(report(reported_at=at), now_ms=BASE_MS)
                self.assertEqual(entry["age_ms"], age_ms)
                self.assertIs(entry["fresh"], expect_fresh)
                self.assertIs(entry["stale"], not expect_fresh)

    def test_future_timestamp_over_skew_is_conflict_and_not_fresh(self):
        """⑤ 未来 > 60s ⇒ conflicts 含 reported_at_in_future 且不 fresh（能展示但不能用）。"""
        entry = occ.normalize(report(reported_at=BASE_MS + 61_000), now_ms=BASE_MS)
        self.assertEqual(entry["age_ms"], -61_000)
        self.assertIn(occ.CONFLICT_FUTURE, entry["conflicts"])
        self.assertFalse(entry["fresh"])
        # 容差以内不算冲突
        inside = occ.normalize(report(reported_at=BASE_MS + 60_000), now_ms=BASE_MS)
        self.assertNotIn(occ.CONFLICT_FUTURE, inside["conflicts"])
        self.assertTrue(inside["fresh"])

    def test_preemptible_conflict_recorded_value_kept(self):
        """⑥ preemptible=True 且在飞 >0 ⇒ conflict，但值不改（以 active_requests 为准）。"""
        entry = occ.normalize(report(preemptible=True, active_requests=2), now_ms=BASE_MS)
        self.assertIn(occ.CONFLICT_PREEMPTIBLE, entry["conflicts"])
        self.assertTrue(entry["preemptible"])
        self.assertEqual(entry["active_requests"], 2)
        # 空闲时同样允许标记可卸 ⇒ 无冲突
        idle = occ.normalize(report(preemptible=True, active_requests=0), now_ms=BASE_MS)
        self.assertNotIn(occ.CONFLICT_PREEMPTIBLE, idle["conflicts"])

    def test_iso_fields_are_plus8_seconds(self):
        """§1.2 对外时间统一 ISO+08:00、秒精度；last_active_ts 也按毫秒换算。"""
        entry = occ.normalize(report(last_active_ts=BASE_MS - 1_000), now_ms=BASE_MS)
        pattern = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$")
        self.assertRegex(entry["reported_at_iso"], pattern)
        self.assertRegex(entry["last_active_at"], pattern)
        self.assertEqual(entry["reported_at_iso"], occ.iso_from_ms(BASE_MS))

    def test_iso_helpers_from_main_spec(self):
        """§1.10 两个时间工具：毫秒/秒入口同款输出，main 直接取用不 AttributeError。"""
        self.assertEqual(occ.iso_from_ms(BASE_MS), "2027-01-15T16:00:00+08:00")
        self.assertEqual(occ.iso_from_ts(BASE_MS / 1000.0), "2027-01-15T16:00:00+08:00")
        self.assertEqual(occ.iso_from_ts(BASE_MS / 1000.0 + 5.9), "2027-01-15T16:00:05+08:00")
        self.assertTrue(occ.iso_from_ms(0).endswith("+08:00"))
        with self.assertRaises(ValueError):
            occ.iso_from_ms(10 ** 18)


# ---------------------------------------------------------------------------
# §1.3 ingest
# ---------------------------------------------------------------------------

class IngestCase(BaseCase):
    """ingest：四种载荷形状、坏条目跳过不抛、按 (host_id, model) 覆盖、容量淘汰。"""

    def test_single_dict_payload(self):
        """单条 dict：index 0 语义，accepted=1，无 rejected。"""
        result = occ.ingest(report(), now_ms=BASE_MS)
        self.assertEqual(result["source"], "push")
        self.assertEqual(result["accepted"], 1)
        self.assertEqual(result["rejected"], [])
        self.assertEqual(result["stored"], 1)

    def test_report_key_payload(self):
        """{"report": {...}} 也收（宿主单条上报的包装写法）。"""
        result = occ.ingest({"report": report(host_id="host-b")}, now_ms=BASE_MS)
        self.assertEqual(result["accepted"], 1)
        self.assertIsNotNone(occ.find("host-b", "m1", now_ms=BASE_MS))

    def test_reports_list_skips_bad_entries(self):
        """①+§1.3 坏条目按下标进 rejected，不影响同批其它条目。"""
        payload = {
            "reports": [
                report(host_id="host-a"),
                report(host_id="host-b", loaded="yes"),      # 类型错
                report(host_id="host-c", reported_at=None),   # 必填缺失
                report(host_id="host-d"),
            ]
        }
        result = occ.ingest(payload, now_ms=BASE_MS)
        self.assertEqual(result["accepted"], 2)
        self.assertEqual([row["index"] for row in result["rejected"]], [1, 2])
        self.assertTrue(all(row["error"] for row in result["rejected"]))
        self.assertEqual(result["stored"], 2)
        self.assertIsNone(occ.find("host-b", "m1", now_ms=BASE_MS))

    def test_bare_list_payload(self):
        """裸数组形状同样收（文件通道的最简写法）。"""
        result = occ.ingest([report(host_id="host-a"), report(host_id="host-b")], now_ms=BASE_MS)
        self.assertEqual(result["accepted"], 2)
        self.assertEqual(result["stored"], 2)

    def test_unsupported_payload_is_rejected_not_raised(self):
        """非 dict/list 载荷 ⇒ accepted 0 + index 0 的 rejected，不抛异常。"""
        result = occ.ingest("not-a-payload", now_ms=BASE_MS)
        self.assertEqual(result["accepted"], 0)
        self.assertEqual(len(result["rejected"]), 1)
        self.assertEqual(result["rejected"][0]["index"], 0)
        self.assertEqual(result["stored"], 0)

    def test_overwrite_same_host_and_model(self):
        """同一 (host_id, model) 后到覆盖先到，存储不涨条目。"""
        occ.ingest(report(active_requests=4), now_ms=BASE_MS)
        result = occ.ingest(report(active_requests=0, mem_used_mib=100.0), now_ms=BASE_MS)
        self.assertEqual(result["stored"], 1)
        entry = occ.find("host-a", "m1", now_ms=BASE_MS)
        self.assertEqual(entry["active_requests"], 0)
        self.assertEqual(entry["mem_used_mib"], 100.0)
        # 不同 model 视为不同条目
        occ.ingest(report(model="m2"), now_ms=BASE_MS)
        self.assertEqual(occ.ingest(report(), now_ms=BASE_MS)["stored"], 2)

    def test_store_limit_evicts_oldest_reported_at(self):
        """⑩ 超过 STORE_LIMIT 时淘汰 reported_at 最旧的（按时间而不是插入顺序）。"""
        total = occ.STORE_LIMIT + 6
        items = [
            report(host_id=f"host-{index:02d}", reported_at=BASE_MS - index * 100)
            for index in range(total)
        ]
        result = occ.ingest(items, now_ms=BASE_MS)
        self.assertEqual(result["accepted"], total)
        self.assertEqual(result["stored"], occ.STORE_LIMIT)
        snapshot = occ.snapshot(now_ms=BASE_MS)
        self.assertEqual(len(snapshot["items"]), occ.STORE_LIMIT)
        # 最旧的 6 条（index 69..64）被淘汰，其余还在
        for index in range(total - 6, total):
            self.assertIsNone(occ.find(f"host-{index:02d}", "m1", now_ms=BASE_MS))
        for index in range(0, occ.STORE_LIMIT):
            self.assertIsNotNone(occ.find(f"host-{index:02d}", "m1", now_ms=BASE_MS))


# ---------------------------------------------------------------------------
# §1.4 snapshot ＋ §1.5 判断接口
# ---------------------------------------------------------------------------

class SnapshotCase(BaseCase):
    """snapshot / fresh_only / find / host_ready_for_retry 的口径与排序。"""

    def test_fresh_only_excludes_stale(self):
        """⑦ 判断接口只认 fresh；过期条目只在 snapshot 展示。"""
        occ.ingest([
            report(host_id="host-fresh", reported_at=BASE_MS),
            report(host_id="host-stale", reported_at=BASE_MS - 31_000),
        ], now_ms=BASE_MS)
        fresh = occ.fresh_only(now_ms=BASE_MS)
        self.assertEqual([item["host_id"] for item in fresh], ["host-fresh"])
        self.assertIsNone(occ.find("host-stale", "m1", now_ms=BASE_MS))
        stale_entry = occ.find("host-stale", "m1", fresh=False, now_ms=BASE_MS)
        self.assertIsNotNone(stale_entry)
        self.assertTrue(stale_entry["stale"])
        snapshot = occ.snapshot(now_ms=BASE_MS)
        self.assertEqual(snapshot["fresh_count"], 1)
        self.assertEqual(snapshot["stale_count"], 1)
        self.assertEqual(len(snapshot["items"]), 2)   # 过期条目不删，只展示

    def test_gpu_none_when_no_fresh_entry(self):
        """⑧ 没有 fresh 条目 ⇒ gpu 为 None（信号不全不猜）。"""
        occ.ingest(report(reported_at=BASE_MS - 90_000), now_ms=BASE_MS)
        self.assertIsNone(occ.snapshot(now_ms=BASE_MS)["gpu"])
        # 空态同样为 None
        occ.reset_state()
        self.assertIsNone(occ.snapshot(now_ms=BASE_MS)["gpu"])

    def test_gpu_none_when_fresh_has_no_mem(self):
        """⑧ fresh 条目都没报显存 ⇒ gpu 仍 None（不拿 util 硬凑）。"""
        occ.ingest(report(drop=["mem_used_mib"]), now_ms=BASE_MS)
        self.assertIsNone(occ.snapshot(now_ms=BASE_MS)["gpu"])

    def test_gpu_takes_max_mem_among_fresh(self):
        """⑧ gpu 取 fresh 条目里 mem 最大者，字段齐全、note 固定。"""
        occ.ingest([
            report(host_id="host-low", mem_used_mib=500.0, gpu_util=0.1),
            report(host_id="host-high", mem_used_mib=12_000.0, gpu_util=0.9),
            report(host_id="host-stale-max", mem_used_mib=99_999.0, reported_at=BASE_MS - 31_000),
        ], now_ms=BASE_MS)
        gpu = occ.snapshot(now_ms=BASE_MS)["gpu"]
        self.assertIsNotNone(gpu)
        self.assertEqual(gpu["reported_by"], "host")
        self.assertEqual(gpu["host_id"], "host-high")
        self.assertEqual(gpu["mem_used_mib"], 12_000.0)
        self.assertEqual(gpu["util"], 0.9)
        self.assertEqual(gpu["reported_at"], BASE_MS)
        self.assertIs(gpu["fresh"], True)
        self.assertEqual(gpu["note"], occ.GPU_NOTE)

    def test_items_sorting(self):
        """⑨ 排序：fresh 先 → active 降 → mem 降（None 当 -1）→ model 升。"""
        occ.ingest([
            report(host_id="host-c", active_requests=0, mem_used_mib=None),
            report(host_id="host-a", active_requests=2, mem_used_mib=500.0),
            report(host_id="host-b", active_requests=2, mem_used_mib=800.0),
            report(host_id="host-d", active_requests=9, mem_used_mib=9_999.0, reported_at=BASE_MS - 31_000),
        ], now_ms=BASE_MS)
        order = [item["host_id"] for item in occ.snapshot(now_ms=BASE_MS)["items"]]
        self.assertEqual(order, ["host-b", "host-a", "host-c", "host-d"])

    def test_items_sorting_ties_by_model(self):
        """⑨ 其余键相同 ⇒ model 升序（规格明写），排序稳定可复现。"""
        occ.ingest([
            report(host_id="host-1", model="m-z", active_requests=1, mem_used_mib=100.0),
            report(host_id="host-2", model="m-a", active_requests=1, mem_used_mib=100.0),
        ], now_ms=BASE_MS)
        models = [item["model"] for item in occ.snapshot(now_ms=BASE_MS)["items"]]
        self.assertEqual(models, ["m-a", "m-z"])

    def test_snapshot_shape_counts_and_sources(self):
        """§1.4 快照固定字段、计数与「最近一次来源」（push/file 分开记）。"""
        occ.ingest(report(host_id="host-a"), source="push", now_ms=BASE_MS)
        occ.ingest({"reports": [report(host_id="host-b"), {"host_id": "bad"}]}, source="file", now_ms=BASE_MS)
        snapshot = occ.snapshot(now_ms=BASE_MS)
        self.assertEqual(snapshot["as_of"], occ.iso_from_ms(BASE_MS))
        self.assertEqual(snapshot["fresh_seconds"], occ.STALE_SECONDS)
        self.assertEqual(snapshot["note"], occ.SNAPSHOT_NOTE)
        self.assertEqual(snapshot["fresh_count"], 2)
        self.assertEqual(snapshot["stale_count"], 0)
        self.assertEqual(snapshot["rejected_total"], 1)
        names = [row["name"] for row in snapshot["sources"]]
        self.assertEqual(names, ["file", "push"])
        by_name = {row["name"]: row for row in snapshot["sources"]}
        self.assertEqual(by_name["push"]["accepted"], 1)
        self.assertEqual(by_name["push"]["rejected"], 0)
        self.assertEqual(by_name["file"]["accepted"], 1)
        self.assertEqual(by_name["file"]["rejected"], 1)
        self.assertEqual(by_name["file"]["at"], occ.iso_from_ms(BASE_MS))
        self.assertEqual(set(snapshot["items"][0]), NORMALIZED_KEYS)

    def test_items_recomputed_at_injected_now(self):
        """§1.4 items 按 now_ms 重算：同一份数据换个 now 就从不 fresh 变 fresh。"""
        occ.ingest(report(reported_at=BASE_MS), now_ms=BASE_MS)
        later = occ.snapshot(now_ms=BASE_MS + 31_000)
        self.assertEqual(later["fresh_count"], 0)
        self.assertEqual(later["items"][0]["age_ms"], 31_000)
        self.assertEqual(later["stale_count"], 1)


class RetryCase(BaseCase):
    """⑪ host_ready_for_retry 三分支与其边界。"""

    def _ingest(self, **overrides) -> None:
        occ.ingest(report(**overrides), now_ms=BASE_MS)

    def test_no_signal_returns_false_none(self):
        """无 fresh 条目（未收录/已过期）⇒ (False, None)，绝不据此重试。"""
        self.assertEqual(occ.host_ready_for_retry("host-a", "m1", BASE_MS - 1, now_ms=BASE_MS), (False, None))
        self._ingest(reported_at=BASE_MS - 31_000)
        self.assertEqual(occ.host_ready_for_retry("host-a", "m1", BASE_MS - 1, now_ms=BASE_MS), (False, None))

    def test_loaded_false_is_ready(self):
        """宿主报告已卸下 ⇒ (True, entry)。"""
        self._ingest(loaded=False, active_requests=3)
        ready, entry = occ.host_ready_for_retry("host-a", "m1", BASE_MS - 1, now_ms=BASE_MS)
        self.assertTrue(ready)
        self.assertIsNotNone(entry)
        self.assertIs(entry["loaded"], False)

    def test_idle_with_mem_drop_is_ready(self):
        """active=0 ＋ 上报不早于 since ＋ 显存确实降了 ⇒ (True, entry)。"""
        self._ingest(active_requests=0, mem_used_mib=5_000.0, loaded=True)
        ready, entry = occ.host_ready_for_retry(
            "host-a", "m1", since_ms=BASE_MS - 1_000, prev_mem_mib=8_000.0, now_ms=BASE_MS)
        self.assertTrue(ready)
        self.assertEqual(entry["mem_used_mib"], 5_000.0)

    def test_idle_but_old_report_is_not_ready(self):
        """active=0 但上报早于 since ⇒ 数据不够新，不重试。"""
        self._ingest(active_requests=0)
        ready, entry = occ.host_ready_for_retry(
            "host-a", "m1", since_ms=BASE_MS + 1_000, prev_mem_mib=8_000.0, now_ms=BASE_MS)
        self.assertFalse(ready)
        self.assertIsNotNone(entry)

    def test_mem_not_dropped_is_not_ready(self):
        """active=0、上报够新，但显存没降 ⇒ 还没真腾出来，不重试。"""
        self._ingest(active_requests=0, mem_used_mib=9_000.0)
        ready, entry = occ.host_ready_for_retry(
            "host-a", "m1", since_ms=BASE_MS - 1_000, prev_mem_mib=1_000.0, now_ms=BASE_MS)
        self.assertFalse(ready)
        self.assertIsNotNone(entry)

    def test_busy_host_is_not_ready(self):
        """还有在飞请求 ⇒ (False, entry)（值要回给账本备核）。"""
        self._ingest(active_requests=2)
        ready, entry = occ.host_ready_for_retry("host-a", "m1", BASE_MS - 1_000, now_ms=BASE_MS)
        self.assertFalse(ready)
        self.assertEqual(entry["active_requests"], 2)

    def test_unknown_mem_or_prev_is_ready(self):
        """prev 没给或本次没报显存 ⇒ 显存条件视为满足（不拿缺项当故障）。"""
        self._ingest(active_requests=0, mem_used_mib=9_000.0)
        ready_no_prev, _ = occ.host_ready_for_retry(
            "host-a", "m1", since_ms=BASE_MS - 1_000, prev_mem_mib=None, now_ms=BASE_MS)
        self.assertTrue(ready_no_prev)
        occ.reset_state()
        self._ingest(active_requests=0, drop=["mem_used_mib"])
        ready_no_mem, _ = occ.host_ready_for_retry(
            "host-a", "m1", since_ms=BASE_MS - 1_000, prev_mem_mib=1.0, now_ms=BASE_MS)
        self.assertTrue(ready_no_mem)


# ---------------------------------------------------------------------------
# §1.6 文件通道（⑫⑬⑭）
# ---------------------------------------------------------------------------

class FileChannelCase(BaseCase):
    """文件交换通道：mtime 缓存、坏 JSON 隔离、reports 数组、poller 幂等。"""

    def setUp(self) -> None:
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)
        self.path = self.dir / "occupancy-host.json"
        self._saved = {
            occ.ENV_OCCUPANCY_FILE: os.environ.get(occ.ENV_OCCUPANCY_FILE),
            "ROUTER_DATA_DIR": os.environ.get("ROUTER_DATA_DIR"),
        }
        os.environ[occ.ENV_OCCUPANCY_FILE] = str(self.path)
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        """恢复环境变量（addCleanup 逆序执行：先复位 env，再删临时目录）。"""
        occ.reset_state()
        for name, saved in self._saved.items():
            if saved is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = saved

    def _write(self, payload) -> None:
        self.path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def test_file_path_honours_env(self):
        """`ROUTER_OCCUPANCY_FILE` 优先（测试全部走临时目录，不碰生产数据目录）。"""
        self.assertEqual(str(occ.file_path()), str(self.path))

    def test_file_path_default_under_data_dir(self):
        """没设专用变量时默认落在 `<副本>/数据/occupancy-host.json`（或 ROUTER_DATA_DIR）。"""
        for name in (occ.ENV_OCCUPANCY_FILE, "ROUTER_DATA_DIR"):
            os.environ.pop(name, None)
        default = occ.file_path()
        self.assertEqual(default.name, "occupancy-host.json")
        self.assertEqual(default.parent.name, "数据")
        self.assertEqual(default.parent.parent, ROOT)

    def test_load_file_returns_ingest_result(self):
        """load_file = 读文件 + ingest(source="file")，附带 file/mtime。"""
        self._write(report(host_id="host-file"))
        result = occ.load_file(now_ms=BASE_MS)
        self.assertEqual(result["source"], "file")
        self.assertEqual(result["accepted"], 1)
        self.assertEqual(result["file"], str(self.path))
        self.assertAlmostEqual(result["mtime"], self.path.stat().st_mtime, places=6)
        self.assertIsNotNone(occ.find("host-file", "m1", now_ms=BASE_MS))

    def test_load_file_missing_and_bad_json(self):
        """文件不存在/JSON 坏 ⇒ 返回 error 字典，不抛异常、不写存储。"""
        missing = occ.load_file(now_ms=BASE_MS)
        self.assertEqual(missing["error"], "file_not_found")
        self.path.write_text("{ not json", encoding="utf-8")
        broken = occ.load_file(now_ms=BASE_MS)
        self.assertIn("bad_json", broken["error"])
        self.assertEqual(occ.snapshot(now_ms=BASE_MS)["fresh_count"], 0)

    def test_poll_file_reports_array_shape(self):
        """⑬ 文件内容为 {"reports": [...]} 数组形状时逐条入库。"""
        self._write({"reports": [
            report(host_id="host-1"),
            report(host_id="host-2"),
            report(host_id="host-3", loaded="nope"),
        ]})
        result = occ.poll_file(now_ms=BASE_MS)
        self.assertEqual(result["accepted"], 2)
        self.assertEqual(result["rejected"][0]["index"], 2)
        self.assertEqual(occ.snapshot(now_ms=BASE_MS)["fresh_count"], 2)

    def test_poll_file_skips_unchanged_mtime(self):
        """⑫ mtime＋size 未变 ⇒ 返回 None，不重复 ingest。"""
        self._write(report())
        self.assertIsNotNone(occ.poll_file(now_ms=BASE_MS))
        self.assertIsNone(occ.poll_file(now_ms=BASE_MS))
        # 内容变长（size 变）⇒ 重新 ingest
        self._write({"reports": [report(host_id="host-a"), report(host_id="host-b")]})
        again = occ.poll_file(now_ms=BASE_MS)
        self.assertIsNotNone(again)
        self.assertEqual(again["accepted"], 2)

    def test_poll_file_force_reingests(self):
        """⑫ force=True 时即使文件没变也强制读一遍。"""
        self._write(report(active_requests=7))
        first = occ.poll_file(now_ms=BASE_MS)
        self.assertEqual(first["accepted"], 1)
        self.assertIsNone(occ.poll_file(now_ms=BASE_MS))
        forced = occ.poll_file(now_ms=BASE_MS, force=True)
        self.assertIsNotNone(forced)
        self.assertEqual(forced["accepted"], 1)
        self.assertEqual(occ.find("host-a", "m1", now_ms=BASE_MS)["active_requests"], 7)

    def test_poll_file_bad_json_keeps_store(self):
        """⑫ 坏 JSON ⇒ 返回 error 且**不污染**既有存储。"""
        self._write(report(host_id="host-keep"))
        self.assertIsNotNone(occ.poll_file(now_ms=BASE_MS))
        self.path.write_text("{\"reports\": [", encoding="utf-8")   # size 变了，必定重读
        broken = occ.poll_file(now_ms=BASE_MS)
        self.assertIn("bad_json", broken["error"])
        snapshot = occ.snapshot(now_ms=BASE_MS)
        self.assertEqual(snapshot["fresh_count"], 1)
        self.assertEqual(snapshot["items"][0]["host_id"], "host-keep")
        # 修好文件后恢复读取
        self._write(report(host_id="host-keep", active_requests=0))
        repaired = occ.poll_file(now_ms=BASE_MS)
        self.assertIsNotNone(repaired)
        self.assertEqual(repaired["accepted"], 1)

    def test_poll_file_missing_file(self):
        """⑫ 文件不存在 ⇒ error 字典，既有存储不受影响。"""
        self.assertEqual(occ.poll_file(now_ms=BASE_MS)["error"], "file_not_found")
        occ.ingest(report(host_id="host-keep"), now_ms=BASE_MS)
        self.assertEqual(occ.poll_file(now_ms=BASE_MS)["error"], "file_not_found")
        self.assertIsNotNone(occ.find("host-keep", "m1", now_ms=BASE_MS))

    def test_start_poller_is_idempotent(self):
        """⑭ 同一路径重复 start_poller 返回同一线程（不会起第二个轮询）。"""
        self._write(report())
        first = occ.start_poller(self.path, interval=0.02)
        second = occ.start_poller(self.path, interval=0.02)
        self.assertIs(first, second)
        self.assertTrue(first.daemon)

    def test_start_poller_ingests_written_file(self):
        """⑭ daemon 线程真能按间隔轮询入库（用 0.02s 间隔，最多等 3s）。"""
        self._write(report(host_id="host-polled", reported_at=BASE_MS))
        thread = occ.start_poller(self.path, interval=0.02)
        self.assertTrue(thread.is_alive())
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            if occ.find("host-polled", "m1", fresh=False, now_ms=None) is not None:
                break
            time.sleep(0.02)
        entry = occ.find("host-polled", "m1", now_ms=BASE_MS)
        self.assertIsNotNone(entry)
        self.assertEqual(entry["host_id"], "host-polled")


if __name__ == "__main__":
    unittest.main(verbosity=2)
