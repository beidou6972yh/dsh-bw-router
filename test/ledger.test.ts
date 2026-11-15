import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/core/ledger.js';
import { estimateStage } from '../src/core/budget.js';
import { bigBrain, coder, makeModel } from './fixtures/models.js';

const clock = () => '2026-10-22T00:00:00.000Z';

const unpriced = makeModel({
  provider: 'cloud',
  name: 'mystery',
  pricing: { inputPerMTok: null, outputPerMTok: null },
});

describe('Ledger', () => {
  it('assigns increasing sequence numbers', () => {
    const ledger = new Ledger(clock);
    ledger.append({ type: 'plan-created' });
    ledger.append({ type: 'stage-start', stageId: 'stage-1' });
    expect(ledger.all().map((e) => e.seq)).toEqual([1, 2]);
  });

  it('stamps events with the injected clock', () => {
    const ledger = new Ledger(clock);
    expect(ledger.append({ type: 'run-end' }).at).toBe(clock());
  });

  it('accumulates actual tokens, actual cost and baseline cost', () => {
    const ledger = new Ledger(clock);
    const estimate = estimateStage({
      model: coder,
      baseline: bigBrain,
      inputTokens: 100_000,
      outputTokens: 50_000,
    });
    ledger.recordStageEnd({
      stageId: 'stage-1',
      modelKey: 'local/qwen-coder',
      inputTokens: 100_000,
      outputTokens: 50_000,
      cost: 0,
      estimate,
    });
    const totals = ledger.totals();
    expect(totals.inputTokens).toBe(100_000);
    expect(totals.outputTokens).toBe(50_000);
    expect(totals.actualCost).toBe(0);
    expect(totals.estimatedCost).toBe(0);
    expect(totals.baselineCost).toBeCloseTo(0.6, 6);
    expect(totals.savings).toBeCloseTo(0.6, 6);
    expect(totals.unpricedStages).toBe(0);
  });

  it('books actual usage, not the plan-time estimate (A-4)', () => {
    const ledger = new Ledger(clock);
    // Plan guessed 1000/1000; the stage really burned 999999/999999.
    const estimate = estimateStage({
      model: bigBrain,
      baseline: bigBrain,
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    ledger.recordStageEnd({
      stageId: 'stage-1',
      modelKey: 'deepseek/reasoner',
      inputTokens: 999_999,
      outputTokens: 999_999,
      cost: 0,
      estimate,
    });
    const actual = estimateStage({
      model: bigBrain,
      baseline: bigBrain,
      inputTokens: 999_999,
      outputTokens: 999_999,
    });
    ledger.recordStageEnd({
      stageId: 'stage-2',
      modelKey: 'deepseek/reasoner',
      inputTokens: 999_999,
      outputTokens: 999_999,
      cost: actual.cost!,
    });
    expect(ledger.totals().actualCost).toBeCloseTo(actual.cost!, 9);
  });

  it('counts a stage whose price is unknown instead of pricing it at zero', () => {
    const ledger = new Ledger(clock);
    ledger.recordStageEnd({
      stageId: 'stage-1',
      modelKey: 'cloud/mystery',
      inputTokens: 10_000,
      outputTokens: 10_000,
      cost: null,
      estimate: estimateStage({
        model: unpriced,
        baseline: bigBrain,
        inputTokens: 10_000,
        outputTokens: 10_000,
      }),
    });
    const totals = ledger.totals();
    expect(totals.unpricedStages).toBe(1);
    expect(totals.actualCost).toBe(0);
    // Savings must not be claimed while a stage is unpriced.
    expect(totals.savings).toBeNull();
  });

  it('counts switches, blocked attempts and deviations separately', () => {
    const ledger = new Ledger(clock);
    ledger.recordSwitch('stage-1', 'a/a', 'b/b', 'plan-1');
    ledger.recordBlocked('stage-2', 'c/c', 'window too small', 'plan-1');
    ledger.recordUnverified('stage-3', 'd/d', 'a/a', 'plan-1');
    ledger.recordDeviation('stage-4', 'b/b', 'e/e', 'plan-1');
    const totals = ledger.totals();
    expect(totals.switches).toBe(1);
    expect(totals.blocked).toBe(1);
    expect(totals.unverified).toBe(1);
    expect(totals.deviations).toBe(1);
  });

  it('is append-only: history cannot be rewritten through a returned entry', () => {
    const ledger = new Ledger(clock);
    const entry = ledger.append({ type: 'stage-end', stageId: 'stage-1', cost: 1 });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(ledger.all()[0])).toBe(true);
    expect(() => {
      (ledger.all()[0] as { cost?: number }).cost = -1;
    }).toThrow(TypeError);
    expect(ledger.all()[0]!.cost).toBe(1);
  });

  it('forStage/forPlan filter without mutating', () => {
    const ledger = new Ledger(clock);
    ledger.append({ type: 'stage-start', stageId: 'stage-1', planId: 'plan-a' });
    ledger.append({ type: 'stage-start', stageId: 'stage-2', planId: 'plan-b' });
    const before = ledger.all();
    expect(ledger.forStage('stage-1')).toHaveLength(1);
    expect(ledger.forPlan('plan-a')).toHaveLength(1);
    expect(ledger.forPlan('plan-b')).toHaveLength(1);
    expect(ledger.all()).toEqual(before);
  });

  it('clear resets everything including the accumulators', () => {
    const ledger = new Ledger(clock);
    ledger.recordStageEnd({
      stageId: 's',
      modelKey: 'k',
      inputTokens: 1,
      outputTokens: 1,
      cost: 0,
      estimate: estimateStage({ model: coder, baseline: bigBrain, inputTokens: 1, outputTokens: 1 }),
    });
    ledger.clear();
    expect(ledger.size()).toBe(0);
    expect(ledger.totals().baselineCost).toBe(0);
    expect(ledger.totals().estimatedCost).toBe(0);
  });
});
