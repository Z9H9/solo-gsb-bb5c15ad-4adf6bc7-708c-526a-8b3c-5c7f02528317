'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const dispatcher = require('./dispatcher');

const PORT = Number(process.env.PORT || 8080);
const SLOW_RECEIVER_MS = Number(process.env.SLOW_RECEIVER_MS || 8000);

const app = express();
// 保留原始请求体（HMAC 校验必须基于发送方原文字节）
const saveRaw = (req, res, buf) => { req.rawBody = buf.toString('utf8'); };
app.use(express.json({ limit: '1mb', verify: saveRaw }));
app.use(express.text({ type: ['text/*', 'application/x-www-form-urlencoded'], limit: '1mb', verify: saveRaw }));

const nowIso = () => new Date().toISOString();
const newId = (p) => `${p}_${crypto.randomUUID()}`;

/* ------------------------------- 事件 API ------------------------------- */

app.get('/api/events', (req, res) => {
  const events = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM deliveries d WHERE d.event_id = e.id) AS delivery_count
    FROM events e ORDER BY e.created_at DESC
  `).all();
  res.json(events);
});

app.post('/api/events', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name 不能为空' });

  let payload = b.payload;
  if (payload === undefined || payload === null || payload === '') payload = '{}';
  if (typeof payload === 'object') payload = JSON.stringify(payload);
  try { JSON.parse(payload); } catch { return res.status(400).json({ error: 'payload 必须是合法 JSON' }); }

  const behavior = ['ok', 'fail', 'flaky', 'slow'].includes(b.behavior) ? b.behavior : 'ok';
  const event = {
    id: newId('evt'),
    name,
    target_url: b.target_url || `http://127.0.0.1:${PORT}/receiver/${behavior}`,
    secret: b.secret || crypto.randomBytes(24).toString('hex'),
    max_retries: Math.max(0, Math.min(10, parseInt(b.max_retries, 10) || 0)),
    backoff_seconds: Math.max(0.5, Math.min(300, parseFloat(b.backoff_seconds) || 2)),
    payload,
    created_at: nowIso(),
  };
  db.prepare(`
    INSERT INTO events (id, name, target_url, secret, max_retries, backoff_seconds, payload, created_at)
    VALUES (@id, @name, @target_url, @secret, @max_retries, @backoff_seconds, @payload, @created_at)
  `).run(event);
  res.status(201).json(event);
});

app.delete('/api/events/:id', (req, res) => {
  const info = db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.status(info.changes ? 204 : 404).end();
});

/** 立即触发一次投递 */
app.post('/api/events/:id/deliver', (req, res) => {
  const delivery = dispatcher.createDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: '事件不存在' });
  res.status(201).json(delivery);
});

/* ------------------------------- 投递 API ------------------------------- */

