import { describe, expect, it } from 'vitest';
import type { CapabilityEntry, LedgerEntry, StagePlan } from '../src/core/types.js';
import { bigBrain } from './fixtures/models.js';

/**
 * Field-level contracts from the M0-1 acceptance criteria. These are compile-time
 * plus a few runtime shape checks, so "the struct exists" is not enough — the
 * fields have to be there and be the right kind.
 */
describe('M0-1 data structure contracts', () => {
  it('CapabilityEntry carries key/model/available/notes', () => {
    const entry: CapabilityEntry = {
      key: 'p/m',
      model: bigBrain,
      available: true,
      notes: ['seen'],
    };
    expect(Object.keys(entry).sort()).toEqual(['available', 'key', 'model', 'notes']);
    expect(entry.model.limits.contextWindow).toBeGreaterThan(0);
    expect(entry.model.pricing.outputPerMTok).toBeGreaterThanOrEqual(0);
    expect(entry.model.capabilities.length).toBeGreaterThan(0);
    expect(entry.model.source).toBe('dsh-config');
  });

  it('StagePlan carries taskId/planId/summary/stages/baseline/createdAt', () => {
    const plan: StagePlan = {
      taskId: 't',
      planId: 'plan-t-1',
      summary: 's',
      stages: [],
      baselineModelKey: 'p/m',
      baselineIsGuess: false,
      createdAt: new Date().toISOString(),
    };
    expect(Object.keys(plan).sort()).toEqual([
      'baselineIsGuess',
      'baselineModelKey',
      'createdAt',
      'planId',
      'stages',
      'summary',
      'taskId',
    ]);
    expect(plan.approvedAt).toBeUndefined();
  });

  it('LedgerEntry is a timestamped, sequenced event', () => {
    const at = new Date().toISOString();
    const entry: LedgerEntry = { type: 'run-end', at, seq: 1 };
    expect(entry.seq).toBe(1);
    expect(entry.at).toBe(at);
    // `at` is optional by type; the ledger always fills it, so narrow explicitly.
    expect(entry.at).toBeDefined();
    expect(Number.isNaN(Date.parse(entry.at ?? ''))).toBe(false);
  });
});
