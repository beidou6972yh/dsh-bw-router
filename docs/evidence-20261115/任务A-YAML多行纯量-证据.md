# 任务A 证据：YAML 多行纯量 → config=0（dsh-bw-router 发布 blocker 1）

> 派工：小棒代老大（2026-11-15 04:1x）。执行：大白（高级开发工程师）[session-待回执填写]
> 项目：`projects/模型路由插件`（分支 `fix/publish-blockers-20261115`，基线 `1ff55a3`）
> 边界：只在本项目内改代码/测试；未动 `/opt/dsh-home/profiles/`，未装插件、未重启服务、未碰 NAS。

## 0. 一句话结论

对侧报的「`sources.config=0`，`skipped` 首条 `unexpected indentation (line 732)`」**已复现、已修**：
YAML 合法的**折行 plain scalar**（`- ApiKey` 后换行续写）过去会让整份 profile 解析失败、文件级跳过；
现在能解析并折叠成一个值，同一份含该写法的 YAML 由 **config=0 → config=2**，provider/价格/窗口全部可读，
全量测试 **543 → 566** 全绿（42 → 44 文件，含任务B并行加入的 12 条）（详见 §5、§6），真正写坏的缩进仍然大声报错，配置读不到时 `skipped` 明说「本次不生效，不等于没配置」。

## 1. 根因（代码级）

- 解析器：`src/adapters/yaml-lite.ts`（自研 YAML 子集读取器，项目铁律「内核零依赖」故不引第三方 YAML）。
- 缺陷：`parseSequence` / `parseMapping` / `parseInlineMapping` 只认**单行**纯量。YAML 允许一个 plain scalar 折行：
  ```
          - ApiKey
            sk-<redacted-key>
  ```
  续写行缩进更深 ⇒ 旧代码走到 `if (line.indent > indent) throw new YamlLiteError('unexpected indentation')`。
- 放大链：抛错 ⇒ `readProfileConfigFiles` 把**整份文件**记成 skipped（`src/adapters/dsh-profile-config.ts`）
  ⇒ `modelReport` 的 `configModels=0` ⇒ `/router/models` 的 `sources.config=0`
  ⇒ 配置里的 `inputPerMTok/outputPerMTok/contextWindow/maxTokens` 一个都读不到，只剩运行时清单（无价）。
  这正是对侧原文：「运行时仍拿到 52 个模型，能跑，但读不到配置里的价格/窗口」。

## 2. 最小失败样例（修复前 config=0，可复跑）

复现装置 `scripts/repro-yaml-multiline.mjs`（随代码提交）：造一份与对侧同形的 `cordis.patch.yml`
——xerj MCP 的 `args` 里 `- ApiKey` + 换行续写密钥，后面接 `llm-pi-ai` 的 provider 段（写清窗口/单价）；
用注释填充行，使**续写行正好落在第 732 行**，与对侧报的报错行号一字不差；然后走插件真实的读取层
`readProfileConfigFiles()`，打印 config / skipped / 价格。

```bash
# 修复前：用基线 1ff55a3 的构建产物（dist 快照，yaml-lite.js sha256 9a1ee540…）
node scripts/repro-yaml-multiline.mjs temp/before-dist/adapters
# 修复后：用当前源码编译出的 adapters
npx tsc --outDir temp/after-dist --module nodenext --moduleResolution nodenext \
        --target es2022 --skipLibCheck --declaration false --sourceMap false \
        src/adapters/dsh-profile-config.ts
node scripts/repro-yaml-multiline.mjs temp/after-dist/adapters
```

真实输出（全文见 `docs/evidence-20261115/任务A-AB复现输出.txt`）：

```
=========== BEFORE（修复前）===========
adapters      : temp/before-dist/adapters
续写行号      : 732
filesRead     : 0
config(providers): 0
config(models)   : 0
providers     : []
models        : []
skipped       : ["…/cordis.patch.yml: unexpected indentation (line 732)"]
VERDICT       : config=0 ❌

=========== AFTER（修复后）===========
adapters      : temp/after-dist/adapters
续写行号      : 732
filesRead     : 1
config(providers): 2
config(models)   : 2
providers     : ["freellmapi","deepseek-account"]
models        : [{"key":"freellmapi/auto","contextWindow":200000,"maxTokens":16384,"inputPerMTok":0,"outputPerMTok":0},
                 {"key":"deepseek-account/deepseek-flash","contextWindow":1048576,"maxTokens":65536,"inputPerMTok":0.28,"outputPerMTok":0.42}]
skipped       : []
VERDICT       : config>0 ✅
```

## 3. 修复内容（`src/adapters/yaml-lite.ts`、`src/adapters/dsh-profile-config.ts`）

