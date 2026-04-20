// Google Programmable Search — general/background research.
// Requires GOOGLE_CSE_KEY + GOOGLE_CSE_CX.

export type GoogleResult = {
  title: string;
  link: string;
  snippet: string;
};

export async function googleSearch(query: string, num = 5): Promise<GoogleResult[]> {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) {
    return [
      {
        title: '[google disabled]',
        link: '',
        snippet: `Would have searched: ${query}`,
      },
    ];
  }
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', key);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(num));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Google CSE ${res.status}`);
  const data = (await res.json()) as {
    items?: Array<{ title: string; link: string; snippet: string }>;
  };
  return (data.items ?? []).map((i) => ({
    title: i.title,
    link: i.link,
    snippet: i.snippet,
  }));
}
