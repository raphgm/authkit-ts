# authkit-ts

A small, dependency-free TypeScript auth gateway that keeps AI provider keys off the client.

It was built for [Pinpoint Pro](https://github.com/raphgm/pinpointpro), a desktop app whose Vite config baked `GEMINI_API_KEY` into the shipped JavaScript. Anyone who downloaded the app could read the key. authkit-ts moves the key to a server and puts device tokens, rate limits and a spending cap in front of it.

```
Pinpoint Pro ──POST /v1/devices──────────▶ authkit-ts ── issues signed device token
Pinpoint Pro ──POST /v1/smart-stack──────▶ authkit-ts ──(server-side key)──▶ Gemini
              Authorization: Bearer <token>   │
                                              ├─ verify HS256 token (rotatable secrets)
                                              ├─ per-device rate limit (429 + Retry-After)
                                              ├─ validate + cap input (size, count, length)
                                              ├─ global daily budget (503 when spent)
                                              └─ filter model output to known tab ids
```

## What's in it

| Area | Detail |
| --- | --- |
| **TypeScript** | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; no runtime dependencies (only `node:crypto` and `node:http`) |
| **Auth** | HS256 device tokens with constant-time signature checks, expiry, and secret rotation (`TOKEN_SECRETS=new,old`) |
| **Abuse limits** | Registrations per IP per hour, requests per device per minute, and a global daily request budget |
| **Safety** | 64 KB body cap, input validation before any provider call, upstream errors never echoed to clients, model output filtered |
| **Tests** | 16 tests on `node:test`, including forged tokens, `alg:none`, rate limits, and checks that the key never reaches the client or the URL |
| **Container** | Multi-stage build; tests run inside the build; distroless non-root runtime with no shell |
| **CI** | Typecheck, tests, `npm audit`, image build, container smoke test, Trivy scan, push to GHCR |
| **Infra** | Terraform for Azure Container Apps: secrets in the app's secret store, health probes, scale to zero |
| **Ops** | JSON request logs, Prometheus `/metrics`, graceful shutdown on SIGTERM |

## Run it

```bash
npm ci
npm test
TOKEN_SECRETS=$(openssl rand -hex 32) GEMINI_API_KEY=your-key npm start
```

```bash
TOKEN=$(curl -s -X POST localhost:8080/v1/devices | jq -r .token)
curl -s localhost:8080/v1/smart-stack \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"tabs":[{"id":"1","title":"GitHub PR"},{"id":"2","title":"Jira board"}]}'
```

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `TOKEN_SECRETS` | required | Comma-separated, each ≥ 32 chars. First signs; all verify. |
| `GEMINI_API_KEY` | required | Never leaves the server. |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | |
| `TOKEN_TTL_SECONDS` | `604800` | 7 days |
| `REQUESTS_PER_MINUTE` | `20` | Per device |
| `REGISTRATIONS_PER_HOUR` | `5` | Per IP |
| `DAILY_REQUEST_BUDGET` | `5000` | Across all devices |
| `ALLOWED_ORIGINS` | empty | CORS allow-list |
| `TRUST_PROXY` | `false` | Read `X-Forwarded-For` only behind a proxy you control |

## Deploy

```bash
cd infra
terraform init
terraform apply -var image=ghcr.io/raphgm/authkit-ts:<sha> \
  -var gemini_api_key="$GEMINI_API_KEY" -var token_secrets="$(openssl rand -hex 32)"
```

## Limits, stated plainly

- **Device tokens are anonymous.** A desktop app can't keep a secret, so anyone can register a device. The defence is the limits: per-IP registration, per-device rate, and the daily budget, which caps the worst-case bill. Add real user sign-in if you need per-person quotas.
- **Rate limits live in memory**, so Terraform pins the app to one replica. Move them to Redis before scaling out.
- **`/metrics` is public** on the ingress. Restrict it, or scrape over an internal network, in production.

## Client integration

See [`examples/pinpoint-client.ts`](examples/pinpoint-client.ts) for the replacement for Pinpoint Pro's direct Gemini call, and [`docs/article.md`](docs/article.md) for the write-up.

MIT licensed.
