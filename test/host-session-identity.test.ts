import { describe, expect, it } from 'vitest';
import {
  createRouter,
  createSessionResolver,
  resolveHostSession,
  type DshHostContext,
} from '../src/plugin/dsh-shell.js';
import { ROUTER_PREFIX } from '../src/plugin/endpoints.js';

/**
 * 阻断 A 回归 + A/B：**切段必须对真正的会话发起**。
 *
 * 真宿主（DSH 0.2.1-rc.2 `/opt/dsh/node_modules/@deepseek-ai/dsh-api-session-controller`）
 * 的形状是：
 *
 *   SessionController.selectModel({ sessionId, provider, model })
 *   // 类型里**没有** sessionId 属性；上下文里也没有 ctx.sessionId
 *   selectModel 第一件事是 resolveAgent(request.sessionId)，未知 id →
 *   RemoteError("session/not-found")
 *
 * 所以旧代码的兜底 `?? 'current'` 在真机上必然
 * `session "current" not found`。这里用**真形状**（controller 无 sessionId、
 * 未知 id 报 not-found）跑完整 plan → confirm → switch，并且对同一台"宿主"跑
 * 一遍旧兜底做反证：旧值必失败，新路径必 200。
 */

const MODELS = [
  {
    id: 'acme',
    name: 'Acme',
    models: [
      {
        id: 'wide',
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        inputPerMTok: 5,
        outputPerMTok: 20,
        capabilities: ['reasoning', 'coding', 'writing', 'summarizing'],
      },
      {
        id: 'narrow',
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        inputPerMTok: 0.5,
        outputPerMTok: 2,
        capabilities: ['reasoning', 'coding', 'writing', 'summarizing'],
      },
    ],
  },
];

interface SelectCall {
  sessionId: string;
  provider: string;
  model: string;
}

interface RigOptions {
  /** Agents registry, exactly the slice the shell reads. */
  agents?: {
    get?(id: string): unknown;
    currentInitiator?(): unknown;
    list?(): readonly unknown[];
  };
}

/**
 * A host shaped like the real one: services through `ctx.get()`, a
 * session controller with **no** `sessionId`, and `session/not-found` for an
 * id it does not know (the `'current'` literal is exactly such an id).
 */
function rig(options: RigOptions = {}) {
  const selectCalls: SelectCall[] = [];
  const services: Record<string, unknown> = {
    sessionController: {
      // Arity 1 → the request-object form 0.2.1-rc.2 really uses.
      async selectModel(request: SelectCall) {
        if (request.sessionId === 'current') {
          // What the real controller answers for an unknown id.
          throw new Error('session "current" not found');
        }
        selectCalls.push(request);
      },
    },
  };
  if (options.agents) services.agents = options.agents;

  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'get') return (name: string) => services[name];
      if (prop === 'providers') return MODELS;
      if (prop === 'profileCandidates') return [];
      throw new Error(`cannot get property "${prop}" without inject`);
    },
  }) as unknown as DshHostContext;

  const router = createRouter(ctx);
  const post = async (path: string, body: Record<string, unknown>) =>
    router.handle({ method: 'POST', path, body });
  return { ctx, router, selectCalls, post };
}

/** plan → confirm → switch, returning the switch answer and the plan id. */
async function planConfirmSwitch(
  harness: ReturnType<typeof rig>,
  confirmSessionId?: string,
  switchSessionId?: string,
) {
  const planned = await harness.post(`${ROUTER_PREFIX}/plan`, {
    taskId: 't1',
    stageNames: ['implement'],
    estimatedInputTokens: 1_000,
  });
  expect(planned.status).toBe(200);
  const planId = String(planned.body.planId);
  const stage = (planned.body.plan as { stages: { stageId: string; modelKey: string }[] }).stages[0]!;

  const confirmed = await harness.post(`${ROUTER_PREFIX}/plan/confirm`, {
    planId,
    ...(confirmSessionId ? { sessionId: confirmSessionId } : {}),
  });
  expect(confirmed.status).toBe(200);

  const switched = await harness.post(`${ROUTER_PREFIX}/switch`, {
    planId,
    stageId: stage.stageId,
    modelKey: stage.modelKey,
    contextTokens: 1_000,
    expectedOutputTokens: 1_000,
    ...(switchSessionId ? { sessionId: switchSessionId } : {}),
  });
  return { planned, planId, switched };
}

