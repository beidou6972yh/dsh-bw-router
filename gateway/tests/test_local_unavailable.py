#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`local_unavailable.py` 的单元测试（规格 §2.9 的 ①–⑭ 全覆盖）。

不联网、不起端口、不写盘、不依赖真实时钟：`wait_for_retry_ready` 一律注入假
`sleep`/`now_fn`/`finder`，`occupancy_host` 用假模块塞进 `sys.modules`。

覆盖：
- ① 私有/公网 base_url 判定；② 显式 local 与 routing.local.upstreams 优先于 URL；
  ③ host_id_for 覆盖与缺省；④ 真实 503 报文取 need/free；⑤ 响应头优先于正文；
  ⑥ 卡占用报文；⑦ 普通 500 不误判；⑧ raw 截断 300；⑨ wait_seconds 四态；
  ⑩ allow_cloud 真假值；⑪ error_body 字段齐全；⑫ 宿主冷却/过期；
  ⑬ wait_for_retry_ready 三分支（不真 sleep）；⑭ seconds<=0 不等待。

运行：
    cd <网关树根>            # 树根需含 main.py 与 config/routing.json、upstreams.json
    export ROUTER_DATA_DIR=/tmp/local-impl-test
    python3 -m unittest tests.test_local_unavailable -v
"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import local_unavailable as lu  # noqa: E402

# 契约 §4.4 实测报文（LiteLLM → decider_d，装不下直接拒）
REAL_503_BODY = (
    '{"error":{"message":"显存不足 12594/9279，驱逐 0，无需让位",'
    '"type":"insufficient_vram"}}'
).encode("utf-8")


class FakeClock:
    """假时钟：sleep 只记账并推进 now，绝不真睡。"""

    def __init__(self, start: float = 1000.0) -> None:
        self.t = start
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds


class FakeUpstream:
    """带 .id/.base_url/.local 属性的上游对象（模拟 main 的 Upstream 直传）。"""

    def __init__(self, up_id: str, base_url: str, local=None) -> None:
        self.id = up_id
        self.base_url = base_url
        self.local = local


# ---------------------------------------------------------------------------
# ① 私有/公网 URL 判定
# ---------------------------------------------------------------------------
class PrivateUrlCase(unittest.TestCase):
    """is_private_base_url：内网一批认、公网一批不认。"""

    def test_loopback_and_localhost_are_private(self):
        """127/8、localhost、::1、0.0.0.0（含端口/路径/裸写）都判私有。"""
        for url in ("http://127.0.0.1:4000/v1", "127.0.0.1", "http://127.9.9.9/v1",
                    "http://localhost:8080/v1", "localhost", "http://[::1]:8080/v1",
                    "::1", "http://0.0.0.0:11434", "localhost."):
            with self.subTest(url=url):
                self.assertTrue(lu.is_private_base_url(url))

    def test_rfc1918_are_private(self):
        """10/8、172.16/12 两端、192.168/16 都判私有（带端口与路径也认）。"""
        for url in ("http://10.1.2.3:8000/v1", "http://172.16.0.1/v1",
                    "http://172.31.255.254:1234/v1", "http://192.168.1.7:11434/v1",
                    "http://192.168.0.10"):
            with self.subTest(url=url):
                self.assertTrue(lu.is_private_base_url(url))

    def test_mdns_and_bare_hostname_are_private(self):
        """.local 后缀与裸主机名（无点，如 ollama／litellm）判私有。"""
        for url in ("http://litellm.local:4000/v1", "http://ollama:11434/v1",
                    "http://gpu-host/v1", "ollama"):
            with self.subTest(url=url):
                self.assertTrue(lu.is_private_base_url(url))

    def test_public_hosts_are_not_private(self):
        """公网域名/公网 IPv4/172.16-31 之外的 172.x 一律不判私有。"""
        for url in ("https://api.example.com/v1", "https://api.example.org/v1",
                    "https://llm.example.net/api/v1",
                    "http://8.8.8.8/v1", "http://1.2.3.4:8000",
                    "http://172.32.1.1/v1", "http://172.15.255.255/v1"):
            with self.subTest(url=url):
                self.assertFalse(lu.is_private_base_url(url))

    def test_empty_and_unparsable_are_not_private(self):
        """空串/None/纯路径 ⇒ False（宁可不认本地，避免误把云端当本地）。"""
        for url in ("", "   ", None, "/v1", "http://"):
            with self.subTest(url=url):
                self.assertFalse(lu.is_private_base_url(url))


