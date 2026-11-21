# WB 模型路由（网关 + DSH 插件 + Skill/MCP）

**把「这次该用哪个模型、这一步要花多少钱」变成一次看得见、可确认、可复盘的流程——你点同意，它才花钱。**

本仓库是 **WB 模型路由 1.0.3.3** 的开源发布仓，含：

| 路径 | 是什么 |
|---|---|
| `gateway/` | Python 单进程、OpenAI 兼容的模型路由网关（规划 → 确认 → 逐段执行 → 回写真实花费） |
| `dsh-wb-max/` | DSH Max 插件 0.2.0：网关形态的前端入口（计划卡、确认、会话内切模型） |
| `dsh-wb-pro/` | DSH Pro 插件 0.2.0：DSH 原生规划的模型路由（不依赖网关） |
| 仓库根（`dsh-bw-router`） | B&W（小棒 & 灰狼）联合插件 0.2.0；沿用历史发布名 |
| `skill-mcp/` | `wb-max-router` 技能与 `wb-max-mcp` MCP 服务 |
| `docs-open/` | 使用说明书、快速上手、Agent 安装说明、开源海报（md/html/pdf） |
| `release-notes-1.0.3.3/` | 变更说明、测试清单、开关与观察、包校验说明 |

> **版本**：`1.0.3.3`（2026-11-21）。1.0.3.3 融合前序版本成果，**网关主代码相对 1.0.3.2 零功能性改动**；差异在测试、运维工具、观测参数与文档。
> **许可**：MIT。**默认只绑 `127.0.0.1`**；管理面请勿对公网开放。

## 一、快速开始（三件包）

从 [Release v1.0.3.3](https://github.com/beidou6972yh/dsh-bw-router/releases/tag/v1.0.3.3) 下载：

```sh
mkdir -p ~/wb-router && cd ~/wb-router
tar -xzf gateway-1.0.3.3.tar.gz
tar -xzf plugins-1.0.3.3.tar.gz
tar -xzf skill-mcp-1.0.3.3.tar.gz
ls   # gateway  plugins  skill-mcp
```

1. `gateway/config/` 内是**匿名样例**（`up-a…local-lan`、`.example.com`），换成你自己的上游与密钥（密钥只放环境变量）。
2. 装两个 Python 依赖：`pip install PyYAML requests`。
3. 启动：`python3 gateway/main.py`（默认 `127.0.0.1:18790`），`curl http://127.0.0.1:18790/health` 应返回 200。
4. 回归：`cd gateway && bash run-tests.sh --clean --config-dir config`（两段各 `Ran 568 / OK`）。

详细步骤见 [`docs-open/WB-Router-User-Guide.v1.0.0.md`](docs-open/WB-Router-User-Guide.v1.0.0.md) 与 [`docs-open/WB-Router-Quick-Start.md`](docs-open/WB-Router-Quick-Start.md)。

## 二、DSH 插件

需要 DeepSeek Harness `0.2.1-rc.2` 或同线版本，Node.js `>=20`。

```sh
# 联合插件（本仓根，历史发布名）
dsh plugin --profile web add 'https://github.com/beidou6972yh/dsh-bw-router/releases/download/v1.0.3.3/dsh-bw-router-0.2.0.tgz'

# WB 路由 Max / Pro（Release 资产）
dsh plugin --profile web add 'https://github.com/beidou6972yh/dsh-bw-router/releases/download/v1.0.3.3/dsh-wb-max-0.2.0.tgz'
dsh plugin --profile web add 'https://github.com/beidou6972yh/dsh-bw-router/releases/download/v1.0.3.3/dsh-wb-pro-0.2.0.tgz'
```

装完重启一次承载插件的宿主（`dsh web`）。三个包都声明 `dsh.bundle`，装后自动启用。

## 三、网关能力（1.0.3.3）

- **规划/确认/执行/回写**：`POST /v1/route/plan` → 用户确认 → `POST /v1/chat/completions`（OpenAI 兼容，支持流式）→ `POST /v1/route/annotation`。
- **B1 边界纪律**：plan 每段只读 `boundary_policy`；`GET /v1/route/discipline` 只读聚合；违约只记账不阻断。
- **B2 报告/回放**：`GET /v1/route/report`、`POST /v1/route/replay`（只读复算，0 执行 0 写账）、`/admin/review`。
- **B3 自动化档位**：`automation_level=L1/L2/L3`（只改确认节奏，不改选模；不传＝现状）。
- **B4 影子判定**（默认关）：`/v1/route/shadow`、`/health.shadow`；异步、失败丢弃、不改选模。
- **B5 只读兼容入口**（默认关）：`X-WB-Route-Mode: passthrough`＋per-key；响应头 `X-WB-Model/Strategy/Usage-Kind`。
- **A0 价格单源**：`config/pricebook.json` 唯一真源；`ROUTER_PRICE_ATTEST=1` 单源自证（27/27）。
- **R4/R5 上下文治理**：`context_governor=shadow`（默认观测）；预算＝窗口−max(1024, ⌈0.2×窗口⌉)；超窗结构化 400；超时 read 270s / stream 600s；trim/413 默认关。
- **观测**：账本 `ctx_gov` 与 `X-DSH-Context-*` / `X-DSH-Band` 响应头。

## 四、仓库根插件：B&W dsh-bw-router（0.2.0）

**B&W = 小棒（B棒）× 灰狼（Wolf）** 合作的 DeepSeek Harness 模型路由插件：把任务拆成分段计划、按段挑模型、同一会话内切模型而不丢上下文；成本要么给出依据、要么明示不可用，绝不编数。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/router/models` | 模型发现（`count`/`sources`/`filesRead`/`pricing`） |
| POST | `/router/plan` | 生成分段计划与计划卡 |
| POST | `/router/plan/confirm` | 确认开工（可带 `sessionId`） |
| POST | `/router/plan/swap` | 开工前给某段换模型 |
| GET | `/router/state` / `/router/card` | 状态栏 / 计划卡数据 |
| POST | `/router/switch` / `/router/stage/finish` | 切模型 / 段末记账 |
| GET | `/router/wizard`、`/router/context`、`/router/reconcile` | 只读辅助视图 |

## 五、开发与验证

```sh
# 网关回归（两段：配置无关 / 生产等价）
cd gateway && bash run-tests.sh --clean

# 根插件（需要本机有源码构建环境）
npm ci && npm test && npm run build
```

## 六、已知边界

- 本仓 `dsh-wb-max/dist/client/client.js` 为**脱敏副本**：余额快照 `SNAP` 已清空（`items:[]`），不含任何真实金额。生产环境的余额注入属本地运维件，不随开源发布。
- `context_governor` 的 **enforce 灰度未开**（shadow 标定样本不足，需低峰窗口与数据）。
- 明确不做：413 默认出口、精确 tokenizer、订阅额度穿透；B1 插件面 per-tool-call/turn-boundary（插件标准面无该事件，以网关 `discipline` 记账兜底）。

## 七、许可

MIT © B&W（小棒 & 灰狼）
