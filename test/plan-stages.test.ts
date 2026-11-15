import { describe, expect, it } from 'vitest';
import { createRouter, type DshHostContext } from '../src/plugin/dsh-shell.js';
import { ROUTER_PREFIX } from '../src/plugin/endpoints.js';
import { makeModel } from './fixtures/models.js';

/**
 * 灰狼 DEF-4 回归：**计划接口的阶段列表**。
 *
 * 报告原文要点："计划接口返回的阶段列表是空的，只有卡片行，因此换模型也改不了"。
 *
 * Two separate holes produced that symptom and both are pinned here:
 *  1. `/router/plan` serialized only the **assigned** stages, so a host whose
 *     models were not discovered answered `stages: []` next to a card full of
 *     rows;
 *  2. `POST /router/plan/swap` looked the stage up in that same assignment list,
 *     so the one row the user needed to fix answered `unknown-stage`.
 *
 * The tests drive the real endpoints through `createRouter(ctx)`.
 */

const wide = makeModel({
  provider: 'acme',
  name: 'wide',
  label: 'Acme Wide',
  capabilities: ['reasoning', 'coding', 'writing', 'summarizing'],
  limits: { contextWindow: 200_000, maxOutputTokens: 8_192, supportsTools: null, supportsImages: false },
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
});

function hostWith(models: (typeof wide)[]): DshHostContext {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'get') return () => undefined;
      if (prop === 'providers') {
        return models.length > 0
          ? [
              {
                id: 'acme',
                name: 'Acme',
                models: models.map((model) => ({
                  id: model.model,
                  name: model.label,
                  contextWindow: model.limits.contextWindow,
                  maxOutputTokens: model.limits.maxOutputTokens,
                  inputPerMTok: model.pricing.inputPerMTok,
                  outputPerMTok: model.pricing.outputPerMTok,
                  capabilities: model.capabilities,
                })),
              },
            ]
          : [];
      }
      if (prop === 'profileCandidates') return [];
      throw new Error(`cannot get property "${prop}" without inject`);
    },
  }) as unknown as DshHostContext;
}

const STAGES = ['analyze', 'implement', 'write', 'summarize'];

async function plan(
  router: ReturnType<typeof createRouter>,
): Promise<Record<string, unknown>> {
  const answer = await router.handle({
    method: 'POST',
    path: `${ROUTER_PREFIX}/plan`,
    body: { taskId: 't1', stageNames: STAGES, estimatedInputTokens: 20_000 },
  });
  expect(answer.status).toBe(200);
  return answer.body;
}

describe('DEF-4: /router/plan returns one entry per stage, assigned or not', () => {
  it('returns every stage with id, name, model and estimate when models exist', async () => {
    const router = createRouter(hostWith([wide]));
    const body = await plan(router);

    const stages = (body.plan as { stages: Record<string, unknown>[] }).stages;
    expect(stages).toHaveLength(4);
    expect(stages.map((stage) => stage.stageId)).toEqual(['stage-1', 'stage-2', 'stage-3', 'stage-4']);
    expect(stages.map((stage) => stage.name)).toEqual(STAGES);
    for (const stage of stages) {
      expect(stage.assigned).toBe(true);
      expect(stage.modelKey).toBe('acme/wide');
      expect(stage.modelLabel).toBe('Acme Wide');
      // The stage's own estimated size is always part of the answer.
      expect(stage.estimated).toMatchObject({
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      });
      // …and the priced estimate travels with the assigned model.
      expect(stage.estimate).toMatchObject({ cost: expect.any(Number) });
    }
  });

  it('still lists every stage when nothing is discovered (modelKey null, not a missing row)', async () => {
    const router = createRouter(hostWith([]));
    const body = await plan(router);

    expect(body.modelCount).toBe(0);
    const stages = (body.plan as { stages: Record<string, unknown>[] }).stages;
    expect(stages).toHaveLength(4);
    for (const stage of stages) {
      expect(stage.assigned).toBe(false);
      expect(stage.modelKey).toBeNull();
      // The row is not blank: it keeps the work it stands for, plus a reason.
      expect(typeof stage.name).toBe('string');
      expect(String(stage.reason).length).toBeGreaterThan(0);
    }
    // And the card has the same four rows — the two halves cannot disagree.
    const card = body.card as { rows: unknown[]; needsWizard: boolean };
    expect(card.rows).toHaveLength(4);
    expect(card.needsWizard).toBe(true);
  });

  it('lets the user assign a model to a stage that had none, and read it back', async () => {
    const router = createRouter(hostWith([]));
    const body = await plan(router);
    const planId = String(body.planId);

    // The wizard registered models after the plan was drawn (the real order on
    // a host whose discovery ran late).
    router.host.registerModels([wide]);

    // Before the change, the card already offers the picker for that row…
    const before = await router.handle({ method: 'GET', path: `${ROUTER_PREFIX}/card?planId=${planId}` });
    expect(before.status).toBe(200);
    const row = (before.body.card as { rows: { stageId: string; alternatives: { key: string }[] }[] }).rows.find(
      (candidate) => candidate.stageId === 'stage-2',
    )!;
    expect(row.alternatives.map((option) => option.key)).toContain('acme/wide');

    // …and the swap now fills it instead of answering `unknown-stage`.
    const swapped = await router.handle({
      method: 'POST',
      path: `${ROUTER_PREFIX}/plan/swap`,
      body: { planId, stageId: 'stage-2', modelKey: 'acme/wide' },
    });
    expect(swapped.status).toBe(200);

    // Read back from the same answer…
    const stages = (swapped.body.plan as { stages: Record<string, unknown>[] }).stages;
    expect(stages).toHaveLength(4);
    expect(stages[1]).toMatchObject({ stageId: 'stage-2', assigned: true, modelKey: 'acme/wide' });
    expect((swapped.body.plan as { unassignedStages: unknown[] }).unassignedStages).toHaveLength(3);

    // …from a fresh `/router/plan`-independent read of the card…
    const after = await router.handle({ method: 'GET', path: `${ROUTER_PREFIX}/card?planId=${planId}` });
    const afterRow = (after.body.card as { rows: { stageId: string; modelKey: string | null; modelLabel: string }[] }).rows.find(
      (candidate) => candidate.stageId === 'stage-2',
    )!;
    expect(afterRow.modelKey).toBe('acme/wide');
    expect(afterRow.modelLabel).toBe('Acme Wide');

    // …and from the plan as the host holds it (the switch will use this).
    expect(router.host.getPlan(planId)!.stages.map((assignment) => assignment.stage.id)).toContain('stage-2');
  });

  it('rejects a swap that the stage cannot use, without changing the plan', async () => {
    const router = createRouter(hostWith([wide]));
    const body = await plan(router);
    const planId = String(body.planId);
    const picture = makeModel({
      provider: 'acme',
      name: 'painter',
      capabilities: ['image-generation'],
      pricing: { inputPerMTok: 0, outputPerMTok: 40 },
    });
    router.host.registerModels([picture]);

    const swapped = await router.handle({
      method: 'POST',
      path: `${ROUTER_PREFIX}/plan/swap`,
      body: { planId, stageId: 'stage-2', modelKey: 'acme/painter' },
    });
    expect(swapped.status).toBe(400);
    expect(swapped.body.code).toBe('missing-capability');
    // Nothing moved.
    expect(
      router.host.getPlan(planId)!.stages.find((assignment) => assignment.stage.id === 'stage-2')!.modelKey,
    ).toBe('acme/wide');
  });
});
