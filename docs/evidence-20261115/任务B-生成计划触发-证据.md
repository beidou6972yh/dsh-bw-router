# 任务B 证据 — 客户端「生成计划」触发入口（blocker B）

> 归属：共享任务板 **task-1 / 任务B**（负责人：高级开发工程师·大白，teammate `task-b-client`）
> 仓库：`/opt/dsh-home/projects/模型路由插件`，分支 `fix/publish-blockers-20261115`（未切分支、未 commit、未 push）
> 时间：2026-11-15 04:0x–04:15（Asia/Shanghai）
> 对应缺陷（灰狼原话要点）：「客户端只有计划卡+状态栏，没有『生成计划』按钮；计划必须我方调 POST /router/plan 发起。」

## 0. 一句话结论

**判据 ①–⑤ 全部通过（0 条未过）**：客户端 dock 新增 `router-plan-trigger`（order 59）按钮，真实发出 `POST /router/plan`；
宿主返回的 card 由既有 `router-plan-card` 槽位从**共享 store** 渲染（点一次只有 1 个 POST，不再多拉 GET）；
`stageNames: []` 由宿主返回 **200**（不是 500）+ 明确提示「空清单：未提供阶段」；失败显示 `加载失败：<宿主原因>`；
既有两条 dock 注册（60/61）id 与 order 均未回归。端到端证据是**真客户端包**跑在假 `window.__ModuleLoader__` 里、
假 fetch 桥到**真** `dispatch` 路由实现，脚本可重复执行：`npm run verify:plan-trigger`。

## 1. 改了哪些文件（路径 + 行号 + 行为）

| 文件 | 位置 | 改了什么（行为） |
|---|---|---|
| `src/plugin/client-entry.ts` | L74（`SLOT_REGISTRATIONS`） | 新增第 3 条 dock 注册 `router-plan-trigger` / order **59** / 组件 `RouterPlanTrigger`；原 `router-plan-card`(60)、`router-status-bar`(61) **id 与 order 原地不动** |
| 同上 | L116–162 | 新增**模块级计划 store**：`PlanView` 类型、`latestPlanView()`、`publishPlanView()`、`subscribePlanView()`、`resetPlanView()`（一个页面一份，触发按钮写、计划卡槽位读） |
| 同上 | L164–262 | 新增触发输入纯函数：`DEFAULT_STAGE_NAMES`、`stageNamesFromText()`、`planStageNames()`、`planRequestFor()`、`requestPlanForTrigger()`。**taskId 由客户端生成**：`ui-<Date.now()>`；宿主 taskId 必填契约不改 |
| 同上 | L310–320 | `createComponents(react, { fetchImpl })`：新增 `fetchImpl` 注入点（`apply` 原本就有该 option 但没用；现在真接上） |
| 同上 | L348–370 | `usePlanCardView()`：计划卡槽位**优先读 store**；store 为空时才走一次 `GET /router/card`（保持原有「宿主里已有计划」的加载路径）；GET 在飞时若用户点了按钮，store 胜出，慢响应不会覆盖新计划 |
| 同上 | L388–412 | `RouterPlanTrigger`：渲染一个真 `<button data-dsh-router="router-plan-trigger">[生成计划]</button>`，`onClick` → `requestPlanForTrigger`（真实 `POST /router/plan`），pending 期间文案「生成计划中…」并禁用；**不画假骨架** |
| 同上 | L426–436 | `apply()` 按 `SLOT_REGISTRATIONS` 注册 3 个组件（原来三目只支持 2 个），并把 `fetchImpl` 传给组件 |
| `src/plugin/client.ts` | L100–126 | 新增 `PlanPayload`（= `{planId, card, notice?, empty?}`），`requestPlan()` 返回该类型 —— 只为把宿主的 `notice`/`empty` 带到 UI；**既有导出行为不变** |
| `src/plugin/endpoints.ts` | L280–316 | `postPlan()`：`stageNames` 校验后**空数组短路** → **200**，body `{ok:true, planId:'', empty:true, notice:'空清单：未提供阶段（请至少给出一个阶段名）', stages:[], modelCount:0, pricing, card}`；card 用既有 `buildPlanCard(空计划)` 生成后只替换 footer/blockers（避免空合计印成 `~$0.0000` 被读成“免费”）。`buildStages()` 的异常契约与 planner 语义**未改** |
| 同上 | L181–190 | （顺带修的结构性缺陷）`FAILURE_STATUS` 补 `'no-plan': 404`。原代码注释与 `client.ts` 都承诺 `404 no-plan` 由客户端映射成 `idle`（新会话不画卡），但实际答 400（默认兜底），于是每个新会话的 dock 首屏都是 `加载失败：no plan yet`。1 行对齐 |
| `test/plan-trigger.test.ts` | 新增，379 行 / 12 测试 | 按钮存在且渲染；点击真的 POST `/router/plan`（taskId=`ui-<ts>`）；卡片槽位从 store 渲染且**不重复 GET**；空清单 200+提示；失败路径 `加载失败：…`；3 条 dock 注册顺序；触发输入/store 纯逻辑 |
| `test/client-slot-registration.test.ts` | L129–176（既有文件，**仅改断言**） | 原断言写死「恰好 2 条注册」。新增触发组件后必须同步：改为 3 条，并显式断言原来两条 id/order 仍是 `router-plan-card@60`、`router-status-bar@61`。**没有弱化任何原有判据** |
| `scripts/verify-plan-trigger.mjs` | 新增，338 行 | 可重复执行的端到端自测（见 §4）：rolldown 打包真源码 → `wrapClientBundle` → 假 `window.__ModuleLoader__` 执行 → `apply` → 假 fetch 桥真 `dispatch` → 模拟点击 → 打印槽位真实渲染行 |
| `package.json` | L45 `scripts.verify:plan-trigger` | 让上面的脚本有正式入口（也是“新增文件必须被引用”的落点） |

