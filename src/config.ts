// All configuration comes from the environment and is validated once at boot,
// so a bad deploy fails fast instead of on the first request.
export interface Config {
  port: number;
  tokenSecrets: string[];
  tokenTtlSeconds: number;
  geminiApiKey: string;
  geminiModel: string;
  requestsPerMinute: number;
  registrationsPerHour: number;
  dailyRequestBudget: number;
  allowedOrigins: string[];
  trustProxy: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // TOKEN_SECRETS is comma-separated: the first signs new tokens, the rest still verify (rotation).
  const tokenSecrets = required(env, 'TOKEN_SECRETS').split(',').map(s => s.trim()).filter(Boolean);
  if (tokenSecrets.some(s => s.length < 32)) throw new Error('Each TOKEN_SECRETS entry must be at least 32 characters');

  return {
    port: int(env, 'PORT', 8080),
    tokenSecrets,
    tokenTtlSeconds: int(env, 'TOKEN_TTL_SECONDS', 7 * 24 * 3600),
    geminiApiKey: required(env, 'GEMINI_API_KEY'),
    geminiModel: env.GEMINI_MODEL?.trim() || 'gemini-3-flash-preview',
    requestsPerMinute: int(env, 'REQUESTS_PER_MINUTE', 20),
    registrationsPerHour: int(env, 'REGISTRATIONS_PER_HOUR', 5),
    dailyRequestBudget: int(env, 'DAILY_REQUEST_BUDGET', 5000),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    // Only trust X-Forwarded-For behind a proxy you control (Container Apps, a load balancer).
    trustProxy: env.TRUST_PROXY === 'true',
  };
}
