import { describe, expect, it, vi } from 'vitest';
import { createRouter, type DshHostContext } from '../src/plugin/dsh-shell.js';
import { ROUTER_PREFIX } from '../src/plugin/endpoints.js';
import { makeModel } from './fixtures/models.js';

/**
 * DEF-1 回修：F5 的压缩链路必须真的接在宿主入口上。
 *
 * The independent review found the wiring was a facade: `createCompressor()` had
 * no caller, `host.compressor` was always undefined on a real host, and every
 * over-full switch therefore landed in `compaction-blocked` + refuse. These tests
 * drive the **real** `createRouter(ctx)` — the same function `apply()` uses — and
 * assert behaviour, not source text: a compaction event in the ledger, money in
 * the book, and the session actually moved.
 */

const wide = makeModel({
  provider: 'acme',
  name: 'wide',
  capabilities: ['reasoning', 'coding', 'writing'],
  limits: { contextWindow: 200_000, maxOutputTokens: 8_192, supportsTools: null, supportsImages: false },
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  strength: 0.8,
});

const narrow = makeModel({
  provider: 'acme',
  name: 'narrow',
  capabilities: ['reasoning', 'coding', 'writing'],
  // 50k window → F5 bands at 25k / 35k / 8k. A 39k context is 78% of it: over the
  // summary line, so the compress branch is the only way through.
  limits: { contextWindow: 50_000, maxOutputTokens: 8_192, supportsTools: null, supportsImages: false },
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  strength: 0.8,
});

/** A host context as DSH would hand it over: session, models, and `compact`. */
function hostContext(
  options: {
    /** Omit to model a host with no compaction at all. */
    compact?: DshHostContext['compact'];
    /** What the host's compaction reports. */
    result?: { tokensAfter: number; inputTokens: number; outputTokens: number; cost?: number | null };
    start?: string;
  } = {},
) {
  let current = options.start ?? 'acme/narrow';
  const ctx: DshHostContext = {
    // Every model source is stated below; no real profile is read.
    profileCandidates: [],
    session: {
      sessionId: 'session-1',
      readCurrent: () => current,
      selectModel: async (provider: string, model: string) => {
        current = `${provider}/${model}`;
      },
    },
    // What DSH hands over: `providers` is the in-memory model list, and it is also
    // what `/router/plan` registers. Limits and prices travel with it, because a
    // model whose window the config does not state is refused by the guard — which
    // would make this file measure the guard instead of the wiring.
    providers: [
      {
        id: 'acme',
        name: 'Acme',
        models: [
          {
            id: 'wide',
            contextWindow: wide.limits.contextWindow,
            maxOutputTokens: wide.limits.maxOutputTokens,
            inputPerMTok: 1,
            outputPerMTok: 4,
            capabilities: ['reasoning', 'coding', 'writing'],
          },
          {
            id: 'narrow',
            contextWindow: narrow.limits.contextWindow,
            maxOutputTokens: narrow.limits.maxOutputTokens,
            inputPerMTok: 1,
            outputPerMTok: 4,
            capabilities: ['reasoning', 'coding', 'writing'],
          },
        ],
      },
    ],
  };
  if (options.compact) ctx.compact = options.compact;
  return { ctx, current: () => current };
}

/** A host compaction that reports the numbers it was told to report. */
function compacting(result: { tokensAfter: number; inputTokens: number; outputTokens: number; cost?: number | null }) {
  return vi.fn(
    async (_input: { rendered: string; tokensBefore: number; targetModelKey?: string }) => ({
      tokensAfter: result.tokensAfter,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      modelKey: 'acme/wide',
      ...(result.cost === undefined ? {} : { cost: result.cost }),
      reopenable: true,
    }),
  );
}

/**
 * A router built by the real entry point, with one approved plan.
 *
 * Nothing is injected here that `apply()` would not have: models come from
 * `deps.models` (`ctx.providers`), the compressor and the compaction hook come
 * from `createRouter`. Registering models by hand would hide exactly the wiring
 * this file exists to check.
 */
async function readyRouter(context: ReturnType<typeof hostContext>) {
  const router = createRouter(context.ctx);
  const planned = await router.handle({
    method: 'POST',
    path: `${ROUTER_PREFIX}/plan`,
    body: { taskId: 'def1', stageNames: ['analyze'], estimatedInputTokens: 1_000 },
  });
  const planId = String(planned.body.planId);
  await router.handle({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } });
  return { ...router, planId };
}

