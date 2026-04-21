// Perplexity research — used for specific, time-sensitive market and company
// research. Returns structured bull/bear summaries by default; callers with
// different response needs (e.g. the universe screener) can override the
// system prompt.

export type PerplexityResult = {
  summary: string;
  citations: string[];
  raw: string;
};

const DEFAULT_SYSTEM =
  'You are a meticulous equity research analyst. Always return (1) a neutral summary, (2) a Bull Case with bullet points, (3) a Bear Case with bullet points, and (4) key sources. Be concise. Cite up-to-date facts.';

export type PerplexityOptions = {
  // Override the system prompt. Use when the default bull/bear framing
  // doesn't match what you need (e.g. ticker discovery for the screener).
  system?: string;
};

export async function perplexitySearch(
  query: string,
  options: PerplexityOptions = {}
): Promise<PerplexityResult> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) {
    return {
      summary: `[perplexity disabled] query was: ${query}`,
      citations: [],
      raw: '',
    };
  }
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar-pro',
      messages: [
        { role: 'system', content: options.system ?? DEFAULT_SYSTEM },
        { role: 'user', content: query },
      ],
      return_citations: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Perplexity error ${res.status}: ${text}`);
  }
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    citations?: string[];
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  return {
    summary: content,
    citations: data.citations ?? [],
    raw: JSON.stringify(data),
  };
}
