import { describe, expect, it } from 'vitest';
import { dispatch, ROUTER_PREFIX, type RouterDeps } from '../src/plugin/endpoints.js';
import { PluginHost, RouterSession, type ContextCompressor } from '../src/plugin/index.js';
import { DshModelAdapter } from '../src/adapters/dsh-model.js';
import { emptyHandover } from '../src/core/context-guard.js';
import type { ModelEntry } from '../src/core/types.js';
import { makeModel } from './fixtures/models.js';

/**
 * M2 end to end through the real endpoints (acceptance 判据 2/3/4). Nothing here
 * reaches into internals that a UI could not reach: plan → confirm → switch →
 * finish, plus `/router/context` and `/router/reconcile`.
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
  // 50k window: the guard's 0.9 headroom still fits a 39k context + reply, so
  // these tests exercise F5 (which speaks first) rather than the older overflow
  // refusal. F5's thresholds on this window are 25k / 35k / 8k, so 39k lands in
  // the compress band — which is the branch worth testing.
  limits: { contextWindow: 50_000, maxOutputTokens: 8_192, supportsTools: null, supportsImages: false },
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  strength: 0.8,
});

/** A compressor that reports exactly what it was told to report. */
function fixedCompressor(result: {
  tokensAfter: number;
  inputTokens: number;
  outputTokens: number;
  modelKey?: string;
  cost?: number | null;
}): ContextCompressor {
  return {
    compress: ({ handover }) => ({
      tokensAfter: result.tokensAfter,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      modelKey: result.modelKey ?? 'acme/wide',
      ...(result.cost === undefined ? {} : { cost: result.cost }),
      ...(handover ? { handover } : {}),
    }),
  };
}

function rig(models: ModelEntry[], compressor?: ContextCompressor, start = 'acme/narrow') {
  let current = start;
  const selection = new DshModelAdapter(
    {
      selectModel: async (_s: string, provider: string, model: string) => {
        current = `${provider}/${model}`;
      },
      readCurrent: () => current,
    },
    'current',
  );
  const host = new PluginHost(selection, compressor ? { compressor } : {});
  const session = new RouterSession(host);
  host.registerModels(models);
  const deps: RouterDeps = {
    host,
    session,
    ...(compressor ? { compressor } : {}),
  };
  return { host, session, deps, current: () => current, setCurrent: (key: string) => { current = key; } };
}

const plan = async (deps: RouterDeps, taskId: string, stageNames: string[], input: number) =>
  dispatch(
    { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId, stageNames, estimatedInputTokens: input } },
    deps,
  );

