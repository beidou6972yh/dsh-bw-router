import { describe, expect, it } from 'vitest';
import { PluginHost, RouterSession } from '../src/plugin/index.js';
import { renderPlanCard, renderStatusBar } from '../src/plugin/client.js';
import { estimateStage } from '../src/core/budget.js';
import type { DshModelSelection } from '../src/adapters/dsh-model.js';
import { allModels, bigBrain, coder, makeModel } from './fixtures/models.js';

/** A platform that actually honours the switch: read-back must agree. */
function fakeSelection(start = 'deepseek/flash'): DshModelSelection & { calls: string[] } {
  const calls: string[] = [];
  let current = start;
  return {
    calls,
    current: () => current,
    select: async (_sessionId: string, modelKey: string) => {
      calls.push(modelKey);
      current = modelKey;
    },
  };
}

/** A platform that accepts `select` and silently ignores it (fire-and-forget). */
function deafSelection(start = 'deepseek/flash'): DshModelSelection & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    current: () => start,
    select: async (_sessionId: string, modelKey: string) => {
      calls.push(modelKey);
    },
  };
}

function buildHost(selection = fakeSelection()) {
  const host = new PluginHost(selection);
  host.registerModels(allModels, allModels.map((m) => `${m.provider}/${m.model}`));
  return { host, selection };
}

describe('PluginHost.plan', () => {
  it('produces one assignment per stage with a reason and an estimate', () => {
    const { host } = buildHost();
    const plan = host.plan({
      taskId: 't1',
      summary: 'ship the router',
      stageNames: ['analyze', 'implement', 'review'],
      estimatedInputTokens: 60_000,
      usage: { 'deepseek/flash': 50 },
    });
    expect(plan.stages).toHaveLength(3);
    expect(plan.baselineModelKey).toBe('deepseek/flash');
    expect(plan.stages.every((s) => s.reason.length > 0)).toBe(true);
    expect(plan.stages.every((s) => s.estimate.inputTokens > 0)).toBe(true);
  });

  it('routes coding to the strong model and summarizing to the cheap one', () => {
    const { host } = buildHost();
    const plan = host.plan({
      taskId: 't1',
      summary: 'x',
      stageNames: ['implement', 'summarize'],
      estimatedInputTokens: 40_000,
    });
    expect(plan.stages[0]!.modelKey).toBe('deepseek/reasoner');
    expect(plan.stages[1]!.modelKey).toBe('deepseek/flash');
  });

  it('totals the plan and states the ± band', () => {
    const { host } = buildHost();
    const plan = host.plan({
      taskId: 't1',
      summary: 'x',
      stageNames: ['implement'],
      estimatedInputTokens: 20_000,
    });
    const { total, line } = host.planTotals(plan);
    expect(total.cost).toBeGreaterThan(0);
    expect(total.baselineCost).toBeGreaterThan(0);
    expect(line).toContain('±35%');
  });

  it('still returns a card when no models are registered (N-3, was a throw)', () => {
    const host = new PluginHost(fakeSelection());
    const plan = host.plan({
      taskId: 't',
      summary: 'x',
      stageNames: ['implement'],
      estimatedInputTokens: 1_000,
    });
    expect(plan.stages).toHaveLength(0);
    expect(plan.unassignedStages?.map((g) => g.stageId)).toEqual(['stage-1']);
    expect(plan.baselineModelKey).toBe('');
    const { line } = host.planTotals(plan);
    expect(line).toContain('price unknown');
    expect(host.unassignedReason(plan.planId, 'stage-1')).toContain('未配置任何模型');
  });

  it('records a plan-created ledger event', () => {
    const { host } = buildHost();
    host.plan({ taskId: 't1', summary: 'x', stageNames: ['implement'], estimatedInputTokens: 1_000 });
    expect(host.ledger.all()[0]!.type).toBe('plan-created');
  });
});

