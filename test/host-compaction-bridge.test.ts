import { describe, expect, it } from 'vitest';
import { createRouter, type DshHostContext } from '../src/plugin/dsh-shell.js';
import { ROUTER_PREFIX, type RouterDeps } from '../src/plugin/endpoints.js';
import { createHostCompaction, resolveAgent } from '../src/plugin/compaction-bridge.js';

/**
 * 灰狼 DEF-2 回归：**压缩接口不匹配**。
 *
 * 报告原文要点："本版宿主提供的是 `compaction`，它要的是 `compact`，所以上下文
 * 达到八成时只会安全拒绝"。
 *
 * The real service, verified in `@org/dsh-compaction@0.2.1-rc.2`:
 *
 *   interface Context { compaction: CompactionEngine }
 *   compactIfNeeded(agent, trigger, signal): Promise<CompactionResult | null>
 *
 * These tests drive the **real** `createRouter(ctx)` against that shape — a
 * Cordis-like context where `ctx.get('compaction')` is the only way in, an agent
 * registry that answers `get(sessionId)`, a token meter that reports the size
 * after, and the durable `compaction/summary` event carrying provider usage.
 * The assertion is behavioural: the compaction runs **before** the switch, the
 * ledger books the host's own numbers, and the session really moved.
 */

const WINDOW = 50_000;

/** A provider snapshot with prices, so the guard is not the thing under test. */
const PROVIDERS = [
  {
    id: 'acme',
    name: 'Acme',
    models: [
      {
        id: 'narrow',
        contextWindow: WINDOW,
        maxOutputTokens: 8_192,
        inputPerMTok: 1,
        outputPerMTok: 4,
        capabilities: ['reasoning', 'coding', 'writing', 'summarizing'],
      },
      {
        // The session starts here, so the switch to `narrow` is a real move and
        // not the "already in use" shortcut.
        id: 'wide',
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        inputPerMTok: 1,
        outputPerMTok: 4,
        capabilities: ['reasoning', 'coding', 'writing', 'summarizing'],
      },
    ],
  },
];

interface RigOptions {
  /** What `compactIfNeeded` answers; `null` = the host found no safe range. */
  outcome?: 'compacted' | 'declined';
  /** Omit to model a host with a compaction service but no token meter. */
  withMeter?: boolean;
  /** Replace the agent registry (default: `get('sess-1')` answers the rig agent). */
  agents?: Record<string, unknown>;
  /** The session the requests state; `undefined` models "the request says none". */
  sessionId?: string | undefined;
}

function rig(options: RigOptions = {}) {
  const order: string[] = [];
  const compactionCalls: { trigger: string; aborted: boolean }[] = [];
  let current = 'acme/wide';

  const session = {
    id: 'sess-1',
    eventAt(seq: number) {
      // The durable summary event the host writes for this compaction.
      if (seq !== 4242) return undefined;
      return {
        type: 'compaction/summary',
        data: {
          provider: 'provider_a',
          model: 'model_a1',
          usage: { inputTokens: 39_000, outputTokens: 900 },
        },
      };
    },
  };
  const agent = { session, options: { provider: 'acme', model: 'narrow' } };

  const services: Record<string, unknown> = {
    sessionController: {
      // Real 0.2.1-rc.2 shape: **no** `sessionId` property on the controller,
      // and `selectModel` takes the request object. The id now arrives from the
      // request (or a real host probe), never from a literal.
      readCurrent: () => current,
      async selectModel(request: { sessionId?: string; provider: string; model: string }) {
        if (!request.sessionId) throw new Error('session "undefined" not found');
        order.push('select');
        current = `${request.provider}/${request.model}`;
      },
    },
    compaction: {
      async compactIfNeeded(_agent: unknown, trigger: string, signal: AbortSignal) {
        order.push('compact');
        compactionCalls.push({ trigger, aborted: signal.aborted });
        if (options.outcome === 'declined') return null;
        return {
          compactionId: 'cid-1',
          summarySeq: 4242,
          summary: [{ type: 'text', text: 'summary' }],
          shadowedRange: { start: 1, end: 39 },
          shadowedSeqs: [1, 2, 3],
          shadowedTokenCount: 30_000,
        };
      },
    },
  };
  services.agents =
    options.agents ?? { get: (id: string) => (id === (options.sessionId ?? 'sess-1') ? agent : undefined) };
  if (options.withMeter !== false) {
    services.tokenMeter = { measure: () => ({ totalTokens: 9_000 }) };
  }

  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'get') return (name: string) => services[name];
      if (prop === 'providers') return PROVIDERS;
      if (prop === 'profileCandidates') return [];
      throw new Error(`cannot get property "${prop}" without inject`);
    },
  }) as unknown as DshHostContext;

  const router = createRouter(ctx);
  return { router, deps: undefined as RouterDeps | undefined, order, compactionCalls, ctx };
}