const confirm = async (deps: RouterDeps, planId: string) =>
  dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/plan/confirm`, body: { planId } }, deps);

describe('F5 判据 2 (host level): the switch answers with the branch it took', () => {
  it('direct: a small context switches with the whole conversation', async () => {
    const { deps, host } = rig([wide]);
    const planned = await plan(deps, 'c-direct', ['analyze'], 1_000);
    const planId = String(planned.body.planId);
    await confirm(deps, planId);
    const answer = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-1', contextTokens: 20_000 } },
      deps,
    );
    expect(answer.status).toBe(200);
    const state = answer.body.state as { stages: unknown[] };
    expect(state.stages).toHaveLength(1);
    const carry = host.ledger.all().find((e) => e.prefill === true);
    expect(carry?.contextAction).toBe('direct');
    expect(carry?.tokensAfter).toBe(20_000);
    expect(carry?.inputTokens).toBe(20_000);
  });

  it('refuse: no compressor + over-full context refuses, names three options, moves nothing', async () => {
    const { deps, host, current } = rig([narrow]);
    const planned = await plan(deps, 'c-refuse', ['analyze'], 1_000);
    const planId = String(planned.body.planId);
    await confirm(deps, planId);
    const answer = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-1', contextTokens: 39_000 } },
      deps,
    );
    expect(answer.status).toBe(409);
    expect(String(answer.body.message)).toMatch(/refusing to switch instead of truncating/);
    expect(String(answer.body.message)).toMatch(/bigger window/);
    expect(String(answer.body.message)).toMatch(/stay on the current model/);
    expect(String(answer.body.message)).toMatch(/split the task/);
    // Nothing moved and the refusal is in the book.
    expect(current()).toBe('acme/narrow');
    expect(host.ledger.all().some((e) => e.type === 'switch-blocked')).toBe(true);
    expect(host.ledger.all().some((e) => e.type === 'compaction-blocked')).toBe(true);
  });
});

describe('F5 判据 3: compaction is booked with real usage, handover checked, user told', () => {
  it('books a real compaction event with its own tokens and cost', async () => {
    const compressor = fixedCompressor({
      tokensAfter: 5_000,
      inputTokens: 39_000,
      outputTokens: 1_200,
      cost: 0.05,
    });
    // Session starts on `wide`, the plan wants `narrow` (the cheaper/better fit
    // here is `narrow` for a small stage and `wide` for a big one — either way the
    // switch must really move for the context branch to run).
    const { deps, host } = rig([narrow, wide], compressor, 'acme/wide');
    const planned = await plan(deps, 'c-compact', ['analyze'], 1_000);
    const planId = String(planned.body.planId);
    await confirm(deps, planId);
    // A complete handover, so the five-field check passes.
    await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/handover`,
        body: {
          planId,
          stageId: 'stage-1',
          goal: '把 M2 做完',
          done: ['F5 落地'],
          artifacts: ['src/core/context-guard.ts'],
          keyFacts: ['阈值 70/50/16'],
          open: ['压缩模型待定'],
        },
      },
      deps,
    );
    const answer = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-1', contextTokens: 39_000 } },
      deps,
    );
    expect(answer.status).toBe(200);
    const compaction = host.ledger.all().filter((e) => e.type === 'compaction');
    expect(compaction).toHaveLength(1);
    expect(compaction[0]!.inputTokens).toBe(39_000);
    expect(compaction[0]!.outputTokens).toBe(1_200);
    expect(compaction[0]!.cost).toBeCloseTo(0.05, 10);
    expect(compaction[0]!.tokensAfter).toBe(5_000);
    // Real usage lands in the totals, in its own bucket.
    const totals = host.ledger.totals();
    expect(totals.compactionInputTokens).toBe(39_000);
    expect(totals.compactionOutputTokens).toBe(1_200);
    // DEF-2: the bucket holds the compression, and **only** the compression. The
    // prefill the switch itself re-sent has its own bucket; it used to be folded
    // in here, which made "what did compressing cost" unanswerable.
    expect(totals.compactionCost).toBeCloseTo(0.05, 10);
    expect(totals.prefillCost).toBeCloseTo(0.005, 10);
    // Both are real charges and both are in the invoice.
    expect(totals.actualCost).toBeCloseTo(0.055, 10);
    // The user is told, and the notice travels with the switch.
    const message = String(answer.body.message);
    expect(message).toMatch(/已把 39k 上下文压缩为 5k 交接摘要/);
    expect(message).toMatch(/原文可回溯/);
  });

  it('a short handover is flagged, not silently accepted', async () => {
    const compressor = fixedCompressor({ tokensAfter: 5_000, inputTokens: 39_000, outputTokens: 800, cost: 0.04 });
    // Session starts on `wide`, the plan wants `narrow` (the cheaper/better fit
    // here is `narrow` for a small stage and `wide` for a big one — either way the
    // switch must really move for the context branch to run).
    const { deps, host } = rig([narrow, wide], compressor, 'acme/wide');
    const planned = await plan(deps, 'c-red', ['analyze'], 1_000);
    const planId = String(planned.body.planId);
    await confirm(deps, planId);
    // No handover recorded at all: the skeleton has a goal and nothing else.
    const answer = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-1', contextTokens: 39_000 } },
      deps,
    );
    expect(answer.status).toBe(200);
    const compaction = host.ledger.all().find((e) => e.type === 'compaction')!;
    expect(String(compaction.detail)).toMatch(/handover check FAILED/);
    expect(String(answer.body.message)).toMatch(/交接校验未过/);
  });

  it('a compressor that cannot get small enough refuses instead of switching', async () => {
    const compressor = fixedCompressor({ tokensAfter: 38_000, inputTokens: 39_000, outputTokens: 900, cost: 0.03 });
    const { deps, host, current } = rig([narrow, wide], compressor, 'acme/wide');
    const planned = await plan(deps, 'c-fail', ['analyze'], 1_000);
    const planId = String(planned.body.planId);
    await confirm(deps, planId);
    const answer = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-1', contextTokens: 39_000 } },
      deps,
    );
    expect(answer.status).toBe(409);
    expect(String(answer.body.message)).toMatch(/still over/);
    expect(current()).toBe('acme/wide');
    // The money was still spent, so it is still booked.
    expect(host.ledger.totals().compactionInputTokens).toBe(39_000);
  });
});