describe('PluginHost.switchForStage', () => {
  it('switches when the context fits and records it', async () => {
    const { host, selection } = buildHost();
    const result = await host.switchWithoutPlan('stage-1', 'local/qwen-coder', 5_000, 2_000, ['coding']);
    expect(result.switched).toBe(true);
    expect(selection.calls).toEqual(['local/qwen-coder']);
    expect(host.ledger.totals().switches).toBe(1);
  });

  it('refuses instead of truncating when the window is too small', async () => {
    const { host, selection } = buildHost();
    const result = await host.switchWithoutPlan('stage-1', 'local/qwen-coder', 30_000, 4_000);
    expect(result.switched).toBe(false);
    expect(result.message).toMatch(/Compress/);
    expect(selection.calls).toEqual([]);
    expect(host.ledger.totals().blocked).toBe(1);
  });

  it('is an idempotent success when the session already runs that model (B1)', async () => {
    const { host } = buildHost(fakeSelection('deepseek/reasoner'));
    const result = await host.switchWithoutPlan('stage-1', 'deepseek/reasoner', 100, 100);
    // The session is on the model the stage needs: that is the outcome asked
    // for. Reporting it as a refusal taught callers to retry a 409.
    expect(result.switched).toBe(true);
    expect(result.alreadyInUse).toBe(true);
    expect(result.message).toMatch(/already in use/);
    // Nothing moved, so nothing extra is booked as a switch.
    expect(host.ledger.totals().switches).toBe(0);
  });

  it('blocks unknown model keys without touching the session', async () => {
    const { host, selection } = buildHost();
    const result = await host.switchWithoutPlan('stage-1', 'ghost/model', 10, 10);
    expect(result.switched).toBe(false);
    expect(selection.calls).toEqual([]);
  });

  it('reports the switch only after reading the session back', async () => {
    const { host, selection } = buildHost();
    const result = await host.switchWithoutPlan('stage-1', 'deepseek/reasoner', 1_000, 1_000);
    expect(result.switched).toBe(true);
    expect(selection.current()).toBe('deepseek/reasoner');
  });

  it('refuses to claim a switch the platform ignored (A-6)', async () => {
    const { host, selection } = buildHost(deafSelection());
    const result = await host.switchWithoutPlan('stage-1', 'deepseek/reasoner', 1_000, 1_000);
    expect(result.switched).toBe(false);
    expect(result.message).toContain('unverified');
    expect(selection.calls).toEqual(['deepseek/reasoner']);
    expect(host.ledger.totals().switches).toBe(0);
    expect(host.ledger.totals().unverified).toBe(1);
    expect(host.ledger.all().some((e) => e.type === 'switch-unverified')).toBe(true);
  });
});

describe('client half', () => {
  it('renders a plan card with a row per stage and a footer', () => {
    const { host } = buildHost();
    const plan = host.plan({
      taskId: 't1',
      summary: 'ship it',
      stageNames: ['implement', 'review'],
      estimatedInputTokens: 20_000,
    });
    const card = renderPlanCard(plan);
    expect(card.title).toBe('ship it');
    expect(card.rows).toHaveLength(2);
    expect(card.rows.map((r) => r.title)).toEqual(['implement', 'review']);
    expect(card.footer).toContain('baseline');
    expect(card.footer).toContain('合计');
    expect(card.skippable).toBe(true);
    // One row per stage, and the row id is the id the switch call uses: the
    // "card and execution stages are 1:1" property, checked on the card itself.
    expect(card.rows.map((r) => r.stageId)).toEqual(plan.stages.map((s) => s.stage.id));
  });

  it('renders a status bar line from state data', () => {
    const { host } = buildHost();
    const plan = host.approvePlan(
      host.plan({
        taskId: 't1',
        summary: 'x',
        stageNames: ['implement', 'review'],
        estimatedInputTokens: 10_000,
      }),
    );
    const session = new RouterSession(host);
    const state = session.state(plan.planId);
    const line = renderStatusBar(state)!;
    expect(line).toContain('[路由] 第 1/2 段');
    expect(line).toContain('已花');
    expect(line).toContain('下一段：review');
  });

  it('renders no status bar at all when no plan is approved', () => {
    const { host } = buildHost();
    const state = new RouterSession(host).state();
    // The defect this guards: an empty shell that looks like a running task.
    expect(renderStatusBar(state)).toBeNull();
  });
});

