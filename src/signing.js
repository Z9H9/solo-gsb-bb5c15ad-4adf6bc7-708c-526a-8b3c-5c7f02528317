'use strict';

const crypto = require('crypto');

/**
 * Stripe-style HMAC signature:
 *   X-Signature: t=<unix seconds>,v1=<hmac sha256 hex of `${t}.${rawBody}`>
 */
function sign(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const signedPayload = `${timestamp}.${rawBody}`;
  const v1 = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return { timestamp, header: `t=${timestamp},v1=${v1}` };
}

function parseSignatureHeader(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Verify an incoming signature. Returns { valid, reason }.
 */
function verify(header, rawBody, secret, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!header) return { valid: false, reason: 'missing_signature_header' };

  const parts = parseSignatureHeader(header);
  if (!parts.t || !parts.v1) return { valid: false, reason: 'malformed_signature_header' };

  const ts = Number(parts.t);
  if (!Number.isFinite(ts)) return { valid: false, reason: 'invalid_timestamp' };
  if (toleranceSeconds > 0 && Math.abs(now / 1000 - ts) > toleranceSeconds) {
    return { valid: false, reason: 'timestamp_outside_tolerance' };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true, reason: null };
}

module.exports = { sign, verify, parseSignatureHeader };
