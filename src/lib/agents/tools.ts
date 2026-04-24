// Tool definitions exposed to the Claude agent during a wake-up run.
// Every tool returns JSON-serialisable data and has a strict input schema.

import type Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { analyze, positionSizeCents, type AnalyzerInput } from '@/lib/analyzer';
import {
  cancelOrder,
  getBrokerAccount,
  getLatestPrice,
  getPositions,
  isMarketOpen,
  placeOrder,
} from '@/lib/alpaca';
import { perplexitySearch } from '@/lib/research/perplexity';
import { googleSearch } from '@/lib/research/google';
import { toCents } from '@/lib/money';
import { startOfDayET } from '@/lib/time';
import { log } from '@/lib/logger';
import {
  AcknowledgeThesisReviewInput,
  GetEventCalendarInput,
  GetOptionChainInput,
  PlaceOptionTradeInput,
  PlaceTradeInput,
  ScreenUniverseInput,
  SizePositionInput,
  UpdateStockFundamentalsInput,
} from './schemas';
import { refreshFundamentalsForSymbol } from '@/lib/data/refresh-fundamentals';
import { runScreen } from '@/lib/data/screener';
import { getUpcomingEvents } from '@/lib/data/events';
import { isInEarningsBlackout } from '@/lib/data/earnings';
import { checkWashSaleBlock } from '@/lib/data/tax';
import { computeSpendable } from '@/lib/wallet';
import { getCurrentRegime } from '@/lib/data/regime';
import { evaluateExits } from './exits';
import {
  getOptionContracts,
  getOptionSnapshot,
  parseOccSymbol,
  placeOptionOrder,
} from '@/lib/alpaca-options';
import { validateOptionTrade } from './options';

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: 'get_account_state',
    description:
      'Returns current Alpaca account snapshot (cash, portfolio value, buying power, daytrade count) plus AgBro user policy (limits, pause/stop flags, expected return).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_positions',
    description: 'List all currently held positions via Alpaca.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_latest_price',
    description: 'Latest trade price for a symbol.',
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
  },
  {
    name: 'is_market_open',
    description: 'Is the US equity market currently open?',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_watchlist',
    description:
      'Returns AgBro\'s internal research universe (seeded value/quality names) with latest fundamentals snapshot.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_brain',
    description:
      "Fetch brain entries. ALWAYS filter — pulling everything is wasteful.\n\n" +
      "Brain is organised on two axes:\n" +
      "  category: principle | playbook | reference | memory | hypothesis | note\n" +
      "  confidence: canonical | high | medium | low\n\n" +
      "You can also filter by the finer-grained `kinds` label (e.g. `checklist` inside category=playbook).\n\n" +
      "Recommended usage by phase:\n" +
      "  - At wake-up (orient): categories=[\"principle\",\"playbook\"] + kinds=[\"weekly_update\",\"agent_run_summary\"] — the rules + where the last agent left off.\n" +
      "  - Before researching a candidate: categories=[\"reference\"] — sector primers + case studies for pattern-match.\n" +
      "  - Before a trade: kinds=[\"checklist\"] + any symbol-scoped post_mortem (categories=[\"memory\"], filter by tag/symbol client-side).\n" +
      "  - In a crisis: kinds=[\"crisis_playbook\"] — the 5 historical case studies.\n" +
      "  - Auditing a past call: categories=[\"memory\"], includeSuperseded=true.\n\n" +
      "Superseded entries are hidden by default (replaced by a corrected version). Pass includeSuperseded=true only when explicitly auditing history. Default limit=20.",
    input_schema: {
      type: 'object',
      properties: {
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['principle', 'playbook', 'reference', 'memory', 'hypothesis', 'note'],
          },
        },
        confidence: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['canonical', 'high', 'medium', 'low'],
          },
        },
        kinds: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'principle',
              'checklist',
              'pitfall',
              'crisis_playbook',
              'sector_primer',
              'case_study',
              'lesson',
              'market_memo',
              'post_mortem',
              'weekly_update',
              'agent_run_summary',
              'research_note',
              'hypothesis',
              'note',
            ],
          },
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tag filter — rows must have ALL listed tags.',
        },
        includeSuperseded: { type: 'boolean' },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'write_brain',
    description:
      "Record a NEW brain entry so the next agent benefits. Use for lessons, post-mortems, market memos, hypotheses, or corrections.\n\n" +
      "Fields:\n" +
      "  category — principle | playbook | reference | memory | hypothesis | note. Agents write `memory` or `hypothesis`. NEVER `principle` (reserved for firm doctrine).\n" +
      "  confidence — high | medium | low. Default medium. Only claim high for a lesson you've seen confirmed multiple times.\n" +
      "  kind — finer label: lesson | post_mortem | market_memo | hypothesis | weekly_update.\n" +
      "  supersedesId — (optional) if this entry CORRECTS a prior entry that turned out wrong, pass its id. The old entry is kept for audit but hidden from default reads.\n" +
      "  tags + relatedSymbols — keep these consistent so future agents can find them.\n\n" +
      "Do NOT call write_brain at the END of the run for the run summary — finalize_run records that automatically. Use this during the run for in-flight observations you want the NEXT agent to inherit (e.g. 'AAPL buyback thesis looks weaker after Q2 — revisit next quarter').",
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['memory', 'hypothesis', 'note'],
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
        },
        kind: {
          type: 'string',
          enum: [
            'lesson',
            'post_mortem',
            'market_memo',
            'hypothesis',
            'weekly_update',
          ],
        },
        title: { type: 'string' },
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        relatedSymbols: { type: 'array', items: { type: 'string' } },
        supersedesId: { type: 'string' },
      },
      required: ['kind', 'title', 'body'],
    },
  },
  {
    name: 'run_analyzer',
    description:
      'Run AgBro\'s internal financial analyzer (Graham, DCF, DDM, sector P/E, moat score, Buffett score, margin of safety, verdict). Call BEFORE considering a trade.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        price: { type: 'number' },
        eps: { type: 'number' },
        epsGrowthPct: { type: 'number' },
        bookValuePerShare: { type: 'number' },
        dividendPerShare: { type: 'number' },
        fcfPerShare: { type: 'number' },
        sharesOutstanding: { type: 'number' },
        totalDebt: { type: 'number' },
        totalEquity: { type: 'number' },
        returnOnEquityPct: { type: 'number' },
        grossMarginPct: { type: 'number' },
        sector: { type: 'string' },
      },
      required: [
        'symbol',
        'price',
        'eps',
        'epsGrowthPct',
        'bookValuePerShare',
        'dividendPerShare',
        'fcfPerShare',
        'sharesOutstanding',
        'totalDebt',
        'totalEquity',
        'returnOnEquityPct',
        'grossMarginPct',
      ],
    },
  },
  {
    name: 'research_perplexity',
    description:
      'Specific, time-sensitive research via Perplexity (earnings, company news, competitive threats). Always ask for a Bull Case AND Bear Case.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'research_google',
    description: 'General/background web search for broader context.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, num: { type: 'number' } },
      required: ['query'],
    },
  },
  {
    name: 'record_research_note',
    description:
      'Persist a research note (bull/bear/summary) to the brain, optionally tied to a symbol.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        topic: { type: 'string' },
        source: { type: 'string' },
        bullCase: { type: 'string' },
        bearCase: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['topic', 'source', 'summary'],
    },
  },
  {
    name: 'size_position',
    description:
      'Use AgBro\'s internal position sizer. Respects max_position_pct, min_cash_reserve_pct and confidence. Returns USD cents to deploy.',
    input_schema: {
      type: 'object',
      properties: {
        buffettScore: { type: 'number' },
        confidence: { type: 'number' },
      },
      required: ['buffettScore', 'confidence'],
    },
  },
  {
    name: 'refresh_fundamentals',
    description:
      "PREFERRED way to get fresh fundamentals. Pulls directly from SEC EDGAR (the authoritative source behind every paid data provider) and upserts into the Stock row. Use this BEFORE run_analyzer whenever the Stock's fundamentalsUpdatedAt is older than 7 days or fundamentalsSource is 'seed'. Returns the snapshot it wrote, or status='not_found' for non-US ADRs / ETFs that EDGAR doesn't cover. For ETFs, fall back to research_perplexity.",
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
  },
  {
    name: 'update_stock_fundamentals',
    description:
      "Manual override — set fundamentals when SEC EDGAR doesn't cover the asset (ETFs, foreign ADRs) or when you have better data than the last filing (between-quarter news). Prefer refresh_fundamentals for US equities. Provide only fields you have fresh data for — omitted fields are left untouched.",
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        peRatio: { type: 'number' },
        pbRatio: { type: 'number' },
        dividendYield: { type: 'number' },
        payoutRatio: { type: 'number' },
        debtToEquity: { type: 'number' },
        returnOnEquity: { type: 'number' },
        grossMarginPct: { type: 'number' },
        fcfYieldPct: { type: 'number' },
        moatScore: { type: 'number' },
        buffettScore: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'screen_universe',
    description:
      "Hunt OUTSIDE the current watchlist for fresh value-investing candidates. " +
      "Rate-limited server-side to once per 7 days — if you call it more often it returns " +
      "status='cooldown_active' with no new work done. Use it when: " +
      "(a) it's the first wake-up of a new week AND the watchlist has no MoS ≥ 20% opportunities, " +
      "OR (b) the last screen is older than 14 days AND the agent is sitting on cash with nothing to do. " +
      "The tool calls Perplexity for candidates matching criteria, excludes everything already in " +
      "the DB (watchlist + prior candidates + rejected names), enriches hits with SEC EDGAR " +
      "fundamentals, and stores up to 5 as Tier 2 candidates for the USER to approve or reject. " +
      "You CANNOT promote candidates to the main watchlist yourself — that's user-gated. " +
      "You CAN research and trade Tier 2 candidates after they're approved.",
    input_schema: {
      type: 'object',
      properties: {
        minRoePct: { type: 'number', description: 'Minimum return on equity %. Default 15.' },
        maxPeRatio: { type: 'number', description: 'Maximum trailing P/E. Default 22.' },
        minDividendYieldPct: { type: 'number', description: 'Minimum dividend yield %. Default 0.' },
        preferredSectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Sectors to favour. Empty = any sector.',
        },
        thesisHint: {
          type: 'string',
          description:
            "Optional free-form hint steering the search — e.g. \"dividend aristocrats trading below 10y avg P/E\" or \"quality names that sold off on recent earnings misses\".",
        },
      },
      required: [],
    },
  },
  {
    name: 'acknowledge_thesis_review',
    description:
      'Call this AFTER reviewing a position whose evaluate_exits signal was "review" and deciding the thesis still holds. Bumps the review timer forward so the same position isn\'t flagged on the next wake-up. Without this acknowledgement, the evaluator will re-surface the same stale review signal on every tick, burning tokens and log noise. Provide a short reviewNote summarising what was re-confirmed (the deeper analysis belongs in record_research_note).',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        reviewNote: { type: 'string', description: 'One-liner reconfirming the thesis.' },
      },
      required: ['symbol', 'reviewNote'],
    },
  },
  {
    name: 'evaluate_exits',
    description:
      'Returns a per-open-position exit assessment: { symbol, signal: "hold"|"review"|"trim"|"sell", reason, thesis, taxHarvestCandidate, unrealizedLossCents }. Signals come from the active strategy\'s exit rules (price target, time stop, thesis review, fundamentals deterioration, dividend safety). Earnings blackout converts any "sell" into "review" — you never auto-sell into an earnings release. taxHarvestCandidate=true means the position is at a loss, it\'s Q4, and the thesis is already under review — if your review concludes "sell," do it THIS calendar year to claim the loss. NEVER harvest a conviction position just for the write-off. CALL THIS FIRST every wake-up, before any new-buy research. Process every non-hold signal before considering new positions.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_option_chain',
    description:
      'List active option contracts for an underlying, filtered by type (call|put) and DTE window. Returns OCC-format symbols, strikes, expirations, and (when available) greeks + bid/ask. USE ONLY when your active strategy allows options AND the user\'s account has optionsEnabled=true. Pick strikes aligned with your fair-value estimate: covered-call strike AT OR ABOVE your fair-value, cash-secured-put strike AT OR BELOW your desired entry price.',
    input_schema: {
      type: 'object',
      properties: {
        underlying: { type: 'string', description: 'Equity ticker (e.g. AAPL).' },
        type: { type: 'string', enum: ['call', 'put'] },
        minDTE: { type: 'number', description: 'Minimum days to expiration. Default 30.' },
        maxDTE: { type: 'number', description: 'Maximum days to expiration. Default 60.' },
      },
      required: ['underlying', 'type'],
    },
  },
  {
    name: 'place_option_trade',
    description:
      'Sell-to-open a covered call OR cash-secured put. These are the only option setups AgBro permits — no naked options, no long options, no spreads. Server hard-rejects anything else. Covered call: you must already hold ≥ qty × 100 shares of the underlying. Cash-secured put: you must have ≥ strike × 100 × qty idle cash. Server also enforces DTE window, max delta, and the strategy\'s options book cap. Your thesis must explain why selling this premium makes sense given your fair-value estimate.',
    input_schema: {
      type: 'object',
      properties: {
        optionSymbol: { type: 'string', description: 'OCC format — e.g. AAPL250117C00200000.' },
        setup: { type: 'string', enum: ['covered_call', 'cash_secured_put'] },
        qty: { type: 'number', description: 'Number of contracts (1 = 100 shares of exposure).' },
        limitPrice: { type: 'number', description: 'Per-share limit price. Omit for market order.' },
        thesis: { type: 'string' },
      },
      required: ['optionSymbol', 'setup', 'qty', 'thesis'],
    },
  },
  {
    name: 'get_event_calendar',
    description:
      'Returns upcoming scheduled events (earnings, FOMC, CPI, market closures) within horizonDays (default 14). Pass symbol to narrow to one name + market-wide events; omit to see events for the whole watchlist. USE THIS before place_trade with side=buy — the server blocks buys within 3 days of a symbol\'s earnings report regardless, but checking first lets you plan around it.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Optional — narrow to one ticker.' },
        horizonDays: { type: 'number', description: 'Lookahead window in days. Default 14, max 90.' },
      },
      required: [],
    },
  },
  {
    name: 'place_trade',
    description:
      "Submit an order to Alpaca. For BUYS, intrinsicValuePerShare AND marginOfSafetyPct are required (compute via run_analyzer first) — the server enforces a minimum MOS consistent with the active strategy's minMarginOfSafetyPct and rejects trades below it. Sells may omit IV/MOS. Server re-validates ALL safety rails before routing.",
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        qty: { type: 'number' },
        orderType: { type: 'string', enum: ['market', 'limit'] },
        limitPrice: { type: 'number' },
        bullCase: { type: 'string' },
        bearCase: { type: 'string' },
        thesis: { type: 'string' },
        confidence: { type: 'number' },
        intrinsicValuePerShare: {
          type: 'number',
          description:
            'Per-share fair value from run_analyzer (or an equivalent documented method). REQUIRED for side=buy.',
        },
        marginOfSafetyPct: {
          type: 'number',
          description:
            'Discount of price vs intrinsic, as a percent (e.g. 25 = price is 25% below intrinsic). REQUIRED for side=buy. Must meet or exceed the active strategy\'s minMarginOfSafetyPct.',
        },
      },
      required: [
        'symbol',
        'side',
        'qty',
        'bullCase',
        'bearCase',
        'thesis',
        'confidence',
      ],
    },
  },
  {
    name: 'finalize_run',
    description:
      'End the run with a short summary + decision (trade|hold|research_more|rebalance). Summary is persisted as a brain entry.',
    input_schema: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          enum: ['trade', 'hold', 'research_more', 'rebalance'],
        },
        summary: { type: 'string' },
      },
      required: ['decision', 'summary'],
    },
  },
];

