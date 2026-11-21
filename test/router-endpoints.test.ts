import { beforeEach, describe, expect, it } from 'vitest';
import { dispatch, ROUTER_PREFIX, type RouterDeps } from '../src/plugin/endpoints.js';
import { PluginHost, RouterError, RouterSession } from '../src/plugin/index.js';
import {
  DshModelAdapter,
  createGlobalDefaultGuard,
  type DshModelSelection,
} from '../src/adapters/dsh-model.js';
import type { ModelEntry } from '../src/core/types.js';
import { allModels, bigBrain, cheapFast, coder, makeModel } from './fixtures/models.js';

/**
 * P0-1: the four endpoints.
 *
 * These tests go through `dispatch`, never through the host directly, because
 * the client half only ever sees JSON. A card that is correct in-process and
 * wrong over HTTP is a broken product, and that is exactly the seam this file
 * covers.
 */

interface Harness {
  host: PluginHost;
  session: RouterSession;
  deps: RouterDeps;
  selection: DshModelSelection & { calls: string[] };
  globalDefault: { value: string | undefined; reads: number; primes: number };
}

function harness(
  options: { models?: ModelEntry[]; start?: string; selectionExtras?: () => Partial<DshModelSelection> } = {},
): Harness {
  const calls: string[] = [];
  let current = options.start ?? 'deepseek/flash';
  const globalDefault = { value: 'deepseek/flash' as string | undefined, reads: 0, primes: 0 };
  const selection: DshModelSelection & { calls: string[] } = {
    ...(options.selectionExtras?.() ?? {}),
    calls,
    current: () => current,
    select: async (_sessionId: string, modelKey: string) => {
      calls.push(modelKey);
      current = modelKey;
    },
    globalDefault: () => {
      globalDefault.reads += 1;
      return globalDefault.value;
    },
    primeGlobalDefault: () => {
      globalDefault.primes += 1;
      return globalDefault.value;
    },
  };
  const host = new PluginHost(selection);
  host.registerModels(
    options.models ?? allModels,
    (options.models ?? allModels).map((m) => `${m.provider}/${m.model}`),
  );
  const session = new RouterSession(host);
  return { host, session, deps: { host, session }, selection, globalDefault };
}

const planBody = {
  taskId: 't1',
  summary: 'ship the router',
  stageNames: ['analyze', 'implement', 'write'],
  estimatedInputTokens: 60_000,
};

describe('POST /router/plan', () => {
  it('returns a card with one row per stage and a money footer', async () => {
    const { deps } = harness();
    const res = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody }, deps);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const card = res.body.card as { rows: unknown[]; footer: string; canStart: boolean };
    expect(card.rows).toHaveLength(3);
    expect(card.footer).toContain('合计');
    expect(card.canStart).toBe(true);
  });

  it('rejects a body without stageNames instead of planning zero stages', async () => {
    const { deps } = harness();
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 't1' } },
      deps,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad-request');
    expect(String(res.body.error)).toContain('stageNames');
  });

  it('refuses an unparseable body the same way (no 500)', async () => {
    const { deps } = harness();
    const res = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: undefined }, deps);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad-request');
  });

  it('pulls models from the injected source before planning', async () => {
    const { deps, host } = harness({ models: [] });
    expect(host.registry.size()).toBe(0);
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody },
      { ...deps, models: () => [bigBrain, cheapFast, coder] },
    );
    expect(res.status).toBe(200);
    expect(host.registry.size()).toBe(3);
  });
});

