import { createHmac, timingSafeEqual } from 'node:crypto';

// Ghost v6.73 webhook-trigger.js: HMAC-SHA256(secret, rawBody + decimalMs).
// There is no separator between the body and the timestamp.

export function signWebhook(rawBody, secret, timestampMs) {
  const mac = createHmac('sha256', secret).update(`${rawBody}${timestampMs}`).digest('hex');
  return `sha256=${mac}, t=${timestampMs}`;
}

export function verifyWebhook({ rawBody, signatureHeader, secret }) {
  if (!secret) {
    return { ok: false, reason: 'secret_required' };
  }
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { ok: false, reason: 'missing_signature' };
  }
  const parts = Object.create(null);
  for (const piece of signatureHeader.split(',')) {
    const index = piece.indexOf('=');
    if (index === -1) {
      continue;
    }
    parts[piece.slice(0, index).trim()] = piece.slice(index + 1).trim();
  }
  if (!parts.sha256 || !parts.t || !/^\d+$/.test(parts.t)) {
    return { ok: false, reason: 'malformed_signature' };
  }
  const expected = createHmac('sha256', secret).update(`${rawBody}${parts.t}`).digest('hex');
  const left = Buffer.from(expected, 'hex');
  let right;
  try {
    right = Buffer.from(parts.sha256, 'hex');
  } catch {
    return { ok: false, reason: 'malformed_signature' };
  }
  if (left.length === 0 || left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, timestampMs: Number(parts.t) };
}
