# B&W（棒&狼）· dsh-bw-router

**B&W = 小棒（B棒）× 灰狼（Wolf）** 合作的 DeepSeek Harness 模型路由插件。

把一件任务拆成分段计划、按每段需要挑模型，并在**同一个会话里**切模型而不丢上下文；同时给出成本与省钱的明示口径（看不到价就明说，不编数）。

> 当前版本 **v0.1.0（预发布 / M0 阶段）**：宿主接口与路由内核已可用，客户端目前只渲染「计划卡 + 状态栏」，生成计划与确认需要调用插件 HTTP 接口（见下）。已知限制见 [Known limitations](#known-limitations)。

## 它能做什么

1. **分段计划**：把任务拆成阶段，每段给出目标、能力需求与推荐模型。
2. **按段选模型**：结合模型能力、上下文窗口、可用性与价格（若宿主提供）挑选。
3. **会话内切换**：切换只作用于当前会话，不改宿主全局默认模型。
4. **账本与成本**：记录每段实际用量与花费；宿主没有配价时明确显示「预估不可用」，只按 token 记账。
5. **失败明示**：守卫拒绝时返回具体判定码（`context-overflow`、`missing-capability`、`price-unknown` 等），不静默降级。

## 安装

需要 DeepSeek Harness `0.2.1-rc.2` 或同线版本，Node.js `>=20`。

```sh
# npm 发布后
dsh plugin --profile web add dsh-bw-router

# 或直接从 GitHub 安装（tag 固定版本）
dsh plugin --profile web add 'github:beidou6972yh/dsh-bw-router#v0.1.0'
```

装完重启一次承载插件的宿主（`dsh web`），无需手写 patch 行——包内 `cordis.patch.yml` 已声明 `dsh.bundle`。

## 使用

1. 打开 GUI，输入区模型选择器左侧的「路由模式」勾选（若已安装 `dsh-router-mode`）会给草稿打上 `[路由模式]` 标记；也可直接说明「按路由模式执行」。
2. 生成计划（HTTP，同源）：

```sh
curl -s -X POST http://127.0.0.1:3080/router/plan \
  -H 'content-type: application/json' \
  -d '{"taskId":"demo-1","stageNames":["分析","实现","验收"],"estimatedInputTokens":5000}'
```

3. 查看状态 / 计划卡：

```sh
curl -s http://127.0.0.1:3080/router/state
curl -s http://127.0.0.1:3080/router/card
```

4. 确认开工（会切到第 1 段模型）：

```sh
curl -s -X POST http://127.0.0.1:3080/router/plan/confirm \
  -H 'content-type: application/json' -d '{"planId":"<planId>","sessionId":"<sessionId>"}'
```

5. 段末记账与切换：`POST /router/stage/finish`、`POST /router/switch`；开工前改某段模型：`POST /router/plan/swap`。

### 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/router/models` | 模型发现（`count`/`sources`/`filesRead`/`pricing`） |
| POST | `/router/plan` | 生成分段计划与计划卡 |
| POST | `/router/plan/confirm` | 确认开工（可带 `sessionId`） |
| POST | `/router/plan/swap` | 开工前给某段换模型 |
| GET | `/router/state` | 状态栏数据 |
| GET | `/router/card` | 计划卡数据 |
| POST | `/router/switch` | 切到某段模型 |
| POST | `/router/stage/finish` | 段末记账 |
| GET | `/router/wizard`、`/router/context`、`/router/reconcile` | 只读辅助视图 |

## 兼容性

- DeepSeek Harness：`^0.2.1-rc.2`（在 `0.2.1-rc.2` 上实测；`engines.dsh` 已声明，宿主版本闸门可识别）。
- 客户端平台：`web`。
- 不接管宿主默认模型与搜索路由；插件禁用/卸载后无残留配置。

## Known limitations（v0.1.0）

1. **客户端无「生成计划」入口**：计划卡与状态栏只做展示，计划需由调用方（人或 agent）调 `POST /router/plan` 发起。
2. **配置来源可能为 0**：部分 profile 的 `cordis.patch.yml` 含多行纯量时，插件内置 YAML 解析器会跳过整份配置（`sources.config=0`）；模型仍可从宿主运行时获得，但读不到配置里的价格/窗口。
3. **价格**：宿主未配价时 `pricing=host-unpriced`，只记 token 不显示预估；这是明示行为，不是错误。
4. **包内为预构建产物**：本版仓库提供 `dist/` 预构建文件（来源提交见 `COMMIT.txt`）；源码与构建脚本随上游源码包补齐后并入本仓库。

## 许可

MIT © B&W（小棒 & 灰狼）
