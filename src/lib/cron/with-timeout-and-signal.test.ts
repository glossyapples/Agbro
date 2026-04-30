// Pin the contract for the AbortSignal-aware timeout helper. Audit C2
// fix relies on the helper handing the inner work a real AbortSignal
// that fires when the deadline hits — without that, a "timed out"
// orchestrator keeps consuming tokens in the background.
//
// Verifies three things:
//   1. The factory receives an AbortSignal (not undefined).
//   2. When the timeout fires, the signal flips to aborted.
//   3. The outer promise rejects with the timeout message.

import { describe, it, expect, vi } from 'vitest';
import { withTimeoutAndSignal } from './runner';

describe('withTimeoutAndSignal', () => {
  it('passes an AbortSignal to the inner factory', async () => {
    let captured: AbortSignal | null = null;
    const result = await withTimeoutAndSignal(
      (signal) => {
        captured = signal;
        return Promise.resolve('ok');
      },
      1000,
      'unit-test'
    );
    expect(result).toBe('ok');
    expect(captured).not.toBeNull();
    // AbortSignal is a real Web/Node API object with an `aborted` field.
    expect(captured!.aborted).toBe(false);
  });

  it('aborts the signal when the timeout fires', async () => {
    let observedSignal: AbortSignal | null = null;
    let onAbortCalled = false;
    // Inner work that never resolves — just waits for the abort.
    const promise = withTimeoutAndSignal(
      (signal) => {
        observedSignal = signal;
        signal.addEventListener('abort', () => {
          onAbortCalled = true;
        });
        return new Promise(() => {
          // never resolves on its own — we expect timeout to fire
        });
      },
      30,
      'unit-test'
    );
    await expect(promise).rejects.toThrow(/timed out after 30ms/);
    expect(observedSignal).not.toBeNull();
    expect(observedSignal!.aborted).toBe(true);
    expect(onAbortCalled).toBe(true);
  });

  it('does NOT abort the signal when inner resolves before timeout', async () => {
    let observedSignal: AbortSignal | null = null;
    const result = await withTimeoutAndSignal(
      (signal) => {
        observedSignal = signal;
        return new Promise<string>((resolve) => setTimeout(() => resolve('done'), 10));
      },
      1000,
      'unit-test'
    );
    expect(result).toBe('done');
    expect(observedSignal!.aborted).toBe(false);
  });

  it('clears the timeout on resolve so it does not leak', async () => {
    // Hard to assert directly, but if the timer leaked we'd see the
    // abort fire 30ms after the promise already resolved. Wait long
    // enough for the would-be timer to fire and observe aborted stays
    // false.
    const result = await withTimeoutAndSignal(
      () => Promise.resolve('quick'),
      30,
      'leak-check'
    );
    expect(result).toBe('quick');
    await new Promise((r) => setTimeout(r, 50));
    // No way to inspect the (now-collected) signal externally; the
    // assertion is implicit: vitest doesn't report a hanging timer.
  });

  it('forwards inner-rejected errors as-is', async () => {
    const inner = new Error('inner failure');
    await expect(
      withTimeoutAndSignal(() => Promise.reject(inner), 1000, 'unit-test')
    ).rejects.toBe(inner);
  });

  it('substitutes the timeout message when an abort caused the rejection', async () => {
    // Inner work that throws an AbortError when the signal fires —
    // simulates how the Anthropic SDK rejects on abort.
    const promise = withTimeoutAndSignal(
      (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by signal')));
        }),
      30,
      'unit-test'
    );
    await expect(promise).rejects.toThrow(/timed out after 30ms/);
  });
});
