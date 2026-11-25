---
name: wb-max-router
description: 非 DSH 用户的 WB-Max 路由：收到「[WB-Max路由]」或用户要求用 WB 模型路由决策器时，调用网关生成分段计划，经用户确认后逐段执行。Use when the user says "[WB-Max路由]" or asks to route a task through the WB model routing gateway.
---

# WB-Max 路由（非 DSH）

本技能是 **WB 模型路由决策器（网关）** 的前端：计划来自网关，执行走网关 chat，账本由网关记录（P1 的 plan/annotation）。

## 触发

- 用户消息含 `[WB-Max路由]`；
- 或用户明确说“用 WB-Max 路由 / 用 WB 模型路由决策器跑这个任务”。

## 铁律

1. **先计划，后确认，再执行**。不得自动执行。
2. 计划必须让用户看到分段、模型、估算；用户明确说“确认/开工”后才能 `wb_route_execute`。
3. 网关 `pricing` 为不可用/部分时，照实说“金额不可用/部分按 0 计，不代表免费”；不得编价。
4. 当前不可 chat 执行的功能（生成/embedding/rerank 等）不要假装能跑。

## 首选：MCP 工具（共 3 个，以 `tools/list` 为准）

连接 `wb-max-mcp` 后使用：

1. `wb_route_plan`：参数 `task`、可选 `strategy`（auto/cost/capability/function）、`function`、`context`、`max_stages`（**1–6，默认 3；HTTP 侧只认 `constraints.max_stages`，MCP 已替调用方包好**）。
2. 把计划展示给用户；等待明确确认。
3. `wb_route_execute`：`plan_id`、`stage_id`、`model`（计划里 `model.key`）、`messages` 或 `prompt`、`confirmed=true`；可选 `strategy`/`capability`/`function`。每段执行后继续下一段；annotation 由 execute 工具自动回写（`plan_id` 无效时回 404 `plan_unknown`，需重新 plan）。
4. `wb_route_health`：无参数；返回网关 `/health` 原文（各上游 state 与熔断状态）。**MCP 不可用或要快速判断网关死活时先用它**。

> 自检：文档列出的工具数必须 == `server.mjs` 注册数。跑 `bash scripts/check-tools.sh`（当前应为 3 = 3）。

> **能力面声明（N6，2026-11-19 补）**：`wb-max-mcp` **只提供 tools，不提供 resources**。
> 协议层 `initialize` 返回 `capabilities: { tools: {} }`（与 `server.mjs:159` 实现一致，无 `resources`/`prompts` 键）；
> 因此客户端不应向本服务发 `resources/list`、`resources/read`、`prompts/list`（会得 `Method not found`），
> 需要知识/文件内容请走 `wb_route_plan` 的 `context` 参数传入。
> 核验一条命令：`grep -n "capabilities" tools/wb-max-mcp/server.mjs`（应只见 `{ tools: {} }`）。

### `max_tokens` 语义（N8①，2026-11-19 补）

- **推理型模型（如 `model_a1`、含 thinking 的档位）`max_tokens` 含 reasoning 预算**：
  思考 token 与正文 token **共用**这一个上限。给得过小（例如 ≤128）时，预算会先被思考吃光，
  `content` 只剩半截思考或干脆为空——**这不是模型故障，是预算截断**。
- 经验取值：推理型模型至少给到 `max_tokens ≥ 512`，需要长正文时按「预计正文长度 ×2 + 256」估；
  只要摘要/判断句的开 `512–1024` 足够。
- 非推理型（`model_f3` 等）`max_tokens` 即正文上限，不受本条影响。
- `wb_route_execute` 的 `max_tokens` 会原样透传给网关 `/v1/chat/completions`；网关不做放大也不做截断。

## 备用：CLI（MCP 挂掉时用这一路）

```bash
NODE="$(command -v node)"        # 本机真实路径 /usr/local/bin/node；不要写 /usr/bin/node（不存在）
CLI="${WB_MAX_CLI:-$(ls ./skill-mcp/wb-max-mcp/bin/wb-max.mjs ./wb-max-mcp/bin/wb-max.mjs "${DSH_HOME:-/nonexistent}/tools/wb-max-mcp/bin/wb-max.mjs" "$SKILL_DIR/../wb-max-mcp/bin/wb-max.mjs" 2>/dev/null | head -1)}"; [ -f "$CLI" ] || { echo "找不到 wb-max.mjs，请设 WB_MAX_CLI 指向实际路径"; exit 2; }
$NODE $CLI health
$NODE $CLI plan --task "任务" --strategy auto
$NODE $CLI exec --plan-id <id> --stage-id s1 --model <计划 model.key> --prompt "..." --confirmed true --strategy <...> --capability <...>
```

> CLI 只绕过 MCP 接入层，不改变鉴权与网关行为；已在实机验证 `health` / `plan` 两条，`exec` 本轮未实跑（需 confirmed=true 且会产生真实调用与账本记录）。

## 配置与可达性

- `WB_GATEWAY_URL`：默认 `http://127.0.0.1:18790`。
- **可达性（2026-11-18 已开放）**：
  - 本机：`http://127.0.0.1:18790`（只回环，仅本机进程用）；
  - **外部（零刻/云主机/他人）**：`https://gateway.example.com`（公网 443 + TLS；只放行 `/health` 与 `/v1/*`）；
  - 外部必须带 `Authorization: Bearer <key>`；key 由灰狼签发（scopes=plan,chat，per-key rpm 默认 60）；**不要**再让外部直连 127.0.0.1 或自行开隧道。

