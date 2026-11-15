import { describe, expect, it } from 'vitest';
import { formatEstimate } from '../src/core/budget.js';
import {
  confirmPlan,
  describeFailure,
  fetchView,
  planCardFor,
  planCardLines,
  renderPlanCard,
  requestPlan,
  requestState,
  statusBarFor,
  statusBarLines,
  totalOf,
  type FetchLike,
} from '../src/plugin/client.js';
import { PluginHost, RouterSession } from '../src/plugin/index.js';
import { dispatch, ROUTER_PREFIX, type RouterDeps } from '../src/plugin/endpoints.js';
import type { RouterState } from '../src/core/card.js';
import { estimateStage } from '../src/core/budget.js';
import { bigBrain, coder, allModels, makeModel } from './fixtures/models.js';

/**
 * P0-2: the client half.
 *
 * Two things are being tested, and they are different:
 *  - the wording/boxing of the card and the bar (pure functions);
 *  - what the dock does when the host cannot answer — never an empty shell.
 *
 * The fetch here is the host's own `dispatch`, wrapped: the client is exercised
 * against real JSON from the real endpoints, because a mock would happily agree
 * with a client that has the contract wrong.
 */

function hostFetch(deps: RouterDeps, overrides: { fail?: string; status?: number } = {}): FetchLike {
  return async (url, init) => {
    if (overrides.fail) throw new Error(overrides.fail);
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    const answer = await dispatch(
      { method: init?.method ?? 'GET', path: url, ...(body === undefined ? {} : { body }) },
      deps,
    );
    return {
      ok: overrides.status ? false : answer.status < 400,
      status: overrides.status ?? answer.status,
      json: async () =>
        overrides.status
          ? { ok: false, error: 'the host said no' }
          : answer.body,
    };
  };
}

function harness() {
  const host = new PluginHost({
    current: () => 'deepseek/flash',
    select: async () => undefined,
  });
  host.registerModels(allModels, allModels.map((m) => `${m.provider}/${m.model}`));
  const session = new RouterSession(host);
  return { host, session, deps: { host, session } as RouterDeps };
}

describe('plan card wording', () => {
  it('draws one line per stage plus totals and the two buttons', async () => {
    const { deps } = harness();
    const view = await requestPlan(
      { taskId: 't1', summary: '做程序开发 ＋ 汇报 PPT', stageNames: ['analyze', 'implement', 'write'], estimatedInputTokens: 60_000 },
      { fetchImpl: hostFetch(deps) },
    );
    const lines = planCardFor(view);
    expect(lines[0]).toContain('执行计划（可改）');
    expect(lines.filter((l) => l.startsWith(' 1.') || l.startsWith(' 2.') || l.startsWith(' 3.'))).toHaveLength(3);
    expect(lines.some((l) => l.includes('▾'))).toBe(true);
    expect(lines.some((l) => l.startsWith('合计'))).toBe(true);
    expect(lines[lines.length - 1]).toBe('[确认开工] [取消]');
  });

  it('shows every same-capability model as a picker option', async () => {
    const { deps } = harness();
    const view = await requestPlan(
      { taskId: 't1', stageNames: ['implement'], estimatedInputTokens: 20_000 },
      { fetchImpl: hostFetch(deps) },
    );
    if (view.state !== 'ready') throw new Error('expected a card');
    const row = view.value.card.rows[0]!;
    // `implement` is coding: both the strong model and the local coder qualify.
    expect(row.alternatives.map((a) => a.key).sort()).toEqual(['deepseek/reasoner', 'local/qwen-coder']);
  });

  it('says "未配置任何模型，请先完成向导" and hides 确认开工 when the list is empty', async () => {
    const empty = new PluginHost({ current: () => '', select: async () => undefined });
    const deps: RouterDeps = { host: empty, session: new RouterSession(empty) };
    const view = await requestPlan(
      { taskId: 't1', stageNames: ['implement'], estimatedInputTokens: 1_000 },
      { fetchImpl: hostFetch(deps) },
    );
    const lines = planCardFor(view);
    expect(lines).toContain('未配置任何模型，请先完成向导');
    expect(lines[lines.length - 1]).toBe('[取消]');
    // And it still shows the stages: a blank card would be less useful, not safer.
    expect(lines.some((l) => l.includes('未分配'))).toBe(true);
    expect(lines.some((l) => l.includes('price unknown'))).toBe(true);
  });

  it('recomputes the row and the total when a stage model is swapped', async () => {
    const { deps } = harness();
    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 't1', stageNames: ['implement'], estimatedInputTokens: 20_000 } },
      deps,
    );
    const swap = await dispatch(
      {
        method: 'POST',
        path: `${ROUTER_PREFIX}/plan/swap`,
        body: { planId: planned.body.planId, stageId: 'stage-1', modelKey: 'local/qwen-coder' },
      },
      deps,
    );
    expect(swap.status).toBe(200);
    const before = (planned.body.card as { footer: string }).footer;
    const after = (swap.body.card as { footer: string; rows: { cost: string }[] }).footer;
    expect(after).not.toBe(before);
    expect((swap.body.card as { rows: { cost: string }[] }).rows[0]!.cost).toContain('save 100%');
  });
});