async function planAndConfirm(
  router: ReturnType<typeof rig>['router'],
  sessionId?: string | undefined,
): Promise<string> {
  const planned = await router.handle({
    method: 'POST',
    path: `${ROUTER_PREFIX}/plan`,
    body: { taskId: 't1', stageNames: ['analyze', 'implement'], estimatedInputTokens: 20_000 },
  });
  expect(planned.status).toBe(200);
  const planId = String(planned.body.planId);
  const confirmed = await router.handle({
    method: 'POST',
    path: `${ROUTER_PREFIX}/plan/confirm`,
    body: { planId, ...(sessionId ? { sessionId } : {}) },
  });
  expect(confirmed.status).toBe(200);
  return planId;
}

/** A switch to `acme/narrow` at 78% of a 50k window (the compress band). */
async function switchBody(router: ReturnType<typeof rig>['router'], planId: string, sessionId?: string | undefined) {
  return router.handle({
    method: 'POST',
    path: `${ROUTER_PREFIX}/switch`,
    body: {
      planId,
      stageId: 'stage-1',
      modelKey: 'acme/narrow',
      contextTokens: 39_000,
      expectedOutputTokens: 2_000,
      ...(sessionId ? { sessionId } : {}),
    },
  });
}

describe('DEF-2: the host compaction service is bridged, not renamed away', () => {
  it('compresses through ctx.compaction and only then switches (39k on a 50k window = 78%)', async () => {
    const { router, order, compactionCalls } = rig({ sessionId: 'sess-1' });
    const planId = await planAndConfirm(router, 'sess-1');

    const answer = await switchBody(router, planId, 'sess-1');

    expect(answer.status).toBe(200);
    expect(answer.body.switched).toBe(true);
    expect(answer.body.sessionId).toBe('sess-1');
    // "压缩，然后再切换" — the order is the defect's whole point.
    expect(order).toEqual(['compact', 'select']);
    expect(compactionCalls).toEqual([{ trigger: 'pressure', aborted: false }]);
    expect((answer.body.context as { action: string }).action).toBe('compress');

    // The decision carries the sizes; the notice carries the sentence.
    const decision = answer.body.context as { carriedTokens: number };
    expect(decision.carriedTokens).toBe(9_000);
    const notice = answer.body.compaction as { text: string };
    expect(notice.text).toContain('压缩');

    // The book carries the host's own usage numbers, not an estimate.
    const compaction = router.host.ledger.all().find((event) => event.type === 'compaction')!;
    expect(compaction).toMatchObject({
      modelKey: 'provider_a/model_a1',
      inputTokens: 39_000,
      outputTokens: 900,
      tokensBefore: 39_000,
      tokensAfter: 9_000,
    });
    // The session really moved after the compression.
    expect(router.session.state(planId).sessionModel).toBe('acme/narrow');
  });

  it('refuses instead of truncating when the host finds no safe range', async () => {
    const { router, order } = rig({ outcome: 'declined', sessionId: 'sess-1' });
    const planId = await planAndConfirm(router, 'sess-1');

    const answer = await switchBody(router, planId, 'sess-1');

    expect(answer.status).toBe(409);
    expect(answer.body.switched).toBe(false);
    expect(String(answer.body.message)).toMatch(/压缩|拒绝|选项/);
    // Nothing was switched, and the refusal is in the book as its own event.
    expect(order).toEqual(['compact']);
    expect(router.host.ledger.all().some((event) => event.type === 'compaction-blocked')).toBe(true);
  });

  it('refuses when the compaction has no way to prove the context shrank', async () => {
    // A token meter is what makes "after" an observation instead of a hope.
    const { router } = rig({ withMeter: false, sessionId: 'sess-1' });
    const planId = await planAndConfirm(router, 'sess-1');

    const answer = await switchBody(router, planId, 'sess-1');

    expect(answer.status).toBe(409);
    expect(answer.body.switched).toBe(false);
    expect(String(answer.body.message)).toMatch(/token|压缩/);
  });

  /**
   * P1-2: the agent that owns the session is found by the **resolved** id, and
   * a fallback to `agents.list()` is only allowed for the single running agent.
   */
  it('locates the agent by the request session id, not by a controller field', async () => {
    // The controller in this rig has no `sessionId`; only the request names one.
    const { router, order } = rig({ sessionId: 'sess-from-request' });
    const planId = await planAndConfirm(router, 'sess-from-request');

    const answer = await switchBody(router, planId, 'sess-from-request');

    expect(answer.status).toBe(200);
    expect(order).toEqual(['compact', 'select']);
  });

  it('accepts a single running agent when the request names no session', async () => {
    const seen: string[] = [];
    const { router, order } = rig({
      sessionId: undefined,
      agents: {
        // `get` is called with the session the resolver picked; the rig's agent
        // is the only running one, so both probes agree.
        get: (id: string) => {
          seen.push(id);
          return id === 'sess-running' ? { session: { id: 'sess-running' }, status: 'running' } : undefined;
        },
        list: () => [{ session: { id: 'sess-running' }, status: 'running' }],
      },
    });
    const planId = await planAndConfirm(router);

    const answer = await switchBody(router, planId);

    expect(answer.status).toBe(200);
    expect(answer.body.sessionSource).toBe('running-agent');
    expect(order).toEqual(['compact', 'select']);
    expect(seen).toContain('sess-running');
  });

  it('refuses to compress when two sessions are live and the named one is unknown', async () => {
    const { router, order } = rig({
      sessionId: 'sess-unseen',
      agents: {
        // The request names an id no agent knows; two other sessions are running.
        get: () => undefined,
        list: () => [
          { session: { id: 'sess-a' }, status: 'running' },
          { session: { id: 'sess-b' }, status: 'running' },
        ],
      },
    });
    const planId = await planAndConfirm(router, 'sess-unseen');

    const answer = await switchBody(router, planId, 'sess-unseen');

    expect(answer.status).toBe(409);
    expect(order).toEqual([]); // no compaction, no switch
    expect(String(answer.body.message)).toMatch(/找不到承载本次会话的 agent/);
  });

});

