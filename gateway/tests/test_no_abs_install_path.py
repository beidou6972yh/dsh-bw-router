#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""1.0.3.10 #12：生效运行代码不得写死 /opt/wb-router 安装路径。

文档字符串里的历史示例与告警句不算（不参与运行）；只查可执行赋值/常量。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class TestNoAbsInstallPath(unittest.TestCase):
    def test_runtime_files_have_no_hardcoded_opt_path(self):
        # 只查参与运行的文件；.bak、文档、测试本身不算
        files = [ROOT / "main.py", ROOT / "router_deciders.py",
                 ROOT / "run-18790.sh", ROOT / "admin_ui.py"]
        bad = []
        for f in files:
            if not f.exists():
                continue
            for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
                s = line.strip()
                if s.startswith("#"):
                    continue
                # 文档字符串里的示例行（含 cd /opt/... 的说明）不算赋值；只查赋值/常量
                if any(x in s for x in ("/opt/" + "wb-router", "/workspace/" + "dsh-home/")) and \
                        ("=" in s or s.startswith("export ")):
                    bad.append(f"{f.name}:{i}: {s[:100]}")
        self.assertEqual(bad, [], "仍有写死路径：" + " | ".join(bad))


if __name__ == "__main__":
    unittest.main()
