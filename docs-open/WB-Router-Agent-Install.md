# WB 模型路由网关 · Agent 安装说明（可直接投喂给 Agent）

> **给 Agent 的话**：这是一份可执行安装任务书。请严格按步骤做，每步有「期望」与「失败怎么办」。
> 你不需要读源码；**不许跳步、不许改包外文件、不许把密钥打印到输出里**。
> 目标：让用户在一台 Linux 机器/容器上把网关跑起来，并能看到「计划 → 确认 → 执行 → 对账」这条链路。

| 项 | 值 |
|---|---|
| 产品 | WB 模型路由网关 v1.0.3.6（OpenAI 兼容，自托管） |
| 用户画像 | 无编码基础；不会读日志也能看懂你的回报 |
| 交付包 | `gateway-1.0.3.6.tar.gz`、`plugins-1.0.3.6.tar.gz`、`skill-mcp-1.0.3.6.tar.gz` |
| 完成判据 | 见 §5（4 条全过才算装好） |

---

## 1. 开工前：先问用户三个问题（一次问完，别反复打扰）

1. **模型服务地址**：你有哪个 OpenAI 兼容的模型服务（云端 API 或本地/局域网模型都行，本地常见如 Ollama 的 `http://<局域网IP>:11434/v1`、vLLM 的 `http://<IP>:8000/v1`）？地址是什么（一般以 `/v1` 结尾）？
2. **密钥**：对应的密钥是什么？（让用户自己填进环境变量；你**不要**把密钥写进任何文件、不要 echo）
3. **装到哪个目录 + 用哪几个模型**：默认建议 `~/wb-router`；模型名要让用户给准确的（如 `deepseek-chat`、`qwen3-8b`）。

> 用户答不上「密钥/服务地址」⇒ 停下来告诉用户：「还差一个模型服务，没有它网关装了也不会跑」，不要自己编地址去试。

## 2. 环境检查（全部通过再往下）

```bash
python3 --version                 # 期望 3.12.x
python3 -m pip --version          # 没有就 python3 -m ensurepip 或装 python3-pip
ss -ltn | grep -q ':18790 ' && echo PORT_BUSY || echo PORT_FREE   # 期望 PORT_FREE
df -h "$HOME" | tail -1           # 至少留 2GB
```

| 不通过 | 怎么办 |
|---|---|
| Python < 3.12 | 告诉用户需要 3.12，或按发行版装 `python3.12`；别用 3.8/3.9 硬跑 |
| 没有 pip | `python3 -m ensurepip --upgrade` 或系统包管理器 |
| 18790 被占 | `ss -ltnp \| grep 18790` 看是谁；是旧实例就停掉，别杀别人的进程 |
| 磁盘 < 2GB | 告诉用户空间不够，先清理 |

## 3. 安装（照抄；`$ROOT` 改成用户选的目录）

### 3.1 解包

```bash
ROOT=~/wb-router
mkdir -p "$ROOT" && cd "$ROOT"
tar -xzf gateway-1.0.3.6.tar.gz
tar -xzf plugins-1.0.3.6.tar.gz
tar -xzf skill-mcp-1.0.3.6.tar.gz
ls    # 期望：gateway  plugins  skill-mcp
test -f gateway/main.py && test -d gateway/config && echo PKG_OK
```

### 3.2 装依赖

```bash
python3 -m pip install --user PyYAML requests
```

期望：`Successfully installed ...`；失败就贴错误原文给用户，别重复重试三次以上。

### 3.3 写配置（两处必改，改前先备份）

```bash
cd "$ROOT/gateway"
cp -a upstreams.json upstreams.json.bak
cp -a config/routing.json   config/routing.json.bak
```

**（a）`upstreams.json`（网关根目录）** —— 把样例里的占位换成用户给的真实值。⚠ 注意：`config/upstreams.json` 是历史样例、**网关不读**（`main.py` 读 `BASE_DIR/upstreams.json`，即 `gateway/upstreams.json`），改错文件不报错但不生效。单个上游的结构是：

```json
{
  "id": "my-cloud",
  "base_url": "https://你的服务地址/v1",
  "api_key_env": "MY_KEY_A",
  "max_rpm": 60,
  "models": {
    "你的模型名": { "context_window": 128000, "max_tokens": 8192, "vision": false, "tier": "cheap" }
  },
  "label": "我的云端模型"
}
```

规则：`models` 的键必须与上游真实模型名**逐字一致**；`api_key_env` 只是**变量名**，不是密钥；不确定的字段（`vision`、`tier`）可先按 `false`/`cheap` 保守填。**本地服务若不需要密钥，可填任意占位值，但 `api_key_env` 字段不要删。**

**（b）`config/routing.json`** —— 只需把候选链里的 `上游/模型` 换成上面写的值，出现在 `routes`、`strategies` 两处（以及 `capability_meta`、`hint.tiers`，如果存在）。不要整份重写，不要改 `context_governor`（保持默认 `shadow`）。

改完自检 JSON 合法：

```bash
python3 -m json.tool upstreams.json >/dev/null && echo UPSTREAMS_OK
python3 -m json.tool config/routing.json   >/dev/null && echo ROUTING_OK
```

