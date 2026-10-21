// Compact HS256 JWTs using only node:crypto. Device tokens are short-lived and
// carry no personal data: just a random device id and an expiry.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface Claims {
  sub: string; // device id
  iat: number; // issued at (seconds)
  exp: number; // expires at (seconds)
}

export type VerifyResult = { ok: true; claims: Claims } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');
const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueToken(secret: string, ttlSeconds: number, now = Date.now()): { token: string; claims: Claims } {
  const iat = Math.floor(now / 1000);
  const claims: Claims = { sub: randomUUID(), iat, exp: iat + ttlSeconds };
  const body = `${HEADER}.${b64url(JSON.stringify(claims))}`;
  return { token: `${body}.${sign(body, secret)}`, claims };
}

export function verifyToken(token: string, secrets: readonly string[], now = Date.now()): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return { ok: false, reason: 'malformed' };
  const [header, payload, signature] = parts as [string, string, string];
  const given = Buffer.from(signature, 'base64url');

  // Accept any active secret so keys can be rotated without logging every device out.
  const valid = secrets.some(secret => {
    const expected = Buffer.from(sign(`${header}.${payload}`, secret), 'base64url');
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return { ok: false, reason: 'malformed' };
  if (claims.exp <= Math.floor(now / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}
