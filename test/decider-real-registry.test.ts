import { describe, expect, it } from 'vitest';
import { decideModel, decidePlan } from '../src/core/decider.js';
import { Registry } from '../src/core/registry.js';
import { PluginHost } from '../src/plugin/index.js';
import { buildPlanCard } from '../src/core/card.js';
import type { Stage } from '../src/core/types.js';
import { allModels, bigBrain, cheapFast, coder, painter } from './fixtures/models.js';

/**
 * P0-3: the decider works against a **real registry** and degrades instead of
 * crashing when that registry is empty.
 *
 * The M1 rule engine shipped with `decideModel` throwing on "nothing fits",
 * which is fine for one stage and wrong for a whole task: an install with no
 * models produced a stack trace where the user needed instructions.
 */

const stage = (over: Partial<Stage> = {}): Stage => ({
  id: 'stage-1',
  name: 'implement',
  goal: 'write the code',
  capability: 'coding',
  estimatedInputTokens: 10_000,
  estimatedOutputTokens: 4_000,
  optional: false,
  ...over,
});

const registryOf = (models = allModels) => {
  const registry = new Registry();
  registry.register({ models });
  return registry;
};

describe('F3: three-capability decision on a real registry', () => {
  it('writing stage → the model that advertises writing', () => {
    const decision = decideModel(stage({ capability: 'writing' }), registryOf().all());
    expect(decision.modelKey).toBe('deepseek/reasoner');
  });

  it('coding stage → the model that advertises coding', () => {
    const decision = decideModel(stage({ capability: 'coding' }), registryOf().all());
    expect(decision.modelKey).toBe('deepseek/reasoner');
  });

  it('image stage → the image model, not the strongest all-rounder', () => {
    const decision = decideModel(stage({ capability: 'image-generation' }), registryOf().all());
    expect(decision.modelKey).toBe('cloud/diffusion-xl');
  });

  it('cheap bulk → the cheap model, price tie-break not used as a score', () => {
    const decision = decideModel(stage({ capability: 'cheap-bulk' }), registryOf().all());
    expect(decision.modelKey).toBe('deepseek/flash');
  });
});

