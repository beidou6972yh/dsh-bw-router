## 1.0.3.15 — 2026-11-27

公开件脱敏第三轮整改（对侧二次复核 P3）与发版卫生加固：
- **清整族内部任务号**：整族内部任务号（日期编号 .DSH 全族）从公开包与仓库源码清除（原 `price_resolver.py` / `router_plan.py` 引用泛化为中性描述）。
- **清历史包内执行记录与内部引用**：公开包不再夹带内部执行记录、内测编号、空占位残句与内部文档引用。
- **修插件鉴权兜底缺陷**：不再内置任何部署路径/凭据文件名；鉴权只认显式注入的 `WB_GATEWAY_API_KEY` / `WB_GATEWAY_KEY_FILE`，缺失时明确 503，不再静默发无鉴权请求；annotations 改为可选增强，仅显式配置 `WB_ANNOTATIONS_FILE` 时读取。
- **统一署名**：npm 子包 `author` 统一为 `B&W`。
- **闸加严**：脱敏闸新增 `internal-task-family` 规则（整族任务号/内测编号），清洗器不再误改功能文件名、不再留空 code span。
- 产品代码功能零改动（仅公开件文案/默认值与脱敏工具）；回归全绿。

## 1.0.3.13 — 2026-11-27

对侧预检 1.0.3.12 发现两处问题，修复后重出。

### 修复
- **清空真实余额快照**：`dsh-wb-max/dist/client/client.js` 的 `SNAP` 原含真实金额与账户标识（具体数值与账户名不在公开件复述），已清为 `{"fetched_at":null,"items":[]}`；`sanitize-bundles.mjs` 补 SNAP 清空逻辑，防再犯。
- **补顶层 SHA256SUMS.txt**：包目录随包提供 tar 级校验清单（此前只有包内清单）。

### 说明
- 产品代码零改动；run-tests.sh 的 MODULES 补 price_state.py 沿用 1.0.3.12。

## 1.0.3.12 — 2026-11-27

修复 run-tests.sh 模块清单漏拷（对侧复测 1.0.3.11 时发现）。

### 修复
- `gateway/run-tests.sh`：MODULES 补 `price_state.py`（main.py 已 import 它；缺这一行时临时树整段 import 失败，脚本误报双源、退出码 5）。
- 产品代码零改动；补行后两段各 596 例全绿、失败集合一致、canary 按预期红。

## 1.0.3.11 — 2026-11-26

产品改名 **WB驭档·模型智能换挡系统（WB-GearPilot）**，并修复 Pro 模式「生成计划」无反应（P0–P3）。

### 改名（展示名，技术标识零改动）
- 中文展示名：WB 模型路由 → **WB驭档·模型智能换挡系统**；英文：**WB-GearPilot**。
- 覆盖：DSH 插件（Pro/Max）、网关（含管理界面）、Skill（wb-max-router）、MCP（wb-max-mcp）、README/文档/海报文案。
- 第一原则：npm 包名（`dsh-wb-pro`/`dsh-wb-max`/`wb-max-mcp`）、skill name（`wb-max-router`）、MCP 工具名（`wb_route_*`）、API 路由（`/router/*`）、槽位名、触发词 `[WB-Max路由]` 全部保持不变。

### 修复（P0–P3，Pro/Max 客户端）
- P0：空草稿点「生成计划」不再静默吞掉，改为 publish/setNotice 明确提示。
- P1：「生成计划」按钮 disabled 只依赖 pending，不再因空草稿点不动。
- P2：hint/error 提示不受 hero/active 阶段门槛限制，任何阶段可见。
- P3：草稿读取加 DOM 兜底（`[contenteditable][data-composer-input]`），`useInput.draft` 为空时从 composer 取真实文本。

### 验证
- `scripts/verify-plan-fix.mjs`：P0–P3 静态断言 8/8 PASS（RED 8 失败 → GREEN 全过）。
- `scripts/verify-rename.mjs`：新名 9/9 + 旧名清除 9/9 PASS。
- 网关 pytest **596 passed / 114 subtests**；两个 bundle `node --check` 通过；浏览器实测加载补丁 bundle 且无 JS 报错。

