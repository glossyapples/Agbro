// Deterministic backtest simulator. Walks day-by-day through a
// historical price window, applies a strategy's rule set to a virtual
// portfolio, records every trade + event, and hands back a clean
// equity-series + event log for the caller to compute metrics and
// render charts.
//
// EXPLICIT LIMITATIONS (same as our Tier-1 scope doc):
//   - No LLM. Stock picks are made deterministically per strategy:
//     "buy the universe equal-weighted on day zero" for value
//     strategies; "DCA into target weights" for Boglehead; no
//     agent-driven judgement anywhere.
//   - No fundamentals check at historical decision dates. Strategy
//     rules that reference P/E / ROE / moat are no-ops in backtest.
//     Tier 2 (deferred) adds point-in-time fundamentals.
//   - No options, no crypto (insufficient history), no earnings
//     blackouts (no historical earnings calendar), no wash-sale (no
//     tax bookkeeping).
//
// What we DO test:
//   - Buy-and-hold behaviour under historical stress (2008, 2020, 2022)
//   - Rebalance-on-drift mechanics (Boglehead + Equal Weight)
//   - Mean-reversion target-sell + time-stop (Graham)
//   - Crisis regime detection logic against real crash windows
//   - Comparison of strategies on the same data

import type { Bar } from '@/lib/alpaca';
import { loadDailyBars, indexByDate, unionDates } from './data';
import { resolveRuleset, type StrategyKey, type BacktestRuleset } from './rules';

export type SimulatorConfig = {
  strategyKey: StrategyKey;
  universe: string[];
  benchmarkSymbol: string;
  startDate: Date;
  endDate: Date;
  startingCashCents: bigint;
};

export type SimulatorEvent = {
  date: string;
  event:
    | 'initial_buy'
    | 'rebalance'
    | 'dca'
    | 'target_sell'
    | 'time_stop_sell'
    | 'regime_transition'
    | 'end_of_run';
  details: Record<string, unknown>;
};

export type SimulatorResult = {
  equitySeries: { t: number; equity: number; benchmark: number }[];
  eventLog: SimulatorEvent[];
  tradeCount: number;
  endingEquityCents: bigint;
  benchmarkEndingCents: bigint;
};

type Position = { symbol: string; qty: number; costBasisPerShare: number; entryDate: string };

type RegimeState = 'calm' | 'elevated' | 'crisis' | 'recovery';

const ONE_DAY_MS = 86_400_000;