describe('status bar wording', () => {
  const state = (over: Partial<RouterState> = {}): RouterState => ({
    active: true,
    planId: 'plan-t1-1',
    total: 3,
    cursor: 1,
    stages: [],
    current: {
      stageId: 'stage-2',
      index: 2,
      title: 'implement',
      modelKey: 'deepseek/reasoner',
      modelLabel: 'DeepSeek Reasoner',
      status: 'running',
    },
    next: { stageId: 'stage-3', title: 'write', modelKey: 'deepseek/reasoner', modelLabel: 'DeepSeek Reasoner' },
    sessionModel: 'deepseek/reasoner',
    sessionModelLabel: 'DeepSeek Reasoner',
    spent: { actualCost: 0.6, unpricedStages: 0, estimatedCost: 0.9, savings: 1.2 },
    globalDefault: 'deepseek/flash',
    globalDefaultWriteBacks: 0,
    notices: [],
    ...over,
  });

  it('prints the spec line: 第 N/M 段 · 当前 · 已花 · 下一段', () => {
    expect(statusBarLines(state())).toEqual([
      '[路由] 第 2/3 段 · 当前 DeepSeek Reasoner · 已花 $0.6000 · 下一段：write',
    ]);
  });

  it('renders nothing before a plan is approved', () => {
    expect(statusBarLines(state({ active: false, total: 0, current: undefined }))).toEqual([]);
    expect(statusBarLines(null)).toEqual([]);
  });

  it('marks the last stage instead of promising a next one', () => {
    const last = statusBarLines(state({ cursor: 2, next: undefined }))[0]!;
    expect(last).toContain('第 3/3 段');
    expect(last).toContain('已是最后一段');
    // Past the end = done. Calling a finished run "第 4/3 段" is how a UI lies.
    const done = statusBarLines(state({ cursor: 3, next: undefined, current: undefined }))[0]!;
    expect(done).toContain('已完成');
  });

  it('never prints 已花 as a bare number when a stage had no price', () => {
    const line = statusBarLines(state({ spent: { actualCost: 0.1, unpricedStages: 2, estimatedCost: 1, savings: null } }))[0]!;
    expect(line).toContain('已花 $0.1000+（2 段无价）');
  });

  it('adds the global-default warning as a second line, never mixed into the bar', () => {
    const lines = statusBarLines(
      state({ notices: ['global default deepseek/flash -> deepseek/reasoner'] }),
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]!.startsWith('⚠ ')).toBe(true);
    expect(lines[0]).not.toContain('global default');
  });
});

