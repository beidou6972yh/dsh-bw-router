# Changelog

## 0.1.0 — 2026-11-15

首个公开预发布。

- 分段计划（`POST /router/plan`）：任务拆段、按段分配模型、返回计划卡。
- 确认开工（`POST /router/plan/confirm`）与会话内切模型（`POST /router/switch`）。
- 段末记账（`POST /router/stage/finish`）、状态栏（`GET /router/state`）、计划卡（`GET /router/card`）。
- 模型发现（`GET /router/models`）与明示价格策略：宿主未配价时显示「预估不可用」，只按 token 记账。
- 守卫判定码：`ok` / `context-overflow` / `missing-capability` / `model-unavailable` / `output-limit-too-small` / `limits-unconfirmed` / `price-unknown`。
- 客户端：`conversation.composer.dock` 注册计划卡与状态栏；无数据时不渲染。
- 已知限制见 README「Known limitations」。