const switchBody = (planId: string, contextTokens: number) => ({
  method: 'POST' as const,
  path: `${ROUTER_PREFIX}/switch`,
  body: { planId, stageId: 'stage-1', contextTokens, modelKey: 'acme/narrow' },
});

describe('DEF-1 ①: createRouter wires the host compressor', () => {
  it('a host that offers ctx.compact gets a defined compressor', () => {
    const { ctx } = hostContext({ compact: compacting({ tokensAfter: 8_000, inputTokens: 39_000, outputTokens: 900 }) });
    const router = createRouter(ctx);
    expect(router.host.compressorWired).toBe(true);
    expect(router.host.canCompress).toBe(true);
  });

  it('a host with no ctx.compact stays honestly unable to compress', () => {
    const { ctx } = hostContext();
    const router = createRouter(ctx);
    expect(router.host.compressorWired).toBe(false);
    expect(router.host.canCompress).toBe(false);
  });
});

describe('DEF-1 ②: an 80% switch really compresses, then switches', () => {
  it('C/W=80% takes the compress branch: compaction booked, cost booked, session moved', async () => {
    const compact = compacting({ tokensAfter: 8_000, inputTokens: 39_000, outputTokens: 1_200, cost: 0.05 });
    // The session starts on `wide` and the plan asks for `narrow`: a real move, so
    // the context branch (and its booking) actually runs.
    const context = hostContext({ compact, start: 'acme/wide' });
    const { host, planId, handle } = await readyRouter(context);

    const answer = await handle(switchBody(planId, 39_000));

    // The switch happened, and it happened the protected way.
    expect(answer.status).toBe(200);
    expect(context.current()).toBe('acme/narrow');
    const decision = answer.body.context as { action: string; carriedTokens: number };
    expect(decision.action).toBe('compress');
    expect(decision.carriedTokens).toBe(8_000);

    // The host's own compaction really ran, once, before the switch.
    expect(compact).toHaveBeenCalledTimes(1);
    const arg = compact.mock.calls[0]![0];
    expect(arg.tokensBefore).toBe(39_000);
    expect(arg.rendered).toContain('## 任务目标');

    // A real compaction event, with its real usage and its money.
    const compaction = host.ledger.all().filter((e) => e.type === 'compaction');
    expect(compaction).toHaveLength(1);
    expect(compaction[0]!.inputTokens).toBe(39_000);
    expect(compaction[0]!.outputTokens).toBe(1_200);
    expect(compaction[0]!.cost).toBeCloseTo(0.05, 10);
    expect(compaction[0]!.tokensBefore).toBe(39_000);
    expect(compaction[0]!.tokensAfter).toBe(8_000);
    const totals = host.ledger.totals();
    expect(totals.compactionCost).toBeCloseTo(0.05, 10);
    expect(totals.compactionInputTokens).toBe(39_000);

    // And **not** the old dead end.
    expect(host.ledger.all().some((e) => e.type === 'compaction-blocked')).toBe(false);
    // The prefill is its own bucket (DEF-2), still in the invoice.
    expect(totals.prefillInputTokens).toBe(8_000);
    expect(totals.prefillCost).toBeCloseTo(0.008, 10);
    expect(totals.actualCost).toBeCloseTo(0.058, 10);
  });

  it('a switch that fits directly does not spend money compressing', async () => {
    const compact = compacting({ tokensAfter: 8_000, inputTokens: 20_000, outputTokens: 900, cost: 0.02 });
    const context = hostContext({ compact, start: 'acme/wide' });
    const { host, planId, handle } = await readyRouter(context);
    const answer = await handle(switchBody(planId, 10_000));
    expect(answer.status).toBe(200);
    expect((answer.body.context as { action: string }).action).toBe('direct');
    expect(compact).not.toHaveBeenCalled();
    expect(host.ledger.all().some((e) => e.type === 'compaction')).toBe(false);
  });

  it('a host compaction that comes back too big still refuses instead of switching', async () => {
    const compact = compacting({ tokensAfter: 40_000, inputTokens: 39_000, outputTokens: 900, cost: 0.03 });
    const context = hostContext({ compact, start: 'acme/wide' });
    const { host, planId, handle } = await readyRouter(context);
    const answer = await handle(switchBody(planId, 39_000));
    expect(answer.status).toBe(409);
    expect((answer.body.context as { action: string }).action).toBe('refuse');
    expect(context.current()).toBe('acme/wide');
    // The money was spent anyway, so it is still booked.
    expect(host.ledger.all().some((e) => e.type === 'compaction')).toBe(true);
  });
});

