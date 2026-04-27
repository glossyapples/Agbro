// Prompt scaffolds for the lookahead-bias leak test.
//
// The whole sprint hinges on whether we can constrain Claude to a
// point-in-time view of the world via prompting alone. The model's
// training data extends well past 2024; an agent researching AAPL "as
// of 2021-01-01" inherently knows what happened next, and any
// "alpha" we measure historically is contaminated by that hindsight.
//
// We test the constraint with two arms that ask the same structured
// question and only differ in their preamble:
//   - STRICT: explicit, repeated instructions to ignore post-date
//     knowledge, plus a self-check ("If your answer used info you
//     wouldn't have had on $DATE, say so").
//   - UNRESTRICTED: states the date once, no constraints.
//
// Both arms return the SAME JSON schema so the comparison is
// numeric, not vibes-based. We score:
//   1. Price-target accuracy vs actual 1-year return
//   2. Presence of known post-date events in expected_events
//   3. Conviction divergence between arms
//
// If unrestricted is systematically closer to actual than strict,
// the strict scaffold is failing — the model leaks. That kills the
// historical-backtest validation plan and forces a pivot to forward
// paper trading.

export type LeakArm = 'strict' | 'unrestricted';

// Output schema both arms must conform to. JSON-only so we can parse
// + compare numerically. Free-text fields (thesis, events, risks)
// are kept short to bound cost.
export const LEAK_OUTPUT_INSTRUCTIONS = `Return ONLY a JSON object (no prose, no markdown fences) matching:
{
  "thesis": "1-2 sentence summary of your view",
  "twelve_month_price_target_usd": number,
  "conviction_0_to_100": integer,
  "expected_events_next_12mo": ["short event 1", "short event 2", "short event 3"],
  "primary_risks": ["short risk 1", "short risk 2"]
}`;

const STRICT_PREAMBLE = `You are a fundamental equity analyst on the date specified below. CRITICAL RULES:

1. You do NOT know what happened in the markets, in the world, in any company's
   future, or in any data series after the specified date. Anything in your
   training data dated after the specified date is OFF LIMITS — treat it as if
   it does not exist.
2. If you find yourself drawing on knowledge of events from after that date
   (e.g. you "know" a stock surged in 2023 but your decision date is 2021), STOP
   and answer only from what was knowable on the date.
3. When you list expected events for the next 12 months, predict them as a
   contemporaneous analyst would — based on company guidance, sector trends,
   and base rates. Do not list events you remember actually happening.
4. Conviction should reflect the inherent uncertainty of forward prediction.
   A prediction with no hindsight is rarely highly confident.
5. Self-check at the end: re-read your answer. If any part of it would only
   make sense WITH knowledge of post-date events, rewrite that part.`;

const UNRESTRICTED_PREAMBLE = `You are a fundamental equity analyst.`;

export function buildLeakPrompt(args: {
  arm: LeakArm;
  symbol: string;
  decisionDateISO: string;
}): { system: string; user: string } {
  const preamble = args.arm === 'strict' ? STRICT_PREAMBLE : UNRESTRICTED_PREAMBLE;
  const dateLine =
    args.arm === 'strict'
      ? `The date is ${args.decisionDateISO}. You are answering AS OF that date with no knowledge of subsequent events.`
      : `The date is ${args.decisionDateISO}.`;
  return {
    system: `${preamble}\n\n${LEAK_OUTPUT_INSTRUCTIONS}`,
    user: `${dateLine}\n\nProvide a 12-month price target and conviction score for ${args.symbol}. Output the JSON only.`,
  };
}

// Parse the model's JSON output. Tolerant of accidental markdown
// fences or stray prose around the object — extracts the first
// balanced JSON object found. Returns null on unparseable output.
export type LeakResponse = {
  thesis: string;
  twelve_month_price_target_usd: number;
  conviction_0_to_100: number;
  expected_events_next_12mo: string[];
  primary_risks: string[];
};

export function parseLeakResponse(raw: string): LeakResponse | null {
  // Strip markdown fences if present.
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  // Find the first { and walk to the matching }.
  const start = stripped.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (
      typeof parsed?.thesis === 'string' &&
      typeof parsed?.twelve_month_price_target_usd === 'number' &&
      typeof parsed?.conviction_0_to_100 === 'number' &&
      Array.isArray(parsed?.expected_events_next_12mo) &&
      Array.isArray(parsed?.primary_risks)
    ) {
      return parsed as LeakResponse;
    }
    return null;
  } catch {
    return null;
  }
}
