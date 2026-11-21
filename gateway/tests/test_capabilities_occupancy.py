#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""能力清单 v2（结构化 models）与只读占位接口 occupancy 的单元测试。

不联网、不起监听端口、不写盘、不依赖真实时钟。

覆盖：
- capabilities v2：models 为对象列表、七字段齐全、models_legacy 与旧平铺一致；
- 取数只来自配置：capability_meta 覆盖优先 → upstreams.json 回落 → 两边缺 → null（不填 0）；
- 价格：只从 capability_meta 读，缺失 → price 为 null；配置有数字则原样输出；
- 兼容开关 ROUTER_CAPABILITIES_V2=0 → 旧平铺结构（models 全 str 且无 models_legacy）；
- occupancy：空态零值、30 秒窗口口径、by_model 在飞数与最近活跃、+08:00 时间戳；
- occupancy v1.1-d2（2026-11-14）：显存字段统一 `mem_used_mib`（旧 `mem_used_mb` 只在输入端兼容读入）、
  `host_view` 宿主视角两列分开、无宿主上报时 gpu 恒 null；
- 两个接口在 RouterHandler._do_get 里确有挂载（用假 handler 直接调，不开 socket）。

期望值口径（对齐样例配置后）：
- 上游 id / 模型名 / 价格 / 模态一律由 ``tests/config_ref.py`` 读**当前部署的**配置推导，
  用例里不写死生产名；同一份用例在样例配置与生产配置下都成立。

运行：
    cd <部署根目录（含 main.py / config/ / upstreams.json）>
    python3 -m unittest discover -s tests -p 'test_capabilities_occupancy.py' -v
