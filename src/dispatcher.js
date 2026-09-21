'use strict';

const crypto = require('crypto');
const db = require('./db');

const CLIENT_TIMEOUT_MS = Number(process.env.CLIENT_TIMEOUT_MS || 5000);
const TICK_MS = 500;
const BATCH_SIZE = 5;

function nowIso() {
  return new Date().toISOString();
}

function sign(secret, timestamp, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** 为事件创建一次投递（手动触发 / 重放均走这里） */
function createDelivery(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return null;
  const delivery = {
    id: newId('dlv'),
    event_id: event.id,
    idempotency_key: newId('idem'),
    status: 'pending',
    attempt_count: 0,
    max_attempts: event.max_retries + 1, // 首次 + 重试次数
    next_attempt_at: nowIso(),
    created_at: nowIso(),
  };
  db.prepare(`
    INSERT INTO deliveries (id, event_id, idempotency_key, status, attempt_count, max_attempts, next_attempt_at, created_at)
    VALUES (@id, @event_id, @idempotency_key, @status, @attempt_count, @max_attempts, @next_attempt_at, @created_at)
  `).run(delivery);
  return delivery;
}

function recordAttempt(row) {
  db.prepare(`
    INSERT INTO attempts (delivery_id, attempt_no, request_headers, request_body, response_status, response_headers, response_body, error, duration_ms, created_at)
    VALUES (@delivery_id, @attempt_no, @request_headers, @request_body, @response_status, @response_headers, @response_body, @error, @duration_ms, @created_at)
  `).run(row);
}

async function attemptDelivery(delivery) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(delivery.event_id);
  if (!event) {
    db.prepare(`UPDATE deliveries SET status = 'failed', completed_at = ? WHERE id = ?`).run(nowIso(), delivery.id);
    return;
  }

  const attemptNo = delivery.attempt_count + 1;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    id: delivery.id,
    idempotency_key: delivery.idempotency_key,
    event: event.name,
    event_id: event.id,
    attempt: attemptNo,
    created_at: delivery.created_at,
    data: JSON.parse(event.payload || '{}'),
  });
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'webhook-sandbox/1.0',
    'X-Webhook-Delivery': delivery.id,
    'X-Webhook-Event': event.name,
    'X-Webhook-Event-Id': event.id,
    'X-Idempotency-Key': delivery.idempotency_key,
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Signature': sign(event.secret, timestamp, body),
  };

  db.prepare(`UPDATE deliveries SET status = 'delivering' WHERE id = ?`).run(delivery.id);

  const started = Date.now();
  let responseStatus = null;
  let responseHeaders = null;
  let responseBody = null;
  let error = null;

  try {
    const res = await fetch(event.target_url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    responseStatus = res.status;
    responseHeaders = JSON.stringify(Object.fromEntries(res.headers.entries()));
    responseBody = (await res.text()).slice(0, 4096);
  } catch (err) {
    error = err.name === 'TimeoutError' || err.name === 'AbortError'
      ? `请求超时（>${CLIENT_TIMEOUT_MS}ms）`
      : String(err.cause && err.cause.code ? `${err.cause.code}: ${err.message}` : err.message);
  }
  const durationMs = Date.now() - started;

  recordAttempt({
    delivery_id: delivery.id,
    attempt_no: attemptNo,
    request_headers: JSON.stringify(headers),
    request_body: body,
    response_status: responseStatus,
    response_headers: responseHeaders,
    response_body: responseBody,
    error,
    duration_ms: durationMs,
    created_at: nowIso(),
  });

  const ok = responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
  if (ok) {
    db.prepare(`UPDATE deliveries SET status = 'delivered', attempt_count = ?, completed_at = ? WHERE id = ?`)
      .run(attemptNo, nowIso(), delivery.id);
  } else if (attemptNo >= delivery.max_attempts) {
    db.prepare(`UPDATE deliveries SET status = 'failed', attempt_count = ?, completed_at = ? WHERE id = ?`)
      .run(attemptNo, nowIso(), delivery.id);
  } else {
    // 指数退避：backoff * 2^(已尝试次数 - 1)
    const delaySec = event.backoff_seconds * Math.pow(2, attemptNo - 1);
    const nextAt = new Date(Date.now() + delaySec * 1000).toISOString();
    db.prepare(`UPDATE deliveries SET status = 'pending', attempt_count = ?, next_attempt_at = ? WHERE id = ?`)
      .run(attemptNo, nextAt, delivery.id);
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const due = db.prepare(`
      SELECT * FROM deliveries
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC
      LIMIT ?
    `).all(nowIso(), BATCH_SIZE);
    for (const delivery of due) {
      await attemptDelivery(delivery);
    }
  } catch (err) {
    console.error('[dispatcher] tick error:', err);
  } finally {
    running = false;
  }
}

function start() {
  setInterval(tick, TICK_MS);
  console.log(`[dispatcher] started (tick=${TICK_MS}ms, timeout=${CLIENT_TIMEOUT_MS}ms)`);
}

module.exports = { start, createDelivery, sign };