# ---------------------------------------------------------------------------
# ②③ 本地上游清单与宿主 id
# ---------------------------------------------------------------------------
class LocalUpstreamsCase(unittest.TestCase):
    """local_upstreams／host_id_for：显式布尔 > 配置名单 > URL。"""

    def test_explicit_local_flag_wins_over_url(self):
        """local=True 的公网 URL 算本地；local=False 的私有 URL 不算（显式布尔最硬）。"""
        upstreams = [
            {"id": "cloud-lookalike", "base_url": "https://api.provider-a.example.com/v1", "local": True},
            {"id": "lan-but-off", "base_url": "http://192.168.1.9:8000/v1", "local": False},
            {"id": "by-url", "base_url": "http://10.0.0.5:4000/v1"},
        ]
        self.assertEqual(lu.local_upstreams(upstreams), {"cloud-lookalike", "by-url"})

    def test_routing_list_overrides_url(self):
        """routing.local.upstreams 名单能收公网 URL 的上游；显式 False 仍可否决名单。"""
        upstreams = [
            {"id": "listed", "base_url": "https://example.com/v1"},
            {"id": "listed-off", "base_url": "https://example.com/v2", "local": False},
            {"id": "plain", "base_url": "https://api.provider-a.example.com/v1"},
        ]
        routing = {"local": {"upstreams": ["listed", "listed-off"]}}
        self.assertEqual(lu.local_upstreams(upstreams, routing), {"listed"})

    def test_url_fallback_with_object_entries(self):
        """不配任何键时退回 URL 判定；main 直传的 Upstream 对象（属性访问）同样支持。"""
        upstreams = [
            FakeUpstream("lan", "http://192.168.1.7:11434/v1"),
            FakeUpstream("wan", "https://api.provider-a.example.com/v1"),
        ]
        self.assertEqual(lu.local_upstreams(upstreams), {"lan"})
        self.assertEqual(lu.local_upstreams(upstreams, {"local": {}}), {"lan"})

    def test_config_dict_shape_supported(self):
        """整份 upstreams.json（{"upstreams": [...]}）直传也能摊平。"""
        doc = {"upstreams": [{"id": "a", "base_url": "http://127.0.0.1:4000/v1"},
                             {"id": "b", "base_url": "https://api.provider-a.example.com/v1"}]}
        self.assertEqual(lu.local_upstreams(doc), {"a"})
        self.assertEqual(lu.local_upstreams(None), set())

    def test_host_id_for_default_and_override(self):
        """host_id_for：有映射取映射，无映射缺省回上游 id。"""
        routing = {"local": {"host_ids": {"local-litellm": "host-gpu-01"}}}
        self.assertEqual(lu.host_id_for("local-litellm", routing), "host-gpu-01")
        self.assertEqual(lu.host_id_for("local-litellm", None), "local-litellm")
        self.assertEqual(lu.host_id_for("other", routing), "other")

    def test_host_id_for_blank_mapping_value(self):
        """映射值为空串/空白的脏数据 ⇒ 回落上游 id（不返回空 host_id）。"""
        routing = {"local": {"host_ids": {"a": "   ", "b": ""}}}
        self.assertEqual(lu.host_id_for("a", routing), "a")
        self.assertEqual(lu.host_id_for("b", routing), "b")


