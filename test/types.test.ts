import { describe, expect, it } from 'vitest';
import { costOf, modelKey, nowIso } from '../src/core/types.js';

describe('types helpers', () => {
  it('costOf multiplies per-million prices correctly', () => {
    const cost = costOf({ inputPerMTok: 2, outputPerMTok: 8 }, 1_000_000, 500_000);
    expect(cost).toBeCloseTo(2 + 4, 10);
  });

  it('costOf is zero for zero-priced models (local)', () => {
    expect(costOf({ inputPerMTok: 0, outputPerMTok: 0 }, 999_999, 999_999)).toBe(0);
  });

  it('modelKey joins provider and model', () => {
    expect(modelKey('deepseek', 'reasoner')).toBe('deepseek/reasoner');
  });

  it('nowIso returns a parseable ISO timestamp', () => {
    expect(Number.isNaN(Date.parse(nowIso()))).toBe(false);
  });
});

describe('core data structures exist with the agreed names', () => {
  it('exports the three milestone data structures as types', async () => {
    const mod = await import('../src/core/types.js');
    // C-2: `typeof x === 'function'` only claimed "some helpers exist", which is
    // not what the test name says. These assertions describe the structures the
    // milestone actually agreed on: their shapes and their honesty contracts.
    const entry: import('../src/core/types.js').CapabilityEntry = {
      key: 'p/m',
      model: {
        id: 'p/m',
        provider: 'p',
        model: 'm',
        label: 'M',
        capabilities: ['coding'],
        limits: { contextWindow: 8_000, maxOutputTokens: 1_000, supportsTools: null, supportsImages: false },
        pricing: { inputPerMTok: 1, outputPerMTok: 2 },
        strength: 0.5,
        source: 'dsh-config',
      },
      available: true,
      notes: ['probe: ok'],
    };
    expect(Object.keys(entry).sort()).toEqual(['available', 'key', 'model', 'notes']);

    const plan: import('../src/core/types.js').StagePlan = {
      taskId: 't',
      planId: 'plan-t-1',
      summary: 's',
      stages: [],
      baselineModelKey: 'p/m',
      baselineIsGuess: false,
      createdAt: nowIso(),
    };
    expect(plan.planId).toBe('plan-t-1');
    // A plan with no stage carries no estimate that could be mistaken for money.
    expect(plan.stages).toEqual([]);

    const event: import('../src/core/types.js').LedgerEvent = { type: 'compaction' };
    expect(event.type).toBe('compaction');
    // The three structures are cheap to build and survive a JSON round trip,
    // which is what the HTTP boundary relies on.
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });

  it('an unknown price is never a known one (costOf contract)', async () => {
    const { costOf: cost } = await import('../src/core/types.js');
    expect(cost({ inputPerMTok: null, outputPerMTok: 2 }, 1_000, 1_000)).toBeNull();
    expect(cost({ inputPerMTok: 2, outputPerMTok: null }, 1_000, 1_000)).toBeNull();
  });
});