/**
 * P1-2 A/B: the bridge is fed the **resolved** session id; the old literal
 * `'current'` is just an id no agent registry knows.
 *
 * Driven through `createHostCompaction` directly, so the assertion is about the
 * probe the bridge performs (`agents.get(<id>)`), not about HTTP plumbing.
 */
describe('P1-2 A/B: the compaction bridge asks for the resolved id, never `current`', () => {
  const summary = {
    compactionId: 'cid-ab',
    summarySeq: 1,
    summary: [],
    shadowedRange: { start: 1, end: 2 },
    shadowedSeqs: [1],
    shadowedTokenCount: 10,
  };
  const session = { id: 'sess-ab', eventAt: () => undefined };

  function harness(sessionId: () => string | undefined) {
    const asked: (string | undefined)[] = [];
    const compact = createHostCompaction({
      engine: { compactIfNeeded: async () => summary },
      agents: {
        get: (id: string) => {
          asked.push(id);
          return id === session.id ? { session, status: 'running' } : undefined;
        },
      },
      tokenMeter: { measure: () => ({ totalTokens: 7 }) },
      sessionId,
    })!;
    return { asked, compact };
  }

  it('locates the agent with the resolved id', async () => {
    const { asked, compact } = harness(() => 'sess-ab');
    const result = await compact({ rendered: 'handover', tokensBefore: 100 });
    expect(asked).toEqual(['sess-ab']);
    expect(result.tokensAfter).toBe(7);
  });

  it('an explicitly stated session wins over a stale probe thunk (no cross-request leak)', async () => {
    // The thunk is "what the last request resolved"; a concurrent request could
    // have moved it. The id threaded through the switch must win.
    const { asked, compact } = harness(() => 'current');
    const result = await compact({ rendered: 'handover', tokensBefore: 100, sessionId: 'sess-ab' });
    expect(asked).toEqual(['sess-ab']);
    expect(result.tokensAfter).toBe(7);
  });

  it('the old literal cannot locate the agent, so the switch is refused instead of guessed', async () => {
    // This is exactly the value the M2 build handed over (`?? 'current'`).
    const { asked, compact } = harness(() => 'current');
    await expect(compact({ rendered: 'handover', tokensBefore: 100 })).rejects.toThrow(
      /找不到承载本次会话的 agent/,
    );
    // It really asked the registry for that literal — and was refused.
    expect(asked).toContain('current');
  });

  it('a single idle agent is not accepted (the old code took any single entry)', async () => {
    const probe = { agents: { list: () => [{ session, status: 'idle' }] } };
    expect(resolveAgent(probe)).toBeUndefined();
    // The old rule, verbatim, did accept it — that is the behaviour that changed.
    const legacyRule = (live: readonly unknown[]) => (live.length === 1 ? live[0] : undefined);
    expect(legacyRule([{ session, status: 'idle' }])).toBeTruthy();
  });
});
