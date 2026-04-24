// Regression test pinning the exit-review denominator fix.
//
// Backstory: the first live Quality Compounders meeting flagged a
// process bug — evaluate_exits kept marking VOO and SCHD as over-cap
// trim candidates even though they were small relative to total
// equity. Root cause: the maxPositionPct denominator summed only
// position market_value, ignoring cash. For a user 85% cash the
// denominator collapsed to ~$15k and every position looked >50% of
// "portfolio" against the 15% cap.
//
// The fix switched the denominator to live broker portfolio_value
// (cash + positions + everything else). These tests pin that shape
// so a future refactor can't silently regress to the cash-blind
// calculation that was burning agent tokens on false positives.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { getPositions, getBrokerAccount, getLatestPrice } = vi.hoisted(() => ({
  getPositions: vi.fn(),
  getBrokerAccount: vi.fn(),
  getLatestPrice: vi.fn(),
}));

const {
  strategyFindFirst,
  positionFindMany,
  accountFindUnique,
  positionUpdateMany,
} = vi.hoisted(() => ({
  strategyFindFirst: vi.fn(),
  positionFindMany: vi.fn(),
  accountFindUnique: vi.fn(),
  positionUpdateMany: vi.fn(),
}));

const { isInEarningsBlackout } = vi.hoisted(() => ({
  isInEarningsBlackout: vi.fn(),
}));

