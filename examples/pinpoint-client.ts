// Drop-in replacement for Pinpoint Pro's Smart Stack call (App.tsx).
// The app no longer holds a Gemini key: it registers once, keeps the token,
// and calls the gateway. Remove the GEMINI_API_KEY `define` lines from vite.config.ts.
const GATEWAY = import.meta.env.VITE_AUTHKIT_URL as string;
const TOKEN_KEY = 'pinpoint_authkit_token';

interface Stored {
  token: string;
  expiresAt: string;
}

async function getToken(): Promise<string> {
  const raw = localStorage.getItem(TOKEN_KEY);
  const stored = raw ? (JSON.parse(raw) as Stored) : null;
  // Refresh a day early so a long session never hits an expired token mid-request.
  if (stored && Date.parse(stored.expiresAt) - Date.now() > 86_400_000) return stored.token;

  const res = await fetch(`${GATEWAY}/v1/devices`, { method: 'POST' });
  if (!res.ok) throw new Error(`Could not register device (${res.status})`);
  const fresh = (await res.json()) as Stored;
  localStorage.setItem(TOKEN_KEY, JSON.stringify(fresh));
  return fresh.token;
}

export async function smartStack(tabs: { id: string; title: string }[]): Promise<{ id: string; category: string }[]> {
  const call = async (token: string) =>
    fetch(`${GATEWAY}/v1/smart-stack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ tabs }),
    });

  let res = await call(await getToken());
  if (res.status === 401) {
    // Token was revoked by a secret rotation: register again once.
    localStorage.removeItem(TOKEN_KEY);
    res = await call(await getToken());
  }
  if (res.status === 429) throw new Error('Smart Stack is busy. Try again in a minute.');
  if (!res.ok) throw new Error(`Smart Stack failed (${res.status})`);
  return ((await res.json()) as { groups: { id: string; category: string }[] }).groups;
}
