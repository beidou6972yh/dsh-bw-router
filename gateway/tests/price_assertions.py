#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""价格判据规则（单一真源）：供「产线用例」与「负向对照」两处调用。

由来（2026-11-20 P1 / L1）：
    判据原先直接写在 ``test_capabilities_occupancy.py`` 里。负向对照（canary）若自己
    再抄一份"同样的断言"，就成了"测试抄测试"——两边一旦漂移，护栏本身形同虚设。
    故把判据规则都抽到本模块，产线用例与 ``guardrail_price_assertions.py``
    只能调用同一份实现：规则若被放水成恒真，负向对照会立刻**变绿**，
    ``run-tests.sh`` 的「负向对照必须非 0 退出」闸门当场报警。

本文件不是测试模块（文件名不以 ``test_`` 开头），不参与 unittest discover。
"""

from __future__ import annotations


def peak_not_below_offpeak(case, peak, offpeak, ctx=()):
    """忙时价（peak）不得低于闲时价（offpeak）。

    * **允许相等**：一口价（部分中转）与本地上游零价，两档本来就是同一个数；
    * **倒挂（peak < offpeak）一律红**：价目页两档的定义是"忙时 ≥ 闲时"，
      倒挂说明解析或配置把两档写反了。
    """
    case.assertGreaterEqual(peak, offpeak, ctx)


def declared_price_kept(case, value, declared, ctx=()):
    """配置声明了具体价（非 bool 数字）就必须原样输出。

    * 被吞成 ``None``（"声明了价却输出 null"）⇒ 红；
    * 被猜成别的数 ⇒ 红（``assertEqual``）。

    只在"配置确实声明了数"时调用。配置没声明时输出 ``None`` 是合法的（不猜价），
    那条口径由各用例自己的 ``assertIsNone`` 负责，不属于本函数。
    """
    case.assertIsNotNone(value, ctx)
    case.assertEqual(value, declared, ctx)


#: 免费标注的取数点（capability_meta 条目上的字段，不新增 schema）
FREE_LABEL_KEYS = ("price_source", "price_note")
FREE_LABEL_WORD = "免费"


def cloud_zero_needs_free_label(case, value, entry, ctx=()):
    """云端价的 0 元口径：**允许 0，但必须自带免费标注**（选项 A，2026-11-20 Lead 定夺）。

    L1 第 6 处「判据 vs 口径」冲突：云端确有真免费模型（provider_d 4 条，两源一致 0.0），
    而原判据要求云端 ``> 0``。定夺＝不新增 ``free`` schema、不改产品、不动配置：
      * ``None``（未报价）⇒ 不判：由「云端未报价必须是 null」那条用例钉死；
      * ``0`` ⇒ ``entry["price_source"]``/``entry["price_note"]`` 必须含「免费」，
        否则按**漏填/猜价**处理 ⇒ 红；
      * ``> 0`` ⇒ 不判（沿用原有 ``> 0`` 约束：正数本就满足）；
      * ``< 0`` ⇒ 红。

    ``entry`` ＝ ``cfg.capability_entry(candidate)``（capability_meta 条目），
    即"免费"标注留在配置里、可审计；``ctx`` 为断言上下文元组。
    """
    if value is None:
        return
    case.assertGreaterEqual(value, 0, ctx)          # 负数一律红（0 与正数放行）
    if value == 0:
        meta = entry if isinstance(entry, dict) else {}
        label = " ".join(str(meta.get(k) or "") for k in FREE_LABEL_KEYS)
        case.assertIn(FREE_LABEL_WORD, label,
                      tuple(ctx) + ("云端写 0 元但 price_source/price_note 未标注「免费」"
                                    "⇒ 按漏填/猜价处理",))