vi.mock('@/lib/alpaca', () => ({ getPositions, getBrokerAccount, getLatestPrice }));
vi.mock('@/lib/db', () => ({
  prisma: {
    strategy: { findFirst: strategyFindFirst },
    position: { findMany: positionFindMany, updateMany: positionUpdateMany },
    account: { findUnique: accountFindUnique },
  },
}));
vi.mock('@/lib/data/earnings', () => ({ isInEarningsBlackout }));
vi.mock('@/lib/data/tax', () => ({
  isHarvestSeason: () => false,
  MIN_HARVEST_LOSS_USD: 100,
  MIN_HARVEST_HELD_DAYS: 31,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { evaluateExits } from './exits';

function brokerPosition(symbol: string, qty: number, marketValue: number) {
  return {
    symbol,
    qty: String(qty),
    avg_entry_price: String(marketValue / qty),
    market_value: String(marketValue),
  };
}

function dbPosition(symbol: string, qty: number) {
  return {
    id: `pos-${symbol}`,
    userId: 'u1',
    symbol,
    qty,
    avgCostCents: BigInt(Math.round((qty * 30) * 100)),
    thesis: 'quality compounder',
    thesisReviewDueAt: new Date('2099-01-01'),
    openedAt: new Date('2025-01-01'),
  };
}

beforeEach(() => {
  getPositions.mockReset();
  getBrokerAccount.mockReset();
  getLatestPrice.mockReset();
  strategyFindFirst.mockReset();
  positionFindMany.mockReset();
  accountFindUnique.mockReset();
  positionUpdateMany.mockReset();
  isInEarningsBlackout.mockReset();

  // Sensible defaults.
  strategyFindFirst.mockResolvedValue({ rules: {} });
  accountFindUnique.mockResolvedValue({ maxPositionPct: 15 });
  positionUpdateMany.mockResolvedValue({ count: 0 });
  getLatestPrice.mockResolvedValue(null);
  isInEarningsBlackout.mockResolvedValue({ blocked: false });
});

describe('evaluateExits — maxPositionPct denominator', () => {
  it('does NOT flag trim for an 8% position when total equity (incl. cash) is the denominator', async () => {
    // Quality Compounders meeting scenario: $100k equity, $85k cash,
    // $8k VOO + $7k SCHD. Under the bug, VOO = 8k/15k = 53% → trim.
    // After the fix, VOO = 8k/100k = 8% → hold.
    getPositions.mockResolvedValue([
      brokerPosition('VOO', 12, 7_820),
      brokerPosition('SCHD', 200, 6_274),
    ]);
    getBrokerAccount.mockResolvedValue({
      portfolioValueCents: 100_094_00n,
      cashCents: 85_025_00n,
    });
    positionFindMany.mockResolvedValue([dbPosition('VOO', 12), dbPosition('SCHD', 200)]);

    const verdicts = await evaluateExits('u1');
    for (const v of verdicts) {
      expect(v.signal).not.toBe('trim');
      if (v.reason) expect(v.reason).not.toMatch(/above max/);
    }
  });

  it('DOES flag trim when a position genuinely exceeds the cap relative to total equity', async () => {
    // Concentration scenario: $50k equity all-in on one name, 15% cap.
    // The full $50k position is 100% of portfolio → must trim.
    getPositions.mockResolvedValue([brokerPosition('NVDA', 100, 50_000)]);
    getBrokerAccount.mockResolvedValue({
      portfolioValueCents: 50_000_00n,
      cashCents: 0n,
    });
    positionFindMany.mockResolvedValue([dbPosition('NVDA', 100)]);

    const verdicts = await evaluateExits('u1');
    const nvda = verdicts.find((v) => v.symbol === 'NVDA');
    expect(nvda?.signal).toBe('trim');
    expect(nvda?.reason).toMatch(/above max 15%/);
    expect(nvda?.trimQty).toBeGreaterThan(0);
  });

  it('falls back to positions-only denominator if the broker read fails', async () => {
    // Defensive: if Alpaca is flaky, don't pretend nothing's at risk
    // — use the old denominator as a lower bound. The pre-fix
    // behaviour wasn't *wrong*, it was *over-sensitive*; reverting to
    // it on broker failure is strictly better than emitting blind
    // no-trim verdicts during an outage.
    getPositions.mockResolvedValue([
      brokerPosition('VOO', 12, 7_820),
      brokerPosition('SCHD', 200, 6_274),
    ]);
    getBrokerAccount.mockResolvedValue(null); // simulates outage
    positionFindMany.mockResolvedValue([dbPosition('VOO', 12), dbPosition('SCHD', 200)]);

    const verdicts = await evaluateExits('u1');
    // With broker down, VOO = 7820 / (7820+6274) = 55% > 15%. Old
    // behaviour kicks in. Not ideal but explicit — no data, no claim.
    const voo = verdicts.find((v) => v.symbol === 'VOO');
    expect(voo?.signal).toBe('trim');
  });

  it('at exactly the cap produces no trim (boundary)', async () => {
    // 15% cap, position is 15% of total equity → no trim.
    getPositions.mockResolvedValue([brokerPosition('KO', 100, 15_000)]);
    getBrokerAccount.mockResolvedValue({
      portfolioValueCents: 100_000_00n,
      cashCents: 85_000_00n,
    });
    positionFindMany.mockResolvedValue([dbPosition('KO', 100)]);
    const verdicts = await evaluateExits('u1');
    const ko = verdicts.find((v) => v.symbol === 'KO');
    expect(ko?.signal).not.toBe('trim');
  });

  it('trimQty is proportional to the excess above the cap', async () => {
    // Position is 30% of equity, cap 15%, so trim half.
    getPositions.mockResolvedValue([brokerPosition('AAPL', 100, 30_000)]);
    getBrokerAccount.mockResolvedValue({
      portfolioValueCents: 100_000_00n,
      cashCents: 70_000_00n,
    });
    positionFindMany.mockResolvedValue([dbPosition('AAPL', 100)]);
    const verdicts = await evaluateExits('u1');
    const aapl = verdicts.find((v) => v.symbol === 'AAPL');
    expect(aapl?.signal).toBe('trim');
    // excessPct / weightPct = 15/30 = 0.5, × qty 100 → 50
    expect(aapl?.trimQty).toBeCloseTo(50, 0);
  });
});
