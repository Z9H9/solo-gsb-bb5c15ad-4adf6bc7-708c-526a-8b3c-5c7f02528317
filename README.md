# 🪝 Webhook Sandbox — 本地 Webhook 调试沙盒

无需任何第三方账号、完全本地运行的 webhook 发送方调试工具。
Node.js + Express + SQLite（`better-sqlite3`），Docker Compose 一键启动。

- **事件（Event）管理**：每个事件可独立配置签名密钥、最大重试次数、指数退避基数、目标 URL
- **定时投递**：创建投递后由内置调度器按 `next_run_at` 自动发出，支持延迟投递
- **HMAC 签名**：Stripe 风格 `X-Signature: t=<ts>,v1=<hmac-sha256(ts.body)>`，接收器逐请求校验（含时间戳容差、常量时间比较）
- **幂等键**：发送 `X-Idempotency-Key`；接收器对已接受过的键返回 `duplicate=true`
- **指数退避重试**：失败（非 2xx / 网络错误 / 超时）后按 `base × 2^(n-1)` 重试，直到最大次数（上限 30 分钟）
- **完整时间线**：记录每次尝试的请求 URL/头/体、响应状态码/头/体、错误信息与耗时
- **手动重放**：一键重放任意投递（可选择新幂等键或复用原键观察去重）
- **内置模拟接收器**：可模拟 500/404/401/超时/延迟/自定义状态码，**每次请求（无论成功或拒绝）都落库**
- 数据持久化在 Docker volume 的 SQLite 文件中，重启不丢

## 一条命令启动

```bash
docker compose up --build -d
```

然后浏览器打开：

> **http://localhost:3000**

停止：`docker compose down`（保留数据）；清空数据：`docker compose down -v`。

> 端口被占用？修改 `docker-compose.yml` 里的 `"3000:3000"`，或 `HOST_PORT=8080 docker compose up` 之前改为 `"${HOST_PORT:-3000}:3000"`。

## 30 秒体验流程

1. 打开 **http://localhost:3000**，在「创建事件」卡片填名称 `order.paid`，重试 `3`、退避 `1000`，点击创建（密钥留空自动生成）
2. 中间栏 payload 里已经有 `"_sim": { "scenario": "fail_500" }`，点击 **「投递（模拟 500，触发退避重试）」**
3. 右侧时间线可观察到请求每 ~1s、~2s、~4s 重试，直到 `failed`；展开可查看完整请求头（含 `X-Signature`）/请求体/响应体
4. 点击 **「手动重放（新幂等键）」** 可重新投递；「复用幂等键」重放会被接收器标记为 `duplicate`
5. 把 payload 改成 `{"order_id":"x"}` 后「立即投递」，一次成功（`succeeded`）
6. 右下角「模拟接收器日志」实时显示所有到达接收器的请求：ACCEPTED / REJECTED / DUP / BAD HMAC

### 模拟接收器支持的场景

在 JSON payload 中加入 `_sim` 字段（不会影响签名，签名覆盖整个原始 body）：

```json
{
  "order_id": "ord_1",
  "_sim": {
    "scenario": "fail_500",   // fail_500(默认500) | fail_404 | unauthorized(401) | timeout(挂起) | ok
    "status": 503,            // scenario=fail_500 时自定义状态码
    "delay_ms": 2000          // 延迟 N 毫秒再响应（最大 60s）
  }
}
```

## HTTP API

也可以完全不使用 UI，直接调 API（例如把目标 URL 指向你自己的服务做联调）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/events` | 创建事件 |
| `GET` | `/api/events` | 事件列表 |
| `GET` | `/api/events/:id` | 事件详情 |
| `DELETE` | `/api/events/:id` | 删除事件（级联删除投递） |
| `POST` | `/api/events/:id/deliveries` | 创建投递 |
| `GET` | `/api/events/:id/deliveries` | 某事件的投递列表 |
| `GET` | `/api/deliveries/:id` | 投递详情 + 全部 attempts 时间线 |
| `POST` | `/api/deliveries/:id/replay` | 手动重放 |
| `GET` | `/api/received` | 模拟接收器收到的原始请求日志 |
| `POST` | `/receiver/webhook` | 内置模拟接收器本身 |

### curl 示例

```bash
# 1. 创建事件
curl -s -X POST localhost:3000/api/events -H 'Content-Type: application/json' \
  -d '{"name":"order.paid","max_retries":3,"backoff_base_ms":1000}'