未触碰：`src/adapters/yaml-lite.ts`、`test/anchors.test.ts`、`test/multiline-scalar.test.ts`、`src/adapters/dsh-profile-config.ts`（属 Lead 的 blocker A），也未动 `profiles/`、未装插件、未重启服务、未碰 NAS；`STATE.md`（未跟踪）未动。

## 2. 判据逐条（命令 + 真实输出 + 结论）

### 判据 ①：点击按钮 → `POST /router/plan` 被真实调用

命令：`npm run verify:plan-trigger`（真客户端包 + 假 fetch 桥真 `dispatch`）

```
== 加载器契约 ==
PASS  loader registered the module under its package id  dsh-model-router
PASS  module exports inject = ["slots"]
PASS  module exports apply()
   dock 注册: router-plan-trigger@59, router-plan-card@60, router-status-bar@61

== 场景 1: 按下 [生成计划] ==
   按钮文本: ["[生成计划]"]
   HTTP GET /router/card -> 404
   HTTP POST /router/plan -> 200
PASS  clicking sent exactly one POST /router/plan
PASS  the POST carried a client-generated taskId  ui-1794687275524
```

单元级同判据（`test/plan-trigger.test.ts`）：`clicking POSTs /router/plan with a client-generated ui-<ts> task id`
断言 `method==='POST'`、`path==='/router/plan'`、`taskId` 匹配 `/^ui-\d+$/`、`stageNames` 来自调用方。

**结果：过。**

### 判据 ②：拿到计划卡并渲染（含模型/费用行）

```
   router-plan-card 槽位渲染出 6 行:
     执行计划（可改）｜UI 生成计划：analyze → implement → write
      1. analyze → DeepSeek Reasoner ▾   ~$0.0168 ±35% (save 30% vs baseline)
      2. implement → Qwen Coder (local) ▾   ~$0.0000 ±35% (save 100% vs baseline)
      3. write → DeepSeek Reasoner ▾   ~$0.0275 ±35% (save 62% vs baseline)
     合计 ~$0.0443 ±61% (save 82% vs baseline) · baseline Diffusion XL (guessed)
     [确认开工] [取消]
PASS  the plan card rendered the host card
PASS  model + money rows are on screen
PASS  the card offers 确认开工
PASS  the card slot did not fetch its own copy (only the mount-time GET /card + the POST)
```

- 卡片行由既有 `planCardLines()` 生成（`执行计划（可改）` / 行号+模型 `▾` + 费用 / `合计` / `[确认开工] [取消]`），
  金额全部来自宿主返回的 card，客户端不自己算钱（M-6 未破）。
- 「一次点击只有 1 个 POST、不再额外 GET」＝ 需求 2 的「不要两处各拉各的」：store 共享，计划卡槽位消费同一份答案。

**结果：过。**

### 判据 ③：`stageNames=[]` 时 200 不报错且有明确提示

命令（真 `dispatch`，打印原始响应）：
`node temp/verify-plan-trigger/raw-empty.mjs`（该临时脚本 import 的是 `scripts/verify-plan-trigger.mjs` 打出的真宿主包）