### 3.4 放密钥（只进环境变量）

```bash
export MY_KEY_A='用户提供的密钥'
echo "${MY_KEY_A:+KEY_SET}"        # 期望输出 KEY_SET；不要 echo 密钥本身
```

要给长期运行用，就把这行写进用户自己的启动脚本（systemd `Environment=` 或 supervisor `environment=`），**不要**写进仓库里的任何文件。

### 3.5 启动

前台试跑（先确认能起来）：

```bash
cd "$ROOT/gateway"
python3 main.py
```

期望：打印一行「凭据已加载：N 个 ref」，然后停在前台不返回（这就是在跑）。用 `Ctrl+C` 可停。

> 需要常驻时，交给用户环境里现成的进程管理器（supervisor 服务名建议 `router-gateway`，systemd 单元同理）；**不要**自己发明开机自启方式。

### 3.6 自检（另开终端）

```bash
curl -s http://127.0.0.1:18790/health | python3 -m json.tool | head -30
curl -s http://127.0.0.1:18790/v1/models | head -c 400
```

期望：
1. `/health` 里 `"ok": true`；
2. 用户配的每个上游 `"state": "ok"`；
3. `/v1/models` 里能看到 `auto`、`auto-fast`、`auto-strong`。

### 3.7 真调一次（会花一点钱，先问用户同意）

```bash
python3 scripts/smoke.py     # 期望：打印 HTTP 码/耗时/返回模型，无 4xx/5xx
```

## 4. 可选：管理面板与密钥

```bash
# 本机打开（只在内网）：  http://127.0.0.1:18790/admin
```

首登后在「API keys」里新建一把给用户自己用（选 `scopes=plan,chat`，设 `rpm`）；**明文只显示一次**，让用户当场存好。
自用/内网联调也可以先在 `config/api-keys.json` 里把 `required` 设为 `false`，**但交付给用户前必须改回 `true`** 并配一把 key——否则等于没有鉴权。

## 5. 完成判据（4 条全过才算装好）

1. `curl /health` 返回 `ok: true`，且每个上游 `state: ok`；
2. `/v1/models` 能列出 3 个虚拟模型（`auto`/`auto-fast`/`auto-strong`）；
3. `scripts/smoke.py` 真调成功（不是 401/4xx/5xx）；
4. 打开 `/admin` 能登录（或按发布说明给出默认账号）且页面不报错。

## 6. 禁止事项（违反即视为任务失败）

1. 不把密钥写进任何文件、不 echo、不进日志、不进回报。
2. 不把 `/admin`、`/router/*` 暴露到公网；对外只放行 `/health` 与 `/v1/*`。
3. 不改系统级配置、不装系统服务、不动别人的进程和端口。
4. 不删用户数据（`数据/`、`logs/`、`config/*.bak` 都不许删）。
5. 不在没得到用户同意时真调付费模型。

## 7. 出问题怎么处理

| 现象 | 最可能原因 | 处理 |
|---|---|---|
| `ModuleNotFoundError: yaml` | 依赖没装/装到了别的解释器 | 用**同一个** `python3` 装：`python3 -m pip install PyYAML requests` |
| `凭据已加载：0 个 ref` | `api_key_env` 名字与 export 的不一致 | 逐字比对（区分大小写），改完重启 |
| 启动直接退出、无报错 | 端口被占 / 配置解析失败 | `python3 -m json.tool config/routing.json`；`ss -ltn \| grep 18790` |
| `/health` 里某上游 `state != ok` | 地址错、网络不通、key 错 | 先用 `curl <base_url>/models` 手工验证，再回头改配置 |
| `/v1/models` 没有虚拟模型 | `routing.json` 的 `virtual_models` 被改坏 | 还原 `routing.json.bak`，只改候选链 |
| 计划里显示「0（待用户录入）」 | 该模型没价格 | 让用户补 `config/pricebook.json` 或先用有价格的模型 |
| 401/403 | 没带 key 或 key 被吊销 | 用管理页确认 key 状态；换 key 后重启客户端 |

## 8. 回滚

```bash
cd "$ROOT/gateway"
cp -a upstreams.json.bak upstreams.json
cp -a config/routing.json.bak   config/routing.json
# 重启进程；数据/ 与 logs/ 保留不动
```

## 9. 交给用户的回报格式（就用这 6 行，别多写）

```
装好了：<安装目录>，当前可用模型 <N> 个（<列表前三个>）
访问地址：http://127.0.0.1:18790 （管理面 /admin，只在本机/内网可开）
自检：/health ok；上游 <N>/<N> ok；冒烟请求通过
你还需要做的一件事：<例如：把价格补到 config/pricebook.json>
怎么用：在 DSH 里选 auto / auto-fast / auto-strong，先「生成计划」再「确认开工」
出问题先看：日志 logs/，或把 /health 的输出发我
```

---

*版本 1.0.3.6；更多细节见同目录《使用说明书》（26 页）与包内 `gateway/README.md`、`gateway/docs-1.0.3.6/`。*
