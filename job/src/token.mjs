import { createHmac } from 'node:crypto';

function base64url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString('base64url');
}

// Documented Admin API integration token. The secret half of `id:hex` is
// decoded as hexadecimal. Audience is `/admin/`. Lifetime is five minutes.
export function adminToken({ key, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const splitAt = key.indexOf(':');
  if (splitAt <= 0) {
    throw new Error('admin key must be id:hex');
  }
  const id = key.slice(0, splitAt);
  const secret = key.slice(splitAt + 1);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: id }));
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds, exp: nowSeconds + 300, aud: '/admin/' }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', Buffer.from(secret, 'hex')).update(unsigned).digest();
  return `${unsigned}.${base64url(signature)}`;
}

export function verifyAdminToken({ token, key, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const splitAt = key.indexOf(':');
  const id = key.slice(0, splitAt);
  const secret = key.slice(splitAt + 1);
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed' };
  }
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', Buffer.from(secret, 'hex')).update(unsigned).digest('base64url');
  if (expected.length !== parts[2].length || expected !== parts[2]) {
    return { ok: false, reason: 'bad_signature' };
  }
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (header.alg !== 'HS256' || header.kid !== id) {
    return { ok: false, reason: 'header' };
  }
  if (payload.aud !== '/admin/' || payload.exp <= nowSeconds || payload.iat > nowSeconds) {
    return { ok: false, reason: 'claims' };
  }
  return { ok: true, payload };
}