export async function runSimulation(config: SimulatorConfig): Promise<SimulatorResult> {
  const rules = resolveRuleset(config.strategyKey);
  const startMs = config.startDate.getTime();
  const endMs = config.endDate.getTime();

  // Load bars. We use a 10-day pad on the start so we have prior
  // prices for regime detection and rebalance computation on day one.
  const padMs = 15 * ONE_DAY_MS;
  const symbolBars = new Map<string, Map<string, number>>();
  for (const sym of config.universe) {
    const bars = await loadDailyBars(sym, startMs - padMs, endMs);
    symbolBars.set(sym, indexByDate(bars));
  }
  const benchmarkBars = await loadDailyBars(config.benchmarkSymbol, startMs - padMs, endMs);
  const benchmarkMap = indexByDate(benchmarkBars);

  // Build the walk calendar from the union of all symbols + benchmark.
  const allMaps = [...symbolBars.values(), benchmarkMap];
  const calendar = unionDates(allMaps).filter((d) => {
    const t = new Date(`${d}T00:00:00Z`).getTime();
    return t >= startMs && t <= endMs;
  });

  if (calendar.length === 0) {
    return {
      equitySeries: [],
      eventLog: [{ date: '', event: 'end_of_run', details: { reason: 'no_data' } }],
      tradeCount: 0,
      endingEquityCents: config.startingCashCents,
      benchmarkEndingCents: config.startingCashCents,
    };
  }

  // Portfolio state — kept as JS numbers for simulator math, converted
  // to cents at the end for storage / display.
  let cash = Number(config.startingCashCents) / 100;
  const positions = new Map<string, Position>();
  const trades: SimulatorEvent[] = [];
  const eventLog: SimulatorEvent[] = [];
  const equitySeries: SimulatorResult['equitySeries'] = [];

  // Benchmark tracker — virtual "what if we just bought $X of SPY on
  // day zero" so the UI can overlay it.
  const benchmarkFirst = benchmarkPrice(calendar[0], benchmarkMap);
  const benchmarkShares =
    benchmarkFirst != null ? Number(config.startingCashCents) / 100 / benchmarkFirst : 0;

  // Rebalance / DCA timestamps (tracked as indices into the calendar).
  let lastRebalanceDay: string | null = null;
  let lastDcaDay: string | null = null;
  let regime: RegimeState = 'calm';

  // ── Day 0: initial deployment ────────────────────────────────────────
  deployInitial(calendar[0], rules, cash, config.universe, symbolBars, positions, trades);
  cash = sumCashFromInitial(cash, positions);

  for (const date of calendar) {
    // Detect regime transitions (cheap — uses benchmark series only).
    const newRegime = classifyRegime(date, benchmarkMap);
    if (newRegime !== regime) {
      eventLog.push({
        date,
        event: 'regime_transition',
        details: { from: regime, to: newRegime },
      });
      regime = newRegime;
    }

    // Rebalance rule (if applicable).
    if (rules.rebalanceCadenceDays != null && rules.rebalanceBandPct != null) {
      const daysSince = lastRebalanceDay ? daysBetween(lastRebalanceDay, date) : Infinity;
      if (daysSince >= rules.rebalanceCadenceDays) {
        const drift = maxDriftPct(positions, symbolBars, date, rules.targetWeights ?? {});
        if (drift > rules.rebalanceBandPct) {
          const result = rebalance(
            date,
            positions,
            cash,
            symbolBars,
            rules.targetWeights ?? {},
            config.universe
          );
          cash = result.cashAfter;
          for (const t of result.trades) trades.push(t);
          eventLog.push({
            date,
            event: 'rebalance',
            details: { drift: drift.toFixed(2), tradeCount: result.trades.length },
          });
          lastRebalanceDay = date;
        }
      }
    }

    // DCA rule (Boglehead-style).
    if (rules.dcaAmountPerPeriod != null && rules.dcaCadenceDays != null) {
      const daysSince = lastDcaDay ? daysBetween(lastDcaDay, date) : Infinity;
      if (daysSince >= rules.dcaCadenceDays) {
        const result = executeDca(
          date,
          rules.dcaAmountPerPeriod,
          rules.targetWeights ?? {},
          cash,
          positions,
          symbolBars
        );
        cash = result.cashAfter;
        for (const t of result.trades) trades.push(t);
        if (result.trades.length > 0) {
          eventLog.push({
            date,
            event: 'dca',
            details: { amountUsd: rules.dcaAmountPerPeriod, legs: result.trades.length },
          });
          lastDcaDay = date;
        }
      }
    }

    // Per-position exit rules.
    for (const [sym, pos] of positions) {
      const price = symbolPrice(sym, date, symbolBars);
      if (price == null) continue;

      // Target sell (mean-reversion, Graham).
      if (rules.targetSellPct != null) {
        const gainPct = ((price - pos.costBasisPerShare) / pos.costBasisPerShare) * 100;
        if (gainPct >= rules.targetSellPct) {
          cash += pos.qty * price;
          trades.push({
            date,
            event: 'target_sell',
            details: { symbol: sym, qty: pos.qty, price, gainPct: gainPct.toFixed(1) },
          });
          eventLog.push({
            date,
            event: 'target_sell',
            details: { symbol: sym, gainPct: gainPct.toFixed(1) },
          });
          positions.delete(sym);
          continue;
        }
      }

      // Time stop (Graham 2-year rule).
      if (rules.timeStopDays != null) {
        const held = daysBetween(pos.entryDate, date);
        if (held >= rules.timeStopDays) {
          cash += pos.qty * price;
          trades.push({
            date,
            event: 'time_stop_sell',
            details: { symbol: sym, qty: pos.qty, price, heldDays: held },
          });
          eventLog.push({
            date,
            event: 'time_stop_sell',
            details: { symbol: sym, heldDays: held },
          });
          positions.delete(sym);
        }
      }
    }

    // Mark to market at end of day.
    let positionValue = 0;
    for (const [sym, pos] of positions) {
      const price = symbolPrice(sym, date, symbolBars);
      if (price != null) positionValue += pos.qty * price;
    }
    const equity = cash + positionValue;
    const benchmarkPriceToday = benchmarkPrice(date, benchmarkMap) ?? 0;
    const benchmarkEquity = benchmarkShares * benchmarkPriceToday;

    equitySeries.push({
      t: new Date(`${date}T00:00:00Z`).getTime(),
      equity,
      benchmark: benchmarkEquity,
    });
  }

  const last = equitySeries[equitySeries.length - 1];
  return {
    equitySeries,
    eventLog,
    tradeCount: trades.length,
    endingEquityCents: BigInt(Math.round((last?.equity ?? 0) * 100)),
    benchmarkEndingCents: BigInt(Math.round((last?.benchmark ?? 0) * 100)),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function symbolPrice(
  symbol: string,
  date: string,
  symbolBars: Map<string, Map<string, number>>
): number | null {
  return symbolBars.get(symbol)?.get(date) ?? null;
}

function benchmarkPrice(date: string, map: Map<string, number>): number | null {
  return map.get(date) ?? null;
}

function daysBetween(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00Z`).getTime();
  const tb = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((tb - ta) / ONE_DAY_MS);
}

function deployInitial(
  firstDate: string,
  rules: BacktestRuleset,
  startingCash: number,
  universe: string[],
  symbolBars: Map<string, Map<string, number>>,
  positions: Map<string, Position>,
  trades: SimulatorEvent[]
) {
  // If the strategy provides target weights, buy exactly those. Otherwise
  // equal-weight the universe. Fully-deployed on day zero is the
  // simplifying assumption — "how would this strategy have performed if
  // it was already invested when the window started?"
  const weights =
    rules.targetWeights && Object.keys(rules.targetWeights).length > 0
      ? rules.targetWeights
      : equalWeight(universe);
  const totalWeight = Object.values(weights).reduce((s, v) => s + v, 0);
  if (totalWeight <= 0) return;

  for (const [sym, w] of Object.entries(weights)) {
    const allocation = (startingCash * w) / totalWeight;
    const price = symbolPrice(sym, firstDate, symbolBars);
    if (price == null || price <= 0) continue;
    const qty = allocation / price;
    if (qty <= 0) continue;
    positions.set(sym, {
      symbol: sym,
      qty,
      costBasisPerShare: price,
      entryDate: firstDate,
    });
    trades.push({
      date: firstDate,
      event: 'initial_buy',
      details: { symbol: sym, qty, price, allocation },
    });
  }
}

function sumCashFromInitial(startingCash: number, positions: Map<string, Position>): number {
  let deployed = 0;
  for (const p of positions.values()) deployed += p.qty * p.costBasisPerShare;
  return Math.max(0, startingCash - deployed);
}

function equalWeight(universe: string[]): Record<string, number> {
  if (universe.length === 0) return {};
  const w = 1 / universe.length;
  return Object.fromEntries(universe.map((s) => [s, w]));
}

function maxDriftPct(
  positions: Map<string, Position>,
  symbolBars: Map<string, Map<string, number>>,
  date: string,
  targetWeights: Record<string, number>
): number {
  const values = new Map<string, number>();
  let total = 0;
  for (const [sym, pos] of positions) {
    const price = symbolPrice(sym, date, symbolBars);
    if (price != null) {
      const v = pos.qty * price;
      values.set(sym, v);
      total += v;
    }
  }
  if (total <= 0) return 0;
  const targetSum = Object.values(targetWeights).reduce((s, v) => s + v, 0);
  let maxDrift = 0;
  for (const [sym, w] of Object.entries(targetWeights)) {
    const actual = (values.get(sym) ?? 0) / total;
    const target = w / targetSum;
    const drift = Math.abs(actual - target) * 100;
    if (drift > maxDrift) maxDrift = drift;
  }
  return maxDrift;
}

function rebalance(
  date: string,
  positions: Map<string, Position>,
  cash: number,
  symbolBars: Map<string, Map<string, number>>,
  targetWeights: Record<string, number>,
  universe: string[]
): { cashAfter: number; trades: SimulatorEvent[] } {
  const trades: SimulatorEvent[] = [];
  // Compute total book value at today's prices.
  const prices = new Map<string, number>();
  let totalValue = cash;
  for (const [sym, pos] of positions) {
    const price = symbolPrice(sym, date, symbolBars);
    if (price != null) {
      prices.set(sym, price);
      totalValue += pos.qty * price;
    }
  }

  const targetSum = Object.values(targetWeights).reduce((s, v) => s + v, 0);
  if (targetSum <= 0) return { cashAfter: cash, trades };

  // For each target, compute desired value and nudge toward it.
  for (const [sym, w] of Object.entries(targetWeights)) {
    if (!universe.includes(sym)) continue;
    const price =
      prices.get(sym) ?? symbolPrice(sym, date, symbolBars) ?? 0;
    if (price <= 0) continue;
    const desiredValue = (w / targetSum) * totalValue;
    const currentValue = (positions.get(sym)?.qty ?? 0) * price;
    const diff = desiredValue - currentValue;
    if (Math.abs(diff) < 1) continue; // ignore dust
    const qtyChange = diff / price;
    const existing = positions.get(sym);
    if (qtyChange > 0) {
      const cost = qtyChange * price;
      cash -= cost;
      if (existing) {
        const newQty = existing.qty + qtyChange;
        const newAvg =
          (existing.qty * existing.costBasisPerShare + qtyChange * price) / newQty;
        positions.set(sym, { ...existing, qty: newQty, costBasisPerShare: newAvg });
      } else {
        positions.set(sym, { symbol: sym, qty: qtyChange, costBasisPerShare: price, entryDate: date });
      }
      trades.push({ date, event: 'rebalance', details: { symbol: sym, side: 'buy', qty: qtyChange, price } });
    } else {
      const sellQty = -qtyChange;
      cash += sellQty * price;
      if (existing) {
        const newQty = existing.qty - sellQty;
        if (newQty < 1e-6) positions.delete(sym);
        else positions.set(sym, { ...existing, qty: newQty });
      }
      trades.push({ date, event: 'rebalance', details: { symbol: sym, side: 'sell', qty: sellQty, price } });
    }
  }

  return { cashAfter: cash, trades };
}

function executeDca(
  date: string,
  amountPerPeriod: number,
  targetWeights: Record<string, number>,
  cash: number,
  positions: Map<string, Position>,
  symbolBars: Map<string, Map<string, number>>
): { cashAfter: number; trades: SimulatorEvent[] } {
  const trades: SimulatorEvent[] = [];
  if (cash < amountPerPeriod) return { cashAfter: cash, trades };
  const targetSum = Object.values(targetWeights).reduce((s, v) => s + v, 0);
  if (targetSum <= 0) return { cashAfter: cash, trades };
  for (const [sym, w] of Object.entries(targetWeights)) {
    const leg = (amountPerPeriod * w) / targetSum;
    if (leg < 1) continue;
    const price = symbolPrice(sym, date, symbolBars);
    if (price == null || price <= 0) continue;
    const qty = leg / price;
    const existing = positions.get(sym);
    if (existing) {
      const newQty = existing.qty + qty;
      const newAvg =
        (existing.qty * existing.costBasisPerShare + qty * price) / newQty;
      positions.set(sym, { ...existing, qty: newQty, costBasisPerShare: newAvg });
    } else {
      positions.set(sym, { symbol: sym, qty, costBasisPerShare: price, entryDate: date });
    }
    cash -= leg;
    trades.push({ date, event: 'dca', details: { symbol: sym, qty, price, amount: leg } });
  }
  return { cashAfter: cash, trades };
}

// Mini-regime classifier. Same thresholds as the live tripwire (7% / 4%
// thresholds) but reads directly from the benchmark bar series we already
// have loaded — doesn't need SPY from Alpaca separately.
function classifyRegime(date: string, benchmarkMap: Map<string, number>): RegimeState {
  const keys = Array.from(benchmarkMap.keys()).sort();
  const idx = keys.indexOf(date);
  if (idx < 4) return 'calm';
  const today = benchmarkMap.get(keys[idx])!;
  const yesterday = benchmarkMap.get(keys[idx - 1])!;
  const dailyMove = ((today - yesterday) / yesterday) * 100;
  if (dailyMove <= -7) return 'crisis';
  // Consecutive down days, up to 5
  let down = 0;
  for (let i = idx; i > 0 && i > idx - 5; i--) {
    if (benchmarkMap.get(keys[i])! < benchmarkMap.get(keys[i - 1])!) down++;
    else break;
  }
  if (down >= 4) {
    const cum = ((today - benchmarkMap.get(keys[idx - down])!) / benchmarkMap.get(keys[idx - down])!) * 100;
    if (cum <= -10) return 'crisis';
  }
  if (dailyMove <= -4) return 'elevated';
  if (down >= 3) return 'elevated';
  return 'calm';
}

export { Bar };