export type ToolContext = {
  agentRunId: string;
  userId: string;
};

type Json = unknown;

// Main dispatcher called by the orchestrator.
export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<Json> {
  switch (name) {
    case 'get_account_state':
      return getAccountState(ctx);
    case 'get_positions':
      return safeAlpaca(() => getPositions());
    case 'get_latest_price':
      return { price: await safeAlpaca(() => getLatestPrice(String(input.symbol))) };
    case 'is_market_open':
      return { open: await safeAlpaca(() => isMarketOpen()) };
    case 'get_watchlist':
      return prisma.stock.findMany({
        where: { onWatchlist: true },
        orderBy: [{ buffettScore: 'desc' }],
      });
    case 'read_brain': {
      const limit = typeof input.limit === 'number' ? input.limit : 20;
      const kinds = Array.isArray(input.kinds) ? (input.kinds as string[]) : undefined;
      const categories = Array.isArray(input.categories)
        ? (input.categories as Array<
            'principle' | 'playbook' | 'reference' | 'memory' | 'hypothesis' | 'note'
          >)
        : undefined;
      const confidence = Array.isArray(input.confidence)
        ? (input.confidence as Array<'canonical' | 'high' | 'medium' | 'low'>)
        : undefined;
      const tags = Array.isArray(input.tags) ? (input.tags as string[]) : undefined;
      const includeSuperseded = input.includeSuperseded === true;
      return prisma.brainEntry.findMany({
        where: {
          userId: ctx.userId,
          ...(kinds ? { kind: { in: kinds } } : {}),
          ...(categories ? { category: { in: categories } } : {}),
          ...(confidence ? { confidence: { in: confidence } } : {}),
          ...(tags && tags.length > 0 ? { tags: { hasEvery: tags } } : {}),
          ...(includeSuperseded ? {} : { supersededById: null }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          kind: true,
          category: true,
          confidence: true,
          title: true,
          body: true,
          tags: true,
          relatedSymbols: true,
          supersededById: true,
          createdAt: true,
        },
      });
    }
    case 'write_brain':
      return writeBrainTool(ctx, input);
    case 'run_analyzer':
      return analyze(input as unknown as AnalyzerInput);
    case 'research_perplexity':
      return perplexitySearch(String(input.query));
    case 'research_google':
      return googleSearch(String(input.query), Number(input.num ?? 5));
    case 'record_research_note':
      return recordResearchNoteTool(ctx, input);
    case 'size_position':
      return sizePositionTool(ctx, input);
    case 'place_trade':
      return placeTradeTool(ctx, input);
    case 'update_stock_fundamentals':
      return updateStockFundamentalsTool(input);
    case 'refresh_fundamentals':
      return refreshFundamentalsForSymbol(String(input.symbol));
    case 'screen_universe': {
      const parsed = ScreenUniverseInput.safeParse(input);
      if (!parsed.success) {
        throw new Error(`screen_universe: invalid input — ${parsed.error.message}`);
      }
      // Agent path never bypasses the cooldown — only the user-triggered
      // /api/candidates/screen endpoint can. Auto-promote is honoured here
      // too so the weekly cron run can act without waiting for the human.
      const account = await prisma.account.findUnique({
        where: { userId: ctx.userId },
        select: { autoPromoteCandidates: true },
      });
      return runScreen(parsed.data, {
        autoPromoteHighConviction: account?.autoPromoteCandidates === true,
      });
    }
    case 'get_event_calendar': {
      const parsed = GetEventCalendarInput.safeParse(input);
      if (!parsed.success) {
        throw new Error(`get_event_calendar: invalid input — ${parsed.error.message}`);
      }
      return { events: await getUpcomingEvents(parsed.data) };
    }
    case 'evaluate_exits': {
      // The orchestrator's syncPositions already reconciled our DB against
      // the broker at the start of this wake-up, so evaluateExits reads
      // from aligned state. No extra Alpaca call needed here.
      return { assessments: await evaluateExits(ctx.userId) };
    }
    case 'acknowledge_thesis_review': {
      const parsed = AcknowledgeThesisReviewInput.safeParse(input);
      if (!parsed.success) {
        throw new Error(`acknowledge_thesis_review: invalid input — ${parsed.error.message}`);
      }
      return acknowledgeThesisReviewTool(ctx, parsed.data);
    }
    case 'get_option_chain': {
      const parsed = GetOptionChainInput.safeParse(input);
      if (!parsed.success) {
        throw new Error(`get_option_chain: invalid input — ${parsed.error.message}`);
      }
      return getOptionChainTool(parsed.data);
    }
    case 'place_option_trade': {
      const parsed = PlaceOptionTradeInput.safeParse(input);
      if (!parsed.success) {
        throw new Error(`place_option_trade: invalid input — ${parsed.error.message}`);
      }
      return placeOptionTradeTool(ctx, parsed.data);
    }
    case 'finalize_run':
      return finalizeRunTool(ctx, input);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function safeAlpaca<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: (e as Error).message } as T;
  }
}

