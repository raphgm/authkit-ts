import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';

const base = { TOKEN_SECRETS: 'x'.repeat(32), GEMINI_API_KEY: 'k' };

test('applies defaults', () => {
  const c = loadConfig(base);
  assert.equal(c.port, 8080);
  assert.equal(c.trustProxy, false);
  assert.deepEqual(c.tokenSecrets, ['x'.repeat(32)]);
});

test('fails fast on a missing key or a weak secret', () => {
  assert.throws(() => loadConfig({ TOKEN_SECRETS: 'x'.repeat(32) }), /GEMINI_API_KEY/);
  assert.throws(() => loadConfig({ ...base, TOKEN_SECRETS: 'short' }), /32 characters/);
  assert.throws(() => loadConfig({ ...base, PORT: 'abc' }), /PORT/);
});
