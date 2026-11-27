#!/usr/bin/env bash
# WB驭档·模型智能换挡系统网关 测试实例（隔离 18790，仅回环）
# 配置：当前为脱敏样例 upstreams.json / config/routing.json —— 只做端点/流程测试，不接真实上游。
# 真实上游/密钥：改 upstreams.json 的 base_url / api_key_env，并在 ROUTER_CREDENTIALS_PATH 的 refs 里给值。
set -euo pipefail
BASE=$(cd "$(dirname "$0")" && pwd)
export ROUTER_HOST=127.0.0.1
export ROUTER_PORT=18790
export ROUTER_DATA_DIR="$BASE/数据"
# 凭据路径按安装树相对定位（上级 DSH_HOME），可用环境变量覆盖。
export ROUTER_CREDENTIALS_PATH="${ROUTER_CREDENTIALS_PATH:-${DSH_HOME:-$(cd "$BASE/../.." && pwd)}/.credentials.yaml}"
export PYTHONUNBUFFERED=1
cd "$BASE"
exec /usr/bin/python3 main.py
