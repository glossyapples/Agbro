// Tests for the tool-classification helpers used by the orchestrator's
// parallel-batch dispatcher. Critical invariants:
//   - every tool actually defined in TOOL_DEFS has a classification
//   - mutating set + read-only set are disjoint
//   - unknown tool names default to mutating (fail-safe)
//   - the union of classifications covers the entire TOOL_DEFS list

import { describe, it, expect } from 'vitest';
import { TOOL_DEFS, isMutatingTool, isKnownTool } from './tools';

describe('tool classification', () => {
  it('every tool in TOOL_DEFS has a classification', () => {
    const unclassified = TOOL_DEFS.filter((t) => !isKnownTool(t.name));
    expect(unclassified.map((t) => t.name)).toEqual([]);
  });

  it('unknown tool names default to mutating (fail-safe)', () => {
    expect(isMutatingTool('not_a_real_tool')).toBe(true);
    expect(isMutatingTool('')).toBe(true);
    expect(isKnownTool('not_a_real_tool')).toBe(false);
  });

  it('all read-only tools are classified non-mutating', () => {
    const readOnly = [
      'get_account_state',
      'get_positions',
      'get_latest_price',
      'is_market_open',
      'get_watchlist',
      'read_brain',
      'run_analyzer',
      'research_perplexity',
      'research_google',
      'size_position',
      'evaluate_exits',
      'get_option_chain',
      'get_event_calendar',
    ];
    for (const name of readOnly) {
      expect(isMutatingTool(name), `${name} should be read-only`).toBe(false);
      expect(isKnownTool(name)).toBe(true);
    }
  });

  it('all mutating tools are classified mutating', () => {
    const mutating = [
      'write_brain',
      'record_research_note',
      'refresh_fundamentals',
      'update_stock_fundamentals',
      'screen_universe',
      'acknowledge_thesis_review',
      'add_to_watchlist',
      'run_post_mortem',
      'place_option_trade',
      'place_trade',
      'finalize_run',
    ];
    for (const name of mutating) {
      expect(isMutatingTool(name), `${name} should be mutating`).toBe(true);
      expect(isKnownTool(name)).toBe(true);
    }
  });

  it('any read-only batch is parallel-eligible', () => {
    // Property check — the orchestrator's batch decision is
    // `toolUses.some(isMutatingTool) ? serial : parallel`. Pin the
    // happy paths it relies on.
    const readOnlyBatch = [
      'get_account_state',
      'get_latest_price',
      'read_brain',
      'evaluate_exits',
    ];
    expect(readOnlyBatch.some(isMutatingTool)).toBe(false);
  });

  it('a single mutating tool poisons the whole batch', () => {
    const mixed = ['get_latest_price', 'place_trade', 'read_brain'];
    expect(mixed.some(isMutatingTool)).toBe(true);
  });
});