describe('DEF-1 ③: no ctx.compact keeps the safe refusal', () => {
  it('the switch refuses with three options and nothing moves', async () => {
    const context = hostContext();
    const { host, planId, handle } = await readyRouter(context);
    const answer = await handle(switchBody(planId, 39_000));

    expect(answer.status).toBe(409);
    expect((answer.body.context as { action: string }).action).toBe('refuse');
    const message = String(answer.body.message);
    expect(message).toMatch(/refusing to switch instead of truncating/);
    expect(message).toMatch(/bigger window/);
    // The session stayed where it was and the refusal is in the book as such.
    expect(context.current()).toBe('acme/narrow');
    expect(host.ledger.all().some((e) => e.type === 'compaction-blocked')).toBe(true);
    expect(host.ledger.all().some((e) => e.type === 'compaction')).toBe(false);
    expect(host.ledger.all().some((e) => e.type === 'model-switch')).toBe(false);
  });
});

describe('DEF-1 A/B 反证: remove the wiring and the new assertions go red', () => {
  /**
   * The same host, with the DEF-1 injection taken back out — i.e. the code as the
   * independent review found it: `ctx.compact` present, `createCompressor()` never
   * called, `host.compressor` undefined. Everything else is identical, so any
   * difference between this and the real router is the wiring itself.
   */
  function routerWithoutWiring(ctx: DshHostContext) {
    const router = createRouter(ctx);
    router.host.setCompressor(undefined);
    router.host.setCompactionHook(undefined);
    return router;
  }

  it('without injection the 80% switch falls into compaction-blocked, not compression', async () => {
    const compact = compacting({ tokensAfter: 8_000, inputTokens: 39_000, outputTokens: 1_200, cost: 0.05 });
    const context = hostContext({ compact, start: 'acme/wide' });
    const broken = routerWithoutWiring(context.ctx);
    const planned = await broken.handle({
      method: 'POST',
      path: `${ROUTER_PREFIX}/plan`,
      body: { taskId: 'def1-ab', stageNames: ['analyze'], estimatedInputTokens: 1_000 },
    });
    const planId = String(planned.body.planId);
    await broken.handle({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } });
    const answer = await broken.handle(switchBody(planId, 39_000));

    // The three assertions the repair exists for, all red without the wiring.
    expect(broken.host.compressorWired).toBe(false);
    expect(answer.status).toBe(409);
    expect(broken.host.ledger.all().some((e) => e.type === 'compaction')).toBe(false);
    expect(broken.host.ledger.all().some((e) => e.type === 'compaction-blocked')).toBe(true);
    expect(compact).not.toHaveBeenCalled();
    expect(context.current()).toBe('acme/wide');
  });

  it('the two routers disagree on the same host, which is what makes the wiring the repair', async () => {
    const withWiring = hostContext({
      compact: compacting({ tokensAfter: 8_000, inputTokens: 39_000, outputTokens: 1_200, cost: 0.05 }),
      start: 'acme/wide',
    });
    const repaired = await readyRouter(withWiring);
    const repairedAnswer = await repaired.handle(switchBody(repaired.planId, 39_000));

    const withoutWiring = hostContext({
      compact: compacting({ tokensAfter: 8_000, inputTokens: 39_000, outputTokens: 1_200, cost: 0.05 }),
      start: 'acme/wide',
    });
    const broken = routerWithoutWiring(withoutWiring.ctx);
    const planned = await broken.handle({
      method: 'POST',
      path: `${ROUTER_PREFIX}/plan`,
      body: { taskId: 'def1-ab2', stageNames: ['analyze'], estimatedInputTokens: 1_000 },
    });
    const planId = String(planned.body.planId);
    await broken.handle({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } });
    const brokenAnswer = await broken.handle(switchBody(planId, 39_000));

    expect(repairedAnswer.status).toBe(200);
    expect(brokenAnswer.status).toBe(409);
    expect((repairedAnswer.body.context as { action: string }).action).toBe('compress');
    expect((brokenAnswer.body.context as { action: string }).action).toBe('refuse');
  });
});

