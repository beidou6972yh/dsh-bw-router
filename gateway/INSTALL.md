# 网关安装与启动（INSTALL）

> 适用于开源发布的匿名样例配置。目标：10 分钟内把网关跑起来、能出计划、能算价。

## 一、环境

- Python 3.10+（已在 3.12 验证）；依赖：`pip install PyYAML requests`
- 默认只绑 `127.0.0.1:18790`；不要直接把管理面对公网开放

## 二、解包与配置

```sh
mkdir -p ~/wb-router && cd ~/wb-router
tar -xzf gateway-1.0.3.6.tar.gz
cd gateway
```

1. `upstreams.json`（网关根目录）：把 `up-a…local-lan`、`*.example.com` 换成你侧真实上游；密钥走每条的 `api_key_env` 环境变量。
2. `config/routing.json`：`routes` / `strategies` / `capability_meta` 三处的 `<上游>/<模型>` 键要与 upstreams 一致。
3. `config/pricebook.json`：价目唯一真源；样例含 `model-usd-fast`（USD 报价，演示币种与汇率折算）。
4. `config/fx-rates.json`：汇率真源（键名 `<币种>CNY`，如 `USDCNY`）；非 CNY 报价缺汇率时判「价未知」。
5. 入口鉴权：`config/api-keys.example.json` 是样例，复制为 `config/api-keys.json` 后按需填 key；不启用时无需 key。

## 三、启动与自检

```sh
python3 main.py                     # 默认 127.0.0.1:18790；可用 ROUTER_PORT 覆盖
curl -s http://127.0.0.1:18790/health | head -c 200
curl -s -X POST http://127.0.0.1:18790/v1/route/plan \
  -H 'content-type: application/json' \
  -d '{"task":"把这份纪要整理成三段结论"}'
curl -s 'http://127.0.0.1:18790/v1/route/prices?model=model-usd-fast' | head -c 400
```

## 四、回归

```sh
bash run-tests.sh --clean --config-dir config   # 两段各 Ran 570 / OK（skip 1），canary 段按预期红
```

## 五、常见问题

- **plan 没价 / cost_known 为 null**：pricebook 里该模型没有报价，或非 CNY 报价缺 `fx-rates.json` 汇率——按「价未知」处理，不会猜 0。
- **端口冲突**：`ROUTER_PORT=18888 python3 main.py`，MCP/Skill 侧同步改 `WB_GATEWAY_URL`。
- **Windows 首次启动报时区**：`pip install tzdata`。

更多：仓库根 `README.md` 与 `release-notes-1.0.3.6/`。