async function getAccountState(ctx: ToolContext) {
  const [broker, account, regime] = await Promise.all([
    safeAlpaca(() => getBrokerAccount()),
    prisma.account.findUnique({ where: { userId: ctx.userId } }),
    getCurrentRegime(),
  ]);
  // Wallet reservation: if the user parked cash in the AgBro wallet,
  // the agent should see reduced buying power. Surface both the raw
  // Alpaca numbers AND the spendable breakdown so the agent's reasoning
  // can distinguish "account has $100k" from "I can deploy $50k".
  const wallet =
    broker && !('error' in broker) && account
      ? computeSpendable({
          alpacaCashCents: broker.cashCents,
          walletBalanceCents: account.walletBalanceCents,
        })
      : null;
  return {
    broker,
    wallet: wallet && {
      alpacaCashCents: wallet.alpacaCashCents.toString(),
      walletBalanceCents: wallet.walletBalanceCents.toString(),
      spendableCents: wallet.spendableCents.toString(),
    },
    // Current market regime. When != 'calm', the agent MUST read brain
    // entries with kinds=['crisis_playbook'] before deciding anything,
    // and apply the strategy-specific crisis behavior. See AGBRO_PRINCIPLES
    // step 5 in the wake-up process.
    regime,
    policy: account && {
      isPaused: account.isPaused,
      isStopped: account.isStopped,
      expectedAnnualPct: account.expectedAnnualPct,
      riskTolerance: account.riskTolerance,
      maxPositionPct: account.maxPositionPct,
      maxDailyTrades: account.maxDailyTrades,
      minCashReservePct: account.minCashReservePct,
      allowDayTrades: account.allowDayTrades,
      tradingHoursStart: account.tradingHoursStart,
      tradingHoursEnd: account.tradingHoursEnd,
    },
  };
}

