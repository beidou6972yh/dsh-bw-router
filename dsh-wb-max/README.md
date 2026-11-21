# dsh-wb-max（WB 路由 · Max）

DSH Max 插件：在 DSH 界面里调用 WB 模型路由网关（`/v1/route/plan`）——计划卡、确认开工、会话内按段切模型；网关未运行时明示不可用。

- 宿主：DeepSeek Harness `^0.2.1-rc.2`（web 客户端）
- 依赖：运行中的 WB 路由网关（默认 `127.0.0.1:18790`；在网关 `/v1/route/plan` 可用时生效）
- 安装：`dsh plugin --profile <profile> add <本包 tgz>`，重启 `dsh web`
- 许可：MIT

> 本仓库内的 `dist/client/client.js` 为脱敏副本：余额快照 `SNAP` 已清空（`items:[]`），不含真实金额。