describe('A: a switch is performed on the session the request names', () => {
  it('real host shape (no sessionId on the controller) + sessionId in the switch body ⇒ 200', async () => {
    const harness = rig();
    const { switched } = await planConfirmSwitch(harness, undefined, 'session-abc');

    expect(switched.status).toBe(200);
    expect(switched.body.switched).toBe(true);
    expect(harness.selectCalls).toHaveLength(1);
    // The id the platform was actually told, not `'current'`.
    expect(harness.selectCalls[0]!.sessionId).toBe('session-abc');
    expect(switched.body.sessionId).toBe('session-abc');
    expect(switched.body.sessionSource).toBe('request');
  });

  it('confirm can bind the session, so the following switch need not repeat it', async () => {
    const harness = rig();
    const { switched } = await planConfirmSwitch(harness, 'session-plan');

    expect(switched.status).toBe(200);
    expect(harness.selectCalls[0]!.sessionId).toBe('session-plan');
    expect(switched.body.sessionSource).toBe('plan');
  });

  it('no session anywhere ⇒ 409 session-unknown, and the platform is never called', async () => {
    const harness = rig();
    const { switched } = await planConfirmSwitch(harness);

    expect(switched.status).toBe(409);
    expect(switched.body.code).toBe('session-unknown');
    expect(switched.body.sessionIdRequired).toBe(true);
    expect(String(switched.body.error)).toMatch(/sessionId/);
    expect(harness.selectCalls).toEqual([]);
  });

  it('falls back to agents.currentInitiator().session.id', async () => {
    const harness = rig({
      agents: {
        currentInitiator: () => ({ session: { id: 'session-init' }, status: 'running' }),
      },
    });
    const { switched } = await planConfirmSwitch(harness);

    expect(switched.status).toBe(200);
    expect(harness.selectCalls[0]!.sessionId).toBe('session-init');
    expect(switched.body.sessionSource).toBe('initiator');
  });

  it('falls back to the only running agent, and refuses when two are running', async () => {
    const one = rig({
      agents: {
        list: () => [{ session: { id: 'session-solo' }, status: 'running' }],
      },
    });
    const solo = await planConfirmSwitch(one);
    expect(solo.switched.status).toBe(200);
    expect(one.selectCalls[0]!.sessionId).toBe('session-solo');
    expect(solo.switched.body.sessionSource).toBe('running-agent');

    // Two live sessions: picking one would switch the wrong conversation.
    const two = rig({
      agents: {
        list: () => [
          { session: { id: 'session-a' }, status: 'running' },
          { session: { id: 'session-b' }, status: 'running' },
        ],
      },
    });
    const ambiguous = await planConfirmSwitch(two);
    expect(ambiguous.switched.status).toBe(409);
    expect(ambiguous.switched.body.code).toBe('session-unknown');
    expect(two.selectCalls).toEqual([]);
  });

  it('an idle-only agent list is not a guess either (running is required)', async () => {
    const harness = rig({
      agents: { list: () => [{ session: { id: 'session-idle' }, status: 'idle' }] },
    });
    const { switched } = await planConfirmSwitch(harness);
    expect(switched.status).toBe(409);
    expect(switched.body.code).toBe('session-unknown');
  });
});

describe('A/B: the old `?? "current"` fallback must fail on the same host', () => {
  it('the legacy literal is rejected by the host, the resolved id is accepted', async () => {
    const harness = rig();

    // The old implementation's exact fallback value.
    const legacySessionId = 'current';
    const controller = resolveHostSession(harness.ctx)!.selectModel as (request: SelectCall) => Promise<unknown>;
    await expect(
      controller({ sessionId: legacySessionId, provider: 'acme', model: 'narrow' }),
    ).rejects.toThrow(/session "current" not found/);

    // The real path on the very same controller.
    const { switched } = await planConfirmSwitch(harness, undefined, 'session-real');
    expect(switched.status).toBe(200);
    expect(harness.selectCalls.map((call) => call.sessionId)).toEqual(['session-real']);

    // And the resolver itself never fabricates that value.
    const resolver = createSessionResolver(harness.ctx);
    expect(resolver.resolve(undefined)).toBeUndefined();
    expect(resolver.current()).toBeUndefined();
    expect(resolver.resolve(undefined, 'session-real')?.sessionId).not.toBe(legacySessionId);
    // If the implementation regressed to `?? 'current'`, the assertions above
    // would report `'current'` (or a 409) instead of the resolved id.
  });
});
