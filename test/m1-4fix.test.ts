import { describe, expect, it } from 'vitest';
import { singleShotMaxTokens, SINGLE_SHOT_SHARE } from '../src/core/guard.js';
import { buildStages, resolvePresetKey } from '../src/core/planner.js';
import { buildPlanCard } from '../src/core/card.js';
import { PluginHost, RouterSession } from '../src/plugin/index.js';
import { dispatch, ROUTER_PREFIX, type RouterDeps } from '../src/plugin/endpoints.js';
import { DshModelAdapter, createGlobalDefaultGuard } from '../src/adapters/dsh-model.js';
import type { ModelEntry, StagePlan } from '../src/core/types.js';
import { allModels, bigBrain, coder, makeModel, painter } from './fixtures/models.js';

/**
 * M1-4FIX: the six defects found in the prior pass in the M1-2 pass, each pinned by a test
 * that fails loudly if the behaviour comes back.
 *
 *   A1 计划卡 canStart 只看"每段有模型" ⇒ 卡片说可开工、switch 被拒
 *   A2 整段预估输出当单次 maxTokens 喂 guard ⇒ 60k 任务第 2 段必 409
 *   A3 出图段路由不到图像模型（planner 无 image-generation 预设）
 *   B1 already-in-use 报 409
 *   B2 stage-finish 缺 token 静默记 done+0 元
 *   B3 /router/state 未知 planId 回误导性 200
 */

/** A model whose window the config never stated: the guard may refuse, not allow. */
const guessedWindow = makeModel({
  provider: 'local',
  name: 'unconfirmed',
  capabilities: ['reasoning', 'coding', 'writing'],
  limitsGuessed: true,
  limits: { contextWindow: 32_000, maxOutputTokens: 8_192, supportsTools: true, supportsImages: false },
});

function rig(models: ModelEntry[] = allModels) {
  let current = 'deepseek/flash';
  const calls: string[] = [];
  const adapter = new DshModelAdapter(
    {
      selectModel: async (_s: string, provider: string, model: string) => {
        const key = `${provider}/${model}`;
        calls.push(key);
        current = key;
      },
      readCurrent: () => current,
    },
    'sess',
    createGlobalDefaultGuard(() => 'deepseek/flash'),
  );
  const host = new PluginHost(adapter);
  host.registerModels(models, models.map((m) => `${m.provider}/${m.model}`));
  const session = new RouterSession(host);
  const deps: RouterDeps = { host, session };
  return { host, session, deps, calls };
}

const planBody = (extra: Record<string, unknown> = {}) => ({
  taskId: 'fix',
  summary: '做程序开发 ＋ 汇报 PPT',
  stageNames: ['analyze', 'implement', 'write'],
  estimatedInputTokens: 60_000,
  ...extra,
});

describe('A1: the card refuses to promise what the switch will refuse', () => {
  it('a plan whose model has an unconfirmed window is not startable', async () => {
    // Only model available for all three stages, and its window was guessed.
    const { deps } = rig([guessedWindow]);
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody({ estimatedInputTokens: 1_000 }) },
      deps,
    );
    expect(res.status).toBe(200);
    const card = res.body.card as {
      canStart: boolean;
      checked: boolean;
      rows: { guard?: { code: string; allowed: boolean } }[];
      blockers: string[];
    };
    // Every stage HAS a model — that was the old, wrong definition of "可开工".
    expect(card.rows.every((r) => Boolean(r.guard))).toBe(true);
    expect(card.rows.map((r) => r.guard!.code)).toEqual([
      'limits-unconfirmed',
      'limits-unconfirmed',
      'limits-unconfirmed',
    ]);
    expect(card.canStart).toBe(false);
    expect(card.checked).toBe(true);
    expect(card.blockers.join(' ')).toMatch(/unconfirmed context window/);
  });

  it('approving such a plan is refused, with the same reason the card shows', async () => {
    const { deps, host } = rig([guessedWindow]);
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody({ estimatedInputTokens: 1_000 }) },
      deps,
    );
    const planId = String(planned.body.planId);
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } },
      deps,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('plan-blocked');
    expect(String(res.body.error)).toMatch(/unconfirmed context window/);
    expect(host.getPlan(planId)!.approvedAt).toBeUndefined();
  });

  it('the guard the card shows is the guard the switch asks', async () => {
    // A big enough task that the local coder cannot hold it, once the session
    // is carrying what the earlier stages left behind.
    const { deps, host } = rig();
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody({ estimatedInputTokens: 200_000 }) },
      deps,
    );
    const planId = String(planned.body.planId);
    const card = planned.body.card as { rows: { stageId: string; modelKey: string; guard: { code: string } }[] };
    const refusing = card.rows.filter((row) => row.guard.code !== 'ok');
    expect(refusing.length).toBeGreaterThan(0);
    await expect(
      dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps),
    ).resolves.toMatchObject({ status: 400 });
    // The plan is not approved, so every switch is refused by the plan gate
    // before the guard — and nothing ran.
    const switched = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: refusing[0]!.stageId } },
      deps,
    );
    expect(switched.status).toBe(409);
    expect(host.ledger.totals().switches).toBe(0);
  });

  it('plain buildPlanCard without guard numbers is not startable either', () => {
    const host = new PluginHost({ current: () => '', select: async () => undefined });
    host.registerModels(allModels, allModels.map((m) => `${m.provider}/${m.model}`));
    const plan = host.plan({ taskId: 't', summary: 'x', stageNames: ['implement'], estimatedInputTokens: 1_000 });
    const stripped: StagePlan = {
      ...plan,
      stages: plan.stages.map(({ guardInputs: _drop, ...rest }) => rest),
    };
    const card = buildPlanCard({ plan: stripped });
    expect(card.checked).toBe(false);
    expect(card.canStart).toBe(false);
  });
});