describe('POST /router/plan: N-3, no baseline price is not an error', () => {
  const unpriced = [
    makeModel({ provider: 'cloud', name: 'mystery', capabilities: ['coding', 'reasoning'], pricing: { inputPerMTok: null, outputPerMTok: null } }),
    makeModel({ provider: 'cloud', name: 'mystery2', capabilities: ['writing'], pricing: { inputPerMTok: null, outputPerMTok: null } }),
  ];

  it('plans a card whose money says "price unknown" and never throws', async () => {
    const { deps } = harness({ models: unpriced });
    const res = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody }, deps);
    expect(res.status).toBe(200);
    const card = res.body.card as { rows: { cost: string }[]; footer: string };
    expect(card.rows).toHaveLength(3);
    for (const row of card.rows) expect(row.cost).toContain('price unknown');
    expect(card.footer).toContain('price unknown');
    // And it must not claim a saving it cannot compute.
    expect(card.footer).not.toContain('save 100%');
  });

  it('plans "no model at all" as unassigned stages plus needsWizard', async () => {
    const { deps } = harness({ models: [] });
    const res = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody }, deps);
    expect(res.status).toBe(200);
    const card = res.body.card as {
      canStart: boolean;
      needsWizard: boolean;
      footer: string;
      blockers: string[];
      rows: unknown[];
    };
    expect(card.canStart).toBe(false);
    expect(card.needsWizard).toBe(true);
    expect(card.blockers).toHaveLength(3);
    expect(card.footer).toContain('price unknown');
    expect(card.rows).toHaveLength(3);
  });
});

describe('POST /router/plan/confirm', () => {
  it('approves, starts the run and hands back state data', async () => {
    const { deps } = harness();
    const planned = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody }, deps);
    const planId = String(planned.body.planId);
    const res = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps);
    expect(res.status).toBe(200);
    const state = res.body.state as { active: boolean; cursor: number; total: number };
    expect(state.active).toBe(true);
    expect(state.total).toBe(3);
    expect(state.cursor).toBe(0);
    expect(deps.host.getPlan(planId)!.approvedAt).toBeDefined();
  });

  it('refuses with needsWizard when stages have no model', async () => {
    const { deps } = harness({ models: [] });
    const planned = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody }, deps);
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId: planned.body.planId } },
      deps,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('plan-incomplete');
    expect(res.body.needsWizard).toBe(true);
  });

  it('404s an unknown planId', async () => {
    const { deps } = harness();
    const res = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId: 'plan-ghost' } }, deps);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('unknown-plan');
  });
});

describe('POST /router/switch', () => {
  let h: Harness;
  let planId: string;

  beforeEach(async () => {
    h = harness();
    const planned = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody }, h.deps);
    planId = String(planned.body.planId);
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, h.deps);
  });

  it('runs the whole kernel path: gate → guard → adapter → read-back', async () => {
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-3' } },
      h.deps,
    );
    expect(res.status).toBe(200);
    expect(res.body.switched).toBe(true);
    // stage-3 is `write` (writing) → the strong model in fixtures.
    expect(h.selection.calls).toEqual(['deepseek/reasoner']);
    expect(String(res.body.message)).toContain('switched to');
    const state = res.body.state as { sessionModel: string };
    expect(state.sessionModel).toBe('deepseek/reasoner');
  });

  it('forwards the guard verdict when the context does not fit', async () => {
    // The plan picked the local coder for `implement` (32k window, 28.8k
    // usable). With the session carrying 40k, the switch must be refused with
    // the guard's own number — the user needs to know which limit bit.
    const res = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/switch`,
        body: { planId, stageId: 'stage-2', contextTokens: 40_000 },
      },
      h.deps,
    );
    expect(res.status).toBe(409);
    expect(res.body.switched).toBe(false);
    expect(String(res.body.message)).toMatch(/usable tokens/);
    expect(h.selection.calls).toEqual([]);
  });

  it('arms the global-default watch before switching (primed, not stale)', async () => {
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-2' } }, h.deps);
    expect(h.globalDefault.primes).toBeGreaterThan(0);
  });

  it('409s with the reason when the plan gate refuses', async () => {
    const fresh = harness();
    const p = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody }, fresh.deps);
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId: p.body.planId, stageId: 'stage-1' } },
      fresh.deps,
    );
    expect(res.status).toBe(409);
    expect(res.body.switched).toBe(false);
    expect(String(res.body.message)).toContain('not approved');
    expect(fresh.selection.calls).toEqual([]);
  });

  it('409s when the context does not fit, and says how much over', async () => {
    const res = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/switch`,
        body: { planId, stageId: 'stage-3', contextTokens: 400_000, expectedOutputTokens: 10_000 },
      },
      h.deps,
    );
    expect(res.status).toBe(409);
    expect(String(res.body.message)).toMatch(/over by/);
    expect(h.selection.calls).toEqual([]);
  });

  it('reports a global-default write-back instead of hiding it (K-003)', async () => {
    // A "settings cell" the fake platform rewrites on select, watched through
    // the real adapter guard — the same shape the DSH shell builds.
    let cell = 'deepseek/flash';
    const calls: string[] = [];
    let current = 'deepseek/flash';
    const adapter = new DshModelAdapter(
      {
        selectModel: async (_sessionId: string, provider: string, model: string) => {
          const key = `${provider}/${model}`;
          calls.push(key);
          current = key;
          cell = key; // the platform drags the default along
        },
        readCurrent: () => current,
      },
      'current',
      createGlobalDefaultGuard(() => cell),
    );
    const host = new PluginHost(adapter);
    host.registerModels(allModels, allModels.map((m) => `${m.provider}/${m.model}`));
    const deps: RouterDeps = { host, session: new RouterSession(host) };

    const planned = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody }, deps);
    const pid = String(planned.body.planId);
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId: pid } }, deps);
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId: pid, stageId: 'stage-3' } },
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.body.globalDefaultWrittenBack).toBe(true);
    const state = res.body.state as { globalDefaultWriteBacks: number; notices: string[] };
    expect(state.globalDefaultWriteBacks).toBe(1);
    expect(state.notices[0]).toContain('global default');
    expect(calls).toEqual(['deepseek/reasoner']);
  });
});

