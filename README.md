# Webhook 调试沙盒

纯本地的 Webhook 调试沙盒：无需任何第三方账号，一条命令启动。可创建事件并配置签名密钥、最大重试次数与退避间隔；内置调度器按计划向内置模拟接收器投递，接收器校验 HMAC 签名与幂等键；失败按指数退避自动重试，每次请求/响应完整落库；页面提供投递时间线与手动重放。

## 快速开始

```bash
docker compose up --build
```

启动后访问：**http://localhost:8080**

> 本地开发（不用 Docker）：`npm install && npm start`，同样访问 http://localhost:8080

## 功能一览

| 功能 | 说明 |
| --- | --- |
| 事件管理 | 创建事件，自定义签名密钥、最大重试次数（0–10）、退避基数（秒）与 JSON payload |
| 签名投递 | 每次投递携带 `X-Webhook-Signature: sha256=HMAC(secret, "<timestamp>.<body>")` 与 `X-Idempotency-Key` |
| 内置模拟接收器 | `POST /receiver/{ok\|fail\|flaky\|slow}`，校验签名、按幂等键去重 |
| 指数退避重试 | 第 n 次重试延迟 = `backoff_seconds × 2^(n-1)`，超过最大次数标记为失败 |
| 完整留痕 | 每次尝试的请求头/请求体/响应状态/响应体/错误/耗时全部记录到 SQLite |
| 时间线与重放 | 页面实时展示投递状态时间线，可展开每次尝试详情，一键手动重放 |

## 接收器行为模式

- **ok** — 校验通过后返回 200
- **fail** — 始终返回 500，用于观察完整的重试与最终失败流程
- **flaky** — 约 50% 概率返回 500，用于观察偶发失败后的成功重试
- **slow** — 延迟 8 秒才响应（客户端 5 秒超时）→ 触发重试 → 接收器通过幂等键识别重复投递并去重

## 验证签名（接收方视角）

```
signature = "sha256=" + HMAC_SHA256(secret, timestamp + "." + rawBody)
```

请求头：`X-Webhook-Signature`、`X-Webhook-Timestamp`、`X-Idempotency-Key`、`X-Webhook-Delivery`、`X-Webhook-Event`。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/events` | 列出 / 创建事件 |
| DELETE | `/api/events/:id` | 删除事件 |
| POST | `/api/events/:id/deliver` | 立即触发一次投递 |
| GET | `/api/deliveries` | 投递列表（可按 `?event_id=` 过滤） |
| GET | `/api/deliveries/:id` | 投递详情（含每次尝试的请求/响应） |
| POST | `/api/deliveries/:id/replay` | 手动重放（生成新投递与新幂等键） |
| GET/DELETE | `/api/receiver/log` | 查看 / 清空接收器日志 |
| POST | `/receiver/:behavior` | 内置模拟接收器 |

## 技术栈与数据

Node.js 20 · Express · better-sqlite3 · 原生 fetch。SQLite 数据文件持久化在 Compose 卷 `webhook-data`（容器内 `/app/data`）。可用环境变量：`PORT`（默认 8080）、`CLIENT_TIMEOUT_MS`（默认 5000）、`SLOW_RECEIVER_MS`（默认 8000）。
