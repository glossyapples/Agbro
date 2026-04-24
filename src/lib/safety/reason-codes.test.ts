// Pure tests for the reason-code module. The goal here is to pin the
// enum / template contract so adding a new code without updating both
// places fails CI, and rendering never throws on well-formed input.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  REASON_CODES,
  RENDER,
  isReasonCode,
  renderReason,
  renderCodedReason,
  summarize,
  type CodedReason,
  type GovernorVerdict,
} from './reason-codes';

describe('reason-codes enum', () => {
  it('every declared code has a renderer (no orphans)', () => {
    for (const code of REASON_CODES) {
      expect(typeof RENDER[code]).toBe('function');
    }
    // And no extra renderers — the RENDER map has exactly one entry per code.
    expect(Object.keys(RENDER).sort()).toEqual([...REASON_CODES].sort());
  });

  it('isReasonCode accepts every declared code and nothing else', () => {
    for (const code of REASON_CODES) expect(isReasonCode(code)).toBe(true);
    expect(isReasonCode('')).toBe(false);
    expect(isReasonCode(null)).toBe(false);
    expect(isReasonCode('earnings_blackout')).toBe(false); // case-sensitive
    expect(isReasonCode(42)).toBe(false);
  });

  it('isReasonCode rejects arbitrary input without throwing (property)', () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        if (typeof x === 'string' && (REASON_CODES as readonly string[]).includes(x)) return;
        expect(isReasonCode(x)).toBe(false);
      })
    );
  });
});

describe('reason-code rendering', () => {
  it('every template produces a non-empty string for typical params', () => {
    const examples: CodedReason[] = [
      { code: 'INVALID_INPUT', params: { message: 'qty must be positive' } },
      { code: 'LIMIT_PRICE_REQUIRED', params: {} },
      { code: 'ACCOUNT_STOPPED', params: {} },
      { code: 'ACCOUNT_PAUSED', params: {} },
      {
        code: 'MOS_INSUFFICIENT',
        params: { mosPct: 12.3, strategyMinPct: 20, strategyName: 'Buffett Core' },
      },
      { code: 'EARNINGS_BLACKOUT', params: { symbol: 'AAPL', nextEarningsAt: new Date('2026-05-01') } },
      { code: 'EARNINGS_BLACKOUT', params: { symbol: 'AAPL', nextEarningsAt: null } },
      { code: 'WASH_SALE_VIOLATION', params: { symbol: 'AAPL', windowEndsAt: new Date('2026-05-20') } },
      { code: 'WASH_SALE_VIOLATION', params: { symbol: 'AAPL', windowEndsAt: null } },
      {
        code: 'WALLET_INSUFFICIENT',
        params: {
          symbol: 'AAPL',
          needCents: 500_000n,
          haveCents: 200_000n,
          walletCents: 300_000n,
        },
      },
      {
        code: 'NOTIONAL_CAP_EXCEEDED',
        params: { symbol: 'AAPL', needCents: 900_000n, capCents: 500_000n },
      },
      { code: 'NO_PRICE_FOR_CAP', params: { symbol: 'AAPL' } },
      { code: 'DAILY_TRADE_CAP_EXCEEDED', params: { cap: 3 } },
      { code: 'OBSERVE_MODE_INTERCEPTED', params: { symbol: 'AAPL' } },
      { code: 'PROPOSE_MODE_REQUIRES_APPROVAL', params: { symbol: 'AAPL' } },
      { code: 'BUDGET_EXCEEDED', params: { mtdSpendUsd: 45.5, budgetUsd: 50 } },
      {
        code: 'MANDATE_CONCENTRATION_BREACH',
        params: { symbol: 'AAPL', wouldBePct: 11.2, capPct: 8 },
      },
      {
        code: 'MANDATE_SECTOR_BREACH',
        params: { sector: 'Tech', wouldBePct: 42, capPct: 30 },
      },
      { code: 'MANDATE_FORBIDDEN_SYMBOL', params: { symbol: 'AAPL' } },
      { code: 'MANDATE_FORBIDDEN_SECTOR', params: { symbol: 'AAPL', sector: 'Tech' } },
      { code: 'MANDATE_CASH_RESERVE_BREACH', params: { floorPct: 10, wouldBePct: 7.5 } },
    ];
    // Every declared code should be exercised.
    const codesCovered = new Set(examples.map((e) => e.code));
    for (const code of REASON_CODES) {
      expect(codesCovered.has(code), `missing example for ${code}`).toBe(true);
    }
    for (const ex of examples) {
      const s = renderCodedReason(ex);
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    }
  });

  it('templates never exceed a soft length ceiling (UX readability)', () => {
    // 280 chars is the rough limit for a mobile card without wrapping
    // three lines. Not a hard security property — just a UX smoke test.
    const examples: CodedReason[] = [
      { code: 'MOS_INSUFFICIENT', params: { mosPct: 12.3, strategyMinPct: 20, strategyName: 'Buffett Core' } },
      { code: 'WALLET_INSUFFICIENT', params: { symbol: 'AAPL', needCents: 500_000n, haveCents: 200_000n, walletCents: 300_000n } },
      { code: 'MANDATE_FORBIDDEN_SECTOR', params: { symbol: 'AAPL', sector: 'Tech' } },
    ];
    for (const ex of examples) {
      expect(renderCodedReason(ex).length).toBeLessThanOrEqual(280);
    }
  });

  it('renderReason is a pure function of its inputs (property)', () => {
    fc.assert(
      fc.property(
        fc.record({
          symbol: fc.string({ minLength: 1, maxLength: 5 }).map((s) => s.toUpperCase()),
          cap: fc.integer({ min: 1, max: 20 }),
          wouldBe: fc.float({ min: 0, max: 100, noNaN: true }),
        }),
        ({ symbol, cap, wouldBe }) => {
          const a = renderReason('MANDATE_CONCENTRATION_BREACH', {
            symbol,
            wouldBePct: wouldBe,
            capPct: cap,
          });
          const b = renderReason('MANDATE_CONCENTRATION_BREACH', {
            symbol,
            wouldBePct: wouldBe,
            capPct: cap,
          });
          expect(a).toBe(b);
          expect(a).toContain(symbol);
        }
      )
    );
  });
});

describe('GovernorVerdict helpers', () => {
  it('summarize returns "Approved." on an empty-reason verdict', () => {
    const v: GovernorVerdict = { decision: 'approved', reasons: [] };
    expect(summarize(v)).toBe('Approved.');
  });

  it('summarize uses the first reason as the headline', () => {
    const v: GovernorVerdict = {
      decision: 'rejected',
      reasons: [
        { code: 'EARNINGS_BLACKOUT', params: { symbol: 'AAPL', nextEarningsAt: null } },
        { code: 'WASH_SALE_VIOLATION', params: { symbol: 'AAPL', windowEndsAt: null } },
      ],
    };
    expect(summarize(v)).toContain('blackout');
  });
});
