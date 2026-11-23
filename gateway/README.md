# WB 模型路由网关（OpenAI 兼容）

单进程 Python 服务：把模型请求按「内容复杂度 + 时段 + 通道健康/频率」路由到多个上游，对客户端暴露标准 OpenAI 接口。默认只绑 `127.0.0.1:18790`。

## 运行

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install PyYAML requests
# 把 config/ 里的匿名样例（up-a…local-lan，.example.com）换成你自己的上游；密钥只放环境变量
python3 main.py
curl -s http://127.0.0.1:18790/health
```

上游密钥通过 `upstreams.json` 里每个条目的 `api_key_env` 指定环境变量名读取；入口鉴权用 `config/api-keys.json`（Bearer）；仓库只带 `config/api-keys.example.json` 样例，首次启动会自动生成 `api-keys.json`（也可自行创建）。

## 接口

- `GET /health`：健康、上游状态、价格自证
- `POST /v1/route/plan`：分段计划与估价（无副作用）
- `POST /v1/route/annotation`：回写真实用量/花费
- `POST /v1/chat/completions`：OpenAI 兼容执行（支持流式）
- `GET /v1/route/{prices,capabilities,report,discipline,shadow}`；`POST /v1/route/replay`
- 管理面：`GET /admin`、`/admin/live`、`/admin/review`（默认只绑回环）

## 目录

```
main.py              # HTTP 入口与路由执行
router_plan.py       # 分段计划
router_strategies.py # 候选链/策略
router_deciders.py   # 决策模型（可关）
router_shadow.py     # 影子判定（默认关）
router_live.py       # /admin/live 只读数据
price_resolver.py    # 计价
api_keys.py          # 入口鉴权
admin_ui.py          # 管理面
config/              # 匿名样例配置
tests/               # 回归（python3 -m unittest discover -s tests）
scripts/             # 价格同步/自证等工具（按需）
run-tests.sh         # 两段回归入口
```

## 回归

```sh
bash run-tests.sh --clean --config-dir config
```

判据：两段用例数一致、全绿、退出码 0。

## 许可

MIT。默认只绑回环，管理面不要对公网开放；管理面源码默认账号请首次登录后立即修改。
