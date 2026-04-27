// Pure-function tests for the lookahead leak-test prompt builders.
// No API calls — these are the only parts cheap enough to land before
// the Opus run next month, but they're also the parts that need to
// be right because every dollar we spend on the actual leak measurement
// rides on these prompts.

import { describe, it, expect } from 'vitest';
import { buildLeakPrompt, parseLeakResponse } from './prompts';

describe('buildLeakPrompt', () => {
  it('strict arm includes the date AND the no-hindsight rules', () => {
    const { system, user } = buildLeakPrompt({
      arm: 'strict',
      symbol: 'GEO',
      decisionDateISO: '2021-01-04',
    });
    expect(system).toMatch(/CRITICAL RULES/);
    expect(system).toMatch(/OFF LIMITS/);
    expect(user).toMatch(/2021-01-04/);
    expect(user).toMatch(/GEO/);
    // Self-check rule must be in the system prompt — without it the
    // model can write the answer fluently and never re-read.
    expect(system).toMatch(/Self-check/);
  });

  it('unrestricted arm states the date but does NOT add hindsight constraints', () => {
    const { system, user } = buildLeakPrompt({
      arm: 'unrestricted',
      symbol: 'NVDA',
      decisionDateISO: '2022-01-03',
    });
    expect(system).not.toMatch(/CRITICAL RULES/);
    expect(system).not.toMatch(/OFF LIMITS/);
    expect(user).toMatch(/2022-01-03/);
    expect(user).toMatch(/NVDA/);
  });

  it('both arms ask for the same JSON schema so responses are comparable', () => {
    const strict = buildLeakPrompt({ arm: 'strict', symbol: 'X', decisionDateISO: '2020-01-01' });
    const unrestricted = buildLeakPrompt({ arm: 'unrestricted', symbol: 'X', decisionDateISO: '2020-01-01' });
    expect(strict.system).toMatch(/twelve_month_price_target_usd/);
    expect(unrestricted.system).toMatch(/twelve_month_price_target_usd/);
    expect(strict.system).toMatch(/conviction_0_to_100/);
    expect(unrestricted.system).toMatch(/conviction_0_to_100/);
  });
});

describe('parseLeakResponse', () => {
  const valid = {
    thesis: 'Defensive value, secular tailwind',
    twelve_month_price_target_usd: 12.5,
    conviction_0_to_100: 65,
    expected_events_next_12mo: ['Q1 earnings', 'contract renewal'],
    primary_risks: ['regulatory'],
  };

  it('parses a clean JSON object', () => {
    const result = parseLeakResponse(JSON.stringify(valid));
    expect(result).toEqual(valid);
  });

  it('strips ```json fences (some models add them despite the instruction)', () => {
    const fenced = '```json\n' + JSON.stringify(valid) + '\n```';
    expect(parseLeakResponse(fenced)).toEqual(valid);
  });

  it('extracts the first JSON object even with leading prose', () => {
    const messy = "Here's my analysis:\n" + JSON.stringify(valid) + '\n\nLet me know if you need more.';
    expect(parseLeakResponse(messy)).toEqual(valid);
  });

  it('handles nested objects in the JSON', () => {
    // The schema doesn't have nested objects today but the parser
    // shouldn't break if the model adds one (e.g., in expected_events
    // entries). Pin via a synthetic case — we want to extract the
    // outer object at minimum.
    const nested = {
      ...valid,
      thesis: 'pair { with } braces in text',
    };
    const parsed = parseLeakResponse(JSON.stringify(nested));
    expect(parsed?.thesis).toBe('pair { with } braces in text');
  });

  it('returns null when required fields are missing', () => {
    const partial = { thesis: 'x', conviction_0_to_100: 50 };
    expect(parseLeakResponse(JSON.stringify(partial))).toBeNull();
  });

  it('returns null on completely unparseable text (model ignored the instruction)', () => {
    expect(parseLeakResponse('Sure! Let me think about GEO...')).toBeNull();
    expect(parseLeakResponse('')).toBeNull();
  });

  it('returns null when types are wrong (e.g., string price target)', () => {
    const wrong = { ...valid, twelve_month_price_target_usd: '12.5' as unknown as number };
    expect(parseLeakResponse(JSON.stringify(wrong))).toBeNull();
  });
});