| # | 位置 | 改动 | 为什么 |
|---|---|---|---|
| A1 | `foldScalarLines()`（新增） | 按 YAML 语义把折行纯量用**空格折叠**成一个值；只折叠「不能开启新结构」的行 | 折行纯量本来就是合法 YAML；折叠＝YAML 的 folding 规则 |
| A2 | `parseSequence` 纯量项 | `- ApiKey` + 更深续写行 ⇒ 折叠，不再 `unexpected indentation` | 对侧 line 732 的原始形状 |
| A3 | `parseMapping` / `parseInlineMapping` 的行内值 | `key: first` + 更深续写行同样折叠；`- key: value` 项内也折叠 | 同一规则的其他写法，避免下次换个位置再炸 |
| A4 | `parseBlock` | 值整段写在 key 下面（`key:` 换行后纯量）也按标量块解析 | 真机 `profiles/headless/cordis.patch.yml` 是裸 `[]`，旧代码报 `expected "key: value" in "[]"`（见 §4.3） |
| A5 | `isBlockScalarMarker` | 认显式缩进指示符 `\|2` / `\|-2` / `>2` 等 | `\|2` 过去落到纯量路径，随后被块自身缩进炸掉 |
| A6 | `parseInlineMapping` 块标量首值 | 用 `readBlockScalar` 返回的 `next` 续扫剩余 key（原来丢掉了 `next`） | 顺手修掉的真 bug：`- text: \|` 这种首值是块标量的项过去必抛 |
| A7 | `unreadableProfile()`（新增） | 解析失败的 `skipped` 文案改成「未读取（原因）—— 该文件的 provider/价格/窗口本次不生效；config=0 只说明没读到，不等于没配置」 | 任务要求「真读不到时给出明确降级与日志，不静默吞成 0」；原本文案只有一个行号，容易被读成「宿主没配置」 |

容错边界（**没有**放宽成「把坏配置当散文读」）：
- 更深的行如果是 `key: value` 或 `- item`，仍然抛 `unexpected indentation`（有测试锁住）；
- 未闭合的 flow（`[ unclosed`）仍然整份文件跳过，只是 `skipped` 现在会说清代价；
- 未闭合引号、多文档等仍按原样拒绝；锚点/别名容错（修正版5）行为不变。

## 4. A/B 与回归

### 4.1 同一份含多行纯量的 YAML（判据本体）

见 §2：`before` = config 0 / `skipped` 报 `unexpected indentation (line 732)`；
`after` = config 2 个 provider、2 个 model，`contextWindow`/`maxTokens`/`inputPerMTok`/`outputPerMTok` 全部读出，`skipped` 为空。

### 4.2 测试先红后绿（TDD 留痕）

新增 `test/multiline-scalar.test.ts`（11 条）。**修复前**（基线 `1ff55a3` + 本测试文件）：

```
$ npx vitest run test/multiline-scalar.test.ts
 Test Files  1 failed (1)
      Tests  7 failed | 3 passed (10)
```

失败样例（节选真实栈）：

```
FAIL … > folds a wrapped value inside a `- key: value` item
YamlLiteError: unexpected indentation (line 2)
 ❯ parseInlineMapping src/adapters/yaml-lite.ts:509:40
FAIL … > tolerates an explicit block-scalar indicator (`|2`, `>-2`)
YamlLiteError: unexpected indentation (line 2)
 ❯ parseMapping src/adapters/yaml-lite.ts:420:37
```

**修复后**：

```
$ npx vitest run test/multiline-scalar.test.ts
 ✓ test/multiline-scalar.test.ts (11 tests) 20ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

11 条覆盖：折行纯量解析/折叠、`config>0` 且价格+窗口可读、`readProfileConfigFiles` 不再跳过、
`/router/models` 的 `sources.config>0`（**判据的直接断言**）、mapping 值折行、`- key: value` 项内折行、
`|`/`>` 块标量不回归、`|2`/`>-2` 指示符、坏缩进仍报错、读不到时说清代价。

### 4.3 真机配置回归（只读，不写）

拿本机真实 profile 做 before/after 对照（只读打开）：

```
$ node -e "…readProfileConfigFiles(['/opt/dsh-home/profiles/web/cordis.patch.yml',
                                   '/opt/dsh-home/profiles/headless/cordis.patch.yml'])"

=== 修复前 ===  filesRead: 1  providers: local-ollama,freellmapi,ark-agentplan,zhenze,momacme,router-gateway  models: 10
                skipped: ["…/headless/cordis.patch.yml: expected \"key: value\" in \"[]\" (line 4)"]
=== 修复后 ===  filesRead: 1  providers: local-ollama,freellmapi,ark-agentplan,zhenze,momacme,router-gateway  models: 10
                skipped: ["…/headless/cordis.patch.yml: no provider list found"]
```

- `profiles/web/cordis.patch.yml`（生产在用的那份）：6 provider / 10 model，**逐项一致**，零回归。
- `profiles/headless/cordis.patch.yml`：内容是裸 `[]`（合法的空数组）。旧代码把它当语法错误，
  新代码正确解析成空数组 ⇒ 变成「这个文件没有 provider 段」。这是**判读更准**，不是放宽：
  该文件本来就不声明任何 provider。（备注：该文件在派工边界内属「只读」，本次零写入。）

### 4.4 全量闸门

```
$ npm test                        # 两个任务合并后（44 文件 / 566 测试）
 Test Files  44 passed (44)
      Tests  566 passed (566)