# ---------------------------------------------------------------------------
# ④–⑧ 故障归类
# ---------------------------------------------------------------------------
class ClassifyCase(unittest.TestCase):
    """classify：真实报文、头优先、卡占用、普通 500、raw 截断。"""

    def test_real_503_message_numbers(self):
        """真实报文「显存不足 12594/9279，驱逐 0，无需让位」⇒ need/free 逐字取到。"""
        info = lu.classify(503, REAL_503_BODY, None)
        self.assertIsNotNone(info)
        self.assertEqual(info["code"], lu.CODE_VRAM)
        self.assertEqual(info["reason"], lu.REASON_VRAM)
        self.assertEqual(info["need_mib"], 12594)
        self.assertEqual(info["free_mib"], 9279)
        self.assertEqual(info["evidence"], "body")
        self.assertIn("显存不足 12594/9279", info["raw"])

    def test_header_evidence_wins_over_body(self):
        """响应头 x-vram-need/free-mib 优先于正文数字（evidence=header）。"""
        headers = {"X-VRAM-Need-MiB": "16000", "x-vram-free-mib": "512"}
        info = lu.classify(503, REAL_503_BODY, headers)
        self.assertEqual(info["evidence"], "header")
        self.assertEqual(info["need_mib"], 16000)
        self.assertEqual(info["free_mib"], 512)

    def test_header_partial_value(self):
        """只带一个显存头也算 header 证据，缺的那个保持 None（不填 0）。"""
        info = lu.classify(503, b"{}", {"x-vram-free-mib": "777"})
        self.assertEqual(info["evidence"], "header")
        self.assertIsNone(info["need_mib"])
        self.assertEqual(info["free_mib"], 777)

    def test_mib_pair_pattern(self):
        """正文「12000 MiB / 8000 MiB」形态也能取到 need/free。"""
        info = lu.classify(503, b"CUDA error: 12000 MiB / 8000 MiB available", None)
        self.assertEqual((info["need_mib"], info["free_mib"]), (12000, 8000))
        self.assertEqual(info["evidence"], "body")

    def test_need_free_english_pattern(self):
        """正文「need 9000 ... free 4096」（大小写不敏感）也能取到。"""
        info = lu.classify(503, b"VRAM NEED 9000 MiB, FREE 4096 MiB", None)
        self.assertEqual((info["need_mib"], info["free_mib"]), (9000, 4096))

    def test_card_busy_classified(self):
        """命中 busy/queue full 且不含显存词 ⇒ code 仍 local_vram_insufficient（契约 §4.4.2 写死），
        reason=card_busy（§4.4.5 控制台靠 reason 区分）。"""
        info = lu.classify(503, b"GPU is busy: queue full, please retry later", None)
        self.assertEqual(info["code"], lu.CODE_VRAM)
        self.assertEqual(info["code"], "local_vram_insufficient")
        self.assertEqual(info["reason"], lu.REASON_BUSY)
        self.assertEqual(info["evidence"], "none")
        self.assertIsNone(info["need_mib"])

    def test_busy_and_vram_both_vram_wins(self):
        """显存词与 busy 词同现 ⇒ 以显存为准（有数字就是装不下，不是被占）。"""
        info = lu.classify(503, "显存不足 12594/9279，卡被占用".encode("utf-8"), None)
        self.assertEqual(info["code"], lu.CODE_VRAM)
        self.assertEqual((info["need_mib"], info["free_mib"]), (12594, 9279))

    def test_plain_500_returns_none(self):
        """普通 500（正文无显存/占用关键词）⇒ None，不误判成本地装不下。"""
        self.assertIsNone(lu.classify(500, b'{"error":"internal server error"}', None))
        self.assertIsNone(lu.classify(500, b"null pointer at handler", None))

    def test_500_with_vram_keyword_classified(self):
        """500 但正文命中 out of memory ⇒ 仍按装不下归类（无数字则两值 None）。"""
        info = lu.classify(500, b"CUDA out of memory while loading weights", None)
        self.assertIsNotNone(info)
        self.assertEqual(info["code"], lu.CODE_VRAM)
        self.assertEqual(info["evidence"], "none")
        self.assertIsNone(info["need_mib"])
        self.assertIsNone(info["free_mib"])

    def test_503_without_keywords_still_vram(self):
        """503 无任何特征词 ⇒ code 仍取 local_vram_insufficient，raw 保原文。"""
        info = lu.classify(503, b'{"error":"service unavailable"}', None)
        self.assertEqual(info["code"], lu.CODE_VRAM)
        self.assertEqual(info["evidence"], "none")
        self.assertEqual(info["raw"], '{"error":"service unavailable"}')

    def test_507_trigger(self):
        """507 与 503 同等对待（状态码本身即本地通道失败）。"""
        info = lu.classify(507, b"{}", {"x-vram-need-mib": "20000", "x-vram-free-mib": "1024"})
        self.assertIsNotNone(info)
        self.assertEqual(info["need_mib"], 20000)

    def test_non_503_status_none(self):
        """200/400/429 一律 None（只有 503/507/带关键词的 500 才归本地装不下）。"""
        for status in (200, 201, 400, 404, 429, 502):
            with self.subTest(status=status):
                self.assertIsNone(lu.classify(status, b"out of memory", None))

    def test_raw_truncated_to_300(self):
        """raw 截断到 300 字符（上游原文只进账本，不进响应）。"""
        info = lu.classify(503, b"x" * 400, None)
        self.assertEqual(len(info["raw"]), 300)
        info2 = lu.classify(503, ("显存不足 12594/9279 " + "备核" * 200).encode("utf-8"), None)
        self.assertEqual(len(info2["raw"]), 300)

    def test_empty_body_and_none_headers(self):
        """空响应体/None 头不炸：503 ⇒ code 取显存、raw 空串。"""
        info = lu.classify(503, None, None)
        self.assertEqual(info["code"], lu.CODE_VRAM)
        self.assertEqual(info["raw"], "")
        info = lu.classify(503, b"", {})
        self.assertEqual(info["evidence"], "none")


