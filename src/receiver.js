'use strict';

const express = require('express');
const db = require('./db');
const { getEventByPublicId } = require('./dispatcher');
const { verify } = require('./signing');

const router = express.Router();

const SIGNATURE_TOLERANCE_SECONDS = Number(
  process.env.SIGNATURE_TOLERANCE_SECONDS || 300
);

function nowIso() {
  return new Date().toISOString();
}

function insertReceived(row) {
  db.prepare(
    `INSERT INTO received
       (event_id, delivery_id, idempotency_key, signature_valid, accepted, duplicate,
        reject_reason, scenario, request_headers, request_body, response_status, created_at)
     VALUES
       (@event_id, @delivery_id, @idempotency_key, @signature_valid, @accepted, @duplicate,
        @reject_reason, @scenario, @request_headers, @request_body, @response_status, @created_at)`
  ).run(row);
}

/**
 * Built-in mock receiver.
 * Every incoming request is logged (success or rejection) into `received`.
 *
 * Raw body handling: the app installs express.json only when the request is NOT
 * for this path, so `body` here is the untouched raw bytes used for HMAC.
 *
 * Optional payload fields for simulating failures:
 *   { "_sim": { "scenario": "fail_500" | "fail_404" | "timeout" | "unauthorized" | "ok",
 *               "status": 503, "delay_ms": 2000 } }
 */
router.post('/webhook', (req, res) => {
  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
  const headers = req.headers;
  const createdAt = nowIso();

  const eventPublicId = headers['x-webhook-event'];
  const deliveryId = headers['x-delivery-id'] || null;
  const idemKey = headers['x-idempotency-key'] || null;
  const event = eventPublicId ? getEventByPublicId(String(eventPublicId)) : null;

  const baseLog = {
    event_id: event ? event.id : null,
    delivery_id: deliveryId,
    idempotency_key: idemKey,
    scenario: null,
    request_headers: JSON.stringify(headers, null, 2),
    request_body: rawBody,
    created_at: createdAt,
  };

  function finish(status, { accepted, duplicate = false, sigValid, reason, scenario = null }) {
    insertReceived({
      ...baseLog,
      signature_valid: sigValid ? 1 : 0,
      accepted: accepted ? 1 : 0,
      duplicate: duplicate ? 1 : 0,
      reject_reason: reason,
      scenario,
      response_status: status,
    });
    res.status(status).json({
      received: true,
      accepted: !!accepted,
      duplicate: !!duplicate,
      reject_reason: reason,
      scenario,
    });
  }

  if (!event) {
    return finish(404, {
      accepted: false,
      sigValid: false,
      reason: 'unknown_event',
    });
  }

  // 1) HMAC verification
  const check = verify(headers['x-signature'], rawBody, event.signing_secret, {
    toleranceSeconds: SIGNATURE_TOLERANCE_SECONDS,
  });
  if (!check.valid) {
    return finish(401, { accepted: false, sigValid: false, reason: check.reason });
  }

  // 2) Parse body for simulation hints
  let parsed = {};
  let sim = null;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
    if (parsed && typeof parsed === 'object' && parsed._sim && typeof parsed._sim === 'object') {
      sim = parsed._sim;
    }
  } catch {
    /* non-JSON bodies are allowed; signature was still validated */
  }
  const scenario = sim && typeof sim.scenario === 'string' ? sim.scenario : null;

  const respond = () => {
    // 3) Simulated failures
    if (scenario === 'unauthorized') {
      return finish(401, { accepted: false, sigValid: true, reason: 'simulated_unauthorized', scenario });
    }
    if (scenario === 'fail_404') {
      return finish(404, { accepted: false, sigValid: true, reason: 'simulated_http_404', scenario });
    }
    if (scenario === 'fail_500') {
      return finish(sim.status && Number.isFinite(sim.status) ? sim.status : 500, {
        accepted: false,
        sigValid: true,
        reason: 'simulated_http_5xx',
        scenario,
      });
    }
    if (scenario === 'timeout') {
      // hang until the dispatcher's client timeout fires; still log the attempt
      insertReceived({
        ...baseLog,
        signature_valid: 1,
        accepted: 0,
        duplicate: 0,
        reject_reason: 'simulated_timeout_no_response',
        scenario,
        response_status: 0,
      });
      return; // no response -> client side ETIMEDOUT/ECONNRESET
    }

    // 4) Idempotency: a previously accepted key is a duplicate
    if (idemKey) {
      const prior = db
        .prepare(
          `SELECT id FROM received
            WHERE event_id = ? AND idempotency_key = ? AND accepted = 1
            ORDER BY id DESC LIMIT 1`
        )
        .get(event.id, idemKey);
      if (prior) {
        return finish(200, {
          accepted: false,
          duplicate: true,
          sigValid: true,
          reason: 'duplicate_idempotency_key',
          scenario,
        });
      }
    }

    // 5) Accepted
    return finish(200, { accepted: true, sigValid: true, reason: null, scenario });
  };

  const delay = sim && Number.isFinite(sim.delay_ms) ? Math.min(60000, Number(sim.delay_ms)) : 0;
  if (delay > 0) setTimeout(respond, delay);
  else respond();
});

module.exports = router;