"""

from __future__ import annotations

import inspect
import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))   # tests/ 目录：import config_ref

import main as router  # noqa: E402
import config_ref as cfg  # noqa: E402
import price_assertions as pa  # noqa: E402  （判据单一真源：负向对照同源调用）
import price_resolver  # noqa: E402  （双源判据：与 main 补价分支用同一表达式解析器）

# 2026-11-17 契约演进：新增 display_label（统一显示规则「供应商/模型标签/¥入/出」）。
# 仍逐字段钉死集合（不是放宽断言）：多一个少一个都要红。
MODEL_FIELDS = ("id", "provider", "tier", "context_window", "max_tokens", "modality", "price",
                "display_label")
PRICE_KEYS = ("input_per_mtok", "output_per_mtok", "cache_hit_input_per_mtok")


def _pricebook_offer_usable(offer) -> bool:
    """pricebook 报价是否属于「能给入/出数字」的形态（对齐 main.py:1490-1528 补价分支的**形态条件**）。

    只判"够不够补价"，**不复算补价结果**——补价出来的数不写死，由被测实现给出后按结构断言。
    两种配置都必须能跑：无 pricebook ⇒ 返回 False（走"两源都无价 ⇒ null"分支）；
    有 pricebook ⇒ 按实际报价形态决定分支，不写死"一定有/一定没有"。
    """
    if not isinstance(offer, dict):
        return False
    raw = offer.get("price")
    if not isinstance(raw, dict) or not raw:
        return False

    def _has_number(block) -> bool:
        if not isinstance(block, dict):
            return False
        if isinstance(block.get("flat"), (int, float)) and not isinstance(block.get("flat"), bool):
            return True
        return any(isinstance(block.get(k), (int, float)) and not isinstance(block.get(k), bool)
                   for k in ("peak", "offpeak"))

    if (_has_number(raw.get("input_per_mtok") or raw.get("input"))
            and _has_number(raw.get("output_per_mtok") or raw.get("output"))):
        return True
    # expr/乘数类报价（如 provider_c billing_expr）：用与补价分支同一个解析器现场算
    try:
        prices = (price_resolver.effective_price(offer) or {}).get("prices") or {}
    except Exception:  # noqa: BLE001 —— 与 main 的补价 try/except 同口径：算不出＝不可用
        return False
    return (isinstance(prices.get("input"), (int, float))
            and isinstance(prices.get("output"), (int, float)))


class CapabilitiesV2Case(unittest.TestCase):
    """能力清单 v2 结构 + 配置取数 + 兼容开关。"""

    def setUp(self) -> None:
        self._saved_env = os.environ.get(router.CAPABILITIES_V2_ENV)
        os.environ.pop(router.CAPABILITIES_V2_ENV, None)
        self._saved_meta = dict(router.CAPABILITY_META_MODELS)

    def tearDown(self) -> None:
        router.CAPABILITY_META_MODELS.clear()
        router.CAPABILITY_META_MODELS.update(self._saved_meta)
        if self._saved_env is None:
            os.environ.pop(router.CAPABILITIES_V2_ENV, None)
        else:
            os.environ[router.CAPABILITIES_V2_ENV] = self._saved_env

    # -- 结构 ------------------------------------------------------------
    def test_default_is_v2_object_list(self):
        payload = router.capabilities_payload()
        self.assertEqual(payload["v"], router.HINT_CONTRACT_VERSION)
        self.assertTrue(all(isinstance(m, dict) for m in payload["models"]))
        self.assertEqual([m["id"] for m in payload["models"]], list(router.HINT_CAPABILITY_MODELS))
        for entry in payload["models"]:
            self.assertEqual(set(entry), set(MODEL_FIELDS))

    def test_models_legacy_matches_flat_ids(self):
        payload = router.capabilities_payload()
        self.assertEqual(payload["models_legacy"], list(router.HINT_CAPABILITY_MODELS))
        self.assertEqual([m["id"] for m in payload["models"]], payload["models_legacy"])

    def test_payload_already_has_tiers_defaults_limits(self):
        payload = router.capabilities_payload()
        self.assertEqual(payload["tiers"],
                         {name: list(chain) for name, chain in router.HINT_TIERS.items()})
        self.assertEqual(payload["defaults"], {"tier": router.HINT_DEFAULT_TIER})
        self.assertEqual(payload["limits"], {"hint_max_bytes": router.HINT_MAX_HEADER_BYTES})

    # -- 兼容开关 --------------------------------------------------------
    def test_switch_zero_returns_legacy_flat_list(self):
        os.environ[router.CAPABILITIES_V2_ENV] = "0"
        payload = router.capabilities_payload()
        self.assertEqual(payload["models"], list(router.HINT_CAPABILITY_MODELS))
        self.assertTrue(all(isinstance(m, str) for m in payload["models"]))
        self.assertNotIn("models_legacy", payload)  # 旧结构逐字节不变，不加新键

    def test_switch_off_values(self):
        for value in ("0", "false", "NO", " off "):
            os.environ[router.CAPABILITIES_V2_ENV] = value
            self.assertFalse(router.capabilities_v2_enabled(), value)
        for value in ("1", "true", "yes", "", "anything"):
            os.environ[router.CAPABILITIES_V2_ENV] = value
            self.assertTrue(router.capabilities_v2_enabled(), value)

    def test_switch_is_read_per_request(self):
        os.environ[router.CAPABILITIES_V2_ENV] = "0"
        first = router.capabilities_payload()
        os.environ.pop(router.CAPABILITIES_V2_ENV, None)
        second = router.capabilities_payload()
        self.assertIsInstance(first["models"][0], str)
        self.assertIsInstance(second["models"][0], dict)

    # -- 取数来源 --------------------------------------------------------
    def test_capability_meta_covers_every_candidate(self):
        self.assertEqual(sorted(router.CAPABILITY_META_MODELS),
                         sorted(router.HINT_CAPABILITY_MODELS))

    def test_context_and_max_tokens_fall_back_to_upstreams_json(self):
        """取数优先级：capability_meta 声明优先 → 缺项回落 upstreams.json → 两边缺才是 null。

        期望值由 ``config_ref`` 直接读两份配置推导（不 import main、不调被测函数当期望）：
        * provider      = capability_meta.provider，缺 → 上游 id；
        * modality      = capability_meta.modality，缺 → upstreams.json 的 ``vision`` 推导；
        * context_window / max_tokens = capability_meta 声明的整数，缺 → upstreams.json 的 spec。

        样例配置里 ``local-lan/model-decider_d`` 显式写了 ``modality: ["text","image"]``，
        与 upstreams 的 ``vision: true`` 推出的 ``["text","vision"]`` 不同 —— 正是本用例要盯的
        「meta 覆盖」优先级；「meta 缺项回落 upstreams」另由下面构造的回落场景钉住。
        """
        for candidate in router.HINT_CAPABILITY_MODELS:
            up_id, _model_id = cfg.split_candidate(candidate)
            meta = cfg.capability_entry(candidate)
            spec = cfg.candidate_spec(candidate)
            entry = router.capability_model_entry(candidate)

            self.assertEqual(entry["provider"], meta.get("provider") or up_id, candidate)
            # config_ref 的 modality_of 与 main 同口径（meta 优先、缺项回落 vision）；
            # 两边都没声明 → 产出必须是 null（config_ref 用 [] 表达"没声明"）。
            self.assertEqual(entry["modality"], cfg.modality_of(candidate) or None, candidate)
            for field in ("context_window", "max_tokens"):
                declared = meta.get(field)
                expected = (declared
                            if isinstance(declared, int) and not isinstance(declared, bool)
                            else spec.get(field))
                self.assertEqual(entry[field], expected, (candidate, field))

        # 回落分支单独钉一条：摘掉 capability_meta 里的显式声明，产出必须来自 upstreams.json
        probe = next((c for c in router.HINT_CAPABILITY_MODELS
                      if "vision" in cfg.candidate_spec(c)
                      and cfg.capability_entry(c).get("modality") is not None
                      and cfg.candidate_spec(c).get("context_window") is not None
                      and cfg.candidate_spec(c).get("max_tokens") is not None), None)
        self.assertIsNotNone(
            probe, "配置里找不到可构造回落场景的候选（需 upstreams 声明 vision/上下文）")
        original = dict(router.CAPABILITY_META_MODELS.get(probe) or {})
        # 换一个新 dict：self._saved_meta 是浅拷贝，就地 pop 会污染后面用到的配置对象
        router.CAPABILITY_META_MODELS[probe] = {
            key: value for key, value in original.items()
            if key not in ("modality", "context_window", "max_tokens")}
        try:
            spec = cfg.candidate_spec(probe)
            fallback = router.capability_model_entry(probe)
            self.assertEqual(fallback["modality"],
                             ["text", "vision"] if spec["vision"] else ["text"], probe)
            self.assertEqual(fallback["context_window"], spec["context_window"], probe)
            self.assertEqual(fallback["max_tokens"], spec["max_tokens"], probe)
        finally:
            router.CAPABILITY_META_MODELS[probe] = original

    def test_capability_meta_overrides_upstreams(self):
        candidate = router.HINT_CAPABILITY_MODELS[0]
        router.CAPABILITY_META_MODELS[candidate] = {
            "provider": "edge-provider",
            "tier": "edge",
            "context_window": 123456,
            "max_tokens": 789,
            "modality": ["text", "audio"],
        }
        entry = router.capability_model_entry(candidate)
        self.assertEqual(entry["provider"], "edge-provider")
        self.assertEqual(entry["tier"], "edge")
        self.assertEqual(entry["context_window"], 123456)
        self.assertEqual(entry["max_tokens"], 789)
        self.assertEqual(entry["modality"], ["text", "audio"])

    def test_unknown_model_everything_null(self):
        entry = router.capability_model_entry("ghost/nonexistent-model")
        self.assertEqual(entry["id"], "ghost/nonexistent-model")
        for field in ("provider", "tier", "context_window", "max_tokens", "modality", "price"):
            self.assertIsNone(entry[field], field)  # 缺失就是 null，绝不填 0 / 空数组

    def test_zero_is_kept_only_when_configured(self):
        """配置明确写 0 就输出 0（不是把缺失当 0）；bool 不算数字。"""
        candidate = router.HINT_CAPABILITY_MODELS[0]
        router.CAPABILITY_META_MODELS[candidate] = {"context_window": 0,
                                                    "max_tokens": True}
        entry = router.capability_model_entry(candidate)
        self.assertEqual(entry["context_window"], 0)
        # max_tokens=True 不算整数 ⇒ 回落 upstreams.json（期望值同样来自配置，不调被测加载器）
        self.assertEqual(entry["max_tokens"], cfg.max_tokens_of(candidate))

    # -- 价格 ------------------------------------------------------------
    def test_price_structure_always_has_peak_offpeak(self):
        """结构恒定：currency=CNY、三个价目键各含 peak/offpeak。

        数值口径按上游类型分（不是"什么都接受"）：
        * **云端上游**：未报价必须是 null（不猜价）、不得为负、``> 0`` 直接过；
          0 元**只允许"真免费且配置自带免费标注"**（``price_source``/``price_note`` 含「免费」），
          写 0 却不标免费 ⇒ 按漏填/猜价红（选项 A，2026-11-20 Lead 定夺，第 6 处判据-口径冲突）；
        * **本地上游**（``cfg.LOCAL_UPSTREAM_IDS``，base_url 为明文 http）：允许显式标 0 元
          （本地模型零元），但不得为负；且配置里声明了 0 就必须原样输出 0
          （不能被吞成 null、也不能被猜成别的数）。
        """
        expected_currency = str(cfg.CAPABILITY_META.get("currency_default") or "CNY")
        local_ids = set(cfg.LOCAL_UPSTREAM_IDS)
        payload = router.capabilities_payload()
        self.assertTrue(payload["models"], "能力清单不能为空（否则本用例空跑）")
        for entry in payload["models"]:
            candidate = entry["id"]
            is_local = cfg.split_candidate(candidate)[0] in local_ids
            declared = cfg.price_of(candidate) or {}
            price = entry["price"]
            self.assertIsInstance(price, dict, candidate)
            self.assertEqual(price["currency"], expected_currency, candidate)
            self.assertEqual(set(price), {"currency", *PRICE_KEYS}, candidate)
            for key in PRICE_KEYS:
                block = price[key]
                if key == "cache_hit_input_per_mtok" and block is None:
                    continue  # 缓存价允许整块不给（main 的口径）
                self.assertIsNotNone(block, (candidate, key))
                self.assertEqual(set(block), {"peak", "offpeak"}, (candidate, key))
                declared_block = declared.get(key)
                declared_block = declared_block if isinstance(declared_block, dict) else {}
                for slot in ("peak", "offpeak"):
                    value = block[slot]
                    declared_value = declared_block.get(slot)
                    declared_num = (declared_value
                                    if isinstance(declared_value, (int, float))
                                    and not isinstance(declared_value, bool) else None)
                    if is_local:
                        # 本地：允许显式 0 元、不得为负；配置声明了就必须原样输出
                        # （声明 0 被吞成 null / 猜成别的数，都要红）
                        if value is not None:
                            self.assertGreaterEqual(value, 0, (candidate, key, slot))
                        if declared_num is not None:
                            # 声明了价就必须原样输出：被吞成 null / 猜成别的数都要红
                            # （规则抽在 tests/price_assertions.py，负向对照同源调用）
                            pa.declared_price_kept(self, value, declared_num,
                                                   (candidate, key, slot))
                    else:
                        # 云端：未报价必须 null（另一条用例钉死）；0 元必须自带免费标注；
                        # 负数一律红（规则抽在 tests/price_assertions.py，负向对照同源调用）
                        pa.cloud_zero_needs_free_label(self, value,
                                                       cfg.capability_entry(candidate),
                                                       (candidate, key, slot))

    def test_priced_models_filled_and_unpriced_null(self):
        """配置里填了价的必须原样有数且 peak >= offpeak；没填价（云端）的必须是 null。

        已填价 / 未报价的名单本身也来自 config_ref（读 ``capability_meta``），不写死生产名：
        * ``filled`` = 配置里 input/output 的 peak 都是正数的候选 —— 逐条验数、两档价差；
        * ``others`` = 其余候选里**排除本地上游**（本地是显式 0 元，不是"未报价"）——
          按配置逐档逐槽位比对：配置没给数 → 输出必须 null（不猜价），配置给了 → 原样输出。
        """
        expected_currency = str(cfg.CAPABILITY_META.get("currency_default") or "CNY")
        filled = cfg.priced_candidates()
        self.assertTrue(filled, "样例配置里至少要有一条已填价的模型，否则本用例空跑")
        payload_ids = {entry["id"] for entry in router.capabilities_payload()["models"]}
        self.assertTrue(set(filled) <= payload_ids, (sorted(filled), sorted(payload_ids)))
        for candidate in filled:
            price = router.capability_model_entry(candidate)["price"]
            self.assertIsInstance(price, dict, candidate)
            self.assertEqual(price["currency"], expected_currency, candidate)
            for key in ("input_per_mtok", "output_per_mtok"):
                self.assertGreater(price[key]["peak"], 0, (candidate, key))
                self.assertGreater(price[key]["offpeak"], 0, (candidate, key))
                # 忙时价不得低于闲时价：**一口价（部分中转/本地）允许相等**；
                # **倒挂（peak<offpeak）一律红**（规则抽在 tests/price_assertions.py，
                # 负向对照 tests/guardrail_price_assertions.py 同源调用）
                pa.peak_not_below_offpeak(self, price[key]["peak"], price[key]["offpeak"],
                                          (candidate, key))

        local_ids = set(cfg.LOCAL_UPSTREAM_IDS)
        others = [c for c in cfg.unpriced_candidates()
                  if cfg.split_candidate(c)[0] not in local_ids]
        self.assertTrue(others, "样例配置里必须存在未报价的云端模型，否则本用例空跑")
        for candidate in others:
            declared = cfg.price_of(candidate)
            price = router.capability_model_entry(candidate)["price"]
            if declared is None:            # capability_meta 没写 price 块 → 整块 null
                self.assertIsNone(price, candidate)
                continue
            self.assertIsInstance(price, dict, candidate)
            self.assertEqual(price["currency"], expected_currency, candidate)
            for key in PRICE_KEYS:
                declared_block = declared.get(key)
                declared_block = declared_block if isinstance(declared_block, dict) else {}
                block = price[key]
                if not declared_block:      # 这一档没声明 → 输出 null（不猜价）
                    self.assertIsNone(block, (candidate, key))
                    continue
                self.assertIsNotNone(block, (candidate, key))
                for slot in ("peak", "offpeak"):
                    raw = declared_block.get(slot)
                    expected = (raw if isinstance(raw, (int, float))
                                and not isinstance(raw, bool) else None)
                    self.assertEqual(block[slot], expected, (candidate, key, slot))

    def test_price_numbers_come_from_config_only(self):
        """L5 单源化后本用例只钉**回退态**：关单源（双写一版）时输出必须逐值等于 config。

        单源开启时的优先级另钉在 `tests/test_price_attest.py`（派生覆盖 config，且不猜价）。
        """
        candidate = router.HINT_CAPABILITY_MODELS[0]
        saved = os.environ.get(router.PRICE_SINGLE_SOURCE_ENV)
        os.environ[router.PRICE_SINGLE_SOURCE_ENV] = "0"
        try:
            router.CAPABILITY_META_MODELS[candidate] = {"price": {
                "currency": "CNY",
                "input_per_mtok": {"peak": 4.0, "offpeak": 2.0},
                "output_per_mtok": {"peak": 16.0, "offpeak": 8.0},
                "cache_hit_input_per_mtok": {"peak": 0.4, "offpeak": 0.2},
            }}
            price = router.capability_model_entry(candidate)["price"]
        finally:
            if saved is None:
                os.environ.pop(router.PRICE_SINGLE_SOURCE_ENV, None)
            else:
                os.environ[router.PRICE_SINGLE_SOURCE_ENV] = saved
        self.assertEqual(price["input_per_mtok"], {"peak": 4.0, "offpeak": 2.0})
        self.assertEqual(price["output_per_mtok"], {"peak": 16.0, "offpeak": 8.0})
        self.assertEqual(price["cache_hit_input_per_mtok"], {"peak": 0.4, "offpeak": 0.2})

    def test_price_missing_or_malformed_is_null(self):
        """meta 无有效价 / 结构畸形时的**双源口径**（2026-11-19 起 meta 无价由 pricebook 补）。

        单一真源＝pricebook（`main.py:1486-1528`，用户 2026-11-19 授权补价）：
        * meta 里没有**数字**价 且 pricebook 有有效报价 ⇒ price 必须**非 None**（补价；吞成 null 一律红）；
        * 两源都无有效报价 ⇒ price 必须 **None**（不猜价）；
        * 畸形 meta 价一律**不得被猜成数字**：要么被 pricebook 补价覆盖，要么整块回落 null。

        分支按 `router.pricebook_offer(candidate)` 的**实际返回**走 ⇒ 临时树（不拷 pricebook）与
        树内（含 `config/pricebook.json`）两种配置下都绿，不写死"一定有/一定没有 pricebook"。
        """
        candidate = router.HINT_CAPABILITY_MODELS[0]
        pb_usable = _pricebook_offer_usable(router.pricebook_offer(candidate))

        def _price_after(meta: dict):
            router.CAPABILITY_META_MODELS[candidate] = meta
            return router.capability_model_entry(candidate)["price"]

        def _assert_no_guessed_number(price, tag):
            """输出里的每个槽位要么是数字、要么是 None：字符串等非数字不得出现在价格里。"""
            for key in PRICE_KEYS:
                block = price.get(key)
                if not isinstance(block, dict):
                    continue
                for slot, val in block.items():
                    self.assertTrue(
                        val is None or (isinstance(val, (int, float)) and not isinstance(val, bool)),
                        (candidate, key, slot, tag, val))

        # ① meta 整块没价
        price = _price_after({})
        if pb_usable:
            self.assertIsNotNone(price, (candidate, "pricebook 有有效价 ⇒ 必须补价，不许吞价"))
            self.assertEqual(price["currency"], "CNY", candidate)
            self.assertIsInstance(price["input_per_mtok"], dict, candidate)
            self.assertIsInstance(price["output_per_mtok"], dict, candidate)
            _assert_no_guessed_number(price, "补价")
        else:
            self.assertIsNone(price, (candidate, "两源都无有效价 ⇒ 必须 null（不猜价）"))

        # ② meta price 是非结构值（整块不可用）
        price = _price_after({"price": "4 元"})
        if pb_usable:
            self.assertIsNotNone(price, (candidate, "meta 畸形、pricebook 有价 ⇒ 必须补价"))
            _assert_no_guessed_number(price, "畸形值+补价")
        else:
            self.assertIsNone(price, (candidate, "meta 畸形且两源无价 ⇒ 必须 null"))

        # ③ meta price 结构畸形（currency 空、peak 是字符串 "4"）
        price = _price_after({"price": {"currency": "", "input_per_mtok": {"peak": "4"}}})
        if pb_usable:
            # 补价覆盖：不得把非数字 "4" 猜成数字，也不得原样输出畸形块、更不得吞价
            self.assertIsNotNone(price, (candidate, "meta 无数字价、pricebook 有价 ⇒ 必须补价"))
            self.assertEqual(price["currency"], "CNY", candidate)
            self.assertNotEqual(price["input_per_mtok"], {"peak": None, "offpeak": None},
                                (candidate, "畸形块必须由 pricebook 覆盖，不能原样输出"))
            _assert_no_guessed_number(price, "畸形结构+补价")
        else:
            self.assertEqual(price["currency"], "CNY")          # 空 currency 回落默认 CNY
            self.assertEqual(price["input_per_mtok"], {"peak": None, "offpeak": None})
            self.assertIsNone(price["output_per_mtok"])

    def test_payload_json_serialisable(self):
        blob = json.dumps(router.capabilities_payload(), ensure_ascii=False)
        self.assertIn("models_legacy", blob)


class OccupancyCase(unittest.TestCase):
    """占位快照：全部走进程内计时点，假时钟注入。"""

    NOW = 1_700_000_000.0

    def setUp(self) -> None:
        router._occ_reset()
        # 宿主视角隔离：清状态 + 文件通道指向不存在的临时路径（不读生产快照）
        router.occ_host.reset_state()
        self._old_occ_file = os.environ.get("ROUTER_OCCUPANCY_FILE")
        os.environ["ROUTER_OCCUPANCY_FILE"] = str(
            Path(__file__).resolve().parent / "__no_such_occupancy__.json")

    def tearDown(self) -> None:
        router._occ_reset()
        router.occ_host.reset_state()
        if self._old_occ_file is None:
            os.environ.pop("ROUTER_OCCUPANCY_FILE", None)
        else:
            os.environ["ROUTER_OCCUPANCY_FILE"] = self._old_occ_file

    def test_empty_snapshot(self):
        payload = router.occupancy_payload(now=self.NOW)
        self.assertEqual(payload["windows"], {"active_30s": 0, "last_active_at": None})
        self.assertEqual(payload["by_model"], [])
        # Q3-3：gpu 字段保持「恒 null + note」，但显式标 connected/status，避免 null 被读成 0 占用
        gpu = payload["gpu"]
        self.assertEqual(gpu["reported_by"], "host")
        self.assertIsNone(gpu["util"])
        self.assertIsNone(gpu["mem_used_mib"])
        self.assertEqual(gpu["note"], "宿主上报，网关不自采")
        self.assertFalse(gpu["connected"])
        self.assertEqual(gpu["status"], "not_connected")
        self.assertTrue(payload["as_of"].endswith("+08:00"))
        # 宿主视角两列分开：无上报时是空列表，不是并入 by_model
        host_view = payload["host_view"]
        self.assertEqual(host_view["items"], [])
        self.assertIsNone(host_view["gpu"])
        self.assertEqual(host_view["fresh_seconds"], 30.0)
        self.assertIn("两列", host_view["note"])
        self.assertFalse(host_view["connected"])
        self.assertEqual(host_view["status"], "not_connected")
        self.assertEqual(host_view["status_text"], "未接入")
        self.assertEqual(payload["host_view_status"], "not_connected")

    def test_active_request_counted(self):
        router._occ_begin("req-1", "label/model-alpha", now=self.NOW - 3)
        payload = router.occupancy_payload(now=self.NOW)
        self.assertEqual(payload["windows"]["active_30s"], 1)
        self.assertEqual(payload["by_model"], [{
            "model": "label/model-alpha", "active_requests": 1,
            "last_active_at": router._iso_from_ts(self.NOW - 3),
        }])
        self.assertEqual(payload["windows"]["last_active_at"], router._iso_from_ts(self.NOW - 3))

    def test_window_boundary_30s(self):
        """结束时刻落在 30 秒内 → 算；超过 30 秒但未超 60 秒保留期 → 不算 active，但仍列出模型。"""
        router._occ_begin("req-old", "model/old", now=self.NOW - 40)
        router._occ_end("req-old", now=self.NOW - 39)
        router._occ_begin("req-new", "model/new", now=self.NOW - 20)
        router._occ_end("req-new", now=self.NOW - 10)
        payload = router.occupancy_payload(now=self.NOW)
        self.assertEqual(payload["windows"]["active_30s"], 1)     # 只有 req-new
        by_model = {row["model"]: row for row in payload["by_model"]}
        self.assertEqual(by_model["model/old"]["active_requests"], 0)
        self.assertEqual(by_model["model/new"]["active_requests"], 0)
        self.assertEqual(by_model["model/old"]["last_active_at"],
                         router._iso_from_ts(self.NOW - 39))

    def test_prune_after_keep_window(self):
        router._occ_begin("req-1", "model/a", now=self.NOW - 100)
        router._occ_end("req-1", now=self.NOW - 99)
        payload = router.occupancy_payload(now=self.NOW)
        self.assertEqual(payload["windows"]["active_30s"], 0)
        self.assertEqual(payload["by_model"], [])
        # 全局最近活跃时间不受剪枝影响（仍是最后一次活动）
        self.assertEqual(payload["windows"]["last_active_at"], router._iso_from_ts(self.NOW - 99))

    def test_bind_moves_request_to_actual_model(self):
        router._occ_begin("req-1", "primary/model", now=self.NOW - 5)
        router._occ_bind("req-1", "actual/model", now=self.NOW - 4)
        payload = router.occupancy_payload(now=self.NOW)
        by_model = {row["model"]: row["active_requests"] for row in payload["by_model"]}
        self.assertEqual(by_model.get("actual/model"), 1)
        self.assertLessEqual(by_model.get("primary/model", 0), 1)
        active_rows = [r for r in payload["by_model"] if r["active_requests"]]
        self.assertEqual([r["model"] for r in active_rows], ["actual/model"])

    def test_end_is_idempotent(self):
        router._occ_begin("req-1", "model/a", now=self.NOW - 2)
        router._occ_end("req-1", now=self.NOW - 1)
        router._occ_end("req-1", now=self.NOW)
        payload = router.occupancy_payload(now=self.NOW)
        self.assertEqual(payload["windows"]["active_30s"], 1)
        self.assertEqual(payload["by_model"][0]["active_requests"], 0)
        self.assertEqual(payload["windows"]["last_active_at"], router._iso_from_ts(self.NOW - 1))

    def test_unknown_req_id_end_is_noop(self):
        router._occ_end("never-started", now=self.NOW)
        payload = router.occupancy_payload(now=self.NOW)
        self.assertEqual(payload["windows"]["active_30s"], 0)
        self.assertIsNone(payload["windows"]["last_active_at"])

    def test_by_model_sorted_by_active_desc(self):
        router._occ_begin("req-a", "m/a", now=self.NOW - 5)
        router._occ_begin("req-b", "m/b", now=self.NOW - 5)
        router._occ_begin("req-c", "m/b", now=self.NOW - 5)
        models = [row["model"] for row in router.occupancy_payload(now=self.NOW)["by_model"]]
        self.assertEqual(models, ["m/b", "m/a"])

    def test_json_serialisable_and_gpu_never_reports(self):
        router._occ_begin("req-1", "m/a", now=self.NOW - 1)
        payload = router.occupancy_payload(now=self.NOW)
        blob = json.dumps(payload, ensure_ascii=False)
        self.assertIn('"util": null', blob)
        self.assertIn('"mem_used_mib": null', blob)
        self.assertNotIn('"mem_used_mb"', blob)   # v1.1-d2 改名：输出侧一处不漏


class OccupancyHooksWiringCase(unittest.TestCase):
    """不改行为，只确认挂载点存在：GET 路由 + 生成流程的 begin/bind/end 计时点。"""

    def _call_get(self, path: str) -> tuple[int, str]:
        handler = object.__new__(router.RouterHandler)
        handler._send_json = lambda status, payload, extra=None: status  # type: ignore[method-assign]
        return handler._do_get(path, {})

    def test_get_route_returns_200(self):
        self.assertEqual(self._call_get("/v1/route/occupancy"), (200, "occupancy"))
        self.assertEqual(self._call_get("/v1/route/capabilities"), (200, "capabilities"))

    def test_index_lists_new_endpoint(self):
        handler = object.__new__(router.RouterHandler)
        captured = {}

        def fake_send(status, payload, extra=None):
            captured["payload"] = payload
            return status

        handler._send_json = fake_send  # type: ignore[method-assign]
        handler._do_get("/", {})
        self.assertIn("GET /v1/route/occupancy", captured["payload"]["endpoints"])

    def test_hooks_are_wired_in_generation_and_forward(self):
        generation = inspect.getsource(router.RouterHandler._handle_generation)
        forward = inspect.getsource(router.RouterHandler._forward)
        self.assertIn("_occ_begin(", generation)
        self.assertIn("finally:", generation)
        self.assertIn("_occ_end(", generation)
        self.assertIn("_occ_bind(", forward)


if __name__ == "__main__":
    unittest.main(verbosity=2)
