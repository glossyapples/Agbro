// Phase 2 property tests on the kill-switch state machine. The logic
// lives in classifyRailVerdict — a pure function extracted from
// checkKillSwitches so these tests don't have to mock Prisma/Alpaca.
//
// These properties pin the fail-CLOSED change (commit 7a90c4c):
// previously a transient Alpaca outage returned ok:true and let the
// agent keep trading blind. Now it returns triggeredBy:'data_unavailable'
// so the scheduler skips the tick.
//
// Also pins the "first trigger wins + correct priority" invariant —
// daily_loss before drawdown, both before data_unavailable.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { classifyRailVerdict } from './rails';

// Bars arbitrary: 2..20 points with non-negative equity.
const bars = fc.array(
  fc.record({ equity: fc.float({ min: 0, max: Math.fround(1_000_000), noNaN: true }) }),
  { minLength: 2, maxLength: 20 }
);

describe('classifyRailVerdict — disabled rails', () => {
  it('both rails disabled (null/0 thresholds) → always ok:true', () => {
    fc.assert(
      fc.property(bars, bars, (day, month) => {
        const v = classifyRailVerdict({
          dailyLossKillPct: null,
          drawdownPauseThresholdPct: null,
          dayBars: day,
          monthBars: month,
        });
        expect(v.ok).toBe(true);
      })
    );
  });

  it('positive thresholds (configured wrong — should be negative) are ignored', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(100) }),
        fc.float({ min: 0, max: Math.fround(100) }),
        bars,
        bars,
        (daily, draw, day, month) => {
          const v = classifyRailVerdict({
            dailyLossKillPct: daily,
            drawdownPauseThresholdPct: draw,
            dayBars: day,
            monthBars: month,
          });
          expect(v.ok).toBe(true);
        }
      )
    );
  });
});

describe('classifyRailVerdict — daily_loss', () => {
  it('fires when actual loss ≤ threshold', () => {
    // open 100, now 90 → -10% loss, threshold -5% → trips.
    const v = classifyRailVerdict({
      dailyLossKillPct: -5,
      drawdownPauseThresholdPct: null,
      dayBars: [{ equity: 100 }, { equity: 90 }],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.triggeredBy).toBe('daily_loss');
      expect(v.reason).toContain('-10.00%');
    }
  });

  it('does NOT fire on gains', () => {
    const v = classifyRailVerdict({
      dailyLossKillPct: -5,
      drawdownPauseThresholdPct: null,
      dayBars: [{ equity: 100 }, { equity: 110 }],
    });
    expect(v.ok).toBe(true);
  });

  it('does NOT fire when loss is above (less-negative than) threshold', () => {
    // -3% loss, threshold -5% — doesn't trip.
    const v = classifyRailVerdict({
      dailyLossKillPct: -5,
      drawdownPauseThresholdPct: null,
      dayBars: [{ equity: 100 }, { equity: 97 }],
    });
    expect(v.ok).toBe(true);
  });

  it('property: any loss deeper than threshold trips; any shallower doesn\'t', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(-50), max: Math.fround(-0.5), noNaN: true }),
        fc.float({ min: Math.fround(50), max: Math.fround(100), noNaN: true }),
        fc.float({ min: Math.fround(-50), max: Math.fround(0), noNaN: true }),
        (threshold, open, pctChange) => {
          const now = open * (1 + pctChange / 100);
          const v = classifyRailVerdict({
            dailyLossKillPct: threshold,
            drawdownPauseThresholdPct: null,
            dayBars: [{ equity: open }, { equity: now }],
          });
          const shouldFire = pctChange <= threshold;
          expect(v.ok).toBe(!shouldFire);
          if (!v.ok) {
            expect(v.triggeredBy).toBe('daily_loss');
          }
        }
      )
    );
  });

  it('requires ≥2 bars to evaluate', () => {
    const v = classifyRailVerdict({
      dailyLossKillPct: -5,
      drawdownPauseThresholdPct: null,
      dayBars: [{ equity: 100 }],
    });
    expect(v.ok).toBe(true); // insufficient data → don't fire
  });
});

describe('classifyRailVerdict — drawdown', () => {
  it('fires when current is below peak by ≥ threshold', () => {
    // peak 100, now 80 → -20% from peak, threshold -15% → trips.
    const v = classifyRailVerdict({
      dailyLossKillPct: null,
      drawdownPauseThresholdPct: -15,
      monthBars: [
        { equity: 80 },
        { equity: 100 },
        { equity: 95 },
        { equity: 80 },
      ],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.triggeredBy).toBe('drawdown');
    }
  });

  it('does NOT fire when drawdown is shallower than threshold', () => {
    // peak 100, now 92 → -8% from peak, threshold -15% → ok.
    const v = classifyRailVerdict({
      dailyLossKillPct: null,
      drawdownPauseThresholdPct: -15,
      monthBars: [{ equity: 80 }, { equity: 100 }, { equity: 92 }],
    });
    expect(v.ok).toBe(true);
  });
});

