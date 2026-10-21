import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { groupTabs, UpstreamError, type Fetch, type Tab } from './gemini.js';
import { Metrics } from './metrics.js';
import { RateLimiter } from './rateLimit.js';
import { issueToken, verifyToken } from './token.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TABS = 100;
const MAX_TITLE = 300;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly headers: Record<string, string> = {}) {
    super(code);
  }
}

export interface Deps {
  config: Config;
  fetch?: Fetch;
  now?: () => number;
}

export function buildServer({ config, fetch, now = Date.now }: Deps): { server: Server; metrics: Metrics } {
  const metrics = new Metrics();
  const perDevice = new RateLimiter({ max: config.requestsPerMinute, windowMs: 60_000 });
  const perIpRegistration = new RateLimiter({ max: config.registrationsPerHour, windowMs: 3_600_000 });
  // A global daily cap bounds the worst case: even a flood of fresh devices can't run up the bill.
  const daily = new RateLimiter({ max: config.dailyRequestBudget, windowMs: 86_400_000 });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = `${req.method} ${url.pathname}`;

    if (key === 'GET /healthz') return send(res, 200, { status: 'ok' });
    if (key === 'GET /metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(metrics.render());
      return;
    }

    if (key === 'POST /v1/devices') {
      const wait = perIpRegistration.hit(clientIp(req, config.trustProxy), now());
      if (wait) throw new HttpError(429, 'too_many_registrations', { 'retry-after': String(wait) });
      const { token, claims } = issueToken(config.tokenSecrets[0]!, config.tokenTtlSeconds, now());
      metrics.inc('authkit_devices_registered_total');
      return send(res, 201, { token, expiresAt: new Date(claims.exp * 1000).toISOString() });
    }

    if (key === 'POST /v1/smart-stack') {
      const deviceId = authenticate(req);
      const wait = perDevice.hit(deviceId, now());
      if (wait) throw new HttpError(429, 'rate_limited', { 'retry-after': String(wait) });
      const tabs = parseTabs(await readJson(req));
      if (daily.hit('global', now())) throw new HttpError(503, 'daily_budget_exhausted');
      try {
        const groups = await groupTabs(tabs, {
          apiKey: config.geminiApiKey,
          model: config.geminiModel,
          ...(fetch ? { fetch } : {}),
        });
        metrics.inc('authkit_upstream_requests_total', { outcome: 'ok' });
        return send(res, 200, { groups });
      } catch (err) {
        metrics.inc('authkit_upstream_requests_total', { outcome: 'error' });
        // Never echo upstream details: they can include request ids or quota info.
        console.error('upstream error', err instanceof Error ? err.message : err);
        throw new HttpError(502, 'upstream_failed');
      }
    }

    throw new HttpError(404, 'not_found');
  }

  function authenticate(req: IncomingMessage): string {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new HttpError(401, 'missing_token');
    const result = verifyToken(token, config.tokenSecrets, now());
    if (!result.ok) {
      metrics.inc('authkit_auth_failures_total', { reason: result.reason });
      throw new HttpError(401, result.reason);
    }
    return result.claims.sub;
  }

  const server = createServer((req, res) => {
    const started = now();
    applyCors(req, res, config.allowedOrigins);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    route(req, res)
      .catch((err: unknown) => {
        if (err instanceof HttpError) return send(res, err.status, { error: err.code }, err.headers);
        console.error('unhandled', err);
        send(res, 500, { error: 'internal' });
      })
      .finally(() => {
        metrics.inc('authkit_http_requests_total', { status: String(res.statusCode) });
        if (process.env.NODE_ENV !== 'test') {
          console.log(JSON.stringify({ method: req.method, path: req.url, status: res.statusCode, ms: now() - started }));
        }
      });
  });

  return { server, metrics };
}

function parseTabs(body: unknown): Tab[] {
  const tabs = (body as { tabs?: unknown })?.tabs;
  if (!Array.isArray(tabs) || tabs.length < 2 || tabs.length > MAX_TABS) throw new HttpError(400, 'tabs_must_be_2_to_100');
  return tabs.map(t => {
    const { id, title } = (t ?? {}) as { id?: unknown; title?: unknown };
    if (typeof id !== 'string' || typeof title !== 'string' || id.length > 100) throw new HttpError(400, 'invalid_tab');
    return { id, title: title.slice(0, MAX_TITLE) };
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'expected_json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (trustProxy && typeof forwarded === 'string') return forwarded.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function applyCors(req: IncomingMessage, res: ServerResponse, allowed: string[]): void {
  const origin = req.headers.origin;
  if (!origin || !allowed.includes(origin)) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
