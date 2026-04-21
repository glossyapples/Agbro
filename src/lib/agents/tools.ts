// Tool definitions exposed to the Claude agent during a wake-up run.
// Every tool returns JSON-serialisable data and has a strict input schema.

import type Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/db';
import { analyze, positionSizeCents, type AnalyzerInput } from '@/lib/analyzer';
import {
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
import { PlaceTradeInput, SizePositionInput } from './schemas';

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
      'Fetch the most recent brain entries (lessons, weekly updates, post-mortems). Use this at the start of every run to pick up where the last agent left off.',
    input_schema: {
      type: 'object',
      properties: {
        kinds: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
      },
      required: [],
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
    name: 'place_trade',
    description:
      'Submit an order to Alpaca. Requires symbol, side, qty, bullCase, bearCase, thesis, confidence (0..1), intrinsicValuePerShare, marginOfSafetyPct. Server re-validates ALL safety rails before routing.',
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
        intrinsicValuePerShare: { type: 'number' },
        marginOfSafetyPct: { type: 'number' },
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
      return prisma.brainEntry.findMany({
        where: { userId: ctx.userId, ...(kinds ? { kind: { in: kinds } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
    }
    case 'run_analyzer':
      return analyze(input as unknown as AnalyzerInput);
    case 'research_perplexity':
      return perplexitySearch(String(input.query));
    case 'research_google':
      return googleSearch(String(input.query), Number(input.num ?? 5));
    case 'record_research_note':
      return prisma.researchNote.create({
        data: {
          agentRunId: ctx.agentRunId,
          symbol: (input.symbol as string) ?? null,
          topic: String(input.topic),
          source: String(input.source),
          bullCase: (input.bullCase as string) ?? null,
          bearCase: (input.bearCase as string) ?? null,
          summary: String(input.summary),
        },
      });
    case 'size_position':
      return sizePositionTool(ctx, input);
    case 'place_trade':
      return placeTradeTool(ctx, input);
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
  const [broker, account] = await Promise.all([
    safeAlpaca(() => getBrokerAccount()),
    prisma.account.findUnique({ where: { userId: ctx.userId } }),
  ]);
  return {
    broker,
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
  const cents = positionSizeCents({
    portfolioValueCents: broker.portfolioValueCents,
    cashCents: broker.cashCents,
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

  const account = await prisma.account.findUnique({ where: { userId: ctx.userId } });
  if (!account) throw new Error('account not found');
  if (account.isStopped) throw new Error('account is stopped; trading disabled');
  if (account.isPaused) throw new Error('account is paused; trading disabled');

  // Enforce daily trade cap server-side, anchored to midnight ET (not host local time).
  const since = startOfDayET();
  const todaysTrades = await prisma.trade.count({
    where: { userId: ctx.userId, submittedAt: { gte: since } },
  });
  if (todaysTrades >= account.maxDailyTrades) {
    throw new Error(`daily trade cap reached (${account.maxDailyTrades})`);
  }

  const symbol = p.symbol.toUpperCase();
  const orderType = p.orderType ?? 'market';
  if (orderType === 'limit' && p.limitPrice == null) {
    throw new Error('place_trade: limitPrice required when orderType=limit');
  }

  const order = await placeOrder({
    symbol,
    qty: p.qty,
    side: p.side,
    orderType,
    limitPrice: p.limitPrice,
  });

  const trade = await prisma.trade.create({
    data: {
      userId: ctx.userId,
      alpacaOrderId: order.id,
      symbol,
      side: p.side,
      qty: p.qty,
      status: 'submitted',
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

  await prisma.notification.create({
    data: {
      userId: ctx.userId,
      tradeId: trade.id,
      kind: 'trade_placed',
      title: `${p.side.toUpperCase()} ${p.qty} ${symbol}`,
      body: `Thesis: ${p.thesis.slice(0, 240)}`,
    },
  });

  return { tradeId: trade.id, alpacaOrderId: order.id, status: 'submitted' };
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
      title: `Agent run ${ctx.agentRunId.slice(0, 8)} — ${decision}`,
      body: summary,
    },
  });
  return { finalized: true };
}
