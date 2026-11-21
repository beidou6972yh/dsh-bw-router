#!/usr/bin/env bash
# 模型路由网关 v1.1d3 测试实例（隔离 18790，仅回环）
# 配置：当前为脱敏样例 upstreams.json / config/routing.json —— 只做端点/流程测试，不接真实上游。
# 真实上游/密钥：改 upstreams.json 的 base_url / api_key_env，并在 ROUTER_CREDENTIALS_PATH 的 refs 里给值。
set -euo pipefail
BASE=$(cd "$(dirname "$0")" && pwd)
export ROUTER_HOST=127.0.0.1
export ROUTER_PORT=18790
export ROUTER_DATA_DIR="$BASE/数据"
export ROUTER_CREDENTIALS_PATH=/opt/wb-router/.credentials.yaml
export PYTHONUNBUFFERED=1
cd "$BASE"
exec /usr/bin/python3 main.py