# 2. 创建投递（payload 对象会被 JSON 序列化后签名发出）
curl -s -X POST localhost:3000/api/events/<EVENT_ID>/deliveries \
  -H 'Content-Type: application/json' \
  -d '{"payload":{"order_id":"o1"},"idempotency_key":"my-key-1","delay_ms":0}'

# 3. 查看时间线（每次尝试的请求/响应全文）
curl -s localhost:3000/api/deliveries/<DELIVERY_ID> | jq

# 4. 重放
curl -s -X POST localhost:3000/api/deliveries/<DELIVERY_ID>/replay \
  -H 'Content-Type: application/json' -d '{}'                          # 新幂等键
curl -s -X POST localhost:3000/api/deliveries/<DELIVERY_ID>/replay \
  -H 'Content-Type: application/json' -d '{"keep_idempotency_key":true}' # 复用 → duplicate
```

### 事件字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `name` | 必填 | 事件名 |
| `signing_secret` | 自动生成 32 位 hex | HMAC 密钥 |
| `max_retries` | `3` | 失败后重试次数（总尝试次数 = 该值 + 1），0–20 |
| `backoff_base_ms` | `1000` | 指数退避基数，`base·2^(n-1)`，上限 30 分钟 |
| `target_url` | 内置接收器 | 投递目标，可指向任何可达的 HTTP 地址 |

### 发出的请求头

```
POST /receiver/webhook HTTP/1.1
Content-Type: application/json
X-Webhook-Event:   <event public id>
X-Delivery-Id:     <delivery public id>
X-Idempotency-Key: idem_xxxx（或调用方指定）
X-Signature:       t=<unix秒>,v1=<HMAC-SHA256 hex>
```

## 本地开发（不用 Docker）

要求 Node.js ≥ 20：

```bash
npm install
npm start                 # http://localhost:3000
npm run dev               # --watch 模式
```

SQLite 数据库文件位于 `data/webhook-sandbox.db`（已 gitignore）。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口（同时用于默认目标 URL 推导） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | SQLite 文件目录 |
| `DEFAULT_TARGET_URL` | `http://127.0.0.1:$PORT/receiver/webhook` | 新事件的默认目标 |
| `WORKER_TICK_MS` | `250` | 调度器轮询间隔 |
| `HTTP_TIMEOUT_MS` | `10000` | 单次投递请求超时 |
| `SIGNATURE_TOLERANCE_SECONDS` | `300` | 接收器允许的签名时间戳偏差；`0` 关闭 |

## 设计说明

- **调度模型**：SQLite 单表 `deliveries` 以 `status=pending AND next_run_at<=now` 查询到期任务；
  原子 `UPDATE ... WHERE status='pending'` 认领（置 `running` 并自增尝试次数），因此可安全重启、不会重复发送同一轮尝试。
- **崩溃恢复**：进程重启时把残留 `running` 的投递重置为 `pending`（被中断的那次仍计入尝试次数）。
- **退避公式**：`min(30min, base × 2^(retryNo-1))`，受调度器 tick 粒度量化。
- **签名校验**：先校验头格式与时间戳容差（防重放），再用 `crypto.timingSafeEqual` 比对 HMAC。
- **幂等语义**：接收器对同一事件下「已接受（HTTP 200 且非 duplicate）」过的幂等键返回 200 + `duplicate:true`；
  失败的重试不会把键标记为已消费，与真实 webhook 端点的常见语义一致。

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── src/
│   ├── server.js       # Express 入口 + REST API
│   ├── db.js           # SQLite schema / 迁移 / 崩溃恢复
│   ├── dispatcher.js   # 调度器、投递 worker、指数退避、HTTP 客户端
│   ├── receiver.js     # 内置模拟接收器（HMAC 校验 + 幂等 + 故障模拟）
│   └── signing.js      # HMAC 签名 / 验证
└── public/
    └── index.html      # 单文件 Web UI（无构建、无 CDN）
```
