import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Force JSON output; disable pretty so assertions are deterministic.
const originalPretty = process.env.AGBRO_LOG_PRETTY;
const originalLevel = process.env.AGBRO_LOG_LEVEL;
process.env.AGBRO_LOG_PRETTY = '0';
process.env.AGBRO_LOG_LEVEL = 'debug';

const { log, child } = await import('./logger');

afterEach(() => {
  if (originalPretty === undefined) delete process.env.AGBRO_LOG_PRETTY;
  else process.env.AGBRO_LOG_PRETTY = originalPretty;
  if (originalLevel === undefined) delete process.env.AGBRO_LOG_LEVEL;
  else process.env.AGBRO_LOG_LEVEL = originalLevel;
});

describe('logger (JSON mode)', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits one JSON line per event with t, level, event fields', () => {
    log.info('test.event', { x: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('test.event');
    expect(parsed.x).toBe(1);
    expect(typeof parsed.t).toBe('string');
  });

  it('serialises errors with name, message, truncated stack', () => {
    const errSpy = vi.mocked(console.error);
    log.error('test.err', new Error('boom'), { caller: 'unit' });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(parsed.event).toBe('test.err');
    expect(parsed.errName).toBe('Error');
    expect(parsed.errMessage).toBe('boom');
    expect(parsed.caller).toBe('unit');
  });

  it('respects the log level env var', () => {
    process.env.AGBRO_LOG_LEVEL = 'warn';
    log.debug('debug.suppressed');
    log.info('info.suppressed');
    log.warn('warn.kept');
    expect(spy).not.toHaveBeenCalled(); // debug + info go to console.log
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
    process.env.AGBRO_LOG_LEVEL = 'debug';
  });

  it('child() merges bound context into every emission', () => {
    const c = child({ requestId: 'abc', userId: 'u1' });
    c.info('scoped.event', { extra: 'y' });
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.requestId).toBe('abc');
    expect(parsed.userId).toBe('u1');
    expect(parsed.extra).toBe('y');
  });

  it('child ctx does not leak into sibling loggers', () => {
    const a = child({ a: 1 });
    const b = child({ b: 2 });
    a.info('a.event');
    const first = JSON.parse(spy.mock.calls[0][0] as string);
    expect(first.a).toBe(1);
    expect(first.b).toBeUndefined();
    b.info('b.event');
    const second = JSON.parse(spy.mock.calls[1][0] as string);
    expect(second.b).toBe(2);
    expect(second.a).toBeUndefined();
  });
});
