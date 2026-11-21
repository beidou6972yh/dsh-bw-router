# Changelog

## 0.2.0 — 2026-11-15

发布阻塞修复版（首个带客户端触发的版本）。

- **YAML 多行纯量**：`yaml-lite` 支持 YAML 合法的折行纯量（`- ApiKey` + 下一行续写），按 folding 规则以空格折叠；修后真实 profile 的 `sources.config` 由 0 变为 5 provider / 19 model，`filesRead` 命中 `profiles/web/cordis.patch.yml`。
- **客户端「生成计划」**：输入区新增触发，`[生成计划]` 直接 `POST /router/plan`，计划卡由既有 `router-plan-card` 槽位渲染，卡片带 `[确认开工]`；空清单返回 200 并给提示，宿主失败显示「加载失败：<原因>」。
- 新增回归测试：`test/multiline-scalar.test.ts`、`test/plan-trigger.test.ts`、`test/client-slot-registration.test.ts`。
- 新增自测脚本：`scripts/verify-plan-trigger.mjs`、`scripts/verify-dist-client.mjs`、`scripts/repro-yaml-multiline.mjs`。
- 包名统一为 `dsh-bw-router`，声明 `dsh.bundle`、`engines.dsh ^0.2.1-rc.2`。

## 0.1.0 — 2026-11-15

首个公开预发布（预构建 dist）。

- 分段计划 `POST /router/plan`、确认开工 `POST /router/plan/confirm`、会话内切换 `POST /router/switch`。
- 段末记账 `POST /router/stage/finish`、状态栏 `GET /router/state`、计划卡 `GET /router/card`。
- 模型发现 `GET /router/models`；宿主未配价时明示「预估不可用」，只按 token 记账。
- 客户端通过 `conversation.composer.dock` 渲染计划卡与状态栏。

## 1.0.3.3 — 2026-11-21

- 融合前序版本成果：网关主代码相对 1.0.3.2 零功能性改动（B1–B5、A0/L5、R4/R5 全部保留）。
- 新增 `tests/test_price_aggregate.py` 6 例（`?model=` 聚合视图回归）；网关回归两段各 568/OK。
- 运维件：重启闸 autorestart 审计（只记不拦）＋修「±600s 洗白」。
- 观测：`config/shadow_judge.json` 采样门 16k→150k（仅影子观测）。
- 文档：`docs-open/`（使用说明书/快速上手/Agent 安装说明/海报）与 `release-notes-1.0.3.3/`。
- 本仓新增 `gateway/`、`dsh-wb-max/`、`dsh-wb-pro/`、`skill-mcp/`；`dsh-wb-max` 前端余额快照已脱敏（`SNAP.items=[]`）。