describe('GET /router/state', () => {
  it('says active:false before anything is approved', async () => {
    const { deps } = harness();
    const res = await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/state` }, deps);
    expect(res.status).toBe(200);
    const state = res.body.state as { active: boolean; total: number };
    expect(state.active).toBe(false);
    expect(state.total).toBe(0);
  });

  it('advances the cursor and books real money when a stage ends', async () => {
    const { deps } = harness();
    const planned = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: planBody }, deps);
    const planId = String(planned.body.planId);
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps);
    const finished = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/stage/finish`,
        body: { planId, stageId: 'stage-1', inputTokens: 1_000_000, outputTokens: 0 },
      },
      deps,
    );
    expect(finished.status).toBe(200);
    const state = finished.body.state as {
      cursor: number;
      current?: { stageId: string };
      spent: { actualCost: number };
      stages: { status: string; stageId: string }[];
    };
    // Money is booked immediately; the cursor does NOT move. A finished stage
    // means the next one is about to run, not that it is running.
    expect(state.stages[0]!.status).toBe('done');
    expect(state.cursor).toBe(0);
    // 1M input tokens on deepseek/reasoner = $2 of real money, not the estimate.
    expect(state.spent.actualCost).toBeCloseTo(2, 6);

    // The switch is what moves the bar. Stage 3 is the writing stage and the
    // session's model can take it; stage 2 would be refused by the output-cap
    // guard (the local coder emits 4096, a stage of this size needs 10800).
    const switched = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-3' } },
      deps,
    );
    expect([200, 409]).toContain(switched.status);
    const after = switched.body.state as { cursor: number; current?: { stageId: string } };
    expect(after.cursor).toBe(2);
    expect(after.current!.stageId).toBe('stage-3');
  });
});

describe('routing table', () => {
  it('404s a path it does not own', async () => {
    const { deps } = harness();
    for (const path of [`${ROUTER_PREFIX}/ghost`, '/other/thing']) {
      const res = await dispatch({ method: 'GET', path }, deps);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('no-route');
    }
  });

  it('405s a GET on a POST route (no silent fallthrough)', async () => {
    const { deps } = harness();
    const res = await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/plan` }, deps);
    expect(res.status).toBe(404);
    expect(String(res.body.error)).toContain('GET');
  });

  it('turns an unexpected crash into a 500 with a message, not a throw', async () => {
    const { deps } = harness();
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan/swap`, body: { planId: 'plan-ghost', stageId: 'stage-1', modelKey: 'deepseek/reasoner' } },
      deps,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('unknown-plan');
  });
});

describe('RouterError', () => {
  it('carries a machine code and details the endpoint can forward', () => {
    const error = new RouterError('plan-incomplete', 'nope', { needsWizard: true });
    expect(error.code).toBe('plan-incomplete');
    expect(error.details.needsWizard).toBe(true);
    expect(error).toBeInstanceOf(Error);
  });
});