describe('plan gate: nothing runs off-plan (A-3)', () => {
  it('carries a planId and is not approved until the user says so', () => {
    const { host } = buildHost();
    const plan = host.plan({
      taskId: 't1',
      summary: 'x',
      stageNames: ['implement'],
      estimatedInputTokens: 10_000,
    });
    expect(plan.planId).toMatch(/^plan-t1-/);
    expect(plan.approvedAt).toBeUndefined();
    expect(host.ledger.all()[0]!.planId).toBe(plan.planId);
  });

  it('refuses to switch before the plan is approved', async () => {
    const { host, selection } = buildHost();
    const plan = host.plan({
      taskId: 't1',
      summary: 'x',
      stageNames: ['implement'],
      estimatedInputTokens: 10_000,
    });
    const result = await host.switchForStage('stage-1', 'deepseek/reasoner', 1_000, 1_000, [], plan.planId);
    expect(result.switched).toBe(false);
    expect(result.message).toMatch(/not approved/);
    expect(selection.calls).toEqual([]);
    expect(host.ledger.totals().blocked).toBe(1);
  });

  it('refuses a stage that is not in the plan (stage-99)', async () => {
    const { host, selection } = buildHost();
    const plan = host.approvePlan(
      host.plan({ taskId: 't1', summary: 'x', stageNames: ['implement'], estimatedInputTokens: 10_000 }),
    );
    const result = await host.switchForStage('stage-99', 'deepseek/reasoner', 1_000, 1_000, [], plan.planId);
    expect(result.switched).toBe(false);
    expect(result.message).toMatch(/not part of plan/);
    expect(selection.calls).toEqual([]);
  });

  it('refuses an unknown planId', async () => {
    const { host } = buildHost();
    const result = await host.switchForStage('stage-1', 'deepseek/reasoner', 1_000, 1_000, [], 'plan-ghost-9');
    expect(result.switched).toBe(false);
    expect(result.message).toMatch(/unknown plan/);
  });

  it('records a deviation instead of pretending an off-plan model was planned', async () => {
    const { host } = buildHost();
    const plan = host.approvePlan(
      host.plan({ taskId: 't1', summary: 'x', stageNames: ['implement'], estimatedInputTokens: 10_000 }),
    );
    const planned = plan.stages[0]!.modelKey;
    expect(planned).toBe('deepseek/reasoner');
    const result = await host.switchForStage('stage-1', 'local/qwen-coder', 1_000, 1_000, ['coding'], plan.planId);
    expect(result.switched).toBe(true);
    expect(host.ledger.totals().deviations).toBe(1);
    const deviation = host.ledger.all().find((e) => e.type === 'plan-deviation')!;
    expect(deviation.planId).toBe(plan.planId);
    expect(deviation.detail).toContain(planned);
  });

  it('keeps two plans of the same task apart', () => {
    const { host } = buildHost();
    const a = host.plan({ taskId: 't1', summary: 'x', stageNames: ['implement'], estimatedInputTokens: 10 });
    const b = host.plan({ taskId: 't1', summary: 'x', stageNames: ['implement'], estimatedInputTokens: 10 });
    expect(a.planId).not.toBe(b.planId);
    expect(host.ledger.forPlan(a.planId)).toHaveLength(1);
    expect(host.ledger.forPlan(b.planId)).toHaveLength(1);
  });
});

describe('cost book: actual, not estimated (A-4)', () => {
  it('books the real charge for real tokens, not the plan-time estimate', () => {
    const { host } = buildHost();
    const plan = host.plan({
      taskId: 't1',
      summary: 'x',
      stageNames: ['implement'],
      estimatedInputTokens: 10_000,
    });
    host.recordStageEnd({
      stageId: 'stage-1',
      modelKey: 'deepseek/reasoner',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      planId: plan.planId,
    });
    const totals = host.ledger.totals();
    // 2 + 8 USD for the actual 1M/1M — the plan predicted a fraction of that.
    expect(totals.actualCost).toBeCloseTo(10, 6);
    expect(totals.estimatedCost).toBeLessThan(totals.actualCost);
    expect(totals.actualCost).not.toBe(totals.estimatedCost);
  });

  it('counts an unpriced stage and refuses to claim savings for it', () => {
    const { host } = buildHost();
    host.registerModels([
      makeModel({ provider: 'cloud', name: 'mystery', pricing: { inputPerMTok: null, outputPerMTok: null } }),
    ]);
    const plan = host.plan({ taskId: 't1', summary: 'x', stageNames: ['implement'], estimatedInputTokens: 10 });
    host.recordStageEnd({
      stageId: 'stage-1',
      modelKey: 'cloud/mystery',
      inputTokens: 10_000,
      outputTokens: 10_000,
      planId: plan.planId,
    });
    const totals = host.ledger.totals();
    expect(totals.unpricedStages).toBe(1);
    expect(totals.savings).toBeNull();
  });
});

describe('unknown price is never free (A-5)', () => {
  it('does not report an unpriced model as a 100% saving', () => {
    const { host } = buildHost();
    host.registerModels([
      makeModel({ provider: 'cloud', name: 'mystery', pricing: { inputPerMTok: null, outputPerMTok: null } }),
    ]);
    const plan = host.plan({
      taskId: 't1',
      summary: 'x',
      stageNames: ['implement'],
      estimatedInputTokens: 10_000,
      usage: { 'cloud/mystery': 99 },
    });
    const { line } = host.planTotals(plan);
    expect(line).toContain('price unknown');
    expect(line).not.toContain('save 100%');
  });

  it('blocks a switch onto a model with no price', async () => {
    const { host, selection } = buildHost();
    host.registerModels([
      makeModel({ provider: 'cloud', name: 'mystery', pricing: { inputPerMTok: null, outputPerMTok: null } }),
    ]);
    const result = await host.switchWithoutPlan('stage-1', 'cloud/mystery', 100, 100);
    expect(result.switched).toBe(false);
    expect(result.message).toMatch(/no price/);
    expect(selection.calls).toEqual([]);
  });
});
