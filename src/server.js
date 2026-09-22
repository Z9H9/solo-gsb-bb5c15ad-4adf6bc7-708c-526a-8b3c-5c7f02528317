'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const dispatcher = require('./dispatcher');
const receiverRouter = require('./receiver');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');

/* The mock receiver needs the untouched raw body for HMAC verification. */
app.use('/receiver', express.raw({ type: '*/*', limit: '2mb' }), receiverRouter);

/* JSON API */
app.use(express.json({ limit: '2mb' }));

const api = express.Router();
app.use('/api', api);

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function notFound(res, message = 'not_found') {
  return res.status(404).json({ error: message });
}

function serializeDelivery(row) {
  return {
    ...row,
    payload: safeJson(row.payload),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* --------------------------------------------------------------- event CRUD */

api.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

api.post('/events', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return badRequest(res, 'name is required');

  const event = dispatcher.createEvent({
    name,
    signing_secret:
      b.signing_secret != null && String(b.signing_secret).length > 0
        ? String(b.signing_secret)
        : crypto.randomBytes(16).toString('hex'),
    max_retries: b.max_retries,
    backoff_base_ms: b.backoff_base_ms,
    target_url: b.target_url,
  });
  res.status(201).json(event);
});

api.get('/events', (_req, res) => {
  res.json(dispatcher.listEvents());
});

api.get('/events/:publicId', (req, res) => {
  const event = dispatcher.getEventByPublicId(req.params.publicId);
  if (!event) return notFound(res, 'event_not_found');
  res.json(event);
});

api.delete('/events/:publicId', (req, res) => {
  const event = dispatcher.getEventByPublicId(req.params.publicId);
  if (!event) return notFound(res, 'event_not_found');
  db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
  res.status(204).end();
});

/* ------------------------------------------------------------ deliveries API */

api.get('/events/:publicId/deliveries', (req, res) => {
  const event = dispatcher.getEventByPublicId(req.params.publicId);
  if (!event) return notFound(res, 'event_not_found');
  const limit = Math.min(200, Number(req.query.limit) || 100);
  const rows = db
    .prepare('SELECT * FROM deliveries WHERE event_id = ? ORDER BY id DESC LIMIT ?')
    .all(event.id, limit);
  res.json(rows.map(serializeDelivery));
});

api.post('/events/:publicId/deliveries', (req, res) => {
  const event = dispatcher.getEventByPublicId(req.params.publicId);
  if (!event) return notFound(res, 'event_not_found');

  const b = req.body || {};
  let rawPayload;
  if (typeof b.payload === 'string') rawPayload = b.payload;
  else if (b.payload != null) rawPayload = JSON.stringify(b.payload);
  else rawPayload = JSON.stringify({ event: event.name, ts: Date.now() });

  if (rawPayload.length === 0) return badRequest(res, 'payload must not be empty');

  let when = new Date();
  const delay = Number(b.delay_ms);
  if (Number.isFinite(delay) && delay > 0) when = new Date(when.getTime() + Math.min(delay, 60 * 60 * 1000));

  const delivery = dispatcher.enqueueDelivery(
    event,
    rawPayload,
    b.idempotency_key ? String(b.idempotency_key) : undefined,
    when.toISOString()
  );
  res.status(201).json(serializeDelivery(delivery));
});

api.get('/deliveries/:publicId', (req, res) => {
  const delivery = db
    .prepare('SELECT * FROM deliveries WHERE public_id = ?')
    .get(req.params.publicId);
  if (!delivery) return notFound(res, 'delivery_not_found');

  const attempts = db
    .prepare('SELECT * FROM attempts WHERE delivery_id = ? ORDER BY attempt_no ASC')
    .all(delivery.id)
    .map((a) => ({
      ...a,
      request_headers: safeJson(a.request_headers),
      response_headers: a.response_headers ? safeJson(a.response_headers) : null,
    }));

  res.json({ ...serializeDelivery(delivery), attempts });
});

/**
 * Manual replay: enqueue a fresh delivery carrying the same payload.
 * By default a NEW idempotency key is minted (so the receiver accepts again).
 * Pass { "keep_idempotency_key": true } to replay the identical key, which the
 * receiver will flag as a duplicate.
 */
api.post('/deliveries/:publicId/replay', (req, res) => {
  const original = db
    .prepare('SELECT * FROM deliveries WHERE public_id = ?')
    .get(req.params.publicId);
  if (!original) return notFound(res, 'delivery_not_found');

  const event = dispatcher.getEvent(original.event_id);
  if (!event) return notFound(res, 'event_not_found');

  const b = req.body || {};
  const delivery = dispatcher.enqueueDelivery(
    event,
    original.payload,
    b.keep_idempotency_key ? original.idempotency_key : undefined
  );
  res.status(201).json(serializeDelivery(delivery));
});

/* --------------------------------------------------------- receiver log API */

api.get('/received', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 100);
  let rows;
  if (req.query.event_public_id) {
    const event = dispatcher.getEventByPublicId(String(req.query.event_public_id));
    if (!event) return notFound(res, 'event_not_found');
    rows = db
      .prepare('SELECT * FROM received WHERE event_id = ? ORDER BY id DESC LIMIT ?')
      .all(event.id, limit);
  } else {
    rows = db.prepare('SELECT * FROM received ORDER BY id DESC LIMIT ?').all(limit);
  }
  res.json(
    rows.map((r) => ({
      ...r,
      request_headers: safeJson(r.request_headers),
      request_body: safeJson(r.request_body),
    }))
  );
});

/* -------------------------------------------------------------- static UI --- */

app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

/* Error handler */
app.use((err, _req, res, _next) => {
  console.error('[http]', err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json_body' });
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Webhook Sandbox listening on http://${HOST}:${PORT}`);
  console.log(`UI:                 http://localhost:${PORT}/`);
  console.log(`Mock receiver URL:  ${dispatcher.defaultTarget()}`);
  dispatcher.startWorker();
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

module.exports = app;
