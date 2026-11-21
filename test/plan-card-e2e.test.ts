import { describe, expect, it } from 'vitest';
import { dispatch, ROUTER_PREFIX, type RouterDeps } from '../src/plugin/endpoints.js';
import { PluginHost, RouterSession } from '../src/plugin/index.js';
import { planCardLines, type PlanCard } from '../src/plugin/client.js';
import { DshModelAdapter, createGlobalDefaultGuard } from '../src/adapters/dsh-model.js';
import { allModels, makeModel } from './fixtures/models.js';

/**
 * End to end over HTTP: the full M1-2 loop, from an empty host to a finished run.
 *
 * Written against `dispatch` with a real adapter, because the interesting bugs
 * live in the seams (plan → confirm → switch → stage end → status bar) and each
 * seam has its own idea of "which stage are we on".
 */

function rig(options: { models?: typeof allModels; defaultCell?: string } = {}) {
  let current = 'deepseek/flash';
  let cell = options.defaultCell ?? 'deepseek/flash';
  const calls: string[] = [];
  const adapter = new DshModelAdapter(
    {
      selectModel: async (_sessionId: string, provider: string, model: string) => {
        const key = `${provider}/${model}`;
        calls.push(key);
        current = key;
      },
      readCurrent: () => current,
    },
    'sess',
    createGlobalDefaultGuard(() => cell),
  );
  const host = new PluginHost(adapter);
  const models = options.models ?? allModels;
  host.registerModels(models, models.map((m) => `${m.provider}/${m.model}`));
  const deps: RouterDeps = { host, session: new RouterSession(host) };
  return { host, deps, calls, setDefault: (key: string) => (cell = key) };
}

