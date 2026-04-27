# Lookahead-bias leak test — pairs design

This directory holds the (symbol, decision-date) pairs for sprint W0:
testing whether Claude can be constrained to a point-in-time view of
the world via prompting alone, or whether its training-data hindsight
leaks into "as-of-2021" research and contaminates every historical
backtest.

## File: `pairs-2026-05.json`

61 pairs (25 famous-hindsight + 21 weak-prior + 8 control + 7
qualitative-only), designed to be run with `--opus` next month when
budget allows. The shape matches what `scripts/lookahead-leak-test.ts`
consumes — extra `_category` / `_note` fields are silently ignored
by the runner but kept here for traceability.

```bash
# Cheap directional read first (Haiku):
npm run research:leak-test -- --pairs research/leak-test/pairs-2026-05.json --cap 1

# Rigorous answer (Opus 4.7, ~$5-7 expected):
npm run research:leak-test -- --opus --pairs research/leak-test/pairs-2026-05.json --cap 15 --out research/leak-test/results-opus-2026-05.json
```

## Categories

Every pair is tagged with one of four categories. The leak signal is
expected to be uneven across categories — that's the point. A model
that leaks uniformly is just noisy; a model that leaks ONLY on
famous post-date events tells us where the strict-PIT scaffold is
working and where it isn't.

### `famous-hindsight` (25 pairs)

Symbols + dates where Claude's training data definitely contains
post-decision-date information that would dominate a contemporaneous
analyst's view. NVDA pre-AI-rally, GME pre-meme-squeeze, MRNA
pre-COVID-vaccine, the 2022 FAANG crash, etc.

If the strict scaffold works, these pairs should NOT show systematic
unrestricted-arm advantage in 1-yr return prediction. If they do, the
scaffold is failing on exactly the cases that matter most for
historical backtest validity.

### `weak-prior` (21 pairs)

Mid- and small-cap names with no famous narrative — Watsco (HVAC
distributor), Lancaster Colony (packaged food), Mercury General
(auto insurance). Claude has weaker priors on these. Even with full
hindsight available, predictions on these names should be more
uncertain.

This is the control group for "is leakage uniform or
narrative-driven." If leak signal is strong on `famous-hindsight`
but ~50% on `weak-prior`, the strict scaffold can be salvaged for
research on less-famous names — which is most of the universe
anyway.

### `control` (8 pairs)

Major indices (SPY, QQQ, IWM, VTI) at various dates. Two purposes:

1. Sanity check. Both arms should produce roughly similar predictions
   on indices because (a) they're heavily in training data and (b)
   they're not stock-pickable in the conventional sense. Wild
   divergence here would be a smoke signal that the strict prompt is
   confusing the model rather than constraining it.
2. Floor. If even the unrestricted arm is wrong on indices, the
   model isn't using hindsight effectively — making strong claims
   about leakage on individual names becomes harder.

### `qualitative-only` (7 pairs)

Bankrupted / delisted symbols (SVB Financial, First Republic,
Signature Bank, Bed Bath & Beyond, Rite Aid). Alpaca likely returns
no bars for these post-collapse, so the **numeric** leak metric
(unrestricted_win_rate) excludes them.

But these pairs are still valuable for **qualitative** leak detection
in the saved JSON report: when reading the unrestricted arm's
`expected_events_next_12mo` for SIVB at 2023-01-17, does the model
list "bank failure" / "deposit run" / "rates squeeze the balance
sheet"? If yes, leakage is undeniable on this category. If no, the
strict scaffold may be holding even on famous post-date events.

## Date distribution

| Year | Pair count |
|------|------------|
| 2019 | 4          |
| 2020 | 17         |
| 2021 | 11         |
| 2022 | 15         |
| 2023 | 13         |
| 2024 | 1          |
| **Total** | **61**  |

`famous-hindsight` and `weak-prior` pairs share dates with controls
so SPY/QQQ can serve as a same-date baseline in the analysis.

## What the metrics mean

Headline output of the runner:

| Metric | Healthy (scaffold works) | Concerning (leakage) |
|---|---|---|
| `unrestricted_win_rate` overall | 0.45 – 0.55 | > 0.65 |
| `unrestricted_win_rate` on `famous-hindsight` only | < 0.65 | > 0.75 |
| `unrestricted_win_rate` on `weak-prior` only | ≈ 0.50 | n/a — weak prior makes this category noisy |
| `mean_target_divergence_pct` | > 5% | < 1% (strict isn't constraining) |
| `mean_conviction_divergence` | > 5 points | < 2 points |

Plus the qualitative read on `qualitative-only` events — manual
inspection of saved JSON.

## Decision

After the Opus run lands, the W0 verdict is one of three branches:

1. **Scaffold works** (numeric + qualitative both healthy) → proceed
   with W1-W4 sprint.
2. **Scaffold partially works** (passes on weak-prior, fails on
   famous-hindsight) → universe restriction strategy: limit the
   research agent to less-famous names where hindsight is bounded.
   Still potentially viable but smaller potential edge.
3. **Scaffold fails** (high win rate even on weak-prior, qualitative
   evidence of post-date events being predicted) → historical
   backtest is dead. Sprint pivots to forward paper trading: the
   agent runs LIVE from a future kickoff date, picks accumulate over
   months, alpha is measured forward only. Same agent, different
   measurement strategy.

## Caveats / known limitations

- **Alpaca free tier coverage**: not every symbol has bars at every
  date. Pairs without 12-month-forward bars get excluded from the
  numeric metric but still inform the qualitative read via their
  `expected_events_next_12mo` content.
- **Survivorship bias in pair selection**: I picked these names
  knowing how the stories played out (model bias check: I'm Claude,
  trained on the same data). To partially mitigate, the
  `weak-prior` category was selected by browsing S&P 600 with no
  particular thesis in mind — but this is imperfect. A blind
  curator would be better.
- **Single decision date per pair**: the test is a snapshot, not a
  trajectory. A model might leak more or less on the same name at
  different dates. Future iterations could repeat each name across
  3-4 dates.
- **Price target as the predicted variable**: not the only signal —
  conviction and event lists also leak. The runner captures all
  three but only `price target vs actual` becomes the headline
  numeric metric. Conviction / event divergence are secondary
  metrics and qualitative event content is in the saved report for
  human inspection.

## Validation plan

This file should be reviewed before the Opus run. Two reviewers
ideal:

1. **A human who wasn't involved in picking the pairs** — to
   challenge the framing and add cases I missed.
2. **Claude itself, with a prompt like "you're auditing the W0 leak
   test design — what category is over-represented, what's missing,
   what would game the metric"** — adversarial review of my own
   construction.

Both reviews are cheap (no API spend on (2) since it's a single
~$0.10 Opus call). Worth doing before committing to the $5-7
batch run.