async function sizePositionTool(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = SizePositionInput.safeParse(input);
  if (!parsed.success) {
    throw new Error(`size_position: invalid input — ${parsed.error.message}`);
  }
  const account = await prisma.account.findUnique({ where: { userId: ctx.userId } });
  if (!account) throw new Error('account not found');
  const broker = await getBrokerAccount();
  const { spendableCents } = computeSpendable({
    alpacaCashCents: broker.cashCents,
    walletBalanceCents: account.walletBalanceCents,
  });
  const cents = positionSizeCents({
    portfolioValueCents: broker.portfolioValueCents,
    // Position sizer treats "cashCents" as what we can actually deploy.
    // Using spendable (Alpaca cash minus wallet reservation) keeps sizing
    // honest with respect to the user's wallet freeze.
    cashCents: spendableCents,
    buffettScore: parsed.data.buffettScore,
    confidence: parsed.data.confidence,
    maxPositionPct: account.maxPositionPct,
    minCashReservePct: account.minCashReservePct,
  });
  return { suggestedAllocationCents: cents.toString(), suggestedAllocationUsd: Number(cents) / 100 };
}

async function placeTradeTool(ctx: ToolContext, input: Record<string, unknown>) {
  const parsed = PlaceTradeInput.safeParse(input);
  if (!parsed.success) {
    throw new Error(`place_trade: invalid input — ${parsed.error.message}`);
  }
  const p = parsed.data;

  const symbol = p.symbol.toUpperCase();
  const orderType = p.orderType ?? 'market';
  if (orderType === 'limit' && p.limitPrice == null) {
    throw new Error('place_trade: limitPrice required when orderType=limit');
  }

  // MOS gate for buys — schema guarantees both fields are present on
  // buy orders; enforce the active strategy's minMarginOfSafetyPct
  // here rather than at Zod level so the error message can name the
  // strategy rule the agent was breaking. Sells skip this block.
  if (p.side === 'buy') {
    const mos = p.marginOfSafetyPct as number; // schema-guaranteed for buys
    const activeStrategy = await prisma.strategy.findFirst({
      where: { userId: ctx.userId, isActive: true },
      select: { name: true, rules: true },
    });
    const strategyMinMos = (() => {
      const rules = (activeStrategy?.rules as Record<string, unknown> | undefined) ?? {};
      const v = rules.minMarginOfSafetyPct;
      return typeof v === 'number' ? v : null;
    })();
    if (strategyMinMos != null && mos < strategyMinMos) {
      log.info('trade.blocked_by_mos', {
        userId: ctx.userId,
        symbol,
        mos,
        strategyMinMos,
        strategy: activeStrategy?.name ?? null,
      });
      throw new Error(
        `place_trade: MOS ${mos.toFixed(1)}% is below ${activeStrategy?.name ?? 'the active strategy'}'s minimum of ${strategyMinMos}%. Either find a price that clears the bar or document the exception in the thesis — the gate does not bend per-trade.`
      );
    }
  }

  // Earnings blackout — hard block on BUYS within 3 days of a scheduled
  // earnings report. Value investing is not speculation on binary events;
  // a buy right before earnings is a gamble on the print. Sells/trims are
  // always allowed (you never want to hold a broken thesis waiting on a
  // call). No agent-side override in v1 — this is intentionally strict.
  if (p.side === 'buy') {
    const blackout = await isInEarningsBlackout(symbol);
    if (blackout.blocked) {
      log.info('trade.blocked_by_earnings', {
        userId: ctx.userId,
        symbol,
        nextEarningsAt: blackout.nextEarningsAt?.toISOString() ?? null,
      });
      throw new Error(
        `place_trade: blocked by earnings blackout — ${blackout.reason}. Wait until after the report. (Sells/trims would have been allowed.)`
      );
    }

    // Wash-sale protection (IRS §1091). If we sold this symbol at a loss
    // within the last 30 days, rebuying would disallow the loss. Block the
    // buy to keep our own tax accounting clean. We don't prevent every
    // possible wash-sale edge case (the IRS rule is symmetric; buying then
    // selling another lot at a loss within 30 days is harder to pre-empt
    // and is rare for a long-term value strategy).
    const washSale = await checkWashSaleBlock(ctx.userId, symbol);
    if (washSale.blocked) {
      log.info('trade.blocked_by_wash_sale', {
        userId: ctx.userId,
        symbol,
        recentSellTradeId: washSale.recentSell?.tradeId,
      });
      throw new Error(`place_trade: ${washSale.reason}`);
    }

    // Wallet-reservation check. If the user has parked cash in the
    // AgBro wallet, subtract it from effective buying power BEFORE
    // routing to the broker. Pre-flight catch is cleaner than letting
    // Alpaca reject — we emit a clear error the agent can act on.
    try {
      const [acct, broker] = await Promise.all([
        prisma.account.findUnique({
          where: { userId: ctx.userId },
          select: { walletBalanceCents: true },
        }),
        getBrokerAccount(),
      ]);
      if (acct) {
        const spendable = computeSpendable({
          alpacaCashCents: broker.cashCents,
          walletBalanceCents: acct.walletBalanceCents,
        });
        // Estimate order cost. Prefer live price; fall back to the
        // limit price on limit orders so the notional cap can still
        // apply. If we have neither, fail CLOSED on buys — previously
        // the whole wallet + notional check block was nested inside
        // `if (price != null)`, so a failed price fetch silently
        // bypassed both gates and let an uncapped order through to
        // Alpaca.
        const livePrice = await getLatestPrice(symbol).catch(() => null);
        const priceForEstimate =
          livePrice != null && livePrice > 0
            ? livePrice
            : p.orderType === 'limit' &&
              typeof p.limitPrice === 'number' &&
              p.limitPrice > 0
              ? p.limitPrice
              : null;
        if (priceForEstimate != null) {
          const estimatedCostCents = BigInt(
            Math.round(priceForEstimate * p.qty * 100)
          );
          if (estimatedCostCents > spendable.spendableCents) {
            log.info('trade.blocked_by_wallet', {
              userId: ctx.userId,
              symbol,
              estimatedCostCents: estimatedCostCents.toString(),
              spendableCents: spendable.spendableCents.toString(),
              walletBalanceCents: spendable.walletBalanceCents.toString(),
            });
            throw new Error(
              `place_trade: insufficient spendable cash. Order needs ~$${(Number(estimatedCostCents) / 100).toFixed(0)} but only $${(Number(spendable.spendableCents) / 100).toFixed(0)} is available ($${(Number(spendable.walletBalanceCents) / 100).toFixed(0)} is parked in the wallet). Transfer from wallet to active cash if you want this trade to go through.`
            );
          }
          // Per-trade notional kill: defensive cap on absolute dollar
          // amount regardless of portfolio size. Only applies to buys —
          // sells reduce exposure so we don't cap their size.
          if (p.side === 'buy') {
            const { checkTradeNotional } = await import('@/lib/safety/rails');
            const notional = await checkTradeNotional(ctx.userId, estimatedCostCents);
            if (!notional.ok) {
              log.info('trade.blocked_by_notional', {
                userId: ctx.userId,
                symbol,
                estimatedCostCents: estimatedCostCents.toString(),
              });
              throw new Error(`place_trade: ${notional.reason}. Raise maxTradeNotionalCents in Settings or split the order.`);
            }
          }
        } else if (p.side === 'buy') {
          // No price for estimation: fail closed on buys so the
          // notional cap can't be silently bypassed by a data-feed
          // hiccup. Sells still fall through (they reduce exposure).
          log.info('trade.blocked_no_price_for_cap', {
            userId: ctx.userId,
            symbol,
            orderType: p.orderType,
          });
          throw new Error(
            `place_trade: cannot estimate order cost for ${symbol} (live price unavailable, no limit price supplied). Retry when market data is healthy, or submit as a limit order so the per-trade notional cap has a price to check against.`
          );
        }
      }
    } catch (walletErr) {
      // Only re-throw the explicit rail throws. Anything else (Alpaca
      // hiccup reading the broker account, DB glitch) falls through to
      // the broker call which will be authoritative.
      if (
        walletErr instanceof Error &&
        (walletErr.message.startsWith('place_trade: insufficient') ||
          walletErr.message.startsWith('place_trade: trade notional') ||
          walletErr.message.startsWith('place_trade: cannot estimate'))
      ) {
        throw walletErr;
      }
    }
  }

  // Atomically: take a per-user write lock, re-read pause/stop + cap under the
  // lock, count today's trades, and reserve a 'pending' Trade row. The lock
  // serialises concurrent place_trade calls for the same user so the
  // count-then-insert pair can't be double-passed by two callers (closes the
  // maxDailyTrades race). It also re-checks pause/stop AFTER acquiring the
  // lock so a user flip between tool entry and the broker call can't slip
  // through (closes the pause-race window).
  const since = startOfDayET();
  const pending = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "Account" WHERE "userId" = ${ctx.userId} FOR UPDATE`;

    const acct = await tx.account.findUnique({ where: { userId: ctx.userId } });
    if (!acct) throw new Error('account not found');
    if (acct.isStopped) throw new Error('account is stopped; trading disabled');
    if (acct.isPaused) throw new Error('account is paused; trading disabled');

    // Pending + submitted + filled all count toward the daily cap — they
    // represent intent that's either at the broker or already executed.
    // ONLY stock trades count against maxDailyTrades; crypto has its own
    // separate ceiling (maxDailyCryptoTrades) so rule-based DCA legs
    // don't eat the agent's trade budget. Schema default 'stock' covers
    // pre-crypto-module rows automatically.
    const todaysTrades = await tx.trade.count({
      where: {
        userId: ctx.userId,
        submittedAt: { gte: since },
        assetClass: 'stock',
      },
    });
    if (todaysTrades >= acct.maxDailyTrades) {
      throw new Error(`daily stock trade cap reached (${acct.maxDailyTrades})`);
    }

    // Write the pending row BEFORE talking to Alpaca. Guarantees we have a
    // record of every attempt even if the broker call fails. This is the
    // audit trail, and it also reserves the daily-cap slot under the lock.
    return tx.trade.create({
      data: {
        userId: ctx.userId,
        alpacaOrderId: null,
        symbol,
        side: p.side,
        qty: p.qty,
        status: 'pending',
        orderType,
        bullCase: p.bullCase,
        bearCase: p.bearCase,
        thesis: p.thesis,
        confidence: p.confidence,
        marginOfSafetyPct: p.marginOfSafetyPct,
        intrinsicValuePerShareCents:
          p.intrinsicValuePerShare && p.intrinsicValuePerShare > 0
            ? toCents(p.intrinsicValuePerShare)
            : null,
        agentRunId: ctx.agentRunId,
      },
    });
  });

  // Step 2: place the order with the broker.
  let order: Awaited<ReturnType<typeof placeOrder>>;
  try {
    order = await placeOrder({
      symbol,
      qty: p.qty,
      side: p.side,
      orderType,
      limitPrice: p.limitPrice,
    });
  } catch (brokerErr) {
    // Broker rejected. Mark the pending row so the agent (and the user)
    // can see what went wrong.
    await prisma.trade
      .update({
        where: { id: pending.id },
        data: {
          status: 'rejected',
          errorMessage: (brokerErr as Error).message.slice(0, 500),
        },
      })
      .catch((dbErr) => {
        log.error('trade.reject_mark_failed', dbErr, { tradeId: pending.id });
      });
    throw brokerErr;
  }

  // Step 3: stitch the order id back onto the trade row. If THIS fails,
  // we've left the broker holding an order with no DB record — try to cancel
  // it so the broker and DB stay in sync.
  let trade;
  try {
    trade = await prisma.trade.update({
      where: { id: pending.id },
      data: { alpacaOrderId: order.id, status: 'submitted' },
    });
  } catch (dbErr) {
    log.error('trade.db_update_failed_after_broker_accept', dbErr, {
      tradeId: pending.id,
      alpacaOrderId: order.id,
    });
    await cancelOrder(order.id);
    throw dbErr;
  }

  await prisma.notification
    .create({
      data: {
        userId: ctx.userId,
        tradeId: trade.id,
        kind: 'trade_placed',
        title: `${p.side.toUpperCase()} ${p.qty} ${symbol}`,
        body: `Thesis: ${p.thesis.slice(0, 240)}`,
      },
    })
    .catch((notifErr) => {
      // Notification failure shouldn't fail the trade — the trade is real.
      log.error('trade.notification_failed', notifErr, { tradeId: trade.id });
    });

  // Record realized P/L on sells so tax-loss-harvest and wash-sale logic
  // has data to reason against. Estimated at submit time using latestPrice
  // vs. the Position row's stored avg cost — the broker's actual fill may
  // differ by a few cents but this is close enough for §1091 gain/loss
  // classification. The IRS-canonical number comes from Alpaca's 1099-B.
  if (p.side === 'sell') {
    try {
      const [position, price] = await Promise.all([
        prisma.position.findUnique({
          where: { userId_symbol: { userId: ctx.userId, symbol } },
          select: { avgCostCents: true },
        }),
        getLatestPrice(symbol).catch(() => null),
      ]);
      if (position && price != null && price > 0) {
        // Position.avgCostCents is per-share (matches Alpaca's avg_entry_price).
        const avgCostPerShareCents = Number(position.avgCostCents);
        const totalCostBasisCents = avgCostPerShareCents * p.qty;
        const totalProceedsCents = price * p.qty * 100;
        const pnlCents = BigInt(Math.round(totalProceedsCents - totalCostBasisCents));
        await prisma.trade.update({
          where: { id: trade.id },
          data: {
            fillPriceCents: BigInt(Math.round(price * 100)),
            realizedPnlCents: pnlCents,
            closedAt: new Date(),
          },
        });
      }
    } catch (pnlErr) {
      // P/L recording is informational — don't fail a successful sell on it.
      log.error('trade.pnl_record_failed', pnlErr, { tradeId: trade.id });
    }
  }

  // Stamp thesis metadata onto the Position row (buys only). We copy the
  // holding-period bias from the active strategy so the exit evaluator can
  // apply the right exit rules even if the user later switches strategy.
  // targetPriceCents comes from the agent's intrinsicValuePerShare — used by
  // price-target strategies (Graham) and harmless for everyone else.
  if (p.side === 'buy') {
    try {
      const active = await prisma.strategy.findFirst({
        where: { userId: ctx.userId, isActive: true },
        select: { id: true, rules: true },
      });
      const r = (active?.rules ?? {}) as { holdingPeriodBias?: string; thesisReviewDays?: number | null };
      const reviewDays = r.thesisReviewDays ?? 180;
      const reviewDue =
        reviewDays != null && reviewDays > 0
          ? new Date(Date.now() + reviewDays * 86_400_000)
          : null;
      await prisma.position.upsert({
        where: { userId_symbol: { userId: ctx.userId, symbol } },
        update: {
          thesis: p.thesis.slice(0, 4_000),
          targetPriceCents:
            p.intrinsicValuePerShare && p.intrinsicValuePerShare > 0
              ? toCents(p.intrinsicValuePerShare)
              : undefined,
          holdingBias: r.holdingPeriodBias ?? undefined,
          thesisReviewDueAt: reviewDue ?? undefined,
          openedUnderStrategyId: active?.id ?? undefined,
        },
        create: {
          userId: ctx.userId,
          symbol,
          qty: p.qty,
          avgCostCents: BigInt(0), // placeholder; orchestrator syncPositions overwrites with broker avg entry on next wake-up
          thesis: p.thesis.slice(0, 4_000),
          targetPriceCents:
            p.intrinsicValuePerShare && p.intrinsicValuePerShare > 0
              ? toCents(p.intrinsicValuePerShare)
              : null,
          holdingBias: r.holdingPeriodBias ?? null,
          thesisReviewDueAt: reviewDue,
          openedUnderStrategyId: active?.id ?? null,
        },
      });
    } catch (psErr) {
      // Thesis metadata is informational — never fail a successful trade on a
      // Position-row write hiccup.
      log.error('trade.position_state_write_failed', psErr, { tradeId: trade.id });
    }
  }

  return { tradeId: trade.id, alpacaOrderId: order.id, status: 'submitted' };
}

async function updateStockFundamentalsTool(input: Record<string, unknown>) {
  const parsed = UpdateStockFundamentalsInput.safeParse(input);
  if (!parsed.success) {
    throw new Error(`update_stock_fundamentals: invalid input — ${parsed.error.message}`);
  }
  const { symbol, ...patch } = parsed.data;
  const sym = symbol.toUpperCase();

  // Only include keys the agent actually sent — don't overwrite existing
  // values with `null` because a field was omitted.
  const data: Record<string, unknown> = { lastAnalyzedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) data[k] = v;
  }

  // upsert so the agent can also discover and add new tickers (we still
  // require the symbol; name defaults to the symbol if the row is new).
  const stock = await prisma.stock.upsert({
    where: { symbol: sym },
    update: data,
    create: { symbol: sym, name: sym, onWatchlist: true, ...data },
  });

  return {
    symbol: stock.symbol,
    updatedFields: Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined),
    lastAnalyzedAt: stock.lastAnalyzedAt,
  };
}

// record_research_note does TWO writes now:
//   (1) ResearchNote — the structured record (symbol, source, bull/bear).
//   (2) BrainEntry mirror — category=memory, kind='research_note', tagged
//       with symbol + 'research_note' so it shows up on /brain alongside
//       every other memory. The prompt promised "every research loop ends
//       with a persisted note", but historically those notes were only
//       queryable via the raw ResearchNote table — invisible from /brain
//       and never surfaced to the agent's own read_brain tool.
async function recordResearchNoteTool(
  ctx: ToolContext,
  input: Record<string, unknown>
) {
  const topic = String(input.topic).slice(0, 240);
  const source = String(input.source).slice(0, 120);
  const symbol =
    typeof input.symbol === 'string' && input.symbol.trim().length > 0
      ? input.symbol.toUpperCase()
      : null;
  const bullCase =
    typeof input.bullCase === 'string' && input.bullCase.trim().length > 0
      ? input.bullCase
      : null;
  const bearCase =
    typeof input.bearCase === 'string' && input.bearCase.trim().length > 0
      ? input.bearCase
      : null;
  const summary = String(input.summary);

  const note = await prisma.researchNote.create({
    data: {
      agentRunId: ctx.agentRunId,
      symbol,
      topic,
      source,
      bullCase,
      bearCase,
      summary,
    },
  });

  // BrainEntry mirror. Body composes the parts into a readable block;
  // kept tight (≤ ~2000 chars) so the /brain list stays scannable.
  const parts: string[] = [summary.trim()];
  if (bullCase) parts.push(`\nBull case: ${bullCase.trim()}`);
  if (bearCase) parts.push(`\nBear case: ${bearCase.trim()}`);
  parts.push(`\nSource: ${source}`);
  const body = parts.join('\n').slice(0, 8_000);
  const title = symbol
    ? `Research: ${symbol} — ${topic}`.slice(0, 240)
    : `Research: ${topic}`.slice(0, 240);
  await prisma.brainEntry
    .create({
      data: {
        userId: ctx.userId,
        kind: 'research_note',
        category: 'memory',
        confidence: 'medium',
        sourceRunId: ctx.agentRunId,
        title,
        body,
        tags: ['research_note', 'auto-recorded'],
        relatedSymbols: symbol ? [symbol] : [],
      },
    })
    .catch((err) => {
      // Don't let a brain write failure break record_research_note —
      // the structured ResearchNote row is the authoritative record,
      // the BrainEntry is just the /brain visibility mirror.
      log.warn('research_note.brain_mirror_failed', {
        userId: ctx.userId,
        agentRunId: ctx.agentRunId,
        err: (err as Error).message,
      });
    });

  return note;
}

async function finalizeRunTool(ctx: ToolContext, input: Record<string, unknown>) {
  const decision = String(input.decision);
  const summary = String(input.summary);
  await prisma.agentRun.update({
    where: { id: ctx.agentRunId },
    data: { decision, summary, endedAt: new Date(), status: 'completed' },
  });
  await prisma.brainEntry.create({
    data: {
      userId: ctx.userId,
      kind: 'agent_run_summary',
      // Run summaries are "this is what happened" — memory, medium
      // confidence. Principles get upgraded only via the slow
      // brain-writer path (weekly cron, or user).
      category: 'memory',
      confidence: 'medium',
      sourceRunId: ctx.agentRunId,
      title: `Agent run ${ctx.agentRunId.slice(0, 8)} — ${decision}`,
      body: summary,
    },
  });
  return { finalized: true };
}

// In-flight brain write. Called during a run when the agent wants to
// stash a lesson, post-mortem, or hypothesis for the NEXT agent to
// pick up. finalize_run covers the overall run summary; this is for
// specific durable observations the agent wants to persist separately.
async function writeBrainTool(ctx: ToolContext, input: Record<string, unknown>) {
  const kind = String(input.kind);
  const title = String(input.title).slice(0, 240);
  const body = String(input.body).slice(0, 8_000);
  if (!title || !body) {
    throw new Error('write_brain: title and body are required');
  }
  // Map category/confidence, falling back to the legacy-kind taxonomy
  // if the agent supplied only `kind`. Agents are NEVER allowed to
  // write `principle` or `canonical` — those are reserved for the
  // seeded firm charter.
  const { BRAIN_KIND_TAXONOMY, DEFAULT_AGENT_TAXONOMY } = await import(
    '@/lib/brain/taxonomy'
  );
  const fallback = BRAIN_KIND_TAXONOMY[kind] ?? DEFAULT_AGENT_TAXONOMY;
  let category = (input.category as string | undefined) ?? fallback.category;
  let confidence =
    (input.confidence as string | undefined) ?? fallback.confidence;
  if (category === 'principle') category = 'memory';
  if (confidence === 'canonical') confidence = 'high';
  // Supersession: if the agent is correcting a prior entry, mark the
  // old one superseded so default reads skip it. Scope to this user so
  // an agent can't accidentally (or maliciously) touch someone else's
  // memory.
  const supersedesId =
    typeof input.supersedesId === 'string' ? input.supersedesId : undefined;
  const entry = await prisma.brainEntry.create({
    data: {
      userId: ctx.userId,
      kind,
      category: category as
        | 'principle'
        | 'playbook'
        | 'reference'
        | 'memory'
        | 'hypothesis'
        | 'note',
      confidence: confidence as 'canonical' | 'high' | 'medium' | 'low',
      title,
      body,
      tags: Array.isArray(input.tags) ? (input.tags as string[]).slice(0, 20) : [],
      relatedSymbols: Array.isArray(input.relatedSymbols)
        ? (input.relatedSymbols as string[]).map((s) => s.toUpperCase()).slice(0, 20)
        : [],
      sourceRunId: ctx.agentRunId,
    },
  });
  if (supersedesId) {
    // Only supersede a row owned by the same user. Silent no-op on
    // mismatch — we don't want the agent's hallucinated ids to error
    // out the tool call.
    await prisma.brainEntry.updateMany({
      where: { id: supersedesId, userId: ctx.userId },
      data: { supersededById: entry.id },
    });
  }
  return {
    id: entry.id,
    kind: entry.kind,
    category: entry.category,
    confidence: entry.confidence,
    supersededPriorEntry: !!supersedesId,
  };
}

// ─── Thesis review acknowledgement ───────────────────────────────────────

async function acknowledgeThesisReviewTool(
  ctx: ToolContext,
  input: AcknowledgeThesisReviewInput
) {
  const symbol = input.symbol.toUpperCase();
  // Strategy's reviewDays governs how far forward to bump. Fall back to
  // 180d if the strategy doesn't define one or none is active.
  const active = await prisma.strategy.findFirst({
    where: { userId: ctx.userId, isActive: true },
    select: { rules: true },
  });
  const r = (active?.rules ?? {}) as { thesisReviewDays?: number | null };
  const reviewDays = r.thesisReviewDays ?? 180;
  const nextReview = new Date(Date.now() + reviewDays * 86_400_000);

  const updated = await prisma.position.updateMany({
    where: { userId: ctx.userId, symbol },
    data: {
      thesisReviewDueAt: nextReview,
      lastReviewedAt: new Date(),
    },
  });
  if (updated.count === 0) {
    throw new Error(
      `acknowledge_thesis_review: no open position for ${symbol}. Nothing to acknowledge.`
    );
  }
  log.info('thesis_review.acknowledged', {
    userId: ctx.userId,
    symbol,
    nextReviewDueAt: nextReview.toISOString(),
    reviewNote: input.reviewNote.slice(0, 200),
  });
  return { symbol, nextReviewDueAt: nextReview.toISOString(), reviewDays };
}

// ─── Options handlers ────────────────────────────────────────────────────

async function getOptionChainTool(input: GetOptionChainInput) {
  const minDTE = input.minDTE ?? 30;
  const maxDTE = input.maxDTE ?? 60;
  const now = new Date();
  const minExp = new Date(now.getTime() + minDTE * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const maxExp = new Date(now.getTime() + maxDTE * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const contracts = await getOptionContracts({
    underlying: input.underlying,
    type: input.type,
    expirationDateGte: minExp,
    expirationDateLte: maxExp,
    limit: 200,
  });
  // Enrich a cap of 25 contracts with greeks/quote so the agent can pick.
  // Fetching a snapshot per contract is rate-limited — cap to keep one tool
  // call under ~2s and avoid burning Alpaca data quota.
  const capped = contracts.slice(0, 25);
  const enriched = await Promise.all(
    capped.map(async (c) => {
      const snap = await getOptionSnapshot(c.symbol).catch(() => null);
      return {
        symbol: c.symbol,
        underlying: c.underlying_symbol,
        type: c.type,
        strike: Number(c.strike_price),
        expiration: c.expiration_date,
        bid: snap?.latestQuote?.bidPrice ?? null,
        ask: snap?.latestQuote?.askPrice ?? null,
        delta: snap?.greeks?.delta ?? null,
        theta: snap?.greeks?.theta ?? null,
        iv: snap?.impliedVolatility ?? null,
      };
    })
  );
  return { contracts: enriched };
}

async function placeOptionTradeTool(ctx: ToolContext, input: PlaceOptionTradeInput) {
  const v = await validateOptionTrade({
    userId: ctx.userId,
    optionSymbol: input.optionSymbol,
    setup: input.setup,
    qty: input.qty,
    limitPrice: input.limitPrice,
  });
  if (!v.ok) {
    log.info('option_trade.blocked', { userId: ctx.userId, optionSymbol: input.optionSymbol, reason: v.reason });
    throw new Error(`place_option_trade: ${v.reason}`);
  }

  const parsed = parseOccSymbol(input.optionSymbol)!; // v.ok guarantees parsable

  // Submit sell-to-open. Prefer limit at bid-mid from validation; agent can
  // override via input.limitPrice. Market orders on illiquid options are a
  // good way to get fleeced, so we default to limit.
  const midPerShare = Number(v.premiumPerContractCents) / 10_000;
  const limitPrice = input.limitPrice ?? Math.max(0.01, Math.round(midPerShare * 100) / 100);

  let order;
  try {
    order = await placeOptionOrder({
      optionSymbol: input.optionSymbol,
      side: 'sell',
      qty: input.qty,
      orderType: 'limit',
      limitPrice,
      timeInForce: 'day',
      positionIntent: 'opening',
    });
  } catch (brokerErr) {
    log.error('option_trade.broker_rejected', brokerErr, { userId: ctx.userId, optionSymbol: input.optionSymbol });
    throw brokerErr;
  }

  const activeStrategy = await prisma.strategy.findFirst({
    where: { userId: ctx.userId, isActive: true },
    select: { id: true },
  });

  const totalCreditCents = v.premiumPerContractCents * BigInt(input.qty);
  const strikeCents = BigInt(Math.round(parsed.strike * 100));
  const expiration = new Date(`${parsed.expiration}T21:00:00Z`);

  await prisma.optionPosition.create({
    data: {
      userId: ctx.userId,
      optionSymbol: input.optionSymbol,
      underlyingSymbol: parsed.underlying,
      contractType: parsed.type,
      setup: input.setup,
      strikeCents,
      expiration,
      quantity: input.qty,
      premiumPerContractCents: v.premiumPerContractCents,
      totalCreditCents,
      alpacaOrderId: order.id,
      thesis: input.thesis.slice(0, 2_000),
      openedUnderStrategyId: activeStrategy?.id ?? null,
    },
  });

  await prisma.notification
    .create({
      data: {
        userId: ctx.userId,
        kind: 'option_opened',
        title: `${input.setup.replace('_', ' ').toUpperCase()} ${input.qty}× ${parsed.underlying} $${parsed.strike} ${parsed.type} ${parsed.expiration}`,
        body: `Credit ≈ $${(Number(totalCreditCents) / 100).toFixed(2)}. Thesis: ${input.thesis.slice(0, 220)}`,
      },
    })
    .catch((notifErr) => {
      log.error('option_trade.notification_failed', notifErr);
    });

  log.info('option_trade.opened', {
    userId: ctx.userId,
    optionSymbol: input.optionSymbol,
    setup: input.setup,
    qty: input.qty,
    creditCents: totalCreditCents.toString(),
  });

  return {
    optionSymbol: input.optionSymbol,
    alpacaOrderId: order.id,
    status: order.status,
    creditCents: totalCreditCents.toString(),
    limitPrice,
  };
}