# ---------------------------------------------------------------------------
# ⑨⑩ 调用方开关
# ---------------------------------------------------------------------------
class HeaderSwitchCase(unittest.TestCase):
    """wait_seconds／allow_cloud 的取值口径。"""

    def test_wait_seconds_defaults(self):
        """缺省/None/空/非法/≤0 ⇒ 0.0（默认关，不等待）。"""
        cases = [
            (None, 0.0),
            ({}, 0.0),
            ({lu.WAIT_LOCAL_HEADER: ""}, 0.0),
            ({lu.WAIT_LOCAL_HEADER: "   "}, 0.0),
            ({lu.WAIT_LOCAL_HEADER: "abc"}, 0.0),
            ({lu.WAIT_LOCAL_HEADER: "0"}, 0.0),
            ({lu.WAIT_LOCAL_HEADER: "-3"}, 0.0),
            ({lu.WAIT_LOCAL_HEADER: "nan"}, 0.0),
        ]
        for headers, expected in cases:
            with self.subTest(headers=headers):
                self.assertEqual(lu.wait_seconds(headers), expected)

    def test_wait_seconds_cap(self):
        """25 秒截到 20.0（MAX_WAIT_SECONDS）；999 也截到 20.0。"""
        self.assertEqual(lu.wait_seconds({lu.WAIT_LOCAL_HEADER: "25"}), 20.0)
        self.assertEqual(lu.wait_seconds({lu.WAIT_LOCAL_HEADER: "999"}), lu.MAX_WAIT_SECONDS)

    def test_wait_seconds_float_and_case_insensitive(self):
        """允许浮点「5.5」→5.5；头名大小写不敏感；边界 20 原样。"""
        self.assertAlmostEqual(lu.wait_seconds({lu.WAIT_LOCAL_HEADER: "5.5"}), 5.5)
        self.assertAlmostEqual(lu.wait_seconds({"x-route-wait-local": " 3 "}), 3.0)
        self.assertAlmostEqual(lu.wait_seconds({"X-ROUTE-WAIT-LOCAL": "20"}), 20.0)

    def test_allow_cloud_truthy(self):
        """1/true/yes/on（大小写不敏感、含空白）⇒ True。"""
        for value in ("1", "true", "TRUE", "yes", "YES", "on", " On "):
            with self.subTest(value=value):
                self.assertTrue(lu.allow_cloud({lu.ALLOW_CLOUD_HEADER: value}))

    def test_allow_cloud_falsey(self):
        """0/空/垃圾/缺省 ⇒ False（默认不转云）。"""
        for headers in (None, {}, {lu.ALLOW_CLOUD_HEADER: ""},
                        {lu.ALLOW_CLOUD_HEADER: "0"}, {lu.ALLOW_CLOUD_HEADER: "maybe"},
                        {lu.ALLOW_CLOUD_HEADER: "no"}):
            with self.subTest(headers=headers):
                self.assertFalse(lu.allow_cloud(headers))