describe('A2: one switch asks for one reply, not the whole stage', () => {
  it('caps a single reply at the model output limit', () => {
    expect(coder.limits.maxOutputTokens).toBe(4_096);
    // A stage budget of 10.8k on a 4k-cap model must not become maxTokens=10800.
    expect(singleShotMaxTokens(10_800, coder)).toBe(4_096);
    // A small stage keeps its share, not the model ceiling.
    expect(singleShotMaxTokens(3_000, bigBrain)).toBe(Math.floor(3_000 * SINGLE_SHOT_SHARE));
  });

  it('a 60k three-stage plan carries per-stage numbers the guard accepts', async () => {
    const { deps, host } = rig();
    const planned = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody() }, deps);
    const planId = String(planned.body.planId);
    const plan = host.getPlan(planId)!;
    for (const assignment of plan.stages) {
      const inputs = assignment.guardInputs!;
      // Never the whole stage output: that was the 409 on stage 2.
      expect(inputs.expectedOutputTokens).toBeLessThanOrEqual(assignment.stage.estimatedOutputTokens);
      expect(host.stageVerdict(planId, assignment.stage.id, assignment.modelKey).allowed).toBe(true);
    }
    // Context grows across stages: a stage runs on what the last one left behind.
    const contexts = plan.stages.map((s) => s.guardInputs!.contextTokens);
    expect(contexts[0]).toBe(0);
    expect(contexts[1]).toBeGreaterThan(contexts[0]!);
    expect(contexts[2]).toBeGreaterThan(contexts[1]!);
  });

  it('a switch with no explicit numbers uses the plan’s, so the card’s ok is real', async () => {
    const { deps, calls } = rig();
    const planned = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody() }, deps);
    const planId = String(planned.body.planId);
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps);
    for (const stageId of ['stage-1', 'stage-2', 'stage-3']) {
      const res = await dispatch(
        { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId } },
        deps,
      );
      expect(res.status).toBe(200);
    }
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('A3: an image stage routes to an image model', () => {
  it('an 出图 stage is planned as image-generation', () => {
    expect(resolvePresetKey('出图')).toBe('image');
    expect(resolvePresetKey('配图')).toBe('image');
    expect(resolvePresetKey('image')).toBe('image');
    const [stage] = buildStages({
      taskId: 't',
      planId: 'p',
      summary: 'x',
      stageNames: ['出图'],
      estimatedInputTokens: 2_000,
    });
    expect(stage!.capability).toBe('image-generation');
    // 段名保持用户原样（2026-10-26 修正：别名只决定能力，不改显示名）。
    expect(stage!.name).toBe('出图');
  });

  it('the plan puts the image model on the image stage', async () => {
    const { deps, host } = rig([bigBrain, painter]);
    const planned = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/plan`,
        body: {
          taskId: 'img',
          stageNames: ['analyze', 'implement', '出图'],
          estimatedInputTokens: 6_000,
        },
      },
      deps,
    );
    expect(planned.status).toBe(200);
    const plan = host.getPlan(String(planned.body.planId))!;
    const image = plan.stages.find((s) => s.stage.capability === 'image-generation');
    expect(image).toBeDefined();
    expect(image!.modelKey).toBe('cloud/diffusion-xl');
    const card = planned.body.card as { rows: { title: string; modelKey: string; guard: { allowed: boolean } }[] };
    const imageRow = card.rows.find((row) => row.title === '出图')!;
    expect(imageRow.modelKey).toBe('cloud/diffusion-xl');
    expect(imageRow.guard.allowed).toBe(true);
  });

  it('with no image model the stage is unassigned, not silently re-routed to a text model', async () => {
    const { deps, host } = rig([bigBrain]);
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 'img2', stageNames: ['出图'], estimatedInputTokens: 1_000 } },
      deps,
    );
    expect(planned.status).toBe(200);
    const plan = host.getPlan(String(planned.body.planId))!;
    expect(plan.stages).toHaveLength(0);
    expect(plan.unassignedStages?.[0]?.reason).toBe('capability-unmet');
  });
});

describe('B1: already in use is an idempotent success', () => {
  it('switching to the model the session already runs answers 200', async () => {
    const { deps, host } = rig();
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 'b1', stageNames: ['analyze'], estimatedInputTokens: 1_000 } },
      deps,
    );
    const planId = String(planned.body.planId);
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps);
    const planned_ = host.getPlan(planId)!.stages[0]!.modelKey;

    // Pretend the session is already there.
    const first = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-1' } },
      deps,
    );
    expect(first.status).toBe(200);
    const again = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-1', modelKey: planned_ } },
      deps,
    );
    expect(again.status).toBe(200);
    expect(again.body.ok).toBe(true);
    expect(again.body.switched).toBe(true);
    expect(again.body.alreadyInUse).toBe(true);
    expect(String(again.body.message)).toMatch(/already in use/);
    // Idempotent: the repeat adds no event, so the count is exactly the one real
    // switch that got the session there.
    expect(host.ledger.totals().switches).toBe(1);
    expect(host.ledger.all().filter((e) => e.type === 'model-switch')).toHaveLength(1);
  });
});

describe('B2: done without token counts is refused, never booked as $0', () => {
  it('409/400s a finish with no usage and names the missing fields', async () => {
    const { deps, host } = rig();
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 'b2', stageNames: ['write'], estimatedInputTokens: 2_000 } },
      deps,
    );
    const planId = String(planned.body.planId);
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps);
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/stage/finish`, body: { planId, stageId: 'stage-1' } },
      deps,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('usage-required');
    expect(host.ledger.totals().actualCost).toBe(0);
    expect(host.ledger.totals().unpricedStages).toBe(0);
    // The stage was not marked done by a refused finish.
    const state = (await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/state?planId=${planId}` }, deps))
      .body.state as { stages: { status: string }[] };
    expect(state.stages[0]!.status).toBe('running');
  });

  it('half a usage report is refused too', async () => {
    const { deps } = rig();
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 'b2b', stageNames: ['write'], estimatedInputTokens: 2_000 } },
      deps,
    );
    const planId = String(planned.body.planId);
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps);
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/stage/finish`, body: { planId, stageId: 'stage-1', inputTokens: 10 } },
      deps,
    );
    expect(res.status).toBe(400);
    expect(res.body.missing).toEqual(['outputTokens']);
  });

  it('a host without token counts can still finish a stage, and the bar says so', () => {
    const { host, session } = rig();
    const plan = host.plan({ taskId: 'b2c', summary: 'x', stageNames: ['write'], estimatedInputTokens: 1_000 });
    host.approvePlan(plan);
    session.start(plan.planId);
    const state = session.finish({ planId: plan.planId, stageId: 'stage-1', modelKey: plan.stages[0]!.modelKey });
    expect(state.stages[0]!.status).toBe('done');
    expect(state.unbookedStages).toEqual(['stage-1']);
    expect(state.notices.join(' ')).toMatch(/without token counts/);
  });
});

describe('B3: state never answers for a plan it does not hold', () => {
  it('404s an unknown planId instead of a hollow 200', async () => {
    const { deps } = rig();
    const res = await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/state?planId=plan-ghost` }, deps);
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('unknown-plan');
  });

  it('still answers 200 with no planId at all: that is a real question', async () => {
    const { deps } = rig();
    const res = await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/state` }, deps);
    expect(res.status).toBe(200);
    expect((res.body.state as { active: boolean }).active).toBe(false);
  });

  it('404s a finish for a plan nobody issued', async () => {
    const { deps } = rig();
    const res = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/stage/finish`,
        body: { planId: 'plan-ghost', stageId: 'stage-1', inputTokens: 1, outputTokens: 1 },
      },
      deps,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('unknown-plan');
  });
});