### 凭据来源与优先级（Q3-7，2026-11-18 补）

| 优先级 | 来源 | 形态 | 说明 |
|---|---|---|---|
| 1（最高） | 环境变量 `WB_GATEWAY_API_KEY` | 明文 token | 显式覆盖一切；适合临时/外部机器 |
| 2 | 文件 `WB_GATEWAY_KEY_FILE`（默认按包内 `wb-max-mcp/config/wb-remote.json` 定位，可用 `WB_GATEWAY_KEY_FILE` 覆盖；权限 600） | `{"token":"..."}` | 本机默认来源；只读，不进仓库 |
| 3 | 都没有 | — | **MCP 对需要鉴权的接口直接报可操作错误**：`未找到网关凭据：请设置 WB_GATEWAY_API_KEY 或提供可读的 WB_GATEWAY_KEY_FILE…`；health 不需要凭据，仍可用 |

- **冲突处置**：env 与文件同时存在且值不同 ⇒ **env 优先**，文件被忽略（不报错，但报错信息里注明 `source=env`）。同一台机器不要长期两份不同 token。
- **外部机器（零刻/云主机/他人）**：拿不到本机 `wb-remote.json` ⇒ 向灰狼申请**短期 key**（写明用途/期限），用 `WB_GATEWAY_API_KEY` 注入；不得把 key 写进仓库、聊天记录或截图。
- **验证三条**（照抄可跑）：
  ```bash
  NODE="$(command -v node)"; CLI="${WB_MAX_CLI:-$(ls ./skill-mcp/wb-max-mcp/bin/wb-max.mjs ./wb-max-mcp/bin/wb-max.mjs "${DSH_HOME:-/nonexistent}/tools/wb-max-mcp/bin/wb-max.mjs" "$SKILL_DIR/../wb-max-mcp/bin/wb-max.mjs" 2>/dev/null | head -1)}"; [ -f "$CLI" ] || { echo "找不到 wb-max.mjs，请设 WB_MAX_CLI 指向实际路径"; exit 2; }
  $NODE $CLI health                                              # 不需要 key
  env -u WB_GATEWAY_API_KEY $NODE $CLI plan --task "验证文件凭据"   # 走 keyfile
  WB_GATEWAY_API_KEY="$(python3 -c 'import json,os;print(json.load(open(os.environ.get("WB_GATEWAY_KEY_FILE", os.path.join(os.path.dirname(__file__),"..","config","wb-remote.json"))))["token"])')" \
    $NODE $CLI plan --task "验证 env 凭据"                        # 走 env
  ```

## 外部接入（可选）

```bash
export WB_GATEWAY_URL='https://gateway.example.com'
export WB_GATEWAY_API_KEY='<向灰狼申请；勿入仓库/聊天>'
NODE="$(command -v node)"; CLI="${WB_MAX_CLI:-$(ls ./skill-mcp/wb-max-mcp/bin/wb-max.mjs ./wb-max-mcp/bin/wb-max.mjs "${DSH_HOME:-/nonexistent}/tools/wb-max-mcp/bin/wb-max.mjs" "$SKILL_DIR/../wb-max-mcp/bin/wb-max.mjs" 2>/dev/null | head -1)}"; [ -f "$CLI" ] || { echo "找不到 wb-max.mjs，请设 WB_MAX_CLI 指向实际路径"; exit 2; }
$NODE $CLI doctor     # exit 0 可达 / 2 不可达
```
- 完整说明（端点/限流/计费/审计/回滚）：`gateway/README.md`
- 外部只读不到 `/admin`、`/router/*`；429 带 `Retry-After`，按提示退避。

## 输出格式

```text
WB-Max 路由计划（策略：cost；3 段）
1. 分析 → model-a  context 1M  token≈...  金额不可用
2. 实现 → model-b ...
3. 验收 → model-c ...
请确认开工；确认后我逐段执行。
```

用户确认后逐段执行，最后汇总“结果 / token / 已知金额 / 未定价说明”。

## 1.0.3.2（2026-11-21）新增能力速查

- **B1 边界纪律**：`/v1/route/plan` 每段带 `boundary_policy`；`/v1/route/annotation` 可带 `turn_ctx{turn_id,tool_turn,context_rebuilt,exempt}`；同轮工具轮换模记 `discipline_violation`（不阻断）；`GET /v1/route/discipline?range=7d` 只读聚合（看 `non_exempt_violations`）。
- **B2 复盘**：`GET /v1/route/report?range=7d&group=model|stage`（预估 vs 实付＋ledger 实账）；`POST /v1/route/replay {plan_id, settings}` 只读复算（0 执行 0 写账）；`/admin/api/report`。
- **B3 自动化档位**：plan body/头 `automation_level=L1|L2|L3`（L1=现状、可不传）；返回 `automation` 块；档位只改确认节奏，不改选模。
- **B4 影子判定**（默认关）：`ROUTER_B4_SHADOW=1` 后 `/v1/route/shadow?range=` 只读汇总；`/health.shadow` 出现；只记录、不改选模。
- **B5 只读兼容入口**（默认关）：任意 OpenAI 客户端 base URL 直连，请求头 `X-WB-Route-Mode: passthrough`（需 key 开通）；响应头 `X-WB-Model/X-WB-Strategy/X-WB-Usage-Kind`。
- **上下文治理**（mode=shadow）：响应头 `X-DSH-Context-Window/-Budget/-Used/-Used-Kind`、`X-DSH-Trimmed`、`X-DSH-Band`；enforce 下超窗返回 400 `context_window_exceeded`（含 context 与 options）。