# ---------------------------------------------------------------------------
# ⑪ 结构化错误体
# ---------------------------------------------------------------------------
class ErrorBodyCase(unittest.TestCase):
    """error_body：字段名严格照契约 §4.4.2，message 缺数字时省括号。"""

    def test_error_body_full_fields(self):
        """字段齐全且 type/code/retryable/status 逐项对上契约。"""
        info = lu.classify(503, REAL_503_BODY, None)
        body = lu.error_body("decider_d", "host-gpu-01", info, fallback="cloud-18b")
        err = body["error"]
        self.assertEqual(set(err), {"type", "code", "message", "model", "host_id",
                                    "need_mib", "free_mib", "retryable", "fallback",
                                    "reason", "evidence", "status"})
        self.assertEqual(err["type"], lu.LOCAL_UNAVAILABLE)
        self.assertEqual(err["code"], lu.CODE_VRAM)
        self.assertEqual(err["model"], "decider_d")
        self.assertEqual(err["host_id"], "host-gpu-01")
        self.assertEqual((err["need_mib"], err["free_mib"]), (12594, 9279))
        self.assertIs(err["retryable"], False)
        self.assertEqual(err["fallback"], "cloud-18b")
        self.assertEqual(err["reason"], lu.REASON_VRAM)
        self.assertEqual(err["evidence"], "body")
        self.assertEqual(err["status"], 503)
        self.assertEqual(err["message"],
                         "本地显存不足（need 12594 MiB / free 9279 MiB），该宿主暂不可用")

    def test_error_body_message_without_numbers(self):
        """缺数字时 message 省掉括号段（不出现 need/free 字样）。"""
        info = lu.classify(500, b"CUDA out of memory", None)
        err = lu.error_body("decider_d", "host-a", info)["error"]
        self.assertEqual(err["message"], "本地显存不足，该宿主暂不可用")
        self.assertNotIn("（", err["message"])
        self.assertIsNone(err["need_mib"])
        self.assertIsNone(err["fallback"])

    def test_error_body_busy_and_fallback(self):
        """card_busy 走自己的中文措辞；fallback 空串 ⇒ None。"""
        info = lu.classify(503, b"GPU is busy: queue full", None)
        err = lu.error_body("decider_d", "host-b", info, fallback="")["error"]
        self.assertEqual(err["code"], lu.CODE_VRAM)      # 契约 §4.4.2：code 固定
        self.assertEqual(err["code"], "local_vram_insufficient")
        self.assertEqual(err["reason"], lu.REASON_BUSY)
        self.assertEqual(err["message"], "本地卡被占用，该宿主暂不可用")
        self.assertIsNone(err["fallback"])

    def test_error_body_tolerates_missing_info(self):
        """info 传 None/空 dict 也不炸：保底 code=CODE_VRAM、各字段不缺失。"""
        for info in (None, {}):
            with self.subTest(info=info):
                err = lu.error_body("m", "h", info)["error"]
                self.assertEqual(err["code"], lu.CODE_VRAM)
                self.assertEqual(err["reason"], lu.REASON_VRAM)
                self.assertEqual(err["evidence"], "none")
                self.assertEqual(err["status"], lu.ERROR_STATUS)
                self.assertIs(err["retryable"], False)


# ---------------------------------------------------------------------------
# ⑫ 同宿主冷却
# ---------------------------------------------------------------------------
class HostDownCase(unittest.TestCase):
    """note_host_down／host_down／reset_state。"""

    def setUp(self) -> None:
        lu.reset_state()

    def tearDown(self) -> None:
        lu.reset_state()

    def test_note_host_down_and_active(self):
        """登记 60s 冷却：立即查到，remaining_s 随假时钟递减。"""
        record = lu.note_host_down("host-a", lu.CODE_VRAM, now=1000.0, ttl=60.0)
        self.assertEqual(record["code"], lu.CODE_VRAM)
        self.assertAlmostEqual(record["until"], 1060.0)
        self.assertAlmostEqual(record["remaining_s"], 60.0)

        down = lu.host_down("host-a", now=1030.0)
        self.assertIsNotNone(down)
        self.assertEqual(down["code"], lu.CODE_VRAM)
        self.assertAlmostEqual(down["until"], 1060.0)
        self.assertAlmostEqual(down["remaining_s"], 30.0)

    def test_host_down_expired_clears(self):
        """到点即过期返回 None，并把条目从表里清掉（后续查询仍 None）。"""
        lu.note_host_down("host-a", lu.CODE_CARD_BUSY, now=1000.0, ttl=10.0)
        self.assertIsNone(lu.host_down("host-a", now=1010.0))
        self.assertIsNone(lu.host_down("host-a", now=1005.0))
        # 过期后可以重新登记
        lu.note_host_down("host-a", lu.CODE_VRAM, now=1020.0, ttl=60.0)
        self.assertIsNotNone(lu.host_down("host-a", now=1021.0))

    def test_note_host_down_keeps_longer_ttl(self):
        """同宿主重复登记取更晚的 until：短 ttl 不缩短已在生效的冷却。"""
        lu.note_host_down("host-a", lu.CODE_VRAM, now=1000.0, ttl=60.0)
        short = lu.note_host_down("host-a", lu.CODE_CARD_BUSY, now=1005.0, ttl=10.0)
        self.assertEqual(short["code"], lu.CODE_VRAM)
        self.assertAlmostEqual(short["until"], 1060.0)
        long = lu.note_host_down("host-a", lu.CODE_CARD_BUSY, now=1005.0, ttl=300.0)
        self.assertEqual(long["code"], lu.CODE_CARD_BUSY)
        self.assertAlmostEqual(long["until"], 1305.0)

    def test_note_host_down_zero_ttl_not_stored(self):
        """ttl<=0 不落表（等于立即过期），host_down 查不到。"""
        lu.note_host_down("host-a", lu.CODE_VRAM, now=1000.0, ttl=0.0)
        self.assertIsNone(lu.host_down("host-a", now=1000.0))
        # 空 host_id 不落表，但仍返回一条形状完整的记录（不抛异常）
        blank = lu.note_host_down("", lu.CODE_VRAM, now=1000.0)
        self.assertEqual(blank["code"], lu.CODE_VRAM)
        self.assertIsNone(lu.host_down("", now=1000.0))

    def test_reset_state_clears(self):
        """reset_state 清空冷却表（测试与热重载用）。"""
        lu.note_host_down("host-a", lu.CODE_VRAM, now=1000.0, ttl=60.0)
        self.assertIsNotNone(lu.host_down("host-a", now=1001.0))
        lu.reset_state()
        self.assertIsNone(lu.host_down("host-a", now=1001.0))


