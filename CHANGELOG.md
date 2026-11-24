# Changelog

## 0.2.5 — 2026-11-24

配合网关 **1.0.3.9** 发行：修「Max 三段模型钉选确认后被弹回默认模型」这一真缺陷，并收口两个同源坑。

### 修复
- **网关 `stage_models` 请求级钉选**：`POST /v1/route/plan` 新增可选 `stage_models`（`{"s1":"<upstream>/<model>"…}`，也接受数字键）。优先级 钉选 > learnedOverride > 策略链首位；**不写盘**、不污染其他会话；非法值记 `stage_models_skipped` 并 fail-open；不传时零差异。计划响应回显 `stage_models` / `stage_models_skipped`，每段带 `pinned` 与 `source=session_pin` 审计痕；计划记账落钉选后的 model_key，执行侧 `model_mismatch` 不误报。
- **MCP `wb_route_plan`**：schema 增加 `stage_models` 并原样下发（此前只透传 task/strategy/max_stages，钉选根本没发出去）。
- **客户端钉选持久化**：按段 id 存 `localStorage`，新建会话/刷新后恢复；主按钮与草稿两条出计划通路都带钉选；「取消」清空。
- **原生回落白名单动态化**：由网关 `/wb-max/models` 自动收集上游 id，不再写死名单（新上游即刻有原生兜底）。
- **空草稿点 Pro 给提示**：不再「无反应」。

### 验证
- 新增 `gateway/tests/test_stage_models_pin.py` **13 例**（钉选生效/数字键/部分钉选/重出一致/fail-open/坏形状/不落盘/优先于 learnedOverride），生产树与公开树各 13/13 OK。
- 影子实例活体冒烟：不传钉选复现「全弹回」，传三路钉选精确落位。

## 0.2.4 — 2026-11-24

配合网关 **1.0.3.8** 发行：补齐 v1.0.3.7 复测报告指出的 B 项残留（User-Guide 两处表格 + 全部 PDF 导出件），并顺手修 `gateway/INSTALL.md` 同病。

### 修复 B 项残留（复测报告 ⚠ 项闭环）
- `docs-open/WB-Router-User-Guide.v1.0.0.md`：**两处表格**（§5.1 配置文件表、§11.3 字段表）`config/upstreams.json` → `upstreams.json`（网关根目录）；`sample-config/upstreams.json` 两处旧引用改为 `gateway/upstreams.json`。
- `gateway/INSTALL.md`：第 1 步 `config/upstreams.json` → `upstreams.json`（本身也是错的，复测报告未提，同批修）。
- **全部 3 份 PDF 重出**（Agent-Install / Quick-Start / User-Guide）：Chromium 打印，`pdftotext` 复核 `config/upstreams` 命中 **0**。

### 验证
- `python3 -m unittest discover -s tests` → **Ran 579 / OK**
- 3 份 PDF 文本复核：旧路径 0 命中
- 残留仅保留 2 处「config/upstreams.json 不生效」的警示句（有意保留）

## 0.2.3 — 2026-11-24

配合网关 **1.0.3.7** 发行：修跨宿主文档路径缺陷（对照外部实测报告 A/B 两项 + 同病扩展）。

### 修复 A：SKILL.md CLI 路径不再写死 `/opt/wb-router`
- `skill-mcp/wb-max-router/SKILL.md` 中 3 处 `CLI="${DSH_HOME:-/opt/wb-router}/tools/wb-max-mcp/bin/wb-max.mjs"` 改为探测式解析（与 `scripts/check-tools.sh` 同款顺序）：`WB_MAX_CLI` 环境变量 → 仓库相对路径 → `$DSH_HOME/tools` → 旧默认；找不到即明确报错退出 2。
- 凭据文件默认路径改为可覆盖：`WB_GATEWAY_KEY_FILE` 优先，`/opt/wb-router/config/wb-remote.json` 仅作旧默认。
- 影响：Windows / 非标准安装路径下，MCP 挂不上时的 CLI 兜底不再直接失效。

### 修复 B：安装说明的 upstreams 配置路径写错
- `docs-open/WB-Router-Agent-Install.md` 4 处 `config/upstreams.json` → `upstreams.json`（网关根目录）。
- **根因**：`gateway/main.py:523` 读 `BASE_DIR/upstreams.json`（= `gateway/upstreams.json`）；`gateway/config/upstreams.json` 是历史样例，网关不读，改它不报错但不生效。
- 同一缺陷扩展修复：`WB-Router-Quick-Start.md`（1 处）、`WB-Router-User-Guide.v1.0.0.md`（样例/备份/回滚命令）同步改正。
- html 导出件同步更新；pdf 导出件待重出。

### 其他
- 文档不再引用已不存在的 `sample-config/`（User-Guide 内 `sample-config/routing.json` 保留为旧版说明，标注可选）。
- 回归：`python3 -m unittest discover -s tests` → Ran 579 / OK（未触及网关逻辑）。
## 0.2.2 — 2026-11-24

版本号随网关 **1.0.3.6** 发行对齐（插件代码与 0.2.1 等价，无行为变更）。

- 三个入口（根插件 / `dsh-wb-max` / `dsh-wb-pro`）版本统一为 **0.2.2**，Release 资产与源码同版本。
- 网关侧变更（价目币种、AFP 统计口径、发布可核、公开包脱敏）见 Release `v1.0.3.6` 与 `release-notes-1.0.3.6/`。
- 信任闸（0.2.1 引入）保持不变：`/router/*` 入口先过 DSH 连接信任检查，fail-closed。

## 0.2.1 — 2026-11-22

HTTP 路由接入 DSH 连接信任闸（DSH 插件市场对注册 HTTP 路由的插件提出的要求；Max/Pro 子包已按同一形状发布 0.2.1）。

- **入口先过信任闸**：`/router/*` 的 handler 第一句问 `ctx.connection.requestRejection(req)`，未认证/未信任当场拒答（401/403），**不读请求体、不执行任何路由逻辑**。
- **fail-closed**：连接服务缺失、`requestRejection` 抛错、或返回非数字（含 `null`）一律按不可信处理 → 403；只有宿主显式返回 `undefined`（表示信任）才放行，行为与 0.2.0 完全一致。
- `inject` 改为 `['connection', 'webServer']`，与 `dsh-host-open-in-app` 同形。
- **对直接调用方的影响**：用脚本/`curl` 直接打这些路由不再免检，需要 DSH 的浏览器认证或 API 凭据——这正是闸门的目的。
- 测试：`test/dsh-shell.test.ts` 新增 9 条闸门用例（403 / 401 / 放行 / 服务缺失 / 抛错 / 垃圾值 / 经 `get()` 取服务 / 布尔返回 / 不读 body）；`test/m2-host-compat.test.ts` 显式覆盖「宿主无连接服务 → 403，绝不 200」。

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
