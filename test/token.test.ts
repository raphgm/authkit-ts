import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issueToken, verifyToken } from '../src/token.js';

const SECRET = 'a'.repeat(32);
const OLD = 'b'.repeat(32);

test('a fresh token verifies', () => {
  const { token, claims } = issueToken(SECRET, 60);
  const result = verifyToken(token, [SECRET]);
  assert.deepEqual(result, { ok: true, claims });
});

test('an expired token is rejected', () => {
  const { token } = issueToken(SECRET, 60, 0);
  assert.deepEqual(verifyToken(token, [SECRET], 61_000), { ok: false, reason: 'expired' });
});

test('a tampered payload is rejected', () => {
  const { token } = issueToken(SECRET, 60);
  const [h, , s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', iat: 0, exp: 9e9 })).toString('base64url');
  assert.deepEqual(verifyToken(`${h}.${forged}.${s}`, [SECRET]), { ok: false, reason: 'bad_signature' });
});

test('alg:none tokens are rejected', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 'x', iat: 0, exp: 9e9 })).toString('base64url');
  assert.deepEqual(verifyToken(`${header}.${body}.`, [SECRET]), { ok: false, reason: 'malformed' });
});

test('tokens signed with a rotated-out secret still verify while it is listed', () => {
  const { token } = issueToken(OLD, 60);
  assert.equal(verifyToken(token, [SECRET, OLD]).ok, true);
  assert.deepEqual(verifyToken(token, [SECRET]), { ok: false, reason: 'bad_signature' });
});