describe('DEF-2: compactionCost holds compression only', () => {
  it('a switch with no compaction does not grow the compaction bucket', async () => {
    // Starts on `wide` so the switch really moves (a no-op switch re-sends
    // nothing, so there would be no prefill to tell the buckets apart with).
    const context = hostContext({ start: 'acme/wide' });
    const { host, planId, handle } = await readyRouter(context);
    // 10k on the 50k window is 20%: direct, whole conversation, prefill billed.
    const answer = await handle(switchBody(planId, 10_000));
    expect(answer.status).toBe(200);
    const totals = host.ledger.totals();
    expect(totals.prefillInputTokens).toBe(10_000);
    expect(totals.prefillCost).toBeCloseTo(0.01, 10);
    // The whole point: no compression ran, so this bucket is empty.
    expect(totals.compactionCost).toBe(0);
    // …while the invoice still carries the prefill.
    expect(totals.actualCost).toBeCloseTo(0.01, 10);
  });

  it('a compression and its prefill land in different buckets, both billed', async () => {
    const context = hostContext({
      compact: compacting({ tokensAfter: 8_000, inputTokens: 39_000, outputTokens: 1_200, cost: 0.05 }),
      start: 'acme/wide',
    });
    const { host, planId, handle } = await readyRouter(context);
    await handle(switchBody(planId, 39_000));
    const totals = host.ledger.totals();
    expect(totals.compactionCost).toBeCloseTo(0.05, 10);
    expect(totals.prefillCost).toBeCloseTo(0.008, 10);
    expect(totals.actualCost).toBeCloseTo(0.058, 10);
  });
});

describe('DEF-5: GET /router/context is a real dry run', () => {
  it('an 80% dry run predicts, and books nothing', async () => {
    const compact = compacting({ tokensAfter: 8_000, inputTokens: 39_000, outputTokens: 1_200, cost: 0.05 });
    const context = hostContext({ compact, start: 'acme/wide' });
    const { host, planId, handle } = await readyRouter(context);

    const dry = await handle({
      method: 'GET',
      path: `${ROUTER_PREFIX}/context?planId=${planId}&stageId=stage-1&contextTokens=39000`,
    });

    expect(dry.status).toBe(200);
    const decision = dry.body.decision as {
      action: string;
      dryRun?: boolean;
      predictedCompactionCost?: number | null;
    };
    expect(decision.action).toBe('compress');
    expect(decision.dryRun).toBe(true);
    // "It will cost about this" — instead of costing it.
    expect(decision.predictedCompactionCost).toBeCloseTo(0.039, 10);

    // Zero side effects: no compaction call, no ledger event, no money.
    expect(compact).not.toHaveBeenCalled();
    expect(host.ledger.all().some((e) => e.type === 'compaction')).toBe(false);
    expect(host.ledger.totals().compactionCost).toBe(0);
    expect(host.ledger.totals().actualCost).toBe(0);
    // And the session did not move either.
    expect(context.current()).toBe('acme/wide');
  });

  it('a dry run on a host with no compressor reports the refusal it would get', async () => {
    const context = hostContext({ start: 'acme/wide' });
    const { host, planId, handle } = await readyRouter(context);
    const dry = await handle({
      method: 'GET',
      path: `${ROUTER_PREFIX}/context?planId=${planId}&stageId=stage-1&contextTokens=39000`,
    });
    const decision = dry.body.decision as { action: string; message: string };
    expect(decision.action).toBe('refuse');
    expect(decision.message).toMatch(/no compressor is wired/);
    expect(host.ledger.size()).toBeGreaterThan(0); // the plan's own events only
    expect(host.ledger.all().some((e) => e.type === 'compaction-blocked')).toBe(false);
  });
});

describe('DEF-7: the compaction notice appears exactly once', () => {
  it('the switch message says the notice one time, and carries it as data', async () => {
    const context = hostContext({
      compact: compacting({ tokensAfter: 8_000, inputTokens: 39_000, outputTokens: 1_200, cost: 0.05 }),
      start: 'acme/wide',
    });
    const { planId, handle } = await readyRouter(context);
    const answer = await handle(switchBody(planId, 39_000));
    const message = String(answer.body.message);
    const occurrences = message.split('已把 39k 上下文压缩为 8k 交接摘要').length - 1;
    expect(occurrences).toBe(1);
    // The structured form is still there for the UI to render on its own.
    expect((answer.body.compaction as { visible: boolean }).visible).toBe(true);
    expect((answer.body.context as { action: string }).action).toBe('compress');
  });
});
