'use strict';

const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const db = require('./db');
const { sign } = require('./signing');

const TICK_MS = Number(process.env.WORKER_TICK_MS || 250);
const REQUEST_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 10000);

/**
 * Default destination: the mock receiver served by this same process.
 * Derived at call time from PORT so every instance targets itself; override
 * with DEFAULT_TARGET_URL (e.g. to point at an external listener).
 */
function defaultTarget() {
  if (process.env.DEFAULT_TARGET_URL) return process.env.DEFAULT_TARGET_URL;
  const port = Number(process.env.PORT) || 3000;
  return `http://127.0.0.1:${port}/receiver/webhook`;
}

function nowIso() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* ------------------------------------------------------------------ enqueue */

const insertEventStmt = db.prepare(`
  INSERT INTO events (public_id, name, signing_secret, max_retries, backoff_base_ms, target_url, created_at)
  VALUES (@public_id, @name, @signing_secret, @max_retries, @backoff_base_ms, @target_url, @created_at)
`);

function createEvent({ name, signing_secret, max_retries, backoff_base_ms, target_url }) {
  const row = {
    public_id: uuid(),
    name: String(name),
    signing_secret: String(signing_secret),
    max_retries: clamp(max_retries, 0, 20, 3),
    backoff_base_ms: clamp(backoff_base_ms, 100, 3_600_000, 1000),
    target_url: target_url ? String(target_url) : defaultTarget(),
    created_at: nowIso(),
  };
  const info = insertEventStmt.run(row);
  return getEvent(info.lastInsertRowid);
}

function getEvent(id) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

function getEventByPublicId(publicId) {
  return db.prepare('SELECT * FROM events WHERE public_id = ?').get(publicId);
}

function listEvents() {
  return db
    .prepare(
      `SELECT e.*,
              (SELECT COUNT(*) FROM deliveries d WHERE d.event_id = e.id) AS delivery_count
         FROM events e ORDER BY e.id DESC`
    )
    .all();
}

const insertDeliveryStmt = db.prepare(`
  INSERT INTO deliveries
    (public_id, event_id, payload, idempotency_key, status, attempt_count, max_attempts, next_run_at, created_at)
  VALUES
    (@public_id, @event_id, @payload, @idempotency_key, 'pending', 0, @max_attempts, @next_run_at, @created_at)
`);

/**
 * Enqueue a new delivery for an event.
 * @param {object} event   event row
 * @param {string} payload raw request body to deliver (string)
 * @param {string} [idem]  optional caller-supplied idempotency key
 * @param {string} [whenIso] schedule time (default: now)
 */
function enqueueDelivery(event, payload, idem, whenIso = nowIso()) {
  const row = {
    public_id: uuid(),
    event_id: event.id,
    payload: String(payload),
    idempotency_key: idem || `idem_${crypto.randomBytes(12).toString('hex')}`,
    max_attempts: event.max_retries + 1,
    next_run_at: whenIso,
    created_at: nowIso(),
  };
  const info = insertDeliveryStmt.run(row);
  notify();
  return db.prepare('SELECT * FROM deliveries WHERE id = ?').get(info.lastInsertRowid);
}

/* ------------------------------------------------------------------- worker */

const dueStmt = db.prepare(`
  SELECT * FROM deliveries
   WHERE status = 'pending' AND next_run_at <= ?
   ORDER BY next_run_at ASC
`);

const claimStmt = db.prepare(
  `UPDATE deliveries SET status = 'running', attempt_count = attempt_count + 1
    WHERE id = ? AND status = 'pending' AND next_run_at <= ?`
);

const failAttemptStmt = db.prepare(`
  UPDATE deliveries
     SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'pending' END,
         next_run_at = ?,
         last_error = ?,
         finished_at = CASE WHEN attempt_count >= max_attempts THEN ? ELSE finished_at END
   WHERE id = ?
`);

const succeedStmt = db.prepare(
  `UPDATE deliveries SET status = 'succeeded', finished_at = ?, last_error = NULL WHERE id = ?`
);