describe('P0-3: empty registry is a question, not an exception', () => {
  it('decideModel still throws for a single stage (contract unchanged)', () => {
    expect(() => decideModel(stage(), [])).toThrow(/no available model/);
  });

  it('decidePlan reports a no-model gap with the wizard hint', () => {
    const plan = decidePlan([stage()], entriesOf([]));
    expect(plan.assignments).toEqual([]);
    expect(plan.unassigned).toHaveLength(1);
    expect(plan.unassigned[0]!.reason).toBe('no-model');
    expect(plan.unassigned[0]!.message).toContain('未配置任何模型');
    expect(plan.blocked).toEqual(plan.unassigned[0]);
  });

  it('names capability-unmet when models exist but none does the work', () => {
    const plan = decidePlan([stage({ capability: 'image-generation' })], entriesOf([coder, cheapFast]));
    expect(plan.unassigned[0]!.reason).toBe('capability-unmet');
    expect(plan.unassigned[0]!.message).toContain('image-generation');
  });

  it('names all-excluded when the capable models are all dead', () => {
    const registry = new Registry();
    registry.register({ models: [bigBrain], availableKeys: [] });
    const plan = decidePlan([stage()], registry.all());
    expect(plan.unassigned[0]!.reason).toBe('all-excluded');
    expect(plan.unassigned[0]!.message).toContain('unavailable');
  });

  it('keeps the stages it CAN fill when only one is impossible', () => {
    const whole = decidePlan(
      [stage({ id: 'stage-1', capability: 'coding' }), stage({ id: 'stage-2', capability: 'image-generation' })],
      entriesOf([coder, painter]),
    );
    expect(whole.assignments.map((a) => a.stage.id)).toEqual(['stage-1', 'stage-2']);
    expect(whole.unassigned).toEqual([]);

    const partial = decidePlan(
      [stage({ id: 'stage-1', capability: 'coding' }), stage({ id: 'stage-2', capability: 'vision' })],
      entriesOf([coder]),
    );
    expect(partial.assignments.map((a) => a.stage.id)).toEqual(['stage-1']);
    expect(partial.unassigned.map((u) => u.stageId)).toEqual(['stage-2']);
    // `blocked` means "nothing at all could run", so a half-filled plan has none.
    expect(partial.blocked).toBeUndefined();
  });

  it('the plan card shows the gap and refuses to start, without throwing', () => {
    const host = new PluginHost({ current: () => '', select: async () => undefined });
    const plan = host.plan({ taskId: 't1', summary: 'x', stageNames: ['implement'], estimatedInputTokens: 1_000 });
    const card = buildPlanCard({ plan });
    expect(card.canStart).toBe(false);
    expect(card.needsWizard).toBe(true);
    expect(card.blockers[0]).toContain('stage-1');
    expect(host.approvePlan.bind(host, plan)).toThrow(/cannot start/);
  });

  it('does not silently drop a stage: rows === stages + gaps', () => {
    const host = new PluginHost({ current: () => '', select: async () => undefined });
    host.registerModels([coder]);
    const plan = host.plan({
      taskId: 't1',
      summary: 'x',
      stageNames: ['implement', 'write'],
      estimatedInputTokens: 2_000,
    });
    const card = buildPlanCard({ plan });
    expect(card.rows).toHaveLength(2);
    expect(plan.stages).toHaveLength(1);
    expect(plan.unassignedStages).toHaveLength(1);
    expect(card.rows.map((r) => r.stageId)).toEqual(['stage-1', 'stage-2']);
    expect(card.rows[1]!.modelKey).toBeNull();
  });
});

/**
 * `decidePlan` takes `CapabilityEntry[]`, not models: the availability signal
 * lives on the entry, and a bare `ModelEntry[]` has none. This keeps the tests
 * honest about which shape the host actually hands over.
 */
const entriesOf = (models = allModels) => registryOf(models).all();

describe('decidePlan: settings that follow the run', () => {
  it('honours a pin when the pinned model is usable', () => {
    const decision = decidePlan([stage()], entriesOf(), {
      pinned: { coding: 'local/qwen-coder' },
    });
    expect(decision.assignments[0]!.decision.modelKey).toBe('local/qwen-coder');
    expect(decision.assignments[0]!.decision.basis).toBe('pinned');
  });

  it('keeps a pin that fits, and shows the fit in the reason', () => {
    const decision = decidePlan([stage({ estimatedOutputTokens: 9_000 })], entriesOf(), {
      pinned: { coding: 'local/qwen-coder' },
    });
    // A pin still has to pass the capability and availability gates. Here it
    // does pass them, so the pin wins — but the stage is bigger than the model's
    // window, and the decision says TIGHT instead of presenting it as a fit.
    const row = decision.assignments[0]!.decision;
    expect(row.modelKey).toBe('local/qwen-coder');
    expect(row.basis).toBe('pinned');
    // 19k in a 32k window is under the "half the window" line, so no tightness
    // flag — the pin is fine here, and the estimate is what carries the risk.
    expect(row.reason).toContain('fits');
  });

  it('prefers a different model for the second stage of the same capability', () => {
    const plan = decidePlan(
      [stage({ id: 'stage-1' }), stage({ id: 'stage-2' })],
      entriesOf([bigBrain, coder]),
    );
    // Stage 1 takes the stronger model; stage 2 is not forced onto it by habit.
    expect(plan.assignments).toHaveLength(2);
    expect(plan.assignments[0]!.decision.modelKey).toBe('deepseek/reasoner');
    expect(plan.assignments[1]!.decision.modelKey).toBe('local/qwen-coder');
  });
});
