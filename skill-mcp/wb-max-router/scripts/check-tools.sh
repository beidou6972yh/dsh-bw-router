#!/usr/bin/env bash
# check-tools.sh —— 自检：SKILL.md 列出的 MCP 工具数 == server.mjs 注册数（Q1-9）
# 判据：两边都等于 3（wb_route_plan / wb_route_execute / wb_route_health）
set -uo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL="$SKILL_DIR/SKILL.md"
# 1.0.3.5：不再硬编码安装路径（写死 /opt/wb-router 换环境必挂）。
# 解析顺序：WB_MCP_SERVER 环境变量 → 同级 ../wb-max-mcp → 上两级 → 旧默认路径（向后兼容）
SERVER="${WB_MCP_SERVER:-}"
if [ -z "$SERVER" ]; then
  for c in "$SKILL_DIR/../wb-max-mcp/server.mjs" "$SKILL_DIR/../../wb-max-mcp/server.mjs" /opt/wb-router/tools/wb-max-mcp/server.mjs; do
    [ -f "$c" ] && SERVER="$c" && break
  done
fi
SERVER="${SERVER:-$SKILL_DIR/../wb-max-mcp/server.mjs}"

[ -f "$SKILL" ] || { echo "❌ 找不到 SKILL.md：$SKILL"; exit 2; }
[ -f "$SERVER" ] || { echo "❌ 找不到 server.mjs：$SERVER"; exit 2; }

reg=$(grep -oE "name: 'wb_route_[a-z_]+'" "$SERVER" | sed "s/name: '//;s/'//" | sort -u)
reg_n=$(echo "$reg" | grep -c . || true)

missing=""
for t in $reg; do
  grep -q "\`$t\`" "$SKILL" || missing="$missing $t"
done

echo "server.mjs 注册（$reg_n）：$(echo $reg | tr '\n' ' ')"
if [ -n "$missing" ]; then
  echo "❌ SKILL.md 漏列：$missing"
  exit 1
fi
doc_n=$(grep -oE "\`wb_route_[a-z_]+\`" "$SKILL" | sed 's/`//g' | sort -u | wc -l)
echo "SKILL.md 提及（$doc_n）"
if [ "$reg_n" -ne 3 ] || [ "$doc_n" -ne 3 ]; then
  echo "❌ 数量不一致：注册 $reg_n / 文档 $doc_n（期望 3 = 3）"
  exit 1
fi
echo "✅ 3 = 3（文档 ↔ 实现一致）"
