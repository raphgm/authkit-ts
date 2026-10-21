import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter } from '../src/rateLimit.js';

test('allows up to max hits per window, then reports the wait', () => {
  const rl = new RateLimiter({ max: 2, windowMs: 10_000 });
  assert.equal(rl.hit('k', 0), 0);
  assert.equal(rl.hit('k', 1), 0);
  assert.equal(rl.hit('k', 2_000), 8);
});

test('keys are independent and windows reset', () => {
  const rl = new RateLimiter({ max: 1, windowMs: 1_000 });
  assert.equal(rl.hit('a', 0), 0);
  assert.equal(rl.hit('b', 0), 0);
  assert.ok(rl.hit('a', 500) > 0);
  assert.equal(rl.hit('a', 1_000), 0);
});
