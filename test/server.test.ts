import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import type { Fetch } from '../src/gemini.js';
import { buildServer } from '../src/server.js';

process.env.NODE_ENV = 'test';

let upstreamCalls: { url: string; key: string | null }[] = [];
let upstreamFails = false;
const fakeGemini: Fetch = async (input, init) => {
  upstreamCalls.push({ url: String(input), key: new Headers(init?.headers).get('x-goog-api-key') });
  if (upstreamFails) return new Response('quota details', { status: 429 });
  const tabs = JSON.parse(JSON.parse(String(init?.body)).contents[0].parts[0].text.split('Tabs: ')[1]) as { id: string }[];
  const groups = [...tabs.map(t => ({ id: t.id, category: 'Work' })), { id: 'injected', category: 'Evil' }];
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(groups) }] } }] });
};

const config = loadConfig({
  TOKEN_SECRETS: 's'.repeat(32),
  GEMINI_API_KEY: 'server-side-key',
  REQUESTS_PER_MINUTE: '3',
  REGISTRATIONS_PER_HOUR: '2',
});
const { server } = buildServer({ config, fetch: fakeGemini });
let base = '';

before(async () => {
  await new Promise<void>(r => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const tabs = [{ id: '1', title: 'GitHub' }, { id: '2', title: 'Jira' }];
const stack = (token: string | null, body: unknown = { tabs }) =>
  fetch(`${base}/v1/smart-stack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const register = async () => (await (await fetch(`${base}/v1/devices`, { method: 'POST' })).json()) as { token: string };

test('healthz is open', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('smart-stack requires a token', async () => {
  const res = await stack(null);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'missing_token' });
  assert.equal(upstreamCalls.length, 0);
});

test('a registered device gets groupings, the key stays on the server, and injected ids are dropped', async () => {
  upstreamCalls = [];
  const { token } = await register();
  const res = await stack(token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { groups: [{ id: '1', category: 'Work' }, { id: '2', category: 'Work' }] });
  assert.equal(upstreamCalls[0]?.key, 'server-side-key');
  assert.ok(!upstreamCalls[0]?.url.includes('server-side-key'), 'key must not be in the URL');
});

test('per-device rate limit returns 429 with retry-after', async () => {
  const { token } = await register();
  for (let i = 0; i < 3; i++) assert.equal((await stack(token)).status, 200);
  const res = await stack(token);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('registration is rate limited per IP', async () => {
  // Two registrations were used by earlier tests in this file.
  assert.equal((await fetch(`${base}/v1/devices`, { method: 'POST' })).status, 429);
});

test('bad input is rejected before reaching the provider', async () => {
  const fresh = buildServer({ config, fetch: fakeGemini }).server;
  await new Promise<void>(r => fresh.listen(0, r));
  const url = `http://127.0.0.1:${(fresh.address() as AddressInfo).port}`;
  const { token } = (await (await fetch(`${url}/v1/devices`, { method: 'POST' })).json()) as { token: string };
  upstreamCalls = [];
  const post = (body: string, type = 'application/json') =>
    fetch(`${url}/v1/smart-stack`, { method: 'POST', headers: { 'content-type': type, authorization: `Bearer ${token}` }, body });
  assert.equal((await post(JSON.stringify({ tabs: [tabs[0]] }))).status, 400);
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post('x'.repeat(70_000))).status, 413);
  assert.equal(upstreamCalls.length, 0);
  fresh.close();
});

test('upstream errors are not leaked to the client', async () => {
  const fresh = buildServer({ config, fetch: fakeGemini }).server;
  await new Promise<void>(r => fresh.listen(0, r));
  const url = `http://127.0.0.1:${(fresh.address() as AddressInfo).port}`;
  const { token } = (await (await fetch(`${url}/v1/devices`, { method: 'POST' })).json()) as { token: string };
  upstreamFails = true;
  const res = await fetch(`${url}/v1/smart-stack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tabs }),
  });
  upstreamFails = false;
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'upstream_failed' });
  fresh.close();
});