$ npx tsc -p tsconfig.json --noEmit
 (0 error)
$ npm run build
 client bundle: dist/client/client.js (19460 bytes, wrapped=true)
```

- 基线 `1ff55a3`：42 文件 / 543 测试。
- 本任务单独落地时：43 文件 / **554** 测试（+1 文件 / +11 测试）；任务B（客户端触发）并行加入 12 条后合计 **566**，零失败、零跳过。
- 另：`npm run build` 之后的**真产物** `dist/adapters` 也跑了同一份 732 复现装置，`VERDICT: config>0 ✅`（不是只有源码路径能过）。

> 注：任务B（客户端「生成计划」触发）在同一分支并行开发，**合并后**的全量数字在回执与
> `docs/evidence-20261115/任务B-生成计划触发-证据.md` 中给出；上表是本任务单独落地时的实测。

## 5. 判据逐条

| # | 判据（派工单原文） | 结果 | 证据 |
|---|---|---|---|
| 1 | 先写最小失败样例（含多行纯量的 cordis.patch.yml），证明现在 config=0 | ✅ 过 | §2 + `scripts/repro-yaml-multiline.mjs`：`config(providers)=0`，`skipped` 报 `unexpected indentation (line 732)` |
| 2 | 修在解析器/读取层（多行纯量也能取到值） | ✅ 过 | §3 A1–A6；`test/multiline-scalar.test.ts` 11/11 |
| 2b | 真读不到时给出明确降级与日志，不静默吞成 0 | ✅ 过 | §3 A7：`skipped` 明确写「本次不生效；config=0 只说明没读到，不等于没配置」，并由 `/router/models` 的 `skipped` 字段外露（有测试断言） |
| 3 | 补回归测试，跑通 `npm test` | ✅ 过 | §4.2 红→绿；§4.4 全绿（44 文件 / 566）；真实 profile 零回归（§4.3） |
| 4 | 同一份含多行纯量的 YAML：修复前 config=0，修复后 config>0 且价格/窗口字段可读 | ✅ 过 | §2 A/B：0 → 2 providers/2 models，`contextWindow=1048576`、`maxTokens=65536`、`inputPerMTok=0.28`、`outputPerMTok=0.42` |
| 5 | 测试全绿 | ✅ 过 | §4.4 |

## 6. 未做到 / 边界

1. **没有对侧的原文件**：第 732 行的真实内容是「`- ApiKey` 后换行续写」（对侧文字描述），
   本证据用同形装置（续写行同样落在 732）复现；若对侧真实形状是另一种折行写法（例如
   `- -ApiKey\n    value` 或块标量紧跟注释），本修复覆盖 plain scalar 折行、标量块、`|2` 指示符，
   其余形状需要拿到原文件再补——请对侧复测后把 `/router/models` 的 `skipped` 原文回传。
2. **未在真实 DSH 宿主上装包复测**（派工边界：不装插件、不重启服务）。本任务只用真 profile（只读）
   + 真实读取层 + 真实 `/router/models` 路由处理器验证；真机复测由对侧（灰狼 3080/3081）执行。
3. 折行纯量里的**空行**（YAML 的段落换行）会被 `toLines()` 丢掉，折叠成单空格；对 provider/价格/窗口无影响，
   但这段语义没做到逐字节等价（已在代码注释里写明）。
4. 未改 `src/plugin/endpoints.ts` 的 `sources` 口径（例如「config 与 runtime 合并后来源记账」是既有 P2-7 未修项，不在本单范围）。

## 7. 替小棒/老大做的决定（范围内取舍）

| # | 冲突/含糊点 | 取了什么 | 为什么 |
|---|---|---|---|
| D1 | 「修在解析器/读取层」没说改哪一层 | 主修**解析器**（`yaml-lite.ts`），读取层只改**文案**（`dsh-profile-config.ts`） | 根因在解析器：不修它，任何「读取层容错」都只是把整份文件丢掉换个说法，价格/窗口照样读不到 |
| D2 | 「容错」到什么程度没界定 | 只容错**YAML 合法**的写法（折行纯量、标量块、`\|`/`>` 指示符）；非法的仍整份拒绝并说明代价 | 项目既有约定「坏配置＝暂无模型，永不崩」不能变成「坏配置＝猜」；把非法缩进读成文本会静默编造值 |
| D3 | 「明确降级与日志」没有日志设施 | 用既有 `skipped` 通道（`/router/models` 返回、GUI 可查）承载，并把文案改成带后果的句子；**没有**新加 console/logger | 插件内零 console（既有风格），而 `skipped` 本来就是给运维看的诊断通道；新增日志设施超出本单、且会污染宿主日志 |
| D4 | 是否顺手兼容 `[]` 空文档（headless profile） | 兼容 | 它是合法 YAML；旧代码把它当错误，导致 README/诊断里出现假报错。改动在 `parseBlock` 一个分支内，可逆 |
| D5 | 未给对侧原文件时如何证明 | 造同形装置并让续写行落在 732，同时用本机真实 profile 做零回归对照 | 复现要「行号也对得上」才算证明得了；只跑合成样例无法排除真机回归 |