```json
{
  "request": { "taskId": "ui-1", "stageNames": [] },
  "status": 200,
  "response": {
    "ok": true,
    "planId": "",
    "empty": true,
    "notice": "空清单：未提供阶段（请至少给出一个阶段名）",
    "stages": [],
    "modelCount": 0,
    "pricing": { "policy": "auto", "mode": "strict", "catalogHasPrices": true, "requireKnownPricing": true },
    "card": {
      "planId": "", "title": "ui-1", "rows": [],
      "footer": "空清单：未提供阶段（请至少给出一个阶段名）",
      "blockers": [], "canStart": false, "checked": true, "needsWizard": false,
      "skippable": false, "baselineModelKey": null,
      "pricing": { "policy": "auto", "mode": "strict", "catalogHasPrices": true, "requireKnownPricing": true }
    }
  }
}
```

反向保护（**不是**把契约改松）：省略 `stageNames` 字段仍然是 400 ——

```json
{ "request": { "taskId": "ui-1" }, "status": 400,
  "response": { "ok": false, "code": "bad-request", "error": "\"stageNames\" must be an array of strings" } }
```

客户端看到的画面（同一份 E2E 输出）：

```
== 场景 2: 空清单（stageNames: []）==
PASS  empty stage list answers 200, not 500  200
   router-plan-card 槽位渲染出 3 行:
     执行计划（可改）｜UI 生成计划：空清单
     空清单：未提供阶段（请至少给出一个阶段名）
     [取消]
PASS  the dock prints the empty-list sentence
PASS  an empty plan offers no 确认开工
```

**结果：过。**（空清单不再 500；`buildStages()` 的 throw 仍在——planner 语义没动，短路发生在 HTTP 边界。）

### 判据 ④：失败路径显示宿主原因（`加载失败：…`，不许空壳）

```
== 场景 3: 宿主 500 ==
PASS  no plan yet means no card (the 404 → idle rule)
   router-plan-card 槽位渲染出 1 行:
     加载失败：the host said no
PASS  a failure reaches the dock as 加载失败：<宿主原因>  ["加载失败：the host said no"]
```

另有一条 transport 直接抛错的用例（`fetch` throw `ECONNREFUSED`）→ `planCardView` 返回 `加载失败：ECONNREFUSED`。

**结果：过。**

### 判据 ⑤：新增测试全绿、原有客户端测试不回归、dock 注册顺序不回归

命令（**只跑本任务范围内的文件，未跑全量 `npm test`**）：

```
$ npx tsc -p tsconfig.json --noEmit
tsc exit=0

$ npx vitest run test/plan-trigger.test.ts test/client-half.test.ts test/client-slot-registration.test.ts test/router-endpoints.test.ts

 RUN  v4.1.12 /opt/dsh-home/projects/模型路由插件

 ✓ test/client-slot-registration.test.ts (5 tests) 74ms
 ✓ test/plan-trigger.test.ts (12 tests) 41ms
 ✓ test/router-endpoints.test.ts (21 tests) 41ms
 ✓ test/client-half.test.ts (18 tests) 61ms

 Test Files  4 passed (4)
      Tests  56 passed (56)
```

因为改了 `FAILURE_STATUS`（`no-plan: 404`），额外跑了一次相邻范围（仍不含 yaml 相关）：

```
 ✓ test/client-slot-registration.test.ts (5 tests)
 ✓ test/router-endpoints.test.ts (21 tests)
 ✓ test/plan-card-e2e.test.ts (7 tests)
 ✓ test/plan-trigger.test.ts (12 tests)
 ✓ test/client-half.test.ts (18 tests)
 ✓ test/plan-stages.test.ts (4 tests)
      Tests  67 passed (67)，6 files passed
```

dock 注册顺序（E2E 真机路径 + 单测双证）：

```
   dock 注册: router-plan-trigger@59, router-plan-card@60, router-status-bar@61
PASS  dock entries: trigger@59, card@60, bar@61
```

**结果：过。** 原有 `client-half.test.ts`（18）、`client-slot-registration.test.ts`（5）、`router-endpoints.test.ts`（21）全绿；
唯一改动过的既有测试断言是「注册条数 2→3」并**额外**断言原两条 id/order 不变（见 §1 表）。

## 3. 自测记录：把真客户端模块放进假 `window.__ModuleLoader__`

可重复执行：`npm run verify:plan-trigger`（= `node scripts/verify-plan-trigger.mjs`；临时产物在 `temp/verify-plan-trigger/`，被 `.gitignore` 忽略）

它做的是（不是 mock 客户端）：