describe('fetching: no data means no shell', () => {
  it('turns a dead endpoint into 加载失败：原因', async () => {
    const view = await requestState(undefined, { fetchImpl: hostFetch({} as RouterDeps, { fail: 'ECONNREFUSED' }) });
    expect(view.state).toBe('error');
    expect(statusBarFor(view)).toEqual(['加载失败：ECONNREFUSED']);
  });

  it('turns a non-2xx into 加载失败, carrying the host sentence', async () => {
    const { deps } = harness();
    const view = await confirmPlan('plan-ghost', { fetchImpl: hostFetch(deps, { status: 500 }) });
    expect(view.state).toBe('error');
    if (view.state === 'error') expect(view.message).toBe('加载失败：the host said no');
  });

  it('draws nothing while loading, and nothing when the host says nothing runs', async () => {
    const { deps } = harness();
    // No approved plan: the request succeeds and the honest answer is silence.
    const view = await requestState(undefined, { fetchImpl: hostFetch(deps) });
    expect(statusBarFor(view)).toEqual([]);
    expect(statusBarFor({ state: 'loading' })).toEqual([]);
    expect(planCardFor({ state: 'loading' })).toEqual([]);
  });

  it('reports a missing fetch implementation instead of throwing', async () => {
    const view = await fetchView('/state', { fetchImpl: undefined });
    // Node 20+ has fetch, so this either works or reports the reason; it must not throw.
    expect(['ready', 'error']).toContain(view.state);
  });

  it('the plan view carries the planId the confirm button needs', async () => {
    const { deps } = harness();
    const view = await requestPlan(
      { taskId: 't9', stageNames: ['implement'], estimatedInputTokens: 5_000 },
      { fetchImpl: hostFetch(deps) },
    );
    if (view.state !== 'ready') throw new Error('expected a card');
    expect(view.value.planId).toMatch(/^plan-t9-/);
    const confirmed = await confirmPlan(view.value.planId, { fetchImpl: hostFetch(deps) });
    expect(confirmed.state).toBe('ready');
  });
});

describe('renderPlanCard stays usable in-process (CLI / tests)', () => {
  it('builds the same rows as the HTTP card', async () => {
    const { host, deps } = harness();
    const plan = host.plan({ taskId: 't1', summary: 'x', stageNames: ['implement'], estimatedInputTokens: 20_000 });
    const local = renderPlanCard(plan);
    const http = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 't1', summary: 'x', stageNames: ['implement'], estimatedInputTokens: 20_000 } },
      deps,
    );
    const remote = (http.body.card as { rows: { stageId: string; cost: string }[] }).rows;
    // Same ids and same money. The in-process card has no registry, so it has
    // no alternatives list — that is the documented difference, not a number.
    expect(local.rows.map((r) => ({ stageId: r.stageId, cost: r.cost }))).toEqual(
      remote.map((r) => ({ stageId: r.stageId, cost: r.cost })),
    );
  });

  it('totalOf only formats what the host computed, it never adds up money itself (M-6)', () => {
    const estimate = estimateStage({ model: coder, baseline: bigBrain, inputTokens: 1_000, outputTokens: 1_000 });
    const hostTotal = formatEstimate(estimate);
    // Same text in, same text out: the client cannot arrive at a figure the host
    // did not send. Passing the raw estimates (the old signature) is what used to
    // let the UI produce its own bill.
    expect(totalOf(hostTotal)).toBe(hostTotal);
    expect(totalOf(hostTotal)).toContain('±35%');
  });

  it('describeFailure always starts with the same prefix', () => {
    expect(describeFailure(new Error('boom'))).toBe('加载失败：boom');
    expect(describeFailure('')).toBe('加载失败：未知原因');
  });
});

describe('plan card with unpriced models', () => {
  it('says price unknown on the row and in the footer, and claims no saving', () => {
    const host = new PluginHost({ current: () => '', select: async () => undefined });
    host.registerModels([makeModel({ provider: 'cloud', name: 'mystery', capabilities: ['coding'], pricing: { inputPerMTok: null, outputPerMTok: null } })]);
    const plan = host.plan({ taskId: 't1', summary: 'x', stageNames: ['implement'], estimatedInputTokens: 10_000 });
    const lines = planCardLines(renderPlanCard(plan));
    expect(lines.some((l) => l.includes('price unknown'))).toBe(true);
    expect(lines.join('\n')).not.toContain('save 100%');
  });
});