# Changelog

## 1.0.3.10 — 2026-11-25

早期问题 真修复（2026-11-25 评审通过）。仅两项改动，行为零回归：

### 修复
- **价格三态单一真源**：新增 `gateway/price_state.py`，`main.price_state_of` 与 `router_plan._price_state_for` 一律委托它。此前两处各判一遍（main 认 4 类本地 provider＋3 段价，plan 只认 provider_b＋2 段价），`/v1/route/prices` 与出计划口径可能漂移。判定逻辑从 main 原样迁入，245 组入参两实现逐位一致（diff=0）。
- **清除写死安装路径**：网关 `main.py`（STALL_NOTIFY_PATH）、`router_deciders.py`（凭据文件）、`admin_ui.py`（plugin-reconcile）、`run-18790.sh`（凭据路径）改为按 DSH_HOME/当前树相对定位，可用环境变量覆盖；不再写死安装树的绝对路径。

### 验证
- 新增 2 组测试：`tests/test_price_state_single_source.py`（3 例，单一真源＋两条委托）、`tests/test_no_abs_install_path.py`（1 例，生效运行文件 0 写死路径）。
- TDD 全流程：RED 4 失败（模块缺失＋2 处硬编码）→ GREEN 4 通过；全量回归 **605 passed / 114 subtests**，无新增告警。
- 第一原则：价格判定 245 组入参旧实现 vs 新实现 diff=0；未改任何 chunk/数据边界、文本、向量。


## 0.2.5 — 2026-11-24

配合网关 **1.0.3.9** 发行：修「Max 三段模型钉选确认后被弹回默认模型」这一真缺陷，并收口两个同源坑。

### 修复
- **网关 `stage_models` 请求级钉选**：`POST /v1/route/plan` 新增可选 `stage_models`（`{"s1":"<upstream>/<model>"…}`，也接受数字键）。优先级 钉选 > learnedOverride > 策略链首位；**不写盘**、不污染其他会话；非法值记 `stage_models_skipped` 并 fail-open；不传时零差异。计划响应回显 `stage_models` / `stage_models_skipped`，每段带 `pinned` 与 `source=session_pin` 审计痕；计划记账落钉选后的 model_key，执行侧 `model_mismatch` 不误报。
- **MCP `wb_route_plan`**：schema 增加 `stage_models` 并原样下发（此前只透传 task/strategy/max_stages，钉选根本没发出去）。
- **客户端钉选持久化**：按段 id 存 `localStorage`，新建会话/刷新后恢复；主按钮与草稿两条出计划通路都带钉选；「取消」清空。
- **原生回落白名单动态化**：由网关 `/wb-max/models` 自动收集上游 id，不再写死名单（新上游即刻有原生兜底）。
- **空草稿点 Pro 给提示**：不再「无反应」。

### 验证
- 新增 `gateway/tests/test_stage_models_pin.py` **13 例**（钉选生效/数字键/部分钉选/重出一致/fail-open/坏形状/不落盘/优先于 learnedOverride），部署树与公开树各 13/13 OK。
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

### 修复 A：SKILL.md CLI 路径不再写死安装路径
- `skill-mcp/wb-max-router/SKILL.md` 中 3 处 旧的写死 CLI 路径 改为探测式解析（与 `scripts/check-tools.sh` 同款顺序）：`WB_MAX_CLI` 环境变量 → 仓库相对路径 → `$DSH_HOME/tools` → 旧默认；找不到即明确报错退出 2。
- 凭据文件默认路径改为可覆盖：`WB_GATEWAY_KEY_FILE` 优先，旧的凭据文件默认路径仅作兼容。
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
- 运维件：重启审计（只记不拦）＋修「±600s 洗白」。
- 观测：`config/shadow_judge.json` 采样门 16k→150k（仅影子观测）。
- 文档：`docs-open/`（使用说明书/快速上手/Agent 安装说明/海报）与 `release-notes-1.0.3.3/`。
- 本仓新增 `gateway/`、`dsh-wb-max/`、`dsh-wb-pro/`、`skill-mcp/`；`dsh-wb-max` 前端余额快照已脱敏（`SNAP.items=[]`）。
