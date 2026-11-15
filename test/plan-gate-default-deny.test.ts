import { describe, expect, it } from 'vitest';
import { PluginHost, UNPLANNED_RUN } from '../src/plugin/index.js';
import type { DshModelSelection } from '../src/adapters/dsh-model.js';
import { allModels } from './fixtures/models.js';

/**
 * F3: the plan gate is default-deny (D-004).
 *
 * M0-1FIX made the gate *work*, but `planId` stayed optional, so a caller that
 * simply forgot it switched models with no plan, no approval and no ledger link —
 * "unmanaged by accident" is the same hole as "unmanaged on purpose".
 */

function selection(start = 'deepseek/flash'): DshModelSelection & { calls: string[] } {
  const calls: string[] = [];
  let current = start;
  return {
    calls,
    current: () => current,
    select: async (_s: string, key: string) => {
      calls.push(key);
      current = key;
    },
  };
}

function buildHost(sel = selection()) {
  const host = new PluginHost(sel);
  host.registerModels(allModels, allModels.map((m) => `${m.provider}/${m.model}`));
  return { host, sel };
}

function approvedPlan(host: PluginHost) {
  return host.approvePlan(
    host.plan({ taskId: 'f3', summary: 'ship', stageNames: ['implement'], estimatedInputTokens: 1_000 }),
  );
}

describe('F3: no plan means no switch', () => {
  it('refuses a switch that carries no plan at all', async () => {
    const { host, sel } = buildHost();
    const result = await host.switchForStage('stage-1', 'local/qwen-coder', 1_000, 1_000, ['coding']);

    expect(result.switched).toBe(false);
    expect(result.message).toMatch(/no plan given/);
    expect(result.message).toMatch(/switchWithoutPlan/);
    expect(sel.calls).toEqual([]);
    expect(host.ledger.totals().blocked).toBe(1);
    expect(host.ledger.totals().switches).toBe(0);
  });

  it('books the refusal with no planId, so the gap is visible in the ledger', async () => {
    const { host } = buildHost();
    await host.switchForStage('stage-1', 'local/qwen-coder', 1_000, 1_000, ['coding']);
    const blocked = host.ledger.all().find((e) => e.type === 'switch-blocked')!;
    expect(blocked.planId).toBeUndefined();
    expect(blocked.detail).toMatch(/no plan given/);
  });

  it('refuses an explicitly empty plan id too', async () => {
    const { host, sel } = buildHost();
    const result = await host.switchForStage('stage-1', 'local/qwen-coder', 1_000, 1_000, ['coding'], '');
    expect(result.switched).toBe(false);
    expect(result.message).toMatch(/unknown plan/);
    expect(sel.calls).toEqual([]);
  });

  it('still refuses an approved-looking but unapproved plan', async () => {
    const { host, sel } = buildHost();
    const plan = host.plan({ taskId: 'f3', summary: 'ship', stageNames: ['implement'], estimatedInputTokens: 10 });
    const result = await host.switchForStage('stage-1', 'local/qwen-coder', 100, 100, ['coding'], plan.planId);
    expect(result.switched).toBe(false);
    expect(result.message).toMatch(/not approved/);
    expect(sel.calls).toEqual([]);
  });

  it('lets an approved plan through, and only for its own stages', async () => {
    const { host, sel } = buildHost();
    const plan = approvedPlan(host);
    expect(plan.approvedAt).toBeDefined();

    // The gate lets it through: the switch itself then succeeds (and is booked).
    const good = await host.switchForStage('stage-1', plan.stages[0]!.modelKey, 1_000, 1_000, [], plan.planId);
    expect(good.message).not.toMatch(/no plan given|not approved|not part of plan/);
    expect(host.ledger.totals().deviations).toBe(0);
    sel.calls.length = 0;

    const off = await host.switchForStage('stage-2', 'local/qwen-coder', 1_000, 1_000, ['coding'], plan.planId);
    expect(off.switched).toBe(false);
    expect(off.message).toMatch(/not part of plan/);
    expect(sel.calls).toEqual([]);
  });

  it('switchWithoutPlan is the one explicit opt-out and it still guards the window', async () => {
    const { host, sel } = buildHost();
    const ok = await host.switchWithoutPlan('stage-1', 'local/qwen-coder', 1_000, 1_000, ['coding']);
    expect(ok.switched).toBe(true);
    expect(sel.calls).toEqual(['local/qwen-coder']);

    const tooBig = await host.switchWithoutPlan('stage-1', 'local/qwen-coder', 30_000, 4_000, ['coding']);
    expect(tooBig.switched).toBe(false);
    expect(tooBig.message).toMatch(/Compress/);
  });

  it('an unplanned switch is booked under an explicit marker, not left blank', async () => {
    const { host } = buildHost();
    await host.switchWithoutPlan('stage-1', 'local/qwen-coder', 1_000, 1_000, ['coding']);
    const switched = host.ledger.all().find((e) => e.type === 'model-switch')!;
    expect(switched.planId).toBe(UNPLANNED_RUN);
  });

  it('UNPLANNED_RUN is not a magic string a caller can pass by accident', async () => {
    const { host, sel } = buildHost();
    // Passing the marker to the gated method is the same as opting out — on purpose.
    const result = await host.switchForStage('stage-1', 'local/qwen-coder', 1_000, 1_000, ['coding'], UNPLANNED_RUN);
    expect(result.switched).toBe(true);
    expect(sel.calls).toEqual(['local/qwen-coder']);
  });
});