1. `rolldown` 把 `src/plugin/client-entry.ts` 打成 CJS，再用仓库自己的 `scripts/client-bundle.mjs` 的
   `wrapClientBundle()` 包成 `window.__ModuleLoader__.load({id, factory(require)})` —— **与 `npm run build` 同一条包装路径**，
   且**不写 `dist/`、不跑 `npm run build`**（Lead 在并行改 yaml，构建闸门归 Lead）；
2. 在假 `window.__ModuleLoader__` 里执行该脚本，拿到 `{ inject, apply }`；
3. `apply(ctx, { react, fetchImpl })`，用假 slots 服务记录 3 条注册；
4. 假 fetch **不造业务数据**，逐条转给真 `src/plugin/endpoints.ts` 的 `dispatch`（真路由/真 `PluginHost`/真卡片）；
5. 用极简 React 替身（`useState` 会触发重渲染、`useEffect([])` 挂载时跑一次）挂载 `router-plan-card` 与
   `router-plan-trigger`，模拟用户按下按钮，等宿主回答后打印 **`router-plan-card` 槽位真正渲染出来的行**；
6. 三个场景：正常计划 / 空清单 / 宿主 500。

上面 §2 里的三段输出就是它的原样输出；退出码非 0 代表断言未过（当前全部 PASS）。

## 4. 关键取舍（都在「最小改动、可逆」范围内，替 Lead 先定）

1. **一张卡只渲染一次**：需求 1 的字面是“触发组件把 card 渲染成计划卡行”，需求 2 是“既有 `router-plan-card` 槽位也能看到”。
   若两处都画，dock 里会出现**两张一模一样的卡**（order 59 与 60 是同一 dock 的两个条目），灰狼一眼就会再报一次视觉缺陷。
   所以取：**触发组件只画按钮并发布结果；卡片由既有 `router-plan-card` 槽位从共享 store 渲染**——
   「点击 → 真实 POST → 计划卡行出现」整条链路在 §3 的端到端里是同一份证据，且只有一份渲染者。
2. **空清单短路放在 HTTP 边界**（`postPlan`），不动 `buildStages()` 的 throw、不动 planner 语义；空卡复用 `buildPlanCard`，
   只把 footer 换成提示，避免空计划印出 `~$0.0000` 被读成“免费的账单”。
3. **`planId: ''` + `empty: true`**：空清单没有建计划，不给一个 `/plan/confirm` 会 404 的假 id；同时把“为什么不能开工”写成数据（不是只有英文句子）。
4. **taskId 客户端生成** `ui-<ts>`：宿主 `taskId` 必填契约原样保留（省略 taskId 仍 400），只是不再让 UI 去猜宿主命名。
5. **顺带修 `no-plan` → 404**：不是本 blocker 的要求，但和新按钮直接相关——若不修，新会话首屏 dock 会先显示
   `加载失败：no plan yet`（`client.ts` 的“404 才当 idle”永远不成立）。1 行、可逆，且让 `client.ts`/`endpoints.ts` 的注释与代码一致。
6. 触发按钮的送参：`props.stageNames`（显式数组，空数组会**原样**送出去，正好覆盖空清单路径）→ 否则 `props.text/prompt/draft`
   按 `→ , ， 、 + ＋ /` 拆 → 否则默认 `['analyze','implement']`。真实 composer 若日后能提供草稿文本，无需再改代码。

## 5. 没做到 / 需要 Lead 收口的事

1. **`dist/client/client.js` 是旧的**：我改了 `src/plugin/client-entry.ts`，但按要求**没有跑 `npm run build`**。
   发布前需要 Lead 在全量闸门里重建（`npm run build`，或至少 `tsc -p tsconfig.build.json && node scripts/build-client.mjs`），
   否则装出去的包仍是没有按钮的旧客户端包。证据脚本验证的是**源码经同一包装路径**产出的包，不是 `dist/` 里的旧产物。
2. **没有在真实 DSH Web 里装上点一次**（硬约束：不装插件、不重启服务）。真机点击的最后一跳（loader 拿 `./client`、
   真实 `fetch` 打到宿主的 HTTP 适配层）未由我验证——这需要 Lead 在收口时按发布流程装包确认。
3. **全量 `npm test` 未跑**（约定由 Lead 统一跑，且 yaml-lite 正在并行改）。我跑的是本任务范围 4 个文件 + 相邻 6 个文件。
4. **未 commit / 未 push / 未切分支**（按硬约束；工作树里目前包含 Lead 的 yaml 改动，别用仓库级回退）。

## 6. 复现命令汇总