# ---------------------------------------------------------------------------
# ⑬⑭ 等卸载后只重试一次（全部注入假时钟，绝不真 sleep）
# ---------------------------------------------------------------------------
class WaitRetryCase(unittest.TestCase):
    """wait_for_retry_ready：立刻就绪/等 t 秒后就绪/超时/不等待/懒导入。"""

    def test_wait_immediate_ready_no_sleep(self):
        """首次探测就绪 ⇒ 直接返回 (True, entry)，一次 sleep 都不许发生。"""
        clock = FakeClock()
        calls: list[tuple] = []

        def finder(host_id, model, since_ms, prev_mem_mib):
            calls.append((host_id, model, since_ms, prev_mem_mib))
            return (True, {"host_id": host_id, "model": model})

        ready, entry = lu.wait_for_retry_ready(
            "host-a", "decider_d", 5.0, 1700000000000, 9000.0,
            sleep=clock.sleep, now_fn=clock.now, finder=finder)

        self.assertTrue(ready)
        self.assertEqual(entry, {"host_id": "host-a", "model": "decider_d"})
        self.assertEqual(clock.sleeps, [])
        self.assertEqual(calls, [("host-a", "decider_d", 1700000000000, 9000.0)])
        self.assertAlmostEqual(clock.now(), 1000.0)

    def test_wait_ready_after_waiting(self):
        """第 3 次探测才就绪：分片 sleep ≤1.0，总时长 ≤ seconds，返回最后 entry。"""
        clock = FakeClock()
        state = {"n": 0}

        def finder(host_id, model, since_ms, prev_mem_mib):
            state["n"] += 1
            return (state["n"] >= 3, {"attempt": state["n"]})

        ready, entry = lu.wait_for_retry_ready(
            "host-a", "decider_d", 5.0, 0, None,
            sleep=clock.sleep, now_fn=clock.now, finder=finder)

        self.assertTrue(ready)
        self.assertEqual(entry, {"attempt": 3})
        self.assertEqual(len(clock.sleeps), 2)
        self.assertTrue(all(s <= 1.0 for s in clock.sleeps))
        self.assertLessEqual(sum(clock.sleeps), 5.0)
        self.assertAlmostEqual(sum(clock.sleeps), 2.0)

    def test_wait_timeout_returns_last_entry(self):
        """一直未就绪 ⇒ 到点返回 (False, 最后一条 entry)，总等待 ≤ seconds。"""
        clock = FakeClock()
        state = {"n": 0}

        def finder(host_id, model, since_ms, prev_mem_mib):
            state["n"] += 1
            return (False, {"attempt": state["n"]})

        ready, entry = lu.wait_for_retry_ready(
            "host-a", "decider_d", 3.0, 0, None,
            sleep=clock.sleep, now_fn=clock.now, finder=finder)

        self.assertFalse(ready)
        self.assertEqual(entry, {"attempt": 4})
        self.assertAlmostEqual(sum(clock.sleeps), 3.0)
        self.assertLessEqual(sum(clock.sleeps), 3.0 + 1e-9)
        self.assertAlmostEqual(clock.now(), 1003.0)

    def test_wait_timeout_without_any_entry(self):
        """未就绪且 finder 从不给条目 ⇒ (False, None)。"""
        clock = FakeClock()

        def finder(*args):
            return (False, None)

        ready, entry = lu.wait_for_retry_ready(
            "host-a", "m", 2.0, 0, None, sleep=clock.sleep, now_fn=clock.now, finder=finder)
        self.assertFalse(ready)
        self.assertIsNone(entry)
        self.assertAlmostEqual(sum(clock.sleeps), 2.0)

    def test_wait_non_positive_no_wait(self):
        """seconds<=0 ⇒ 立即 (False, None)：不调 finder、不 sleep。"""
        clock = FakeClock()

        def finder(*args):
            raise AssertionError("seconds<=0 时不该探测占用")

        for seconds in (0, 0.0, -1.0, -0.001):
            with self.subTest(seconds=seconds):
                ready, entry = lu.wait_for_retry_ready(
                    "host-a", "m", seconds, 0, None,
                    sleep=clock.sleep, now_fn=clock.now, finder=finder)
                self.assertFalse(ready)
                self.assertIsNone(entry)
        self.assertEqual(clock.sleeps, [])

    def test_wait_lazy_import_failure_no_signal(self):
        """occupancy_host 缺失 ⇒ 按无信号返回 (False, None)，不抛异常、不 sleep。"""
        clock = FakeClock()
        with mock.patch.dict(sys.modules, {"occupancy_host": None}):
            ready, entry = lu.wait_for_retry_ready(
                "host-a", "m", 5.0, 0, None, sleep=clock.sleep, now_fn=clock.now)
        self.assertFalse(ready)
        self.assertIsNone(entry)
        self.assertEqual(clock.sleeps, [])

    def test_wait_lazy_import_success_arg_order(self):
        """finder=None 时懒导入 occupancy_host，并用四个位置参数按约定顺序调用。"""
        clock = FakeClock()
        seen: dict = {}
        fake = types.ModuleType("occupancy_host")

        def host_ready_for_retry(host_id, model, since_ms, prev_mem_mib=None, now_ms=None):
            seen.update({"host_id": host_id, "model": model,
                         "since_ms": since_ms, "prev_mem_mib": prev_mem_mib})
            return (True, {"host_id": host_id})

        fake.host_ready_for_retry = host_ready_for_retry
        with mock.patch.dict(sys.modules, {"occupancy_host": fake}):
            ready, entry = lu.wait_for_retry_ready(
                "host-a", "decider_d", 5.0, 1700000000123, 9000.0,
                sleep=clock.sleep, now_fn=clock.now)

        self.assertTrue(ready)
        self.assertEqual(entry, {"host_id": "host-a"})
        self.assertEqual(seen["host_id"], "host-a")
        self.assertEqual(seen["model"], "decider_d")
        self.assertEqual(seen["since_ms"], 1700000000123)
        self.assertEqual(seen["prev_mem_mib"], 9000.0)
        self.assertEqual(clock.sleeps, [])

    def test_wait_finder_exception_does_not_crash(self):
        """finder 抛异常 ⇒ 当未就绪继续等到超时，返回 (False, None)，异常不外抛。"""
        clock = FakeClock()

        def boom(*args):
            raise RuntimeError("占用模块炸了")

        ready, entry = lu.wait_for_retry_ready(
            "host-a", "m", 2.0, 0, None, sleep=clock.sleep, now_fn=clock.now, finder=boom)
        self.assertFalse(ready)
        self.assertIsNone(entry)
        self.assertAlmostEqual(sum(clock.sleeps), 2.0)

    def test_wait_boolean_finder_result(self):
        """finder 只返回布尔（不返回元组）也认：True ⇒ (True, None)。"""
        clock = FakeClock()
        ready, entry = lu.wait_for_retry_ready(
            "host-a", "m", 5.0, 0, None,
            sleep=clock.sleep, now_fn=clock.now, finder=lambda *a: True)
        self.assertTrue(ready)
        self.assertIsNone(entry)
        self.assertEqual(clock.sleeps, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
