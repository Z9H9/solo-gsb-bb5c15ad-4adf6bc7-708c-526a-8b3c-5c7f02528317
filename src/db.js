'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'sandbox.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  target_url      TEXT NOT NULL,
  secret          TEXT NOT NULL,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  backoff_seconds REAL    NOT NULL DEFAULT 2,
  payload         TEXT    NOT NULL DEFAULT '{}',
  created_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | delivering | delivered | failed
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_event ON deliveries(event_id, created_at);

CREATE TABLE IF NOT EXISTS attempts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id      TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt_no       INTEGER NOT NULL,
  request_headers  TEXT,
  request_body     TEXT,
  response_status  INTEGER,
  response_headers TEXT,
  response_body    TEXT,
  error            TEXT,
  duration_ms      INTEGER,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_delivery ON attempts(delivery_id, attempt_no);

-- 模拟接收器侧的幂等登记表
CREATE TABLE IF NOT EXISTS received (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key  TEXT NOT NULL,
  delivery_id      TEXT,
  event_name       TEXT,
  signature_valid  INTEGER NOT NULL DEFAULT 0,
  processed        INTEGER NOT NULL DEFAULT 0,   -- 是否已成功处理（占用幂等键）
  duplicate        INTEGER NOT NULL DEFAULT 0,   -- 是否被去重的重复投递
  behavior         TEXT,
  headers          TEXT,
  body             TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_received_key ON received(idempotency_key);
`);

module.exports = db;