describe('classifyRailVerdict — priority ordering', () => {
  it('daily_loss fires before drawdown when both would trip', () => {
    // Daily: 100 → 80 = -20%, threshold -5% → trips.
    // Drawdown: peak 100, now 80 = -20%, threshold -15% → also trips.
    // Rule: daily_loss wins (intraday is the faster / more important signal).
    const v = classifyRailVerdict({
      dailyLossKillPct: -5,
      drawdownPauseThresholdPct: -15,
      dayBars: [{ equity: 100 }, { equity: 80 }],
      monthBars: [{ equity: 100 }, { equity: 80 }],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.triggeredBy).toBe('daily_loss');
  });

  it('drawdown fires when daily is fine', () => {
    const v = classifyRailVerdict({
      dailyLossKillPct: -10,
      drawdownPauseThresholdPct: -15,
      // Daily: 100 → 98 = -2%, above threshold → ok.
      dayBars: [{ equity: 100 }, { equity: 98 }],
      // Drawdown: peak 110, now 80 = -27%, below threshold → trips.
      monthBars: [{ equity: 100 }, { equity: 110 }, { equity: 80 }],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.triggeredBy).toBe('drawdown');
  });
});

describe('classifyRailVerdict — fail-closed on data unavailable', () => {
  it('data_unavailable when daily fetch fails + rail enabled', () => {
    const v = classifyRailVerdict({
      dailyLossKillPct: -5,
      drawdownPauseThresholdPct: null,
      dailyFetchFailed: true,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.triggeredBy).toBe('data_unavailable');
  });

  it('data_unavailable when drawdown fetch fails + rail enabled', () => {
    const v = classifyRailVerdict({
      dailyLossKillPct: null,
      drawdownPauseThresholdPct: -15,
      drawdownFetchFailed: true,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.triggeredBy).toBe('data_unavailable');
  });

  it('a REAL trip still wins over data_unavailable when both are present', () => {
    // Daily trips outright; drawdown fetch failed — the actual trip
    // is the true signal, data_unavailable is for the "nothing could
    // be checked" case.
    const v = classifyRailVerdict({
      dailyLossKillPct: -5,
      drawdownPauseThresholdPct: -15,
      dayBars: [{ equity: 100 }, { equity: 80 }],
      drawdownFetchFailed: true,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.triggeredBy).toBe('daily_loss');
  });

  it('fetch failure on a DISABLED rail → ignored (doesn\'t trip data_unavailable)', () => {
    // dailyLossKillPct=null means rail disabled; failure is meaningless.
    const v = classifyRailVerdict({
      dailyLossKillPct: null,
      drawdownPauseThresholdPct: -15,
      monthBars: [{ equity: 100 }, { equity: 95 }],
      dailyFetchFailed: true, // ignored — rail is off
    });
    expect(v.ok).toBe(true);
  });

  it('no rails enabled + fetch fails → still ok:true (nothing to protect)', () => {
    const v = classifyRailVerdict({
      dailyLossKillPct: null,
      drawdownPauseThresholdPct: null,
      dailyFetchFailed: true,
      drawdownFetchFailed: true,
    });
    expect(v.ok).toBe(true);
  });
});

describe('classifyRailVerdict — invariants', () => {
  it('verdict is always a well-formed RailVerdict', () => {
    fc.assert(
      fc.property(
        fc.record({
          dailyLossKillPct: fc.option(
            fc.float({ min: Math.fround(-80), max: Math.fround(80), noNaN: true })
          ),
          drawdownPauseThresholdPct: fc.option(
            fc.float({ min: Math.fround(-80), max: Math.fround(80), noNaN: true })
          ),
          dayBars: fc.option(bars),
          monthBars: fc.option(bars),
          dailyFetchFailed: fc.boolean(),
          drawdownFetchFailed: fc.boolean(),
        }),
        (input) => {
          const v = classifyRailVerdict({
            dailyLossKillPct: input.dailyLossKillPct,
            drawdownPauseThresholdPct: input.drawdownPauseThresholdPct,
            dayBars: input.dayBars ?? undefined,
            monthBars: input.monthBars ?? undefined,
            dailyFetchFailed: input.dailyFetchFailed,
            drawdownFetchFailed: input.drawdownFetchFailed,
          });
          expect(typeof v.ok).toBe('boolean');
          if (!v.ok) {
            expect(typeof v.reason).toBe('string');
            expect(v.reason.length).toBeGreaterThan(0);
            expect([
              'daily_loss',
              'drawdown',
              'trade_notional',
              'data_unavailable',
              'other',
            ]).toContain(v.triggeredBy);
          }
        }
      )
    );
  });

  it('is deterministic — same input always produces same verdict', () => {
    fc.assert(
      fc.property(
        fc.record({
          dailyLossKillPct: fc.float({ min: Math.fround(-50), max: Math.fround(0), noNaN: true }),
          drawdownPauseThresholdPct: fc.float({ min: Math.fround(-80), max: Math.fround(0), noNaN: true }),
          dayBars: bars,
          monthBars: bars,
          dailyFetchFailed: fc.boolean(),
          drawdownFetchFailed: fc.boolean(),
        }),
        (input) => {
          const a = classifyRailVerdict(input);
          const b = classifyRailVerdict(input);
          expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        }
      )
    );
  });
});