const insertAttemptStmt = db.prepare(`
  INSERT INTO attempts
    (delivery_id, attempt_no, scheduled_at, started_at, finished_at,
     request_url, request_method, request_headers, request_body,
     response_status, response_headers, response_body, error_message, duration_ms)
  VALUES
    (@delivery_id, @attempt_no, @scheduled_at, @started_at, @finished_at,
     @request_url, @request_method, @request_headers, @request_body,
     @response_status, @response_headers, @response_body, @error_message, @duration_ms)
`);

/** Exponential backoff: base * 2^(n-1), capped at 30 minutes. */
function backoffMs(base, retryNo) {
  return Math.min(30 * 60 * 1000, base * 2 ** Math.max(0, retryNo - 1));
}

function performRequest({ url, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      resolve({ status: null, headers: null, text: '', error: `invalid_url: ${err.message}` });
      return;
    }

    const req = http.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers,
        timeout: timeoutMs,
        // One connection per attempt: avoids a poisoned keep-alive socket from
        // a previous timeout/reset breaking later retries.
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            error: null,
          });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error(`request_timeout_after_${timeoutMs}ms`)));
    req.on('error', (err) =>
      resolve({ status: null, headers: null, text: '', error: err.message })
    );
    req.write(body);
    req.end();
  });
}

async function processDelivery(delivery, event, tickIso) {
  const claimed = claimStmt.run(delivery.id, tickIso);
  if (claimed.changes === 0) return; // another tick / process owns it

  const fresh = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(delivery.id);
  const startedAt = new Date();
  const { header } = sign(event.signing_secret, fresh.payload);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'webhook-sandbox/1.0',
    'X-Webhook-Event': event.public_id,
    'X-Idempotency-Key': fresh.idempotency_key,
    'X-Delivery-Id': fresh.public_id,
    'X-Signature': header,
  };

  const result = await performRequest({
    url: event.target_url,
    headers,
    body: fresh.payload,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  const finishedAt = new Date();
  const ok = result.error === null && result.status >= 200 && result.status < 300;

  insertAttemptStmt.run({
    delivery_id: fresh.id,
    attempt_no: fresh.attempt_count,
    scheduled_at: fresh.next_run_at,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    request_url: event.target_url,
    request_method: 'POST',
    request_headers: JSON.stringify(headers, null, 2),
    request_body: fresh.payload,
    response_status: result.status,
    response_headers: result.headers ? JSON.stringify(result.headers, null, 2) : null,
    response_body: result.text,
    error_message: result.error,
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
  });

  if (ok) {
    succeedStmt.run(finishedAt.toISOString(), fresh.id);
  } else {
    const retryNo = fresh.attempt_count; // attempts used so far (1-based)
    const exhausted = fresh.attempt_count >= fresh.max_attempts;
    const errorSummary =
      result.error || `receiver responded with HTTP ${result.status}`;
    failAttemptStmt.run(
      exhausted ? finishedAt.toISOString() : new Date(finishedAt.getTime() + backoffMs(event.backoff_base_ms, retryNo)).toISOString(),
      errorSummary,
      finishedAt.toISOString(),
      fresh.id
    );
  }
  notify();
}

let wakeup = null;
function notify() {
  if (wakeup) wakeup();
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = nowIso();
    const due = dueStmt.all(now);
    for (const delivery of due) {
      const event = getEvent(delivery.event_id);
      if (!event) {
        db.prepare(
          `UPDATE deliveries SET status='failed', last_error='event_deleted', finished_at=? WHERE id=?`
        ).run(nowIso(), delivery.id);
        continue;
      }
      await processDelivery(delivery, event, now);
    }
  } catch (err) {
    console.error('[worker] tick error:', err);
  } finally {
    running = false;
  }
}

function startWorker() {
  const timer = setInterval(tick, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  // event loop wake support: also run a tick right after enqueue
  wakeup = () => {
    setTimeout(tick, 0);
  };
  console.log(`[worker] started (tick=${TICK_MS}ms, timeout=${REQUEST_TIMEOUT_MS}ms)`);
  return timer;
}

module.exports = {
  defaultTarget,
  createEvent,
  getEvent,
  getEventByPublicId,
  listEvents,
  enqueueDelivery,
  backoffMs,
  startWorker,
  tick,
};
