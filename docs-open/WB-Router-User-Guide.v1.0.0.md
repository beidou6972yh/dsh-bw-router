# WB驭档·模型智能换挡系统网关 · 使用说明书（零编码基础版）

> **版本**：1.0.3.15（2026-11-27）　**展示名**：WB驭档·模型智能换挡系统网关（英文可用 WB-GearPilot）
> **读者**：不会写代码，但会解压文件、会复制粘贴命令的人
> **一句话**：把「这次该用哪个模型、这一步要花多少钱」变成一次看得见、可确认、可复盘的流程——你点同意，它才花钱。
> **开源状态**：**已于 2026-11-22 开源**；仓库 `https://github.com/beidou6972yh/dsh-bw-router`，许可证 **MIT**（详见 §11.6）。

---

<a id="toc"></a>
## 目录

1. [一、这是什么（3 分钟读懂）](#s1)
2. [二、它能帮你做什么](#s2)
3. [三、安装前准备](#s3)
4. [四、安装（照着做）](#s4)
5. [五、模型配置（四张表）](#s5)
6. [六、开始使用（三种入口）](#s6)
7. [七、花钱与对账](#s7)
8. [八、开关与灰度](#s8)
9. [九、常见问题 FAQ](#s9)
10. [十、安全与备份](#s10)
11. [十一、附录](#s11)
12. [十二、编者自检](#s12)

---

<a id="s1"></a>
## 一、这是什么（3 分钟读懂）

### 1.1 一句话说明

它装在你自己的机器上，坐在你和多个大模型之间。你把任务交给它，它先给你一张**分段计划＋每段估价**；你点同意，它才真去调模型；调完把**真实花了多少**记回账本，让你月底能对上账。

它不是模型、也不卖模型。它管的是**决策和账**：这一段该用哪个模型、这一步大概多少钱、实际花了多少。

### 1.2 它由哪几件组成

| 件 | 是什么 | 你要不要装 |
|---|---|---|
| 网关（核心） | 单进程 Python 服务，对外说标准 OpenAI 接口 | 要，这是主体 |
| 管理面板 | 内网可看：`/admin`、`/admin/live`（运行状态）、`/admin/review`（复盘页） | 随网关自带 |
| DSH 插件（Pro / Max） | 在 DSH 界面里直接用的两个入口 | 只有你在用 DSH 才需要 |
| Skill / MCP | 给 Agent 调用的技能与工具（可选） | 按需 |

技术底子：单进程、Python 3.12、只依赖 `PyYAML` 与 `requests`；默认只绑本机回环 `127.0.0.1:18790`，不对外。

### 1.3 适合谁 / 不适合谁

**适合**：你在用好几个模型（云端＋本地），每次都要纠结「这个活派给谁」；月底只看到一张总账，说不出钱花在哪个环节；想让「花钱」每次都被你看一眼、点个头；会解压、会改 JSON 文本、会复制命令——**不需要会写代码**。

**不适合**：你要的是全自动、不打扰、自己换模型（本项目的设计相反：**要你确认**，节奏可调见 8.4）；你指望它自带模型或额度（它只连你已有的上游）；你想让它替你判断谁「更聪明」（它按你给的规则、窗口、价格、健康度选，不做效果排名）；你在 Windows 或 macOS 原生环境（见 3.1）。

### 1.4 三个先划清的边界

一是**不承诺具体价格**：上游名单与价格表随你自己配置，本书不写任何具体单价。二是**不做效果承诺**：不写准确率、不写省钱比例、不做「谁更强」的比较。三是**开源信息已定**：仓库 `https://github.com/beidou6972yh/dsh-bw-router`、许可证 MIT；开源版面板默认账号见 §11.6。

---

<a id="s2"></a>
## 二、它能帮你做什么

### 2.1 它对准的五个真问题

1. **选模型靠猜**：贵模型处处用、或便宜模型不敢用，没有依据。
2. **钱花在哪说不清**：月底只看到一张总额，不知道哪一段、哪个模型花的。
3. **换模型要改代码/重启**：业务被迫绑死一个模型。
4. **一次超窗或超时，整轮白跑**：上下文超预算、本地装不下、上游超时，错误信息看不懂。
5. **自动化是黑箱**：出事说不清「为什么选了它」「这一步花了多少」。

### 2.2 四步链：像请装修队

| 步 | 网关动作 | 生活里的对应 |
|---|---|---|
| 计划 plan | 把任务切成 2–3 段，每段给模型＋估价，**无副作用** | 装修队先上门量房，给你一张**报价单**：哪个房间派谁、大概多少钱 |
| 确认 confirm | 你点同意；不点，不执行 | 你在报价单上**签字**；没签字，师傅不动手 |
| 执行 execute | 按段调模型（OpenAI 兼容接口，支持流式） | 按房间**分段施工** |
| 回写 annotate | 把真实用量记回计划，返回 `estimate_delta` | 完工按**实际用料结算**，多退少补写在单子上 |

关键点：**计划这一步不花钱**。你可以在报价单上反复看、反复改，点了「确认」才产生实际调用。

### 2.3 它和「自动换模型」的工具差在哪

不比谁更强，只比四件事：**决策单位**（按段 vs 按轮）、**谁按开关**（用户确认 vs 阈值自动）、**钱的口径**（账本实账 vs 配置口径估算）、**复盘**（报告＋只读复算 vs 日志报表）。一句话差异：**别人替你「自动换模型」，我们让你「先看计划、再点同意、花完能对账」。**

---

<a id="s3"></a>
## 三、安装前准备

### 3.1 系统要求（不扩大范围）

| 项 | 要求 | 验证状态 |
|---|---|---|
| 操作系统 | Linux 或容器 | **已验证**（发布方生产部署即在此环境） |
| Windows / macOS 原生安装 | — | **未验证**（待确认，见 11.6） |
| Python | 3.12（依赖仅 `PyYAML`、`requests`） | 已验证 |
| 端口 | 默认 `127.0.0.1:18790`，只绑本机回环 | 已验证 |
| 磁盘 | 账本按请求逐行追加，会随时间增长 | 视你的用量 |

### 3.2 要先准备四样东西

| 准备项 | 具体是什么 | 没有会怎样 |
|---|---|---|
| 上游地址 | 每家上游的 `base_url`（通常以 `/v1` 结尾） | 连不上，`/health` 里该上游报错 |
| 上游密钥 | 每家的 API key（**只放环境变量**） | 该上游 401 或被熔断 |
| 模型清单 | 每家有哪些模型、窗口多大、能否看图、输出上限 | 选到不存在的模型，或超窗被拒 |
| 价格表 | 每百万 token 的输入/输出单价（分峰谷） | 计划显示「0（待用户录入）」，不算钱 |

**最省事的起步方式**：先别改配置，用包里的匿名样例把服务跑起来、把 `/health` 打通，再逐张表替换成你自己的。这样出问题时能分清「是装坏了」还是「是配置错了」。

### 3.3 三个心理准备

- **改配置改坏是常态**：每次改前先复制一份 `.bak-日期`（第十章有命令）。
- **改完要重启**（少数例外见 8.1）；**密钥只走环境变量**，不写进 JSON、不进聊天记录、不进截图。

---

<a id="s4"></a>
## 四、安装（照着做）

> 下文用 `~/wb-router` 当「安装目录」的例子；你放在别处也行，把命令里的路径换成你的即可。

### 4.1 建目录并进入

```bash
mkdir -p ~/wb-router
cd ~/wb-router
```

**你会看到**：无输出，提示符回来，说明目录建好了。**报错 `Permission denied`**：换到家目录下（如 `~/wb-router`）即可。

### 4.2 第 1 步：解包三件

```bash
cd ~/wb-router
tar -xzf gateway-1.0.3.15.tar.gz
tar -xzf plugins-1.0.3.15.tar.gz
tar -xzf skill-mcp-1.0.3.15.tar.gz
ls
```

**你会看到**（三件）：`gateway  plugins  skill-mcp`。其中 `gateway/` 里有 `main.py`、`config/`、`tests/`、`scripts/`、`run-tests.sh`、`VERSION`；`plugins/` 是两份 DSH 插件；`skill-mcp/` 是技能与 MCP。

### 4.3 第 2 步：用样例配置起跑

包里的 `gateway/config/` 已是**匿名样例**：上游叫 `up-a`、`up-b`、`up-c`、`up-d`、`local-lan`，地址是 `.example.com` 占位，不含任何真实凭据与价格。先跑通，再换成你自己的。

如果你手里还有源码树里的 `sample-config/` 两份模板，可以直接抄：

```bash
cd ~/wb-router
cp -a sample-config/routing.json   gateway/config/routing.json
cp -a gateway/upstreams.json gateway/upstreams.json.bak   # 改前先备份；config/upstreams.json 不生效
python3 -m json.tool gateway/config/routing.json > /dev/null   # 无输出＝JSON 合法
```

### 4.4 第 3 步：把凭据放进环境变量

**变量名以 `upstreams.json` 里每家的 `api_key_env` 为准**（样例是 `UPSTREAM_A_API_KEY` 这类名字，不是密钥本身）。真实密钥只在这个环境变量里。

```bash
export UPSTREAM_A_API_KEY='你的真实密钥'
export UPSTREAM_B_API_KEY='你的真实密钥'
export UPSTREAM_C_API_KEY='你的真实密钥'
export UPSTREAM_D_API_KEY='你的真实密钥'
export LOCAL_UPSTREAM_API_KEY='你的真实密钥'
```

只填你真实用到的那几家。想让变量长期生效，把这几行写进 `~/.bashrc`，重开终端生效。

**你会看到**：无输出。确认是否设好：`echo ${UPSTREAM_A_API_KEY:+已设置}` → 输出「已设置」。**别**用 `echo $UPSTREAM_A_API_KEY`（会把密钥打到屏幕上）。

### 4.5 第 4 步：装两个 Python 依赖

```bash
python3 -m pip install PyYAML requests
```

**你会看到**：最后一行类似 `Successfully installed ... PyYAML ... requests`。**报错 `No module named pip`**：先 `python3 -m ensurepip`，或用系统包管理器装 `python3-pip`。

### 4.6 第 5 步：启动

```bash
cd ~/wb-router/gateway
python3 main.py
```

**你会看到**：① 先打印一行凭据加载信息，形如 `凭据已加载：N 个 ref（仅内存）`；② 然后**停在前台不返回提示符**——这就是在跑了；③ 另开一个终端执行 `ss -ltn | grep 18790`，能看到一行 `LISTEN`。

停止：在这个窗口按 `Ctrl+C`。**长期运行**建议交给进程管理器(按你的部署环境选择，服务名自定义)；具体写法随环境不同，本书不展开。

### 4.7 第 6 步：自检 `/health`

```bash
curl -s http://127.0.0.1:18790/health | python3 -m json.tool | head -20
```

**你会看到**大致这样的结构（内容随你的配置变）：

```json
{
    "ok": true,
    "uptime": 12.3,
    "upstreams": [
        {"id": "up-a", "state": "ok", "circuit": {"open": false, "remaining_s": 0}, "last_error": null}
    ]
}
```

**判据（三条同时满足才算装好）**：① `"ok": true`；② 你配置的每个上游 `state` 都是 `ok`；③ `curl -s http://127.0.0.1:18790/v1/models | head -c 300` 能看到 `auto`、`auto-fast`、`auto-strong` 三个虚拟模型名。

> 发布方自己的生产部署上还能看到价格自证区块与上游状态（**上游家数与价格自证一律以你部署的 `/health` 为准**）——这是**发布方部署的口径**，你自建后数量按你自己的配置算，判据仍是上面三条。

### 4.8 安装期常见报错一张表

| 报错 / 现象 | 原因 | 怎么办 |
|---|---|---|
| `tar: Cannot open` / `does not look like a tar archive` | 包没放对位置、文件名不同、传输被截断 | `ls` 看清文件名；重新取包并核对校验值 |
| `缺少配置文件：.../config/routing.json` | 配置没放进 `config/` | 回到 4.3 用 `cp` 放进去 |
| `配置文件 JSON 语法错误` | 编辑时多/少逗号，或用了中文引号 | `python3 -m json.tool <文件>` 定位；先还原 `.bak` 再改 |
| `ModuleNotFoundError: No module named 'yaml'` | 依赖没装 | 回到 4.5 |
| `OSError: [Errno 98] Address already in use` | 18790 已被占用 | `ss -ltn \| grep 18790` 查占用并停旧实例；排查时可 `ROUTER_PORT=18791 python3 main.py` 起隔离实例 |
| `凭据已加载：0 个 ref`／提示某上游缺密钥 | 环境变量名与 `api_key_env` 不一致，或启动前没 export | 名字逐字比对（区分大小写）；设好后**重启** |

### 4.9 装完的验收清单

| 检查 | 命令 | 通过的样子 |
|---|---|---|
| 服务在听 / 健康 | `ss -ltn \| grep 18790`；`curl -s http://127.0.0.1:18790/health` | 有 `LISTEN`；`ok: true`，上游全 `ok` |
| 模型清单 | `curl -s http://127.0.0.1:18790/v1/models` | 有虚拟模型名 |
| 真调一次（会花钱） | `python3 scripts/smoke.py` | 打印 HTTP 码/耗时/返回模型，官方那家成功 |
| 价格自证（填价后） | `python3 scripts/price-attest.py` | 退出码 0，覆盖里 `unsourced` 为 0 |
| 回归（可选，几分钟） | `bash run-tests.sh --clean` | 两段都 `OK`、无失败、退出码 0 |

> 回归数字：发布方出厂验证是**两段各 596 个用例全绿、exit 0**。你自己跑时判据是「**两段一致 ＋ 全绿**」，不必盯固定数字——用例数会随配置展开而变。

---

<a id="s5"></a>
## 五、模型配置（四张表）

### 5.1 总览

| 文件 | 管什么 | 必须改 | 改错会怎样 |
|---|---|---|---|
| `upstreams.json`（网关根目录，非 config/） | 有哪些上游、怎么连、每个模型的窗口与能力 | 上游 `id`、`base_url`、`api_key_env`、模型清单 | 连不上、401、超窗误判、模型选不到 |
| `config/routing.json` | 怎么选：虚拟模型、候选链、时段、熔断、超时、上下文治理 | `routes`／`strategies` 里的「上游/模型」键、`peak`、`timeouts`、`context_governor` | 选到不存在的模型（启动告警剔除）、候选全灭回 502 |
| `config/pricebook.json` | 每个模型多少钱（**价格只以这一份为准**） | 每个模型的输入/输出单价（分峰谷） | 计划显示「0（待用户录入）」，不算钱、对不了账 |
| `config/api-keys.json` | 谁能用、用哪些接口、每分钟多少次 | `required`、每把 key 的 `scopes` 与 `rpm` | 401；或能看计划但执行被拒（缺 scope） |

> 包内**不含** `pricebook.json` 与 `api-keys.json`（属于你自己的数据）：前者要你生成或手填，后者可由管理面板创建。

### 5.2 `upstreams.json`：有哪些上游

```jsonc
{
  "id": "up-a",                                   // 上游短名
  "base_url": "https://upstream-a.example.com/v1", // 换成真实地址，通常以 /v1 结尾
  "api_key_env": "UPSTREAM_A_API_KEY",             // 密钥的「环境变量名」，不是密钥值
  "max_rpm": 50,                                   // 这家每分钟最多发多少请求
  "models": {
    "model-fast-0731": {                           // 模型名必须与上游实际模型名一致
      "context_window": 800000,                    // 上下文窗口（token）
      "max_tokens": 65536, "vision": false, "tier": "cheap"  // 输出上限 / 能否看图 / 档位
    }
  },
  "label": "上游 up-a（示例，请替换）"
}
```

**必须改四处**：`id`、`base_url`、`api_key_env`、`models` 里的模型名与元数据。

**改错会怎样**：`base_url` 错 → 这家请求必失败；`api_key_env` 名不一致 → 等于没有密钥；`vision` 标错（实际不能看图却写 `true`）→ 带图请求被上游拒；`context_window` 写小 → 本来能跑的长输入被判超窗。

**改完怎么验证**：`curl -s http://127.0.0.1:18790/health | python3 -m json.tool | head -20` 看这家 `state` 是否 `ok`；`/v1/models` 看模型名在不在。**改完必须重启**。

### 5.3 `routing.json`：怎么选

这张表大，但你要动的只有几处：

| 位置 | 管什么 | 你必须做的 |
|---|---|---|
| `virtual_models` | 对外暴露的虚拟模型：`auto`（平衡）、`auto-fast`（便宜优先）、`auto-strong`（能力优先） | 一般不用改 |
| `routes` | 按「时段 × 复杂度」排候选链：`peak`/`offpeak` × `L1`/`L2`/`L3`/`image` | **把 `up-x/model-y` 换成你真实的「上游/模型」** |
| `strategies` | `fast`、`strong` 两条策略各自的候选链 | 同上，一起改 |
| `complexity` | 什么算简单（L1）、什么算复杂（L3） | 按模型能力调，保守就先用默认 |
| `peak` | 什么时段算高峰（默认工作日 `09:00–12:00`、`14:00–18:00`） | 按你上游的计价时段调 |
| `breaker` | 熔断窗口（默认失败类 600 秒、鉴权类 3600 秒） | 一般不用改 |
| `timeouts` | 超时（默认读 270 秒、流式 600 秒） | 经常超时就调大（重启生效） |
| `context_governor` | 上下文治理：模式、预算比例、超窗说法、裁剪、413 | 先保持 `shadow` 观察（见第八章） |
| `hint` | 插件给网关的「档位提示」通道，默认 `record`（只记录不执行） | 一般不用改 |

**一条硬规则**：`routes`、`strategies`、`capability_meta`、`hint.tiers` 里出现的每个 `"上游/模型"`，都必须在 `upstreams.json` 里真实存在。写错会被启动时自动剔除并打告警；整条链被剔干净，请求就走到「全候选失败」→ 502。

**改错会怎样**：候选链全写错 → 每次 502；时段写反 → 高峰用了便宜档；超时写太小 → 长任务被自己掐断。

**改完怎么验证**：重启 → 打 `/v1/route/capabilities`（档位与模型能力清单，确认模型都在）→ 打一次真实小请求，看响应头 `X-Router-Decision` 选的模型是否如你所愿。

> 复杂度分级：输入短、无图、无工具、输出要求不高 → L1；输入很长、含图、或输出要求很高 → L3；其余 L2。阈值就在 `complexity` 里。

### 5.4 `pricebook.json`：每个模型多少钱

这是**价格的单一真源**：估价、实付、对账都以它为准。包里没有这份文件，要你自己做。

**路线 A（推荐，省事）**：用自带脚本抓公开价目表生成。

```bash
cd ~/wb-router/gateway
python3 scripts/price_sync.py --dry-run                     # 先看抓到的价，不写文件
python3 scripts/price_sync.py --out config/pricebook.json    # 满意了再落盘
```

**路线 B**：照样例结构手填。关键是每个模型的 `price.input` / `price.output`，单位是「元 / 百万 token」，分 `peak` / `offpeak`；`cache_hit` 是命中缓存的输入价。

```jsonc
{
  "models": {
    "某个模型名": {
      "offers": [{
        "provider": "你的上游 id", "model_id": "上游那边的模型名",
        "price": {
          "input":     {"peak": 2.0,  "offpeak": 1.0},
          "cache_hit": {"peak": 0.04, "offpeak": 0.02},
          "output":    {"peak": 8.0,  "offpeak": 4.0}
        }
      }]
    }
  }
}
```

> 上面数字只是**结构示意**，不是任何厂商的真实报价。真实价格按你自己的价目表填。

**没填价会怎样**：不是「免费」，而是标成**未定价**——计划里这段的 `price_state` 是 `unpriced`，价格标签显示「0（待用户录入）」，未定价模型会被列进 `totals.unpriced_models` 并提示「未知部分按 0 计（不代表免费）」。本地模型则显示「0（本地）」。

**改完怎么验证（两条一起看）**：

```bash
curl -s http://127.0.0.1:18790/health | python3 -c "import sys,json;print(json.load(sys.stdin).get('price_consistency'))"
python3 scripts/price-attest.py
```

看到 `status` 为 `consistent`、`unsourced` 为 0、`drift` 为 0 就算过。本版**不对固定数字作承诺**——发布方部署在 2026-11-27 实测仍有新接入/本地自建候选未登记单价来源，故判据一律以你部署的 `/health.price_consistency` 为准；你自建后按你填了多少模型算。

### 5.5 `api-keys.json`：谁能用

这份文件管**给别人用的钥匙**（网关自己的 Bearer key），跟上游密钥是两套，别混。

| 字段 | 含义 |
|---|---|
| `required` | 是否强制验钥匙。为 `true` 时所有 `/v1/*` 都要带 `Authorization: Bearer <key>` |
| `keys[].id` / `name` | 编号与备注名（给自己认人用） |
| `keys[].prefix` / `salt` / `hash` / `iterations` | 前缀与哈希存储（**不要手改**，改了这把钥匙就废） |
| `keys[].scopes` | 权限范围：`plan`（计划/回写）、`chat`（对话/补全/向量/重排） |
| `keys[].rpm` | 这把钥匙自己的每分钟请求上限 |
| `keys[].revoked_at` | 吊销时间；不为 null 即已失效 |

**正确用法**：不要手写，用管理面创建——在网关那台机器打开 `http://127.0.0.1:18790/admin`，在 API keys 卡片里新建，选 `scopes`、填 `rpm`，保存。**明文 key 只显示一次**，当场抄进密码管理器。

**这份文件不存在时**：网关会建一份空的（`required=false`），即**默认不验钥匙**，靠「只绑 127.0.0.1」这道网络边界。你自己在本机用，这样最省事；一旦要给别的机器或别人用，就创建钥匙并把 `required` 打开。

**改错会怎样**：只给 `plan` 不给 `chat` → 能出计划但对话被拒；`rpm` 太小 → 正常用也会 429；手改哈希 → 这把钥匙直接 401。

### 5.6 改完统一这样验证（四步）

1. **重启**网关（配置启动时读一次）；
2. `curl -s http://127.0.0.1:18790/health` → `ok: true`、上游全 `ok`；
3. 打一次小请求，看响应头 `X-Router-Decision`（实际选中的上游/模型）与 `X-Router-Reason`（一句话理由）；
4. 看账本在不在长：`ls -l ~/wb-router/gateway/数据/ledger.jsonl`。

### 5.7 三条配置纪律

1. **改前先备份**：`cp -a config/routing.json "config/routing.json.bak-$(date -Iseconds)"`。
2. **一次只改一处**：改完立刻验证，出问题好定位。
3. **不要整份覆盖**：升级时别用新包的 `routing.json` 整体盖掉你调好的那份，要合并。

---

<a id="s6"></a>
## 六、开始使用（三种入口）

### 6.1 先选路径

| 入口 | 适合谁 | 你要做什么 | 花费进网关账本吗 |
|---|---|---|---|
| DSH Max 插件 | 已在用 DSH，希望计划、确认、账本都走网关 | 装插件 → 选网关模型 → 计划卡点确认 | **进** |
| DSH Pro 插件 | 已在用 DSH，只想本机自动分段、不接网关 | 装插件 → 勾路由模式 → 生成计划 | 不进（计划在本机生成） |
| 任意 OpenAI 客户端直连 | 用任何支持 OpenAI 接口的软件/脚本 | 填三个值：地址、钥匙、模型名 | **进** |

**最省事的一条**：先在**本机**用直连打通（6.2），确认 `/health` 与一次对话都正常，再去接插件或别的机器。

### 6.2 最省事：本机直连（无钥匙模式）

网关默认只绑 `127.0.0.1`、默认不验钥匙，你自己在本机可以直接开始：

```bash
curl -sS http://127.0.0.1:18790/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"用一句话说明今天天气"}],"max_tokens":64}'
```

**你会看到**：一段标准 OpenAI 格式 JSON（含 `choices`、`usage` 里的 token 数），响应头带 `X-Router-Decision`，形如 `up-a/model-fast-0731`。

**判据**：有 `choices` 且 `usage.total_tokens` 大于 0 → 通了。想流式：加 `"stream":true` 并用 `curl -N`，结束会收到一行 `data: [DONE]`。

### 6.3 DSH 里点开就用（两种插件）

**装插件**：解包 `plugins-1.0.3.15.tar.gz`，得到 `dsh-wb-pro-0.2.5` 与 `dsh-wb-max-0.2.5` 两个目录。把它们覆盖到你的 DSH 插件目录（对应宿主版本的那份），刷新页面；涉及宿主侧文件的改动需重启一次 DSH。

> 插件公开下载：GitHub Release `v1.0.3.15` 资产 `plugins-1.0.3.15.tar.gz`（https://github.com/beidou6972yh/dsh-bw-router/releases/tag/v1.0.3.15 ）。

**用起来（Max，走网关）**：① 在 DSH 模型选择里选网关模型（`auto` / `auto-fast` / `auto-strong`）；② 输入区点「生成计划」；③ 计划卡出现在输入区上方，每段写着用哪个模型、大概多少钱；④ 点「确认开工」，会话切到第 1 段模型；⑤ 状态栏显示 `[路由] 第 n/N 段 · 当前模型 · 已花 … · 下一段：…`，按提示逐段推进；开工前可在计划卡上给某段换模型。

**关键设计**：**不点确认，不执行、不花钱。**

**用起来（Pro，本机规划）**：勾「路由模式」→ 点「生成计划」→ 计划卡 → 确认开工。Pro 的计划在你本机生成、不经过网关，所以**它的花费不进网关账本**；要让每笔都能对账，用 Max 或直连。

### 6.4 给别的机器或程序用：先签发钥匙

1. 在网关那台机器打开 `http://127.0.0.1:18790/admin`（管理面只在内网，不要暴露到外网）；
2. 找到 API keys 卡片，新建一把：备注名写清给谁用，`scopes` 勾上 `plan` 和 `chat`，`rpm` 按对方用量设；
3. 保存后显示一次明文 key（形如 `wb_...`）——**只显示这一次**，立刻抄走；
4. 把 key 交给对方，按 6.7 填。

> 管理面首次登录的账号密码：源码默认为 `admin/admin`（**首次登录后请立刻改口令**）；管理面只绑 `127.0.0.1`，不要对公网开放。

### 6.5 换模型不丢上下文

**一句话**：同一段对话里换模型，不用重开会话、不用重说一遍——历史消息照常带上，网关只替换「这一段由谁来答」。

**为什么不会把任务带偏**（1.0.3.6 的 B1 边界纪律，默认开）：B1 会在计划每段带一段只读的「什么时候该换」说明（`boundary_policy`），其约定是——

- **工具调用进行到一半不换**：同一轮的连续工具调用里模型被冻住（规则名 `same_turn_model_frozen`），避免前半段一个模型、后半段另一个模型各说各话；
- **只在两个时机换**：新的一条用户消息（`new_user_message`）或上下文重建处（`context_rebuild`）；
- **换完先复述再动手**：新接手的模型先复述「目标／已完成／下一步／不做什么」，把对表补齐再继续；
- 网关因治理、守门或上游降级被动换模时，会记一笔豁免（`context_governor`／`guard`／`fallback`），不算违规——判据看非豁免计数（`GET /v1/route/discipline?range=7d`）。

要说明的是：B1 **只记不拦**（违规落账本 `discipline_violation`，不给请求报错），所以「换得对」最终靠上面这套节奏约定。

**你能看到、能做的**：

| 在哪 | 能看到 / 能做什么 |
|---|---|
| 计划卡 | 开工前直接给某一段换模型（最稳） |
| 状态栏 | `[路由] 第 n/N 段 · 当前模型 · 已花 … · 下一段：…` |
| 账本 | 同一会话里出现不同模型的行——说明是「同一会话，只换了模型」 |

### 6.6 直连 API：先计划，再执行，再回写

以下三个命令只用本书附录列出的端点，可直接复制（把 `$WB_KEY` 换成你的钥匙；本机无钥匙模式可去掉 Authorization 头）。

**第 1 步：要一份计划（不花钱）**

```bash
export WB_BASE=http://127.0.0.1:18790
export WB_KEY='wb_你的钥匙'

curl -s -X POST "$WB_BASE/v1/route/plan" \
  -H "Authorization: Bearer $WB_KEY" -H 'Content-Type: application/json' \
  -d '{"task":"把三项数据汇总成一句话","strategy":"auto","max_stages":2}'
```

**你会看到**：`plan_id`（形如 `plan-…`）、`stages`（每段有 `stage_id`、`model.key`、`estimate`）、`totals`（含 `unpriced_models`）、`pricing.policy`、`estimate_basis`。记下 `plan_id` 与第 1 段的 `stage_id`、`model.key`。

**第 2 步：确认后执行这一段（这一步才花钱）**

```bash
curl -s -X POST "$WB_BASE/v1/chat/completions" \
  -H "Authorization: Bearer $WB_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"up-a/model-fast-0731","messages":[{"role":"user","content":"把三项数据汇总成一句话"}]}'
```

`model` 填计划里那段的 `model.key`。

**第 3 步：把真实用量回写（对账靠它）**

```bash
curl -s -X POST "$WB_BASE/v1/route/annotation" \
  -H "Authorization: Bearer $WB_KEY" -H 'Content-Type: application/json' \
  -d '{"plan_id":"plan-你的编号","stage_id":"s1","model_key":"up-a/model-fast-0731","confirmed":true,"outcome":"ok","usage":{"prompt_tokens":12,"completion_tokens":35}}'
```

**你会看到**：`recorded: true`，以及 `estimate_delta`（预估 vs 实付的 token 差与金额差）。不带 `usage` 就只有一条「已确认」，没有差额。

> 三个必填：`plan_id`、`stage_id`、`model_key`；`confirmed` 必须是 `true`/`false`（布尔值）；`outcome` 只能是 `ok` / `fallback` / `failed`。
> 计划状态只在前台内存里留一段时间（约 24 小时，重启即清）；过期后回写会报「计划不存在或已过期」，重新生成一份即可。

### 6.7 填进任意 OpenAI 客户端

| 客户端里的字段 | 填什么 |
|---|---|
| Base URL / 接口地址 | `http://127.0.0.1:18790/v1`（要完整路径就填 `.../v1/chat/completions`） |
| API Key | 你签发的 `wb_...`（本机无钥匙模式可留空） |
| Model | `auto`（让网关选）、`auto-fast`（便宜优先）、`auto-strong`（能力优先），或直接写 `上游/模型` |

**首次成功的三个标志**：客户端能正常回话；网关账本多了一行；响应头里有 `X-Router-Decision`。三种入口怎么选：只想本机少折腾 → 直连；已在用 DSH 且要「点确认才花钱」＋统一账本 → Max；只要本机分段计划、不接网关 → Pro（花费不进网关账本）。

---

<a id="s7"></a>
## 七、花钱与对账

### 7.1 钱是怎么算出来的

一句话：**token 用量 × 单价**。单价来自 `pricebook.json`；用量以响应里的 `usage` 为准；单价分高峰/低峰。它不替你猜价：没填单价的模型显示「0（待用户录入）·未定价（不当作免费）」，本地模型显示「0（本地）」。

### 7.2 plan 的估价怎么读

| 字段 | 怎么读 |
|---|---|
| `stages[].model.key` | 这段打算用的「上游/模型」——执行时就把它填进 `model` |
| `stages[].estimate.input_tokens` / `output_tokens` | 这段的输入/输出 token 估算 |
| `stages[].estimate.price_state` | `priced`（有单价）/ `local`（本地 0）/ `unpriced`（未定价） |
| `stages[].estimate.price_label` | 给人看的标签：`按已填单价` / `0（本地）` / `0（待用户录入）` |
| `totals.unpriced_models` | 哪些模型没价——**出现它就要当心，不代表免费** |
| `pricing.policy` | 三种状态的官方说法 |
| `estimate_basis` | 估价口径：**不含 system prompt、不含历史消息**，是上限近似不是承诺 |
| `estimate_confidence` | `low`（有未定价模型）或 `medium` |
| `automation`（传了档位才有） | 当前确认节奏（见 8.4） |

**读法**：先看 `totals.unpriced_models` 是否为空，再逐段看 `model.key` 与估价。不满意就换段模型（插件里换，或改计划再执行），**这一切都不花钱**。

### 7.3 你确认之后发生什么

只有你点确认（`confirmed: true`）或自己发起对话，才有真实调用与花费；每次真实调用在账本落一行（模型、耗时、token 用量、状态）；回写把真实 `usage` 记回计划并算出差额。

### 7.4 `estimate_delta` 怎么读

| 字段 | 含义 |
|---|---|
| `planned_input_tokens` / `planned_output_tokens` | 计划里的估算 |
| `actual_input_tokens` / `actual_output_tokens` | 实际用量 |
| `input_tokens_delta` / `output_tokens_delta` | 差值；**正数＝实付比预估多** |
| `input_ratio` / `output_ratio` | 实际/预估的倍数 |
| `actual_cost` / `planned_cost` / `cost_delta` | 金额差（元，6 位小数，小钱也看得见） |
| `basis` | 口径提醒：估价不含 system prompt/历史消息 |

**为什么会对不上**：估算是按字符数粗估、且不含系统提示与历史消息，真实调用会把它们算进去——「实付 > 预估」是常见现象，不是出错。

### 7.5 `/v1/route/report`：预估 vs 实付

主对账表：把计划里的预估与账本里的实账放一起比，可按时间范围与分组看。

```bash
curl -s "http://127.0.0.1:18790/v1/route/report?range=7d&group=model" \
  -H "Authorization: Bearer $WB_KEY"
```

**你会看到**：两套汇总——一套来自回写（计划侧），一套来自账本（实账侧），以及 `notes` 提示。只读到账本尾部一段数据时会标 `partial`（不完整，别当全量）。**怎么看**：同一模型/同一组差得离谱 → 先查价格表（单价填错或没填），再查是否长期用最大窗口的模型跑小任务。

### 7.6 `/v1/route/replay`：只读复算

用当前配置把同一份计划重算一遍「如果现在跑，会怎么选、大概多少钱」，**不执行、不写账**。

```bash
curl -s -X POST "http://127.0.0.1:18790/v1/route/replay" \
  -H "Authorization: Bearer $WB_KEY" -H 'Content-Type: application/json' \
  -d '{"plan_id":"plan-你的编号"}'
```

**你会看到**：`mode: "read_only"`，以及每段「原来选了什么、现在会选什么、有没有变、差额多少」。**用途**：改完配置或价格表先复算再决定是否真跑；也用于事后追查「当时为什么选它」。**限制**：计划状态在内存里（约 24 小时，重启即清），过期后复算会提示计划不存在，重新生成即可。

### 7.7 `/admin` 系列三个页面看什么

- **`/admin`（管理页）**：上游健康与熔断；**上游余额／套餐快照**（快照太久没更新会提示）；**API Key**（新建／吊销／轮换，设 `scopes` 与 `rpm`）；**路由策略与价目**；**插件状态**；**自动学习开关**（`learnedOverrides` 的查看）。三个页面里只有它能改东西，改完按页面提示区分「热读」与「需重启」。
- **`/admin/live`（运行状态，只读）**：这一屏的价值不是给你一堆数字，而是让你**一眼看懂四件事**——
   1. **整个任务的路由策略**：任务怎么切成「轻判断／主力执行／关键决策」三层，每层承担什么活、各占多少量（分工泳道）；
   2. **每次请求的选模策略与方式**：每次请求的候选链有哪些、最后选中哪个模型、什么时候升档、什么时候降级（失败／超时／上下文不够）（实时请求流）；
   3. **不同任务分别调用哪些模型**：按模型看的承接量、成功率、P50/P95、Token 与花费（模型分工矩阵）；
   4. **运行情况怎么样**：请求数、成功率、P50/P95、输入/输出 Token、成本、本地与云端占比、上游健康与熔断，以及上下文治理的 band 分布（`pass`／`compress`／`reject`）。
- **`/admin/review`（复盘页，只读）**：按时间段对账复盘，适合每周或每月固定看一次；和 `/v1/route/report` 的「预估 vs 实付」对照着看。

**访问前提**：三个页面都只绑本机回环、只在内网，且需要登录；对外只放行 `/health` 与 `/v1/*`，所以从外网打管理面一定 404（见 FAQ 9.17）。

### 7.8 一周一次的对账习惯与排查顺序

对账五步：① 看 `/admin/live` 上游是否全绿、有没有长时间熔断；② 拉一次 `/v1/route/report?range=7d&group=model` 并把「预估 vs 实账」存档；③ 看有没有 `unpriced_models`，有就补价格表；④ 看有没有一直用最贵档跑小活的组（那是调候选链的信号）；⑤ 有疑问的某份计划，用 `replay` 复算一次。

对不上先查四个：价格表有没有这个模型（`unpriced`）／峰谷时段对不对（`peak` 设错则单价全错）／回写有没有真的带 `usage`／报告是不是 `partial`。

---

<a id="s8"></a>
## 八、开关与灰度

设计原则：**先只观察，稳定后逐级开启；每次只动一个开关，并记下改动时间与回滚点。**

### 8.1 出厂默认一览

| 能力 | 开关 | 默认 | 改完要重启吗 |
|---|---|---|---|
| B1 边界纪律 | `ROUTER_B1_DISCIPLINE` | 开（1） | 要 |
| B2 报告与回放 | 无独立开关 | 开 | — |
| B3 自动化档位 | `ROUTER_B3_AUTOMATION` | 开（1，不传档位＝现状） | 要 |
| B4 影子判定 | `config/shadow_judge.json → enabled` 或 `ROUTER_B4_SHADOW=1` | **关** | **不用**（热加载） |
| B5 只读直通 | `ROUTER_B5_PASSTHROUGH=1` ＋ key 的 `passthrough:true` | **关** | 要 |
| 上下文治理 | `context_governor.mode` 或 `ROUTER_CTX_GOVERNOR` | `shadow` | 要 |
| 阶梯裁剪 trim | `context_governor.trim.enabled` | **关** | 要 |
| 413 出口 | `context_governor.error.allow_413` | **关**（默认回 400） | 要 |
| 单源价格自证 | `ROUTER_PRICE_ATTEST` | 开（1） | 要 |
| 超时收回 | `timeouts.read_seconds` / `stream_seconds` | 读 270 秒 / 流式 600 秒 | 要 |

### 8.2 建议的开启节奏

1. **第 1 天**：全部保持默认（shadow/关档），只观察 `/health`、`/v1/route/report`、`/v1/route/discipline`、`/v1/route/shadow`；确认错误率与响应时间和升级前一个样。
2. **第 2–3 天**：只把 `context_governor` 从 `shadow` 切到 `enforce`（trim 仍关），盯 `ctx_gov.band=reject` 的比例与 400 次数；比例异常就先切回 shadow 再分析。
3. **稳定后**：按需逐个开 trim / 413 / B4 / B5，一次只动一个；**任何异常先关开关**（不必卸载），再查 `/v1/route/report` 与账本 `ctx_gov`——回滚不删数据。

### 8.3 上下文治理 `context_governor`（默认 shadow）

**是什么**：给每次请求算一个输入预算：**预算 ＝ 模型窗口 − max(1024, ⌈0.2×窗口⌉)**；超了按模式处理。中文按更保守口径估，图片按固定成本粗估。
**三档模式**：`off`（不管）／`shadow`（只观测、不改行为，**默认**）／`enforce`（真正按预算拒收或处理）。
**超窗会怎样**：`enforce` 下回结构化 **400 `context_window_exceeded`**，并带头 `X-DSH-Context-Window`/`-Budget`/`-Used`/`-Used-Kind`。
**怎么切**：改 `context_governor.mode`（或 `ROUTER_CTX_GOVERNOR`）→ 重启。**看什么**：账本 `ctx_gov.band`（`pass`/`compress`/`reject`）分布、响应头 `X-DSH-Context-*`、400 次数。**回滚**：改回 `shadow` 或 `off`。

### 8.4 其余开关：怎么开、看什么、怎么回滚

| 能力 | 怎么开 | 看什么 | 回滚 |
|---|---|---|---|
| B1 边界纪律（默认开） | 默认开；关＝`ROUTER_B1_DISCIPLINE=0` 并重启 | `GET /v1/route/discipline?range=7d` 的 `non_exempt_violations`（非豁免计数才算判据） | 设回 1 并重启 |
| B3 自动化档位（默认 L1） | 请求体/头带 `automation_level` 取 `L1`/`L2`/`L3`；**只改确认节奏、不改选模** | 计划返回的 `automation` 块；L2/L3 下确认次数减少 | 不传档位即回 L1 |
| B4 影子判定（默认关） | `config/shadow_judge.json → enabled=true`（**热加载**）或 `ROUTER_B4_SHADOW=1` | `/v1/route/shadow?range=7d` 的 `calls`/`ok`/`bad_output`/`latency`；`/health.shadow` | `enabled=false` |
| B5 只读直通（默认关） | **两道都开**：`ROUTER_B5_PASSTHROUGH=1`（或 `ROUTER_B5_PASSTHROUGH_KEYS` 指定 key）＋ 管理面给这把 key 勾权限；请求头 `X-WB-Route-Mode: passthrough` | 响应头 `X-WB-Model`/`X-WB-Strategy`/`X-WB-Usage-Kind`；账本 `passthrough=true` 行 | 关环境变量或撤 key 权限 |
| 阶梯裁剪 trim（默认关） | `context_governor.trim.enabled=true`（**只在 `enforce` 下生效**） | 账本 `attempts` 的 `trimmed`/`ctx_trim_retry`、响应头 `X-DSH-Trimmed` | 置回 `false` 并重启 |
| 413 出口（默认关） | `context_governor.error.allow_413=true`；默认同类超限回 400 | 状态码分布里是否出现 413 | 置回 `false` 并重启（除非客户端明确区分 413，否则别开） |
| 价格自证（默认开） | 默认开（`ROUTER_PRICE_ATTEST=1`） | `/health.price_consistency` 的 `status`/`unsourced`/`drift`（以你部署实测为准） | 设 `0` 并重启 |
| 超时收回（读 270 秒 / 流式 600 秒） | 改 `timeouts.read_seconds` / `stream_seconds` 后重启 | 账本 `attempts[].ms` 的高分位（p99）；长任务总在同一时长附近断就是它 | 改回旧值并重启 |

### 8.5 一次只动一个（记录模板）

| 日期时间 | 改了哪个开关 | 改前 | 改后 | 观察多久 | 结论 | 回滚点 |
|---|---|---|---|---|---|---|
| 例：11-21 20:00 | `context_governor.mode` | shadow | enforce | 3 天 | 待观察 | 改回 shadow |

---

<a id="s9"></a>
## 九、常见问题 FAQ

> 每条按「现象 → 原因 → 怎么办」。改配置的，改完都**要重启**（8.1 里标了热加载的除外）。

**9.1 返回 401，说没授权**
**现象**：所有 `/v1/*` 都 401，`type` 是 `authentication_error`、`code` 是 `unauthorized`，响应头带 `WWW-Authenticate`。
**原因**：没带 `Authorization` 头；写成「非 Bearer」形式；key 拼错或带多余空格；key 已被吊销；或 `required` 已打开但手上还是旧 key。
**怎么办**：头写成 `Authorization: Bearer wb_...`（`Bearer` 大小写不敏感，key 本身别加引号）；到管理面看这把 key 的 `revoked_at`；换 key 后**重启客户端**（不少客户端启动只读一次 key）。

**9.2 返回 429，说太频繁**
**现象**：429，`type` 是 `rate_limit_error`、`code` 是 `rate_limit_exceeded`，带 `Retry-After` 头与 `retry_after` 秒数。
**原因**：这把 key 每分钟请求数超过它自己的 `rpm`；或这个 token 连续鉴权失败被临时限流。
**怎么办**：按 `retry_after` 等；把并发降下来；确实不够就在管理面提高这把 key 的 `rpm`（保存即生效）；若是鉴权失败引起，先按 9.1 修好。

**9.3 返回 400 `context_window_exceeded`**
**现象**：400，`code` 是 `context_window_exceeded`，响应头有 `X-DSH-Context-Window`/`-Budget`/`-Used`/`-Used-Kind`。
**原因**：输入加上要预留的输出超过所选模型窗口（`context_governor` 处于 `enforce` 时被结构性拒收）。
**怎么办**：精简上下文（去掉长历史、长工具输出）；换窗口更大的模型（`auto-strong` 或指定大窗口模型）；看 `-Used-Kind` 判断估算口径。只想观察可把 `context_governor` 切回 `shadow`（重启生效），但那是放松治理，别长期放。

**9.4 返回 413**
**现象**：413，`code` 是 `payload_too_large`。
**原因**：**只有**把 `context_governor.error.allow_413` 设成 `true` 才会出现；默认同类超限回 400。
**怎么办**：默认不用管，按 9.3 处理；若你开了 413 又不想要，置回 `false` 重启。

**9.5 返回 503 `local_unavailable`**
**现象**：503，错误体里 `type` 是 `local_unavailable`（不是一句干巴巴的 503）。
**原因**：本地候选（私有地址或显式标 `local` 的上游）回了 503/507，或回了带显存关键词的 500，网关统一转成结构化错误；同一台宿主还会进短冷却（默认 60 秒），期间不再重试。
**怎么办**：改走云端候选——候选阶梯里要有云端同档，且调用方要带 `X-Route-Allow-Cloud: 1`（**默认不自动转云**）；或等本地模型卸载/加载完；要等卸载可带 `X-Route-Wait-Local=<秒>`（上限 20 秒，只重试一次）。

**9.6 返回 503 `local_vram_insufficient`**
**现象**：503，`code` 是 `local_vram_insufficient`，带 `need_mib`/`free_mib`，且 `retryable: false`。
**原因**：模型装不下显存——这个错误重试没用。
**怎么办**：换更小的本地模型或走云端；**不要反复重试同一台宿主**（只会把等待时间叠加）；判断依据看 `need_mib` 与 `free_mib` 的差。

**9.7 返回 502 上游错误**
**现象**：502，`type` 是 `upstream_error`，响应体里带每一步的 `上游/模型=状态` 摘要（或每个候选被跳过的 `skip:` 原因）。
**原因**：候选链全部失败（上游 5xx、超时、鉴权失败），或全部候选被熔断/RPM 跳过。
**怎么办**：先看 `/health` 各上游 `state`；再读摘要，判断是「上游坏了」「我们的 key/额度有问题」还是 `max_rpm` 太小；修完再试。摘要能告诉你「一个都没发出去」——这种情况也回 502。

**9.8 熔断 `circuit_open:<秒>`**
**现象**：账本或错误里出现 `circuit_open:600` 这类字样；`/health` 里某上游 `circuit.open=true`、`state=circuit_open`。
**原因**：这家上游连续失败被熔断（连接失败/超时/402/408/429/5xx 默认 600 秒；401/403 默认 3600 秒）。400/413/422 属「请求本身不合适」，**不计熔断**，只计被拒次数。
**怎么办**：等窗口过去（`remaining_s` 会倒数）；同时修根因（key 过期最常见）；熔断状态只在内存，重启即清零——但别用重启掩盖问题。

**9.9 启动失败 / 端口被占用**
**现象**：启动就退出，报 `Address already in use`；或进程管理器反复重启。
**原因**：18790 已有进程在听（旧实例没停，或别的程序占了）。
**怎么办**：`ss -ltn | grep 18790` 看谁在听；停掉旧实例（前台 `Ctrl+C`，或用进程管理器停）；只排查时可临时换端口起隔离实例 `ROUTER_PORT=18791 python3 main.py`，但别把正式入口改乱。

**9.10 价格缺失或对不上**
**现象**：计划里某段显示「0（待用户录入）」、`price_state` 是 `unpriced`；或报告里预估与实付差得远。
**原因**：`pricebook.json` 没有这个模型的单价（未定价**不当作免费**）；或估价口径不含 system prompt/历史消息；或峰谷单价填反。
**怎么办**：补价格（手填，或 `python3 scripts/price_sync.py --out config/pricebook.json`）后重启；跑 `python3 scripts/price-attest.py` 看覆盖与偏差；对账以账本实账与 `/v1/route/report` 为准；差额解释看 `estimate_delta.basis`。

**9.11 计划卡不出现 / 点了没反应**
**现象**：点「生成计划」没反应；计划卡不出现；或点「确认开工」模型没切。
**原因**：插件没装好或页面没刷新（宿主改动需重启 DSH）；插件与宿主版本不配套；Max 模式下网关没在跑或 `/v1/route/plan` 不通；这把 key 的 `scopes` 里没有 `plan`。
**怎么办**：先 `curl -s http://127.0.0.1:18790/health` 确认网关活着；再用 curl 直接打一次计划接口看能否拿到 `plan_id`；刷新页面或重启 DSH；确认 Base URL 指向网关；到管理面确认这把 key 勾了 `plan`。

**9.12 流式输出中途断了**
**现象**：字出来一半没了；账本这行 `final_status` 是 `stream_error`；客户端报连接被重置。
**原因**：流式一旦开始发响应头，上游中途断开就**只能断连接**、没法再改状态码；或超过流式超时（默认 600 秒）；或中间代理/客户端自己先超时。
**怎么办**：同样的内容先打一次**非流式**，判断是上游还是链路；调大 `timeouts.stream_seconds`（重启生效）；看 `/health` 里该上游状态与账本 `attempts`。

**9.13 账本找不到**
**现象**：找不到 `数据/ledger.jsonl`，或找到了但是空的。
**原因**：账本路径写在 `routing.json → ledger.path`（样例 `数据/ledger.jsonl`，**相对进程当前目录**）；你从别的目录启动它就落到别处；或还没有一次成功请求。
**怎么办**：先 `cd ~/wb-router/gateway` 再启动；`ls -l 数据/` 看文件在不在、有没有变大；内网还有一个只读账本查询接口（`/router/ledger`），用法见包内 `README.md`；失败请求也会落一行，`final_status` 会说明结果。

**9.14 换了 key 不生效**
**现象**：换了上游密钥或客户端 key，行为没变：还是 401，或还在用旧额度。
**原因**：上游密钥来自环境变量、进程启动时读入 → **必须重启网关**；客户端把 key 缓存在自己的配置或连接里；两套 key 容易混（上游密钥 vs 客户端 key）。
**怎么办**：改的是环境变量或凭据文件 → 重启网关；改的是管理面里的客户端 key（创建/吊销/轮换）→ 网关侧立即生效，但客户端要换成新 token；先确认你改的是对的那套。

**9.15 升级与回滚怎么回**
**现象**：换了新版本，或升级后行为不对、想退回旧版。
**原因**：升级不只是换文件，还要合并配置——新版本会新增配置块、也会改动默认值（1.0.3.6 就新增了上下文治理块、超时值也变了），整份覆盖会把你的设置改坏。
**怎么办（升级四步）**：① 备份 `config`、`数据`、`logs`（见 10.4）；② 解包新包，**保留你自己的** `config/api-keys.json`、凭据、`数据/`、`logs/`；③ 合并配置——拿新包 `routing.json` 与你的比对，**只补新增块，不要整份覆盖**（1.0.3.6 新增上下文治理块、超时值也变了）；④ 重启并自检（`/health`、价格自证、一次小请求）。
**怎么办（回滚三步）**：还原 `.bak` 文件 → 重启 → 再自检一次。**数据不删、账本不清**。

**9.16 改了配置没生效**
**现象**：改完 `routing.json`/`upstreams.json`/环境变量，行为照旧。
**原因**：这些都是**启动时读一次**，运行中改了不会自动加载。
**怎么办**：重启网关。例外：影子判定的 `config/shadow_judge.json` 是热加载；路由策略文件按修改时间热读（以包内说明为准）。改前照例先 `.bak`。

**9.17 `/admin` 打不开或 404**
**现象**：浏览器打开管理面 404，或连接被拒。
**原因**：管理面只绑本机回环；对外**只放行 `/health` 与 `/v1/*`**，任何外部路径都 404；端口随 `ROUTER_PORT`。
**怎么办**：在**网关那台机器上**打开 `http://127.0.0.1:18790/admin`；不要指望从外网打开；远程排查用 SSH 转发到本机端口，别把管理面暴露出去。

**9.18 换模型后，之前的上下文还在吗？**
**现象**：担心切成另一个模型之后，新模型不记得前面说过什么，任务要从头再来。
**原因**：历史消息是**客户端照常携带**的，网关只替换「这一段由谁来答」，其余请求内容原样转发、默认不做裁剪（详见 6.5）；B1 边界纪律只约束「什么时候可以换」，不碰内容。真正会动上下文的是另外两个开关：阶梯裁剪 `trim` 与上下文治理 `enforce`（默认分别是关与 `shadow`）。
**怎么办**：直接在同一个会话里换，不必重开会话、也不必重说一遍；换完后先让新模型复述「目标／已完成／下一步／不做什么」再继续。若发现上下文明显被截断，先查是否开了 `trim`，或把 `context_governor` 从 `enforce` 回 `shadow`（见 8.3、8.4），并看响应头 `X-DSH-Trimmed`。

---

<a id="s10"></a>
## 十、安全与备份

### 10.1 凭据三条铁律

1. **只放环境变量**（或你本机的凭据文件），不写进 JSON 配置、不进仓库、不进聊天记录、不进截图。
2. **配置里只写变量名**：`upstreams.json` 的 `api_key_env` 是变量名，不是密钥；**密钥不进日志与账本**，网关只在内存里用它，日志不打印请求体/响应体。
3. **换人要换钥匙**：人/设备离开就吊销并轮换客户端 key，别只做口头交接。

### 10.2 账本与隐私

账本 `数据/ledger.jsonl` **每请求一行、只记特征不记正文**：记的是长度类特征（字符数、token 估算、消息条数）、状态、耗时、token 用量；不记消息正文、prompt、工具参数、图片内容，上游错误也只记状态码/异常类型。所以：**账本能给你对账，但不能用来回放你说过的话**——这是设计上的取舍。

### 10.3 管理面只在内网

管理面（`/admin`、`/admin/live`、`/admin/review` 与 `/router/*` 那组只读接口）**只在内网**，默认只绑本机回环；对外只放行 `/health` 与 `/v1/*`。确实要让别的机器接入，请走「反向代理＋白名单只放行 `/health` 与 `/v1/*`」，不要把管理面一起开出去。开源包里没有现成的公网方案（**未包含**，见 11.6）。

### 10.4 改之前先备份

```bash
cd ~/wb-router/gateway
STAMP=$(date -Iseconds)
mkdir -p "$HOME/wb-backup-$STAMP"
cp -a config upstreams.json "$HOME/wb-backup-$STAMP"/
cp -a 数据 "$HOME/wb-backup-$STAMP"/ 2>/dev/null || true
ls "$HOME/wb-backup-$STAMP"
```

**你会看到**：备份目录里有 `config/`、`upstreams.json`、`数据/`——这就是你的回滚点。

### 10.5 回滚三步

```bash
cd ~/wb-router/gateway
# 1) 还原（<备份名> 换成你的目录名）
cp -a "$HOME/wb-backup-<备份名>/config/routing.json"   config/routing.json
cp -a "$HOME/wb-backup-<备份名>/upstreams.json" upstreams.json
# 2) 重启：前台 Ctrl+C 后重新 python3 main.py；用进程管理器的 restart 你的服务
python3 main.py
# 3) 另开终端自检
curl -s http://127.0.0.1:18790/health | python3 -m json.tool | head -5
```

**注意**：回滚只还原文件、不清账本。账本是你的历史事实，别为了「看起来干净」删它。

### 10.6 对外分享前检查四件事

① 配置里没有密钥明文（只应有变量名）；② 账本不含正文（本来就只记特征，抽查两行确认）；③ 截图遮住了 key 与内网地址；④ 文档里不写你不想公开的上游名与价格。

---

<a id="s11"></a>
## 十一、附录

### 11.1 端点速查

| 方法 | 路径 | 作用 | 备注 |
|---|---|---|---|
| GET | `/health` | 健康、熔断、价格自证 | **不需要 key** |
| GET | `/v1/models` | 虚拟模型＋上游模型清单 | 需要 key（本机无钥匙模式除外） |
| GET | `/v1/route/capabilities` | 档位与模型能力清单 | 需要 key |
| GET | `/v1/route/prices` | 价格目录（已定价/本地/未定价） | 需要 key |
| GET | `/v1/route/functions`、`/v1/route/strategies` | 功能路由与策略（只读） | 需要 key |
| POST | `/v1/route/plan` | 生成分段计划＋估价（**无副作用**） | 需要 `plan` 权限 |
| POST | `/v1/route/annotation` | 回写执行结果（带 usage 时回差额） | 需要 `plan` 权限 |
| POST | `/v1/chat/completions` | 对话（OpenAI 兼容，支持流式） | 需要 `chat` 权限 |
| POST | `/v1/completions` | 补全（旧式） | 需要 `chat` 权限 |
| POST | `/v1/embeddings`、`/v1/rerank` | 向量 / 重排透传 | 需要 `chat` 权限 |
| GET | `/v1/route/report` | 预估 vs 实付＋账本实账 | 需要 key |
| POST | `/v1/route/replay` | 只读复算（0 执行 0 写账） | 需要 key |
| GET | `/v1/route/discipline` | 边界纪律只读聚合 | 需要 key |
| GET | `/v1/route/shadow` | 影子判定统计 | 开 B4 后才有内容 |
| GET | `/health.shadow` | 影子判定健康子页 | 仅开启时出现 |

> 管理面那组（`/admin`、`/admin/live`、`/admin/review`、`/router/ledger`、`/router/stats`、`/router/config`）**只在内网**，不在对外放行范围内。

### 11.2 错误码速查

| 状态 | `type` / `code` | 什么时候出现 | 你该怎么办 |
|---|---|---|---|
| 401 | `authentication_error` / `unauthorized` | key 缺失或不匹配 | 检查 `Authorization: Bearer`；换了 key 要重启客户端 |
| 429 | `rate_limit_error` / `rate_limit_exceeded` | 这把 key 的每分钟上限超了（带 `Retry-After`） | 等 `retry_after` 秒，或申请更高 rpm |
| 400 | `invalid_request_error` / `context_window_exceeded` | 输入超模型窗口（`enforce` 下） | 精简上下文或换更大窗口模型 |
| 413 | `payload_too_large` | 仅当 `error.allow_413=true`；默认回 400 | 同上；默认不用管 |
| 503 | `service_unavailable` ＋ `local_unavailable` / `local_vram_insufficient` | 本地模型装不下显存 | 改走云端候选，或等本地卸载 |
| 502 | `upstream_error` | 上游失败且无可用候选 | 稍后重试；看 `/health` 上游状态 |
| 熔断 | `circuit_open:<秒>` | 某上游连续失败被熔断 | 等熔断窗口结束；看 `/health` |

### 11.3 配置文件字段速查

| 文件 | 关键字段 | 一句话 |
|---|---|---|
| `upstreams.json`（网关根目录，非 config/） | `upstreams[].id`/`base_url`/`api_key_env`/`max_rpm`；`models.<模型>.context_window`/`.max_tokens`/`.vision`/`.tier` | 有哪些上游、怎么连、每个模型能吃多长 |
| `config/routing.json` | `virtual_models`、`routes`（时段×级别候选链）、`strategies`（`fast`/`strong`）、`complexity`、`peak`、`breaker`、`timeouts`、`context_governor`、`hint`、`ledger.path` | 怎么选、何时算高峰、出错怎么退 |
| `config/pricebook.json` | `models.<模型>.offers[].price.input/output/cache_hit`（`peak`/`offpeak`）、`rules.peak_rule`、`currency` | 每个模型多少钱（价格只以这一份为准） |
| `config/api-keys.json` | `required`、`keys[].scopes`（`plan`/`chat`）、`keys[].rpm`、`keys[].revoked_at` | 谁能用、能用哪些接口、多快 |

### 11.4 环境变量速查

| 变量 | 作用 | 默认 |
|---|---|---|
| `<上游>_API_KEY`（名字以 `api_key_env` 为准） | 某家上游的真实密钥 | 无 |
| `ROUTER_HOST` / `ROUTER_PORT` | 改监听地址/端口（起隔离实例用） | `127.0.0.1` / `18790` |
| `ROUTER_API_KEY` | 单钥匙入口鉴权（设了就要带 Bearer） | 空＝关 |
| `ROUTER_PRICE_ATTEST` | 价格单源自证 | `1`（开） |
| `ROUTER_CTX_GOVERNOR` | 上下文治理模式（`off`/`shadow`/`enforce`） | 取配置文件，出厂 `shadow` |
| `ROUTER_B1_DISCIPLINE` / `ROUTER_B3_AUTOMATION` | B1 / B3 开关 | `1` / `1` |
| `ROUTER_B4_SHADOW` / `ROUTER_B5_PASSTHROUGH` / `ROUTER_B5_PASSTHROUGH_KEYS` | B4 影子判定 / B5 总闸 / 限定钥匙 | 关 / 关 / 空 |
| `WB_API_KEYS_REQUIRED` | 强制开启 per-key 校验（优先于文件里的 `required`） | 跟随文件 |

### 11.5 版本与变更摘要（1.0.3.15，8 组能力各一句）

| 组 | 一句话 |
|---|---|
| B1 边界纪律 | 计划每段带只读边界说明；同轮工具轮换模型只记不拦 |
| B2 报告与回放 | 预估 vs 实付的报告＋只读复算的回放，复算不执行不写账 |
| B3 自动化档位 | L1/L2/L3 只改「确认节奏」，不改选哪个模型；不传＝现状 |
| B4 影子判定 | 影子模型异步判档，只记录、不改选模，默认关、热加载 |
| B5 只读直通 | 只读兼容入口，默认关，要环境变量＋key 两道开关 |
| R4/R5 上下文治理 | 给输入算预算、超窗回结构化 400、413 与裁剪各有独立开关 |
| A0/L5 价格单源 | 价格只以 `pricebook.json` 为准，默认自证覆盖与偏差 |
| 观测 | 账本记 `ctx_gov`，响应头给窗口/预算/已用/裁剪/档位 |

**出厂验证口径（发布方数据，2026-11-27 实测）**：网关回归**两段各 596 个用例全绿**、失败集合一致、canary 按预期红、exit 0；**3 种入口**（DSH Pro 插件 / DSH Max 插件 / OpenAI 兼容直连）；能力分 **8 组**；账本**只记特征、不记正文**。价格自证分区与上游家数一律以你自己部署的 `/health` 为准。

### 11.6 待确认 / 未验证清单

| 项 | 状态 | 说明 |
|---|---|---|
| 开源仓库地址与许可证 | **已定** | 仓库 https://github.com/beidou6972yh/dsh-bw-router ；许可证 MIT |
| 开源初版系统要求 | **部分未验证** | Linux/容器已验证；**Windows/macOS 原生安装未验证** |
| 开源版管理面板默认账号 | **admin/admin（源码默认值）** | 首次登录后立刻改口令；管理面只绑 `127.0.0.1` |
| 上游名单与价格表 | **随你自配** | 本书不承诺任何具体价格与上游清单 |
| 插件公开下载渠道 | **GitHub Release** | `plugins-1.0.3.15.tar.gz` / Release `v1.0.3.15` |
| 公网接入方案 | **未包含** | 开源包只保证「只绑回环＋只放行 `/health` 与 `/v1/*`」；要对外请自建反向代理与白名单 |

### 11.7 术语小词典

| 词 | 白话 |
|---|---|
| 上游 / 候选链 | 真正干活的那家大模型服务（云端或你本机）／一段任务可依次尝试的模型名单 |
| 虚拟模型 | `auto`/`auto-fast`/`auto-strong` 这类名字，代表「让网关选」 |
| 计划 / 回写 | 切段＋选谁＋估价（不花钱）／把真实用量填回计划（对账） |
| 账本 | 每请求一行的记录，只记特征不记正文 |
| 熔断 / RPM / 峰谷 | 连续失败后暂停该上游一段时间／每分钟请求上限／上游的忙时段（贵）与闲时段（便宜） |
| shadow / enforce / 灰度 | 只观察不干预／真正按规则拦截／新能力先只记录再真正执行 |

### 11.8 本书来源

- 事实表：（内部编制资料，不随包）
- 网关文档：`README.md`、`README.md`（网关代码树内）
- 版本文档：`变更说明-1.0.3.15.md`、`开关开启与观察.md`
- 样例配置：`gateway/upstreams.json`、`gateway/config/routing.json`；字段另行核对 `config/pricebook.json`、`config/api-keys.json`
- 其余细节以交付包内 `docs-1.0.3.15/` 与 `README.md` 为准

---

<a id="s12"></a>
## 十二、编者自检

### 12.1 内容来源对照

| 章节 | 主要来源 |
|---|---|
| 一、二章 | 事实表 §0 命名与发布状态、§1 一句话定位、§2 组成、§3 核心问题、§4 四步链、§7 差异对比（只比决策单位/开关/钱的口径/形态）、§11 待确认 |
| 三、安装前准备 | 事实表 §11-2（系统要求未验证口径）、§2（Python 3.12、两个依赖、18790）、§8.2 |
| 四、安装 | 事实表 §8.1 安装步骤、§2 服务形态；期望输出取自 `README.md` 启动与 `/health`；回归判据取自 `run-tests.sh` 头部说明 |
| 五、模型配置 | 事实表 §8.2、§11-4；字段名取自 `gateway/upstreams.json`、`gateway/config/routing.json`、`config/pricebook.json`、`config/api-keys.json`；价格命令取自 `scripts/price_sync.py`、`scripts/price-attest.py` 头部说明 |
| 六、七章 | 事实表 §4、§5、§9 三种入口、§8.2、§8.3；计划与回写必填项、`estimate_delta`、`pricing.policy`、`estimate_basis`、`partial`、计划状态 TTL 取自 `router_plan.py`；插件交互取自 `dsh-wb-pro-0.2.5/README.md` 与 `变更说明-1.0.3.6.md`；6.5 的换模时机（`switch_on`＝`new_user_message`/`context_rebuild`、`tool_turns_frozen`、豁免项）与转发原则取自 `router_plan.py`、`README.md`；7.7 的页面分区取自 `admin.html`、`admin-live.html` |
| 八、开关与灰度 | 事实表 §5（8 组能力与默认值）；逐项开启方法/观察指标/回滚取自 `开关开启与观察.md`；上下文治理口径取自 `变更说明-1.0.3.6.md` |
| 九、常见问题 | 事实表 §8.4 错误码表；本地 503 细节与熔断时长取自 `README.md`；计划过期取自 `router_plan.py`；其余为安装运维常识（不引入新数字） |
| 十、十一章 | 事实表 §10、§6「只记特征不记正文」、§8.3 端点、§8.4 错误码、§5 能力组、§6 硬数字、§11 待确认；字段速查来自样例配置与 `ROUTER_*` 环境变量（见 `开关开启与观察.md`） |

### 12.2 本书标注为「未验证 / 需你自配」的部分

1. Windows / macOS 原生安装未验证；
2. 公网接入方案（开源包未包含，需自建反向代理与白名单）；
3. 上游名单与价格表随用户自配，不承诺具体价格。

### 12.3 自检结果

| 检查项 | 结果 |
|---|---|
| FAQ 条数 | **18 条**（9.1–9.18），满足 ≥15；覆盖 401、429、400 `context_window_exceeded`、413、503（`local_unavailable`/`local_vram_insufficient`）、502、熔断 `circuit_open`、启动失败/端口占用、价格缺失或对不上、计划卡不出现/点了没反应、流式中断、账本找不到、换 key 不生效、升级与回滚、换模型后上下文是否还在 |
| 目录锚点 | **12 个**目录条目，逐个对应 `id="s1"…"s12"` 与 12 个章节标题，一一一致 |
| 硬数字 | 只用事实表 §6 的 596（两段各）全绿、3 种入口、8 组、只记特征不记正文（价格自证改注「以部署方 `/health` 为准」；其余历史数字只在变更说明中作历史陈述）；其余为操作参数（状态码、270/600 秒、1024、0.2、`127.0.0.1:18790`、Python 3.12、24 小时计划状态、60 秒本地冷却、20 秒等待上限），均出自事实表 §2/§5/§8 与上述 repo 文档 |
| 禁用表述 | 自 grep 结果：无星号计数、无百分比数值（许可证名 MIT 仅出现在 1.4 与 11.6 的既定事实陈述中）、无排名或独占类夸张表述；效果承诺类词只出现在 1.4「不做此类承诺」的否定句与本行说明中；未写具体单价（价格示例已标注「结构示意」） |
| 命令与路径 | 命令全在代码块内；路径统一 `~/wb-router`（＝安装目录）相对写法，未写死发布方本机绝对路径；本机绝对路径仅出现在 11.8 来源 |
| 行数统计 | `wc -l` 实测 **926 行**（按本轮修订口径 ≤940 行） |