app.get('/api/deliveries', (req, res) => {
  const clauses = [];
  const params = {};
  if (req.query.event_id) { clauses.push('d.event_id = @event_id'); params.event_id = req.query.event_id; }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT d.*, e.name AS event_name, e.target_url
    FROM deliveries d JOIN events e ON e.id = d.event_id
    ${where}
    ORDER BY d.created_at DESC
    LIMIT 100
  `).all(params);
  res.json(rows);
});

app.get('/api/deliveries/:id', (req, res) => {
  const delivery = db.prepare(`
    SELECT d.*, e.name AS event_name, e.target_url
    FROM deliveries d JOIN events e ON e.id = d.event_id
    WHERE d.id = ?
  `).get(req.params.id);
  if (!delivery) return res.status(404).json({ error: '投递不存在' });
  const attempts = db.prepare('SELECT * FROM attempts WHERE delivery_id = ? ORDER BY attempt_no ASC').all(delivery.id);
  res.json({ ...delivery, attempts });
});

/** 手动重放：基于同一事件生成一次全新投递（新的幂等键） */
app.post('/api/deliveries/:id/replay', (req, res) => {
  const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
  if (!delivery) return res.status(404).json({ error: '投递不存在' });
  const replay = dispatcher.createDelivery(delivery.event_id);
  if (!replay) return res.status(404).json({ error: '所属事件已删除' });
  res.status(201).json(replay);
});

/* ----------------------------- 接收器日志 API ----------------------------- */

app.get('/api/receiver/log', (req, res) => {
  const rows = db.prepare('SELECT * FROM received ORDER BY id DESC LIMIT 100').all();
  res.json(rows);
});

app.delete('/api/receiver/log', (req, res) => {
  db.prepare('DELETE FROM received').run();
  res.status(204).end();
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: nowIso() }));

/* ------------------------------ 内置模拟接收器 ------------------------------ */
/*
 * POST /receiver/:behavior
 *   ok    — 校验签名与幂等键后返回 200
 *   fail  — 始终返回 500（模拟接收方故障，用于观察重试）
 *   flaky — 约 50% 概率返回 500
 *   slow  — 延迟 8s 才响应（客户端 5s 超时 → 触发重试 → 演示幂等去重）
 */
app.post('/receiver/:behavior', async (req, res) => {
  const behavior = req.params.behavior;
  const rawBody = req.rawBody || '';
  const headers = req.headers;

  const eventId = headers['x-webhook-event-id'];
  const event = eventId ? db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) : null;

  // HMAC 校验：sha256 = HMAC(secret, "<timestamp>.<body>")
  let signatureValid = false;
  const sigHeader = headers['x-webhook-signature'] || '';
  const timestamp = headers['x-webhook-timestamp'] || '';
  if (event && sigHeader.startsWith('sha256=')) {
    const expected = dispatcher.sign(event.secret, timestamp, rawBody);
    const a = Buffer.from(sigHeader);
    const b = Buffer.from(expected);
    signatureValid = a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const idemKey = headers['x-idempotency-key'] || '';
  // 幂等：仅当某次投递曾被成功处理（processed=1）时，后续同键投递才被去重
  const duplicate = idemKey
    ? !!db.prepare('SELECT 1 FROM received WHERE idempotency_key = ? AND processed = 1 LIMIT 1').get(idemKey)
    : false;

  // 决定本次行为的结果：fail/flaky 失败时不占用幂等键，重试可再次处理
  let status = 200;
  let processed = 0;
  let payload = { received: true };
  if (!signatureValid) {
    status = 401; payload = { error: 'invalid signature' };
  } else if (duplicate) {
    payload = { received: true, duplicate: true };
  } else {
    switch (behavior) {
      case 'fail':
        status = 500; payload = { error: 'simulated receiver failure' };
        break;
      case 'flaky':
        if (Math.random() < 0.5) { status = 500; payload = { error: 'flaky receiver said no' }; break; }
        processed = 1;
        break;
      case 'slow':
        // 处理成功并占用幂等键，但响应延迟 8s（客户端 5s 超时 → 重试 → 命中去重）
        processed = 1;
        break;
      default:
        processed = 1;
    }
  }

  db.prepare(`
    INSERT INTO received (idempotency_key, delivery_id, event_name, signature_valid, processed, duplicate, behavior, headers, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    idemKey,
    headers['x-webhook-delivery'] || null,
    headers['x-webhook-event'] || null,
    signatureValid ? 1 : 0,
    processed,
    duplicate ? 1 : 0,
    behavior,
    JSON.stringify(headers),
    rawBody.slice(0, 4096),
    nowIso()
  );

  if (behavior === 'slow' && status === 200 && !duplicate) {
    await new Promise((r) => setTimeout(r, SLOW_RECEIVER_MS));
    payload.note = `slow response after ${SLOW_RECEIVER_MS}ms`;
  }
  return res.status(status).json(payload);
});

/* -------------------------------- 静态页面 -------------------------------- */

app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`[server] webhook sandbox listening on http://localhost:${PORT}`);
  dispatcher.start();
});