describe('F6 判据 4: intervals, an honest band, and a reconciliation that can fail', () => {
  it('the plan carries an error statement and an interval per row', async () => {
    const { deps, host } = rig([wide]);
    const planned = await plan(deps, 'f6-band', ['analyze', 'implement'], 20_000);
    const planId = String(planned.body.planId);
    expect(String(planned.body.plan && (planned.body.plan as { summary: string }).summary)).toBe('f6-band');
    const planObj = host.getPlan(planId)!;
    expect(planObj.errorStatement).toMatch(/误差口径/);
    expect(planObj.errorStatement).toMatch(/尚未与真实用量对账/);
    const interval = host.estimateInterval(planId, 'stage-1')!;
    expect(interval.cost!.low).toBeLessThan(interval.cost!.high);
    expect(interval.tokens.input.low).toBeLessThan(interval.tokens.input.high);
    expect(interval.statement).toBe(planObj.errorStatement);
  });

  it('a real stage narrows the band and the reconciliation says "inside"', async () => {
    const { deps, host } = rig([wide]);
    const planned = await plan(deps, 'f6-rec', ['analyze'], 20_000);
    const planId = String(planned.body.planId);
    await confirm(deps, planId);
    const before = host.calibratedBand();
    const estimate = host.getPlan(planId)!.stages[0]!.estimate;

    // Real usage exactly as predicted: the band must shrink, never grow.
    await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/stage/finish`,
        body: {
          planId,
          stageId: 'stage-1',
          inputTokens: estimate.inputTokens,
          outputTokens: estimate.outputTokens,
        },
      },
      deps,
    );
    const after = host.calibratedBand();
    expect(after).toBeLessThan(before);
    expect(host.calibrationState().tokenSamples).toHaveLength(1);
    const reconciled = await dispatch(
      { method: 'GET', path: `${ROUTER_PREFIX}/reconcile?planId=${planId}` },
      deps,
    );
    expect(reconciled.status).toBe(200);
    const report = reconciled.body.reconcile as { ok: boolean; within: number; outside: number };
    expect(report.within).toBe(1);
    expect(report.outside).toBe(0);
    expect(report.ok).toBe(true);
    // The statement now says it has been compared against one real stage.
    expect(host.estimateErrorStatement()).toMatch(/已与 1 段真实用量对账/);
  });

  it('a bill outside the advertised band is reported as outside, not smoothed over', async () => {
    const { deps, host } = rig([wide]);
    const planned = await plan(deps, 'f6-miss', ['analyze'], 20_000);
    const planId = String(planned.body.planId);
    await confirm(deps, planId);
    const estimate = host.getPlan(planId)!.stages[0]!.estimate;
    await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/stage/finish`,
        body: { planId, stageId: 'stage-1', inputTokens: estimate.inputTokens * 6, outputTokens: estimate.outputTokens * 6 },
      },
      deps,
    );
    const report = host.reconcile(planId);
    expect(report.outside).toBe(1);
    expect(report.ok).toBe(false);
    expect(host.calibrationState().outOfBand).toBe(1);
    // And the next card is wider, because one stage is a sample and it was 6× off.
    expect(host.calibratedBand()).toBeGreaterThan(0.35);
  });

  it('an unpriced model never enters the savings figure and says why', async () => {
    const mystery = makeModel({
      provider: 'acme',
      name: 'mystery',
      capabilities: ['reasoning'],
      pricing: { inputPerMTok: null, outputPerMTok: null },
    });
    const { deps, host } = rig([mystery]);
    const planned = await plan(deps, 'f6-unpriced', ['analyze'], 5_000);
    const planId = String(planned.body.planId);
    const exclusion = host.savingsExclusions(planId);
    expect(exclusion.unpriced.length).toBeGreaterThan(0);
    expect(exclusion.reason).toMatch(/无价格/);
    expect(exclusion.reason).toMatch(/未知不等于 0 元/);
    // Nothing was claimed as saved.
    const estimate = host.getPlan(planId)!.stages[0]!.estimate;
    expect(estimate.savings).toBeNull();
    expect(estimate.cost).toBeNull();
  });

  it('the switch prefill is booked as input on the target model (F6 §5)', async () => {
    const { deps, host } = rig([wide, narrow]);
    const planned = await plan(deps, 'f6-prefill', ['analyze', 'implement'], 1_000);
    const planId = String(planned.body.planId);
    await confirm(deps, planId);
    // The session starts on `wide` and the plan wants `narrow` (or the reverse,
    // depending on scoring): either way the first switch really moves, and the
    // prompt it re-sends is the prefill that must be booked.
    const target = host.getPlan(planId)!.stages[0]!.modelKey;
    const answer = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/switch`, body: { planId, stageId: 'stage-1', contextTokens: 10_000 } },
      deps,
    );
    expect(answer.status).toBe(200);
    if (answer.body.alreadyInUse === true) {
      // Nothing moved, so nothing was re-sent — and the book says exactly that.
      expect(host.ledger.totals().prefillInputTokens).toBe(0);
    } else {
      expect(target).not.toBe('acme/narrow');
      expect(host.ledger.totals().prefillInputTokens).toBe(10_000);
    }
  });
});

describe('F5 判据 3: the five elements survive a real handover round trip', () => {
  it('records what it was given and reports the missing fields', async () => {
    const { deps, host } = rig([wide]);
    const planned = await plan(deps, 'handover', ['analyze'], 1_000);
    const planId = String(planned.body.planId);
    const partial = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/handover`,
        body: { planId, stageId: 'stage-1', goal: '目标', done: ['做了'], artifacts: [], keyFacts: [], open: [] },
      },
      deps,
    );
    expect(partial.status).toBe(200);
    expect(partial.body.complete).toBe(false);
    const problems = partial.body.problems as { field: string }[];
    expect(problems.map((p) => p.field)).toEqual(['artifacts', 'keyFacts', 'open']);
    // Stored on the host: the next compression asks for this exact shape.
    expect(host.handoverProblems(planId, 'stage-1').map((p) => p.field)).toEqual(['artifacts', 'keyFacts', 'open']);
    expect(emptyHandover().goal).toBe('');
  });

  it('the dry-run endpoint answers with the same function the switch uses', async () => {
    const { deps, host } = rig([narrow, wide], undefined, 'acme/wide');
    const planned = await plan(deps, 'dry', ['analyze'], 1_000);
    const planId = String(planned.body.planId);
    // 39k on the 50k window: over 70% → compress (or refuse when no compressor is
    // wired — this rig has none, so the dry run must say "refuse" and list the
    // three options, which is exactly what the real switch then does).
    const dry = await dispatch(
      {
        method: 'GET',
        path: `${ROUTER_PREFIX}/context?planId=${planId}&stageId=stage-1&contextTokens=39000&modelKey=acme/narrow`,
      },
      deps,
    );
    expect(host.getPlan(planId)!.stages[0]!.modelKey).toBeTruthy();
    expect(dry.status).toBe(200);
    const decision = dry.body.decision as { action: string; targetTokens: number };
    expect(decision.action).toBe('refuse');
    expect(decision.targetTokens).toBe(Math.floor(50_000 * 0.16));
    expect((dry.body.decision as { options: unknown[] }).options).toHaveLength(3);
    expect(dry.body.thresholds).toMatchObject({ directShare: 0.5, summaryShare: 0.7, refuseShare: 0.16 });
  });
});
