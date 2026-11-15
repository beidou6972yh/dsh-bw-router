#!/usr/bin/env bash
# 接收 NPC 的 base64 patch 并应用（推送权限未开时的兜底通路）
# 用法：bash scripts/apply-npc-patch.sh <拼接好的.b64文件> <期望patch sha256>
set -euo pipefail
B64="$1"; WANT_SHA="${2:-}"
[ -f "$B64" ] || { echo "❌ 找不到 $B64"; exit 2; }
base64 -d "$B64" | gunzip > /tmp/npc.patch
GOT=$(sha256sum /tmp/npc.patch | awk '{print $1}')
echo "patch 大小: $(wc -c < /tmp/npc.patch) 字节"
echo "sha256: $GOT"
if [ -n "$WANT_SHA" ] && [ "$GOT" != "$WANT_SHA" ]; then echo "❌ sha256 不匹配（期望 $WANT_SHA）"; exit 1; fi
git apply --check /tmp/npc.patch && echo "✅ apply 预检通过"
git apply /tmp/npc.patch && echo "✅ 已应用"
git status -s | head -40
