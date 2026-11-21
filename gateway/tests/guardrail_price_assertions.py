#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""价格判据的**负向对照（canary）**：故意红，用来证明判据没有放水成恒真。

定位（2026-11-20 P1 / L1，判据口径见 ``tests/price_assertions.py``）：
  - 本文件的用例把**构造的坏输入**直接喂给产线判据，且**不捕获**它抛出的
    ``AssertionError`` ⇒ 运行时必然红、退出码**非 0**（这正是期望结果）；
  - **文件名不带 ``test`` 前缀**（与 ``tests/price_assertions.py`` 同一手法）⇒
    ``python3 -m unittest discover -s tests``（默认 ``-p 'test*.py'``）天然跳过本文件，
    所以它既不进主回归的 439 例计数，也不会被"不走 run-tests.sh 的人/自动化"误当成真红；
    ``run-tests.sh`` 在主回归之后单独跑本文件，并**要求它非 0 退出**——一旦有人把判据
    改宽成恒真，这两个用例会**变绿**，该闸门当场报警（对应 task-4 的
    "转绿不能靠把负向用例改绿"）；
  - 只吃构造输入：不读生产配置、不联网、不写盘。

运行（期望非 0 退出）：
    cd <网关树根>
    python3 -m unittest tests.guardrail_price_assertions -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # tests/ 目录：import price_assertions

import price_assertions as pa  # noqa: E402


class PriceAssertionGuardrailCase(unittest.TestCase):
    """负向对照：用例**红**＝判据有约束力；用例**绿**＝判据已被放水（回归告警）。"""

    def test_inverted_peak_offpeak_must_go_red(self):
        """构造倒挂 peak=3 / offpeak=5 ⇒ 判据必须红（peak<offpeak 一律红）。"""
        pa.peak_not_below_offpeak(self, 3.0, 5.0,
                                  ("constructed/peak-inverted", "input_per_mtok"))

    def test_declared_price_swallowed_to_none_must_go_red(self):
        """构造"配置声明了价（12.0）、实现却返回 None"（吞价）⇒ 判据必须红。"""
        pa.declared_price_kept(self, None, 12.0,
                               ("constructed/price-swallowed", "input_per_mtok", "peak"))

    def test_cloud_zero_without_free_label_must_go_red(self):
        """构造"云端写 0 元、配置未标注免费"（漏填/猜价）⇒ 判据必须红（选项 A）。"""
        pa.cloud_zero_needs_free_label(
            self, 0.0, {"price_source": "手填 0，无来源",
                        "price_note": "constructed/unlabeled"},
            ("constructed/cloud-zero-unlabeled", "input_per_mtok", "peak"))


if __name__ == "__main__":
    unittest.main()
