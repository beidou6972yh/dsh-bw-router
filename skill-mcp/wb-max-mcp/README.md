# wb-max-mcp

WB-GearPilot 换挡决策器的 MCP stdio server + CLI（无第三方依赖，Node >=20）。

## 工具

| 工具 | 作用 |
|---|---|
| `wb_route_plan` | 调网关 `/v1/route/plan`，无副作用；返回 plan_id/stages/估算；`confirm_required:true` |
| `wb_route_execute` | `confirmed=true` 才执行；调网关 chat + 回写 annotation；返回 content/usage |
| `wb_route_health` | 网关健康 |

## MCP 配置示例

```json
{
  "mcpServers": {
    "wb-max": {
      "command": "node",
      "args": ["<你的部署目录>/tools/wb-max-mcp/server.mjs"],
      "env": {
        "WB_GATEWAY_URL": "http://127.0.0.1:18790",
        "WB_GATEWAY_KEY_FILE": "<你的部署目录>/config/<凭据文件>"
      }
    }
  }
}
```

## 外部接入（可选）

- 基址：`https://gateway.example.com`（只放行 `/health` 与 `/v1/*`）
- 鉴权：`Authorization: Bearer <key>`（向灰狼申请；per-key rpm 默认 60）
- 自检：`node bin/wb-max.mjs doctor`（打印 base/key 来源/可达性，不打印 token；exit 0/2）
- 完整说明：`gateway/README.md`

## CLI

```bash
node bin/wb-max.mjs plan --task "任务" --strategy auto
node bin/wb-max.mjs doctor
node bin/wb-max.mjs exec --plan-id ... --stage-id s1 --model upstream/model --prompt "..." --confirmed true
```

## 安全

- 远程/外部使用走公网入口 `https://gateway.example.com`（TLS），必须启用入口 API key（`config/api-keys.json` required=true）并遵守 per-key rpm；不要直连 127.0.0.1。
- `wb_route_execute` 必须显式 `confirmed=true`；未确认会报错。
- 网关价格为空时只记 token，不编价。
