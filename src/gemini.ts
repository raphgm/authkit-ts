// The only code that ever sees the provider key. It runs on the server, so the
// key never ships inside the desktop app.
export interface Tab {
  id: string;
  title: string;
}

export interface Grouping {
  id: string;
  category: string;
}

export type Fetch = typeof fetch;

export class UpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: { id: { type: 'STRING' }, category: { type: 'STRING' } },
    required: ['id', 'category'],
  },
};

export async function groupTabs(tabs: Tab[], opts: { apiKey: string; model: string; fetch?: Fetch; timeoutMs?: number }): Promise<Grouping[]> {
  const doFetch = opts.fetch ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`;
  const prompt = `Categorize these browser tabs into logical groups. Return a JSON array of objects with "id" and "category" (max 2 words). Tabs: ${JSON.stringify(tabs)}`;

  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  if (!res.ok) throw new UpstreamError(`Gemini returned ${res.status}`, res.status);

  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new UpstreamError('Gemini returned no content', 502);

  // Never trust model output: keep only well-formed entries for tabs we actually sent.
  const known = new Set(tabs.map(t => t.id));
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new UpstreamError('Gemini returned a non-array', 502);
  return parsed
    .filter((g): g is Grouping => typeof g?.id === 'string' && typeof g?.category === 'string' && known.has(g.id))
    .map(g => ({ id: g.id, category: g.category.slice(0, 40) }));
}
