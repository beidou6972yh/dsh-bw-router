#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""规则 5 阶梯裁剪（1.0.3.2 T1 补充，默认关）单元测试：纯函数、不改默认行为。

覆盖：未超预算时字节不变、丢最老整轮、system 保留、tool_calls/tool 成组、图片只留 N 张、
tool 回显截断、裁剪后估算下降。不联网、不写盘。
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main as gw  # noqa: E402


def _params(**trim):
    params = gw.ctx_gov_params()
    params = json.loads(json.dumps(params))
    params["trim"].update({"enabled": True, "keep_images": 1,
                           "tool_result_max_chars": 10, "keep_recent_turns": 6})
    params["trim"].update(trim)
    return params


def _payload():
    return {"messages": [
        {"role": "system", "content": "系统提示"},
        {"role": "user", "content": "第一轮：" + "中" * 200},
        {"role": "assistant", "tool_calls": [{"id": "call-1", "type": "function",
                                              "function": {"name": "f", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "call-1", "content": "工" * 100},
        {"role": "assistant", "content": "第一轮回答"},
        {"role": "user", "content": "第二轮：" + "中" * 50},
        {"role": "assistant", "content": "第二轮回答"},
    ]}


class TrimCase(unittest.TestCase):
    def test_no_change_when_under_budget(self):
        body = {"messages": [{"role": "user", "content": "短"}]}
        out, stats = gw.trim_body(body, gw.extract_features(body), None, _params())
        self.assertEqual(json.dumps(out, sort_keys=True, ensure_ascii=False),
                         json.dumps(body, sort_keys=True, ensure_ascii=False))
        self.assertFalse(stats["changed"])

    def test_drops_oldest_turn_and_keeps_system(self):
        body = _payload()
        feats = gw.extract_features(body)
        budget = {"input_cap": max(1, gw.context_tokens_estimate(feats) - 100)}
        out, stats = gw.trim_body(body, feats, budget, _params())
        self.assertGreaterEqual(stats["dropped_turns"], 1)
        self.assertEqual(out["messages"][0]["role"], "system")
        self.assertEqual(out["messages"][0]["content"], "系统提示")
        self.assertLess(gw.context_tokens_estimate(gw.extract_features(out)),
                        gw.context_tokens_estimate(feats))

    def test_tool_calls_are_not_orphaned(self):
        body = _payload()
        feats = gw.extract_features(body)
        out, _ = gw.trim_body(body, feats, {"input_cap": 1}, _params())
        ids, tool_ids = set(), set()
        for msg in out["messages"]:
            if msg.get("role") == "assistant" and isinstance(msg.get("tool_calls"), list):
                ids.update(str(c.get("id")) for c in msg["tool_calls"] if isinstance(c, dict))
            if msg.get("role") == "tool":
                tool_ids.add(str(msg.get("tool_call_id")))
        self.assertEqual(ids, tool_ids, (ids, tool_ids))

    def test_images_cull_to_keep_images(self):
        def _img():
            return {"type": "image_url", "image_url": {"url": "data:image/png;base64,xx"}}
        body = {"messages": [{"role": "user", "content": [_img(), {"type": "text", "text": "看图"}]},
                             {"role": "user", "content": [_img(), {"type": "text", "text": "再看"}]}]}
        out, stats = gw.trim_body(body, gw.extract_features(body), None,
                                  _params(keep_images=1, tool_result_max_chars=9999))
        self.assertEqual(stats["dropped_images"], 1)
        images = [p for msg in out["messages"] if isinstance(msg.get("content"), list)
                  for p in msg["content"] if isinstance(p, dict) and p.get("type") == "image_url"]
        self.assertEqual(len(images), 1)

    def test_tool_content_truncated(self):
        body = {"messages": [{"role": "tool", "tool_call_id": "c1", "content": "x" * 100}]}
        out, stats = gw.trim_body(body, gw.extract_features(body), None,
                                  _params(tool_result_max_chars=10))
        self.assertEqual(stats["truncated_tools"], 1)
        self.assertLess(len(out["messages"][0]["content"]), 100)
        self.assertIn("网关已截断", out["messages"][0]["content"])

    def test_trim_disabled_by_default_in_config(self):
        # 发布默认：trim.enabled=false（只验证配置默认值与函数无关）
        self.assertFalse(gw.ctx_gov_params()["trim"].get("enabled"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
