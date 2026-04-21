// Structured logger. One JSON line per event in production so Railway /
// Datadog / any log shipper can parse fields directly. Pretty-prints in dev.
//
// Usage:
//   log.info('trade.placed', { userId, tradeId, symbol });
//   log.error('cron.tick.failed', err, { userId });
//
// Zero dependencies. If you later want Pino, swap the internals here.

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel(): Level {
  const raw = process.env.AGBRO_LOG_LEVEL?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

const PRETTY =
  process.env.AGBRO_LOG_PRETTY === '1' ||
  (process.env.NODE_ENV !== 'production' && process.env.AGBRO_LOG_PRETTY !== '0');

type Context = Record<string, unknown>;

function serializeError(err: unknown): Context {
  if (err instanceof Error) {
    return {
      errName: err.name,
      errMessage: err.message,
      errStack: err.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }
  return { errValue: String(err) };
}

function emit(level: Level, event: string, ctx?: Context, err?: unknown) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const record: Context = {
    t: new Date().toISOString(),
    level,
    event,
    ...(ctx ?? {}),
    ...(err ? serializeError(err) : {}),
  };
  if (PRETTY) {
    const { t, level: _l, event: _e, ...rest } = record;
    const restStr = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : '';
    const line = `[${String(t).slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${event}${restStr}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } else {
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

export const log = {
  debug: (event: string, ctx?: Context) => emit('debug', event, ctx),
  info: (event: string, ctx?: Context) => emit('info', event, ctx),
  warn: (event: string, ctx?: Context, err?: unknown) => emit('warn', event, ctx, err),
  error: (event: string, err?: unknown, ctx?: Context) => emit('error', event, ctx, err),
};

// Child logger: returns a logger whose context is merged into every call.
// Use for request/agent-run scopes so every line carries the same identifiers.
export function child(bound: Context) {
  return {
    debug: (event: string, ctx?: Context) => emit('debug', event, { ...bound, ...(ctx ?? {}) }),
    info: (event: string, ctx?: Context) => emit('info', event, { ...bound, ...(ctx ?? {}) }),
    warn: (event: string, ctx?: Context, err?: unknown) =>
      emit('warn', event, { ...bound, ...(ctx ?? {}) }, err),
    error: (event: string, err?: unknown, ctx?: Context) =>
      emit('error', event, { ...bound, ...(ctx ?? {}) }, err),
  };
}

// Test-only hook for silencing output.
export function __setLevelForTests(level: Level) {
  process.env.AGBRO_LOG_LEVEL = level;
}
