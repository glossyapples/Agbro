// Named historical windows for the robustness grid. Deliberately mixes
// crises, grinding bears, and calm bulls so the grid reflects strategy
// behaviour across *market regimes*, not just crash-porn cherry picks.
//
// The split between visible and held-out is a discipline guardrail:
//   - Visible windows are what the grid displays and what the future
//     multi-agent Proposer will reason about when suggesting changes.
//   - Held-out windows are never shown on the grid by default and are
//     reserved for the Validator step. They prove a change generalises
//     rather than overfits to the data the Proposer saw.
//
// Rotate occasionally: once a year, migrate a couple of held-out
// windows into visible and add fresh held-outs. Prevents the system
// (human or agentic) from effectively memorising the validator set
// through repeated review.

export type BacktestWindow = {
  key: string;
  label: string;
  // YYYY-MM-DD strings so they're easy to stamp onto a BacktestRun row.
  startDate: string;
  endDate: string;
  heldOut: boolean;
  // Why this window is in the set — shown as a tooltip / detail row so
  // reviewers (human + agent) know what regime they're reasoning about.
  description: string;
};

const RAW: Array<Omit<BacktestWindow, 'heldOut'> & { heldOut?: boolean }> = [
  // ── VISIBLE ─────────────────────────────────────────────────────────
  // Crisis windows — obvious stress tests.
  {
    key: 'gfc-08-09',
    label: 'GFC 2008–09',
    startDate: '2008-01-01',
    endDate: '2009-12-31',
    description: 'Global Financial Crisis. S&P -57% peak-to-trough.',
  },
  {
    key: 'euro-crisis-11',
    label: 'Euro Crisis 2011',
    startDate: '2011-06-01',
    endDate: '2012-06-01',
    description: 'European sovereign debt crisis + US debt ceiling.',
  },
  {
    key: 'covid-20',
    label: 'COVID 2020',
    startDate: '2020-01-01',
    endDate: '2021-01-01',
    description: 'Fastest -34% in history, V-shaped recovery to new highs.',
  },
  {
    key: 'rate-cycle-22',
    label: 'Rate Cycle 2022',
    startDate: '2022-01-01',
    endDate: '2023-01-01',
    description: 'Stocks + bonds both down. S&P -25%, Nasdaq -33%.',
  },
  // Calm / grinding bull windows — strategies must not suck in these.
  {
    key: 'bull-13-15',
    label: 'Calm Bull 2013–15',
    startDate: '2013-01-01',
    endDate: '2015-01-01',
    description: 'Post-QE smooth rally, low vol.',
  },
  {
    key: 'oil-crash-15-17',
    label: 'Oil Crash + Recovery',
    startDate: '2015-01-01',
    endDate: '2017-01-01',
    description: 'Oil from $100 → $30; WTI bottom Feb 2016.',
  },
  {
    key: 'pre-covid-19',
    label: 'Pre-COVID 2019',
    startDate: '2019-01-01',
    endDate: '2020-01-01',
    description: 'Calm record-high year before the crash.',
  },
  {
    key: 'meltup-21',
    label: 'Meltup 2021',
    startDate: '2021-01-01',
    endDate: '2022-01-01',
    description: 'Post-COVID speculation peak; meme stocks, IPOs, SPACs.',
  },
  {
    key: 'ai-recovery-23',
    label: 'AI Recovery 2023',
    startDate: '2023-01-01',
    endDate: '2024-01-01',
    description: 'Nvidia + AI narrative pulls S&P out of bear.',
  },
  {
    key: 'recent-24',
    label: 'Recent 2024–25',
    startDate: '2024-01-01',
    endDate: '2025-04-01',
    description: 'Most recent complete window with full bar history.',
  },

  // ── HELD-OUT ────────────────────────────────────────────────────────
  {
    key: 'q4-18-crash',
    label: 'Q4 2018 Crash',
    startDate: '2018-09-01',
    endDate: '2019-03-01',
    heldOut: true,
    description: 'Fed-driven Q4 crash + January V. Overfitting trap.',
  },
  {
    key: 'early-recovery-10',
    label: 'GFC Recovery 2010',
    startDate: '2010-01-01',
    endDate: '2011-01-01',
    heldOut: true,
    description: 'Post-crisis normalisation year. Flash crash in May.',
  },
  {
    key: 'brexit-16',
    label: 'Brexit 2016',
    startDate: '2016-01-01',
    endDate: '2017-01-01',
    heldOut: true,
    description: 'Brexit + US election + Jan selloff + recovery.',
  },
  {
    key: 'trump-bull-17',
    label: 'Trump Bull 2017',
    startDate: '2017-01-01',
    endDate: '2018-01-01',
    heldOut: true,
    description: 'Lowest-volatility year in modern history.',
  },
  {
    key: 'vol-shock-18',
    label: 'Vol Shock Feb 2018',
    startDate: '2018-01-01',
    endDate: '2018-09-01',
    heldOut: true,
    description: 'VIX spike Feb 5; short-vol fund blowups.',
  },
  {
    key: 'mid-gfc-drain',
    label: 'GFC Grind 2008',
    startDate: '2008-06-01',
    endDate: '2009-03-01',
    heldOut: true,
    description: 'Peak GFC slice — subset of GFC window; different entry.',
  },
];

export const BACKTEST_WINDOWS: BacktestWindow[] = RAW.map((w) => ({
  ...w,
  heldOut: w.heldOut === true,
}));

export const VISIBLE_WINDOWS = BACKTEST_WINDOWS.filter((w) => !w.heldOut);
export const HELDOUT_WINDOWS = BACKTEST_WINDOWS.filter((w) => w.heldOut);

export function windowByKey(key: string): BacktestWindow | null {
  return BACKTEST_WINDOWS.find((w) => w.key === key) ?? null;
}