describe('M1-2 end to end: card → confirm → switch → finish → bar', () => {
  it('runs a 60k three-stage task end to end, and no switch is refused', async () => {
    const { deps, calls, host } = rig();

    const planned = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/plan`,
        body: {
          taskId: 'e2e',
          summary: '做程序开发 ＋ 汇报 PPT',
          stageNames: ['analyze', 'implement', 'write'],
          estimatedInputTokens: 60_000,
        },
      },
      deps,
    );
    expect(planned.status).toBe(200);
    const planId = String(planned.body.planId);
    const card = planned.body.card as unknown as PlanCard;
    // The card the user reads: three rows, a total, two buttons.
    const lines = planCardLines(card);
    expect(lines.filter((l) => /^ ?\d\./.test(l))).toHaveLength(3);
    expect(lines[lines.length - 1]).toBe('[确认开工] [取消]');

    // Every row was pre-checked with the same guard the switch uses, so "可开工"
    // is a promise the run can keep (A1).
    expect(card.checked).toBe(true);
    expect(card.canStart).toBe(true);
    expect(card.rows.map((row) => row.guard?.code)).toEqual(['ok', 'ok', 'ok']);

    // Nothing runs before the user says so: no switch, no bar.
    const before = await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/state` }, deps);
    expect((before.body.state as { active: boolean }).active).toBe(false);
    expect(calls).toEqual([]);

    const confirmed = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } },
      deps,
    );
    expect(confirmed.status).toBe(200);
    const started = confirmed.body.state as { active: boolean; current?: { stageId: string } };
    expect(started.active).toBe(true);
    expect(started.current!.stageId).toBe('stage-1');

    // All three stages run. A 60k task on a plan whose stages were checked with
    // the plan's own numbers must not produce a single refusal: the old e2e
    // asserted a 409 on stage 2 and booked it as `failed`, which is how a real
    // defect (whole-stage output fed to the guard as maxTokens) was recorded as
    // expected behaviour (A2).
    const plan = host.getPlan(planId)!;
    expect(plan.stages.map((s) => s.stage.name)).toEqual(['analyze', 'implement', 'write']);
    for (const assignment of plan.stages) {
      const stageId = assignment.stage.id;
      const switched = await dispatch(
        { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId } },
        deps,
      );
      expect({ stageId, status: switched.status, message: switched.body.message }).toEqual({
        stageId,
        status: 200,
        message: expect.any(String),
      });
      expect(switched.body.switched).toBe(true);
      // The session really moved to the model the plan named (or was already
      // there, which is now an idempotent success — B1).
      expect(host.currentModel()).toBe(assignment.modelKey);

      const finished = await dispatch(
        {
          method: 'POST',
          path: `${ROUTER_PREFIX}/stage/finish`,
          body: {
            planId,
            stageId,
            // Real usage for this stage: the plan says how big it is.
            inputTokens: assignment.stage.estimatedInputTokens,
            outputTokens: assignment.stage.estimatedOutputTokens,
          },
        },
        deps,
      );
      expect(finished.status).toBe(200);
    }

    // The bar after the run: every stage done, cursor on the last one, and the
    // money is the real charge — not "done, $0.0000".
    const state = (await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/state?planId=${planId}` }, deps))
      .body.state as {
      cursor: number;
      total: number;
      stages: { stageId: string; status: string; actualCost?: number }[];
      spent: { actualCost: number; unpricedStages: number };
      unbookedStages?: string[];
      notices: string[];
    };
    expect(state.total).toBe(3);
    expect(state.cursor).toBe(2);
    expect(state.stages.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(state.spent.actualCost).toBeGreaterThan(0);
    expect(state.spent.unpricedStages).toBe(0);
    expect(state.unbookedStages ?? []).toEqual([]);
    // Every stage was booked with a real charge, and the run moved the session
    // at least twice: stage 1 starts on the baseline, so two adapter calls is
    // exactly "each stage got the model the plan named", not one model reused.
    expect(state.stages.every((stage) => typeof stage.actualCost === 'number')).toBe(true);
    expect(new Set(calls).size).toBe(2);
    expect(state.stages.map((s) => s.stageId)).toEqual(['stage-1', 'stage-2', 'stage-3']);
  });

  it('books nothing when a stage reports done without token counts (B2)', async () => {
    const { deps } = rig();
    const planned = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/plan`,
        body: { taskId: 'b2', stageNames: ['analyze'], estimatedInputTokens: 5_000 },
      },
      deps,
    );
    const planId = String(planned.body.planId);
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps);

    const refused = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/stage/finish`, body: { planId, stageId: 'stage-1' } },
      deps,
    );
    // Not a 200 with "done" and $0: the stage's real cost would vanish.
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('usage-required');
    expect(refused.body.missing).toEqual(['inputTokens', 'outputTokens']);

    // A failure may omit usage: nothing ran.
    const failed = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/stage/finish`,
        body: { planId, stageId: 'stage-1', failed: true },
      },
      deps,
    );
    expect(failed.status).toBe(200);
    const state = failed.body.state as { stages: { status: string }[]; spent: { actualCost: number } };
    expect(state.stages[0]!.status).toBe('failed');
    expect(state.spent.actualCost).toBe(0);
  });

  it('records a deviation when the user switches to a model the plan did not pick', async () => {
    const { host, deps } = rig();
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 'd', stageNames: ['implement'], estimatedInputTokens: 5_000 } },
      deps,
    );
    const planId = String(planned.body.planId);
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps);
    const plannedKey = host.getPlan(planId)!.stages[0]!.modelKey;
    const other = host
      .registry!.all()
      .find((e) => e.key !== plannedKey && e.model.capabilities.includes('coding'))!.key;
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-1', modelKey: other } },
      deps,
    );
    expect(res.status).toBe(200);
    expect(host.ledger.totals().deviations).toBe(1);
  });

  it('a swap before start is not a deviation: the plan was changed, not broken', async () => {
    const { host, deps } = rig();
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 's', stageNames: ['implement'], estimatedInputTokens: 5_000 } },
      deps,
    );
    const planId = String(planned.body.planId);
    const swapped = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/plan/swap`,
        body: { planId, stageId: 'stage-1', modelKey: 'local/qwen-coder' },
      },
      deps,
    );
    expect(swapped.status).toBe(200);
    expect(host.getPlan(planId)!.stages[0]!.modelKey).toBe('local/qwen-coder');
    expect(host.ledger.totals().deviations).toBe(0);
  });

  it('refuses a swap after approval: what the user agreed to stays put', async () => {
    const { deps } = rig();
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 'a', stageNames: ['implement'], estimatedInputTokens: 5_000 } },
      deps,
    );
    const planId = String(planned.body.planId);
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps);
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan/swap`, body: { planId, stageId: 'stage-1', modelKey: 'local/qwen-coder' } },
      deps,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('plan-locked');
  });

  it('refuses a swap to a model that cannot do the stage', async () => {
    const { deps } = rig({
      models: [...allModels, makeModel({ provider: 'cloud', name: 'painter2', capabilities: ['image-generation'] })],
    });
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 'c', stageNames: ['implement'], estimatedInputTokens: 5_000 } },
      deps,
    );
    const res = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/plan/swap`,
        body: { planId: planned.body.planId, stageId: 'stage-1', modelKey: 'cloud/painter2' },
      },
      deps,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('missing-capability');
  });

  it('keeps the global default visible in the state after a write-back', async () => {
    const { deps } = rig();
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 'g', stageNames: ['write'], estimatedInputTokens: 5_000 } },
      deps,
    );
    const planId = String(planned.body.planId);
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps);
    const state = (await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/state` }, deps)).body.state as {
      globalDefault: string | undefined;
      globalDefaultWriteBacks: number;
    };
    expect(state.globalDefault).toBe('deepseek/flash');
    expect(state.globalDefaultWriteBacks).toBe(0);
  });
});