```bash
cd /opt/dsh-home/projects/模型路由插件

# 类型检查（含 test/）
npx tsc -p tsconfig.json --noEmit

# 本任务测试 + 既有客户端/端点回归
npx vitest run test/plan-trigger.test.ts test/client-half.test.ts \
              test/client-slot-registration.test.ts test/router-endpoints.test.ts

# 端到端：真客户端包 → 假 __ModuleLoader__ → 假 fetch → 真 dispatch → 模拟点击 → 打印渲染行
npm run verify:plan-trigger
```

---

## 7. Lead 复核（独立，2026-11-15 04:1x–04:2x）

### 7.1 复核口径

发现者≠验证者：本节由 Lead（大白，会话 `session-50e86a4d-64bb-40c5-8c30-f217c195d008`）独立跑，
不引用上面结论，只认自己跑出来的输出。

### 7.2 全量闸门（Lead 跑）

```
$ npm test
 Test Files  44 passed (44)
      Tests  566 passed (566)          # 基线 1ff55a3：42 文件 / 543 测试；两任务合计 +2 文件 / +23 测试
$ npx tsc -p tsconfig.json --noEmit
 (0 error / exit 0)
$ npm run build
 client bundle: dist/client/client.js (19460 bytes, wrapped=true)   # 旧包 11252 B → 新包含按钮
$ npm run verify:plan-trigger
 全部断言通过：客户端内可以直接生成计划。
```

### 7.3 **产物级**复核（关键补充：验的是发布出去的那一份）

任务B 的证据脚本验的是**源码**现打的包；Lead 另外验了 `npm run build` 之后的**真产物**
`dist/client/client.js`（新增 `npm run verify:dist-client`，脚本 `scripts/verify-dist-client.mjs`）：
假 `window.__ModuleLoader__` → 真 `factory()` → `apply()` → 点 `[生成计划]` →
请求交给 `dist/plugin/endpoints.js` 里**真的** `dispatch`（真 `PluginHost`/`RouterSession`）→ 客户端渲染函数出卡。

```
$ npm run build && npm run verify:dist-client
PASS  loader id = package name  dsh-model-router
PASS  dock 注册 trigger@59 + card@60 + bar@61  ["router-plan-trigger","router-plan-card","router-status-bar"]
PASS  按钮是 <button> 且文案 [生成计划]
PASS  点击真的发了 POST /router/plan
PASS  taskId 由客户端生成 ui-<ts>
PASS  拿回 ready 的计划卡  state=ready
PASS  卡里有模型行与费用
PASS  空清单：状态码不是 500（响应 ok）  state=ready
PASS  空清单：卡里印出提示且不给确认开工
PASS  失败显示宿主原因而非空壳  ["加载失败：boom"]

VERDICT: 全部通过 ✅
```

场景 1 真产物渲染行（Lead 自己那次的输出，模型是复核脚本自带的 3 个虚拟模型）：

```
执行计划（可改）｜UI 生成计划：analyze → implement
 1. analyze → deepseek reasoner ▾   ~$0.0103 ±35% (save 0% vs baseline)
 2. implement → qwen coder ▾   ~$0.0000 ±35% (save 100% vs baseline)
合计 ~$0.0103 ±49% (save 68% vs baseline) · baseline deepseek flash (guessed)
[确认开工] [取消]
```

场景 2（空清单）真产物渲染行：

```
执行计划（可改）｜UI 生成计划：空清单
空清单：未提供阶段（请至少给出一个阶段名）
[取消]
```

### 7.4 取舍裁定

- **「触发组件只画按钮、卡片由既有槽位从 store 渲染」——接受**（§4.1 的取舍）。同一 dock 里 order 59 与 60 都画卡会出两张一样的卡，
  这是缺陷不是证据；判据要的「拿到计划卡」由同一 store 的 60 号槽位满足，§3/§7.3 两份输出都在同一屏打印了卡片行。
- **`no-plan: 404`——接受**：与 `endpoints.ts` 自己的 docstring、`client.ts` 的「404→idle」约定一致，改前是代码与文档相矛盾。
  已跑全量无回归（`test/plan-card-e2e`、`test/plan-stages`、`test/router-endpoints` 全绿）。
- **`stageNames` 省略仍 400、空数组 200**——接受：前者是打字漏字段（该报错），后者是用户明确说“没有阶段”（该给提示），两种语义不混。

### 7.5 Lead 复核后仍未验的一跳

真机「装进 DSH Web 点一次」未做（派工硬约束：不装插件、不重启服务）。产物级 §7.3 已到
「真 `client.js` + 假 loader + 真路由」为止；再往上需要装包重启，属发布流程由小棒/灰狼执行。
