# I shipped my API key inside my desktop app. Here's the TypeScript gateway that fixed it.

*Raphael Gab-Momoh*

Pinpoint Pro is a desktop workspace I built with React, Vite and Electron. One of its best features is **Smart Stack**: select a pin full of browser tabs, and Gemini groups them into categories like "Research" or "Code review".

While reviewing the code for a portfolio project, I opened `vite.config.ts` and found this:

```ts
define: {
  'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
},
```

`define` is a find-and-replace at build time. Every `process.env.API_KEY` in the app becomes the literal key string, and that string ships inside the JavaScript bundle. Anyone who installs the app can unzip it, search for `AIza`, and spend my Gemini quota.

This is one of the most common mistakes in frontend and desktop apps, and it's easy to make because it works perfectly in development. This article covers how I fixed it, and why the fix is a small DevOps project in its own right.

## The rule: a client can't keep a secret

Anything you ship to a user's machine, whether a browser bundle, an Electron app or a mobile app, belongs to the user. Obfuscation slows people down; it doesn't stop them. So the key has to live somewhere the user can't reach: a server.

But a server that forwards requests to Gemini for anyone who asks just moves the problem. Now the open endpoint is the thing being abused. The server needs three things:

1. **Identity:** who is calling?
2. **Limits:** how much can each caller do?
3. **A ceiling:** what's the most this can ever cost me?

That's **authkit-ts**: about 400 lines of strict TypeScript with no runtime dependencies.

## Identity without accounts

Pinpoint Pro has no user accounts, and I didn't want to add a sign-up flow just to group some tabs. So the app registers itself as a **device**:

```
POST /v1/devices  →  { "token": "eyJ...", "expiresAt": "2026-10-28T..." }
```

The token is an HS256 JWT signed with a server secret. It holds a random device id and an expiry, and nothing else. I wrote the signing with `node:crypto` instead of pulling in a JWT library, which forced me to handle the classic pitfalls explicitly:

- **Constant-time comparison.** `timingSafeEqual` prevents timing attacks on the signature.
- **Pin the algorithm.** The header must exactly match `{"alg":"HS256","typ":"JWT"}`, so an `alg: none` token is rejected as malformed before any signature logic runs. There's a test for it.
- **Rotation.** `TOKEN_SECRETS` is a list. The first secret signs; all of them verify. To rotate, put a new secret first, wait out the token lifetime, then drop the old one. No device gets logged out.

Let's be honest about what this gives us: **anyone can register a device**. A desktop app can't prove it's genuine. Device tokens give me something to *count* against, which is what the limits need.

## Limits that bound the bill

There are three layers, each answering a different attack:

| Limit | Default | Stops |
| --- | --- | --- |
| Registrations per IP | 5/hour | One machine minting thousands of fresh devices |
| Requests per device | 20/minute | One device hammering the endpoint |
| Global daily budget | 5,000/day | Everything else, including a distributed attack |

The daily budget is the important one. Whatever happens, I know the worst-case cost of a day. When it's spent, the gateway returns `503 daily_budget_exhausted` and Gemini is never called.

Order matters too. The handler authenticates first, then checks the per-device limit, then parses and validates the body, and only then takes a unit from the daily budget. A malformed request or an unauthenticated caller never touches the budget or the provider.

## Don't trust either side

The gateway sits between an untrusted client and a model whose output is also untrusted:

- **Input:** 64 KB body cap, 2–100 tabs, titles cut to 300 characters, ids type-checked. The prompt the gateway builds can't be made arbitrarily large.
- **Output:** the model is asked for `[{id, category}]`, but the gateway keeps only entries whose `id` was in the request and cuts categories to 40 characters. A prompt-injected tab title can't make the response invent ids.
- **Errors:** if Gemini fails, the client gets `502 upstream_failed` and nothing more. Provider errors can contain quota details and request ids; those go to the server log.

## Testing the security properties, not just the happy path

The test suite uses Node's built-in `node:test` runner with no framework. It asserts the things that would actually hurt:

```ts
test('a registered device gets groupings, the key stays on the server, and injected ids are dropped', async () => {
  const { token } = await register();
  const res = await stack(token);
  assert.deepEqual(await res.json(), { groups: [{ id: '1', category: 'Work' }, { id: '2', category: 'Work' }] });
  assert.equal(upstreamCalls[0]?.key, 'server-side-key');
  assert.ok(!upstreamCalls[0]?.url.includes('server-side-key'), 'key must not be in the URL');
});
```

The fake Gemini deliberately returns an extra `{"id": "injected"}` entry, and the test proves it gets filtered out. Other tests cover forged payloads, `alg: none`, expired tokens, secret rotation, oversized bodies, rate limits with `Retry-After`, and upstream errors that must not leak. That's 16 tests in all, and they run in about two seconds, including compilation.

`fetch` is passed in as a dependency, so the tests never touch the network or need a real key.

## The DevOps half

A security fix that's hard to deploy doesn't get deployed. So the repo ships the whole path to production.

**Container.** A multi-stage Dockerfile. The build stage runs `npm test`, so an image cannot exist unless the tests pass. The runtime stage is `distroless/nodejs22:nonroot`: no shell, no package manager, not running as root.

**CI (GitHub Actions).** Every push runs:
1. typecheck, tests and `npm audit`
2. a Docker build
3. a **smoke test of the real container**: start it, hit `/healthz`, register a device, confirm `/v1/smart-stack` returns 401 without a token
4. a Trivy scan that fails on fixable HIGH or CRITICAL CVEs
5. on `main` only, a push to GHCR tagged with the commit SHA

**Infrastructure (Terraform → Azure Container Apps).** The Gemini key and token secrets go into the Container App's secret store and reach the process as environment variables. They're never in the image, the repo or a Terraform output. The app gets liveness and readiness probes on `/healthz` and scales to zero when idle.

**Operations.** Config is validated at boot, so a missing key or a 10-character secret crashes the deploy instead of the first request. Logs are structured JSON, one line per request, and `/metrics` exposes Prometheus counters for registrations, auth failures by reason, upstream outcomes and response codes. On SIGTERM the server finishes in-flight requests before exiting, so rolling deploys don't drop traffic.

## The client side

In Pinpoint Pro, the fix is two changes:

1. Delete the `GEMINI_API_KEY` lines from `vite.config.ts`, so the key is gone from the bundle.
2. Replace the direct `GoogleGenAI` call with a small client that registers once, caches the token, refreshes it a day before expiry, and re-registers once on a 401 (a rotated secret).

The client is in `examples/pinpoint-client.ts`, under 50 lines.

**Then rotate the key.** Removing a leaked key from future builds doesn't un-leak it from past ones. Every version already downloaded still contains it, so revoke it in Google AI Studio and give only the gateway the new one.

## What I'd do next

- **Redis-backed limits.** The limiter is in memory, so Terraform pins the app to one replica. The `RateLimiter` interface is small enough to swap for Redis.
- **Real accounts.** If Pinpoint Pro grows sign-in, the token's `sub` becomes a user id, and limits become per person instead of per device.
- **Lock down `/metrics`.** It's public on the ingress today; production should scrape it over the internal network.

## Takeaways

- `define`, `import.meta.env` and `process.env` in frontend build tools **embed values at build time**. If it's in the bundle, it's public.
- Moving a key to a server is half the fix. The other half is **identity, limits and a hard cost ceiling**.
- Test the **security properties** (forged tokens, leaked errors, injected output), not just that the happy path returns 200.
- Make the secure path the easy path: tests in the image build, a smoke test in CI, and secrets in the platform's secret store.

The code is at **github.com/raphgm/authkit-ts**.
