'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'webhook-sandbox.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id         TEXT    NOT NULL UNIQUE,
  name              TEXT    NOT NULL,
  signing_secret    TEXT    NOT NULL,
  max_retries       INTEGER NOT NULL DEFAULT 3,
  backoff_base_ms   INTEGER NOT NULL DEFAULT 1000,
  target_url        TEXT    NOT NULL,
  created_at        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id         TEXT    NOT NULL UNIQUE,
  event_id          INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  payload           TEXT    NOT NULL,
  idempotency_key   TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'pending',
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL,
  next_run_at       TEXT    NOT NULL,
  last_error        TEXT,
  finished_at       TEXT,
  created_at        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id       INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  attempt_no        INTEGER NOT NULL,
  scheduled_at      TEXT    NOT NULL,
  started_at        TEXT    NOT NULL,
  finished_at       TEXT    NOT NULL,
  request_url       TEXT    NOT NULL,
  request_method    TEXT    NOT NULL,
  request_headers   TEXT    NOT NULL,
  request_body      TEXT    NOT NULL,
  response_status   INTEGER,
  response_headers  TEXT,
  response_body     TEXT,
  error_message     TEXT,
  duration_ms       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS received (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id          INTEGER REFERENCES events(id) ON DELETE SET NULL,
  delivery_id       TEXT,
  idempotency_key   TEXT,
  signature_valid   INTEGER NOT NULL DEFAULT 0,
  accepted          INTEGER NOT NULL DEFAULT 0,
  duplicate         INTEGER NOT NULL DEFAULT 0,
  reject_reason     TEXT,
  scenario          TEXT,
  request_headers   TEXT    NOT NULL,
  request_body      TEXT    NOT NULL,
  response_status   INTEGER NOT NULL,
  created_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_due  ON deliveries(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_attempts_delivery ON attempts(delivery_id);
CREATE INDEX IF NOT EXISTS idx_received_created ON received(created_at);
`);

/* Crash recovery: deliveries claimed as 'running' never finished.
   Re-queue them; attempt_count was already incremented at claim time, so the
   interrupted request counts as one attempt toward max_attempts. */
db.prepare(
  `UPDATE deliveries SET status = 'pending', next_run_at = ? WHERE status = 'running'`
).run(new Date().toISOString());

module.exports = db;
