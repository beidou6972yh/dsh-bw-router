# B&W（棒&狼）· dsh-bw-router

**B&W = 小棒（B棒）× 灰狼（Wolf）** 合作的 DeepSeek Harness 模型路由插件。

把一件任务拆成分段计划、按每段需要挑模型，并在**同一个会话里**切模型而不丢上下文；成本要么给出依据、要么明示不可用，绝不编数。

> 当前版本 **v0.2.0**：两个发布阻塞已修复——① 配置里的多行纯量不再让整份 profile 被跳过（`sources.config>0` 可复现）；② 客户端输入区新增「生成计划」触发，不必再手工调接口。

## 它能做什么

1. **分段计划**：把任务拆成阶段，每段给出目标、能力需求与推荐模型。
2. **按段选模型**：结合模型能力、上下文窗口、可用性与价格（若宿主提供）挑选。
3. **会话内切换**：切换只作用于当前会话，不改宿主全局默认模型。
4. **账本与成本**：记录每段实际用量与花费；宿主没有配价时明确显示「预估不可用」，只按 token 记账。
5. **失败明示**：守卫拒绝时返回具体判定码（`context-overflow`、`missing-capability`、`price-unknown` 等），不静默降级。

## 安装

需要 DeepSeek Harness `0.2.1-rc.2` 或同线版本，Node.js `>=20`。

```sh
# 从 GitHub 固定 tag 安装（推荐）
dsh plugin --profile web add 'github:beidou6972yh/dsh-bw-router#v0.2.0'

# 或从 Release 的预构建 tarball 安装
dsh plugin --profile web add 'https://github.com/beidou6972yh/dsh-bw-router/releases/download/v0.2.0/dsh-bw-router-0.2.0.tgz'
```

> npm 渠道暂不发布；GitHub 仓库与 Release tarball 是唯一发布源。

装完重启一次承载插件的宿主（`dsh web`）。包内 `cordis.patch.yml` 已声明 `dsh.bundle`，安装后会自动启用，无需手写 patch 行。

## 使用

1. 正常对话；需要路由时在输入区勾选「路由模式」（若已安装 `dsh-router-mode`，草稿会带上 `[路由模式]` 标记），或直接说明「按路由模式执行」。
2. 点击输入区旁的 **生成计划**（或调用 HTTP 接口），插件会把任务拆段并分配模型，计划卡出现在输入区上方。
3. 在计划卡上点 **确认开工**，会话切到第 1 段模型；状态栏显示 `[路由] 第 n/N 段 · 当前模型 · 已花 … · 下一段：…`。
4. 每段结束按状态栏提示推进；开工前可在计划卡上换某段模型。

### HTTP 接口（同源，便于脚本/外部触发）

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

```sh
curl -s -X POST http://127.0.0.1:3080/router/plan \
  -H 'content-type: application/json' \
  -d '{"taskId":"demo-1","stageNames":["分析","实现","验收"],"estimatedInputTokens":5000}'
```

## 兼容性

- DeepSeek Harness：`^0.2.1-rc.2`（在 `0.2.1-rc.2` 上实测；`engines.dsh` 已声明，宿主版本闸门可识别）。
- 客户端平台：`web`。
- 不接管宿主默认模型与搜索路由；插件禁用/卸载后无残留配置。

## Known limitations（v0.2.0）

1. **价格**：宿主未配价时 `pricing=host-unpriced`，只记 token 不显示预估；这是明示行为，不是错误。
2. **配置读取**：多行纯量已支持；但若是结构上真正残缺的 YAML（多文档、复杂键、未闭合流式），插件仍按「该文件不可读」跳过——这是既定规则，不冒崩溃风险。
3. **客户端触发**：计划由输入区「生成计划」或 HTTP 接口发起；没有“自动对每条消息都路由”的开关。

## 开发

```sh
npm ci
npm test                      # 单元/回归测试（全量请在 release/* 或 feat/* 分支上跑）
npm run build                 # 编译 dist 与客户端 bundle
npm run verify:plan-trigger   # 客户端「生成计划」端到端自测
```

## 许可

MIT © B&W（小棒 & 灰狼）
