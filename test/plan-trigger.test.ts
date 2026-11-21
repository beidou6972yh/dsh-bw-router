import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_STAGE_NAMES,
  SLOT_REGISTRATIONS,
  apply,
  createComponents,
  latestPlanView,
  planCardView,
  planRequestFor,
  planStageNames,
  publishPlanView,
  requestPlanForTrigger,
  resetPlanView,
  stageNamesFromText,
  subscribePlanView,
  type ClientSlotsContext,
  type ReactLike,
} from '../src/plugin/client-entry.js';
import { dispatch, ROUTER_PREFIX, type RouterDeps } from '../src/plugin/endpoints.js';
import { PluginHost, RouterSession } from '../src/plugin/index.js';
import type { FetchLike } from '../src/plugin/client.js';
import { allModels } from './fixtures/models.js';

/**
 * Blocker B（灰狼 2026-11-15）：**客户端内能不能直接发起计划**。
 *
 * 报告原文要点："客户端只有计划卡+状态栏，没有『生成计划』按钮；计划必须我方调
 * POST /router/plan 发起。" 于是这个文件回答四个问题，每个都打真实代码：
 *
 *  1. 按钮存在，且按下去真的发 POST /router/plan（不是 mock 客户端，而是把
 *     假 fetch 接到真的 `dispatch` 路由实现上）；
 *  2. 宿主回来的 card 由既有的 `router-plan-card` 槽位渲染（共享 store，不是
 *     两个槽位各拉一份）；点完不会再多一次 GET /card；
 *  3. stageNames 为空 → **200** + 明确提示（不是 500），客户端能把提示打印出来；
 *  4. 失败照样有话说（`加载失败：<宿主原因>`），以及既有两条 dock 注册的
 *     id/order 不回归。
 */

/* ------------------------------------------------------------------ harness */

interface FakeNode {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}

/** Minimal stand-in for the module table's React (no re-render: tests re-call). */
function fakeReact(): ReactLike & { rendered: FakeNode[] } {
  const rendered: FakeNode[] = [];
  const react: ReactLike & { rendered: FakeNode[] } = {
    rendered,
    useState<T>(initial: T): [T, (next: T) => void] {
      return [initial, () => {}];
    },
    // Effects run once, immediately (the real React runs them after mount). The
    // cleanup is dropped, which is fine here: the only side effects are a
    // subscription and a fetch, and every test resets the store.
    useEffect(effect: () => void | (() => void)): void {
      effect();
    },
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) {
      const node: FakeNode = { type, props: props ?? {}, children };
      rendered.push(node);
      return node;
    },
  };
  return react;
}

/** Every string drawn under a node, in render order (the dock's lines). */
function nodeTexts(node: unknown): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') walk((value as FakeNode).children);
  };
  walk(node);
  return out;
}

interface Harness {
  deps: RouterDeps;
  fetchImpl: FetchLike;
  calls: { method: string; path: string; body?: unknown }[];
}

/**
 * A fetch that is a thin wire onto the **real** endpoint router.
 *
 * Mocking the host would let a client with the wrong contract pass; going through
 * `dispatch` means the request body, the status codes and the card are the ones
 * production serves.
 */
function harness(): Harness {
  const host = new PluginHost({ current: () => 'deepseek/flash', select: async () => undefined });
  host.registerModels(allModels, allModels.map((model) => `${model.provider}/${model.model}`));
  const session = new RouterSession(host);
  const deps: RouterDeps = { host, session };
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url, ...(body === undefined ? {} : { body }) });
    const answer = await dispatch(
      { method, path: url, ...(body === undefined ? {} : { body }) },
      deps,
    );
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
  return { deps, fetchImpl, calls };
}

/** Resolves with the next view the dock publishes (click handlers are async). */
function nextPublishedView(): Promise<unknown> {
  return new Promise((resolve) => {
    const unsubscribe = subscribePlanView((view) => {
      if (view !== undefined) {
        unsubscribe();
        resolve(view);
      }
    });
  });
}

function recorder(): {
  ctx: ClientSlotsContext;
  registers: { spec: { name: string; id?: string; order?: number }; component: unknown }[];
} {
  const registers: { spec: { name: string; id?: string; order?: number }; component: unknown }[] = [];
  return {
    registers,
    ctx: {
      slots: {
        inject: (_name, callback) => callback(),
        register: (spec, component) => {
          registers.push({ spec, component });
          return () => {};
        },
      },
    },
  };
}

beforeEach(() => {
  // The store is module-level state by design; each test must start from
  // "nobody asked yet", or one test's plan leaks into the next one's dock.
  resetPlanView();
});

/* ------------------------------------------- 1. the button really POSTs /plan */

describe('生成计划触发: the button is real and calls the real endpoint', () => {
  it('renders exactly one [生成计划] button and nothing else before it is pressed', () => {
    const react = fakeReact();
    const { RouterPlanTrigger } = createComponents(react);
    const node = RouterPlanTrigger({}) as FakeNode;

    expect(node.type).toBe('button');
    expect(node.props['data-dsh-router']).toBe('router-plan-trigger');
    expect(nodeTexts(node)).toEqual(['[生成计划]']);
    expect(typeof node.props.onClick).toBe('function');
    // Nothing else was drawn: no card, no skeleton, no placeholder.
    expect(nodeTexts(react.rendered)).toEqual(['[生成计划]']);
  });

  it('clicking POSTs /router/plan with a client-generated ui-<ts> task id', async () => {
    const { fetchImpl, calls } = harness();
    const { RouterPlanTrigger } = createComponents(fakeReact(), { fetchImpl });
    const node = RouterPlanTrigger({}) as FakeNode;

    const published = nextPublishedView();
    (node.props.onClick as () => void)();
    const view = await published;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/router/plan');
    const body = calls[0]!.body as { taskId: string; stageNames: string[] };
    // taskId is the **client's** (`ui-<timestamp>`), so the host's required-field
    // contract stays as it is and the ledger can tell a click from a CLI call.
    expect(body.taskId).toMatch(/^ui-\d+$/);
    expect(body.stageNames).toEqual([...DEFAULT_STAGE_NAMES]);
    expect(view).toMatchObject({ state: 'ready' });
  });

  it('the answer is rendered by the existing plan-card slot — from the shared store, not a second fetch', async () => {
    const { fetchImpl, calls } = harness();
    const react = fakeReact();
    const { RouterPlanTrigger, RouterPlanCard } = createComponents(react, { fetchImpl });

    const node = RouterPlanTrigger({ stageNames: ['analyze', 'implement', 'write'] }) as FakeNode;
    const published = nextPublishedView();
    (node.props.onClick as () => void)();
    await published;

    const cardNode = RouterPlanCard() as FakeNode;
    const lines = nodeTexts(cardNode);
    expect(lines[0]).toContain('执行计划（可改）');
    // 模型行 + 费用行：both came from the host's card, neither was computed here.
    expect(lines.some((line) => line.includes('▾'))).toBe(true);
    expect(lines.some((line) => line.includes('$'))).toBe(true);
    expect(lines[lines.length - 1]).toBe('[确认开工] [取消]');
    // The card slot did NOT fetch its own copy: one click = one request.
    expect(calls).toHaveLength(1);
    expect(calls.filter((call) => call.path.startsWith('/router/card'))).toEqual([]);
    // …and the store is what it rendered, so the two cannot disagree.
    const store = latestPlanView();
    expect(store?.state).toBe('ready');
    if (store?.state === 'ready') {
      expect(planCardView(store)).toEqual(lines);
      expect(store.value.planId).toMatch(/^plan-ui-\d+-/);
    }
  });

  it('the card slot still falls back to GET /card when nobody pressed the button', async () => {
    const { fetchImpl, calls } = harness();
    const { RouterPlanCard } = createComponents(fakeReact(), { fetchImpl });
    // No plan exists on a fresh host: `requestCard` maps the 404 to `idle`, so
    // the card draws nothing — and it did ask the host, once.
    expect(RouterPlanCard()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.map((call) => call.path)).toEqual(['/router/card']);
    expect(calls[0]!.method).toBe('GET');
  });
});

/* ---------------------------------------- 2. empty stage list is a 200 + words */

describe('空清单: POST /router/plan answers 200 with an explicit notice', () => {
  it('returns 200 (not 500), no rows, and the reason as data', async () => {
    const { deps } = harness();
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 'ui-1', stageNames: [] } },
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.empty).toBe(true);
    expect(res.body.stages).toEqual([]);
    // No plan was created: an empty id beats a fake one that confirm would 404 on.
    expect(res.body.planId).toBe('');
    expect(String(res.body.notice)).toContain('空清单：未提供阶段');
    const card = res.body.card as { rows: unknown[]; canStart: boolean; footer: string };
    expect(card.rows).toEqual([]);
    expect(card.canStart).toBe(false);
    expect(card.footer).toContain('空清单：未提供阶段');
  });

  it('still refuses a body that omits stageNames entirely (that is a typo, not an empty plan)', async () => {
    const { deps } = harness();
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 'ui-1' } },
      deps,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('bad-request');
  });

  it('the client prints the empty-list sentence instead of an error banner', async () => {
    const { fetchImpl, calls } = harness();
    const view = await requestPlanForTrigger(
      { stageNames: [] },
      { fetchImpl, now: 1_700_000_000_000 },
    );
    expect(calls[0]!.body).toMatchObject({ taskId: 'ui-1700000000000', stageNames: [] });
    expect(view.state).toBe('ready');
    if (view.state !== 'ready') throw new Error('expected the empty plan to be a 200');
    expect(view.value.empty).toBe(true);
    expect(view.value.notice).toContain('空清单：未提供阶段');
    const lines = planCardView(view);
    expect(lines).not.toBeNull();
    expect(lines!.join('\n')).toContain('空清单：未提供阶段');
    // An empty plan has nothing to start: no 确认开工 button is offered.
    expect(lines!.join('\n')).not.toContain('确认开工');
  });
});

/* ------------------------------------------------------ 3. failure has a reason */

describe('失败: the host reason reaches the dock', () => {
  it('a non-2xx answer becomes 加载失败：<host sentence>, and the card slot shows it', async () => {
    const failing: FetchLike = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false, code: 'internal', error: 'the host said no' }),
    });
    const { RouterPlanTrigger, RouterPlanCard } = createComponents(fakeReact(), { fetchImpl: failing });

    const node = RouterPlanTrigger({}) as FakeNode;
    const published = nextPublishedView();
    (node.props.onClick as () => void)();
    const view = await published;

    expect(view).toMatchObject({ state: 'error', message: '加载失败：the host said no' });
    const lines = nodeTexts(RouterPlanCard());
    expect(lines).toEqual(['加载失败：the host said no']);
  });

  it('a dead transport (fetch throws) is reported, never swallowed', async () => {
    const dead: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const view = await requestPlanForTrigger({}, { fetchImpl: dead });
    expect(planCardView(view)).toEqual(['加载失败：ECONNREFUSED']);
  });
});

/* ---------------------------------------------- 4. dock registrations, in order */

describe('dock 注册: the trigger is added, the two originals keep their place', () => {
  it('registers trigger(59) + card(60) + bar(61), and 60/61 are unchanged', () => {
    expect(SLOT_REGISTRATIONS.map((slot) => slot.id)).toEqual([
      'router-plan-trigger',
      'router-plan-card',
      'router-status-bar',
    ]);
    expect(SLOT_REGISTRATIONS.map((slot) => slot.order)).toEqual([59, 60, 61]);
    expect(SLOT_REGISTRATIONS.map((slot) => slot.component)).toEqual([
      'RouterPlanTrigger',
      'RouterPlanCard',
      'RouterStatusBar',
    ]);

    const { ctx, registers } = recorder();
    apply(ctx, { react: fakeReact() });
    expect(registers.map((entry) => entry.spec)).toEqual([
      { name: 'conversation.composer.dock', id: 'router-plan-trigger', order: 59 },
      { name: 'conversation.composer.dock', id: 'router-plan-card', order: 60 },
      { name: 'conversation.composer.dock', id: 'router-status-bar', order: 61 },
    ]);
    for (const entry of registers) expect(typeof entry.component).toBe('function');
  });
});

/* ------------------------------------------------ 5. the pure input/store pieces */

describe('plan input: what one click asks the host to plan', () => {
  it('builds the body from the caller, keeping an explicit empty list empty', () => {
    expect(planRequestFor({ stageNames: [] }, 42).stageNames).toEqual([]);
    expect(planRequestFor({ stageNames: ['analyze', 'review'] }, 42)).toMatchObject({
      taskId: 'ui-42',
      stageNames: ['analyze', 'review'],
      estimatedInputTokens: 20_000,
    });
    // A composer draft is enough to plan it: people type "分析 → 实现 → 写文档".
    expect(planStageNames({ text: '分析 → 实现 → 写文档' })).toEqual(['分析', '实现', '写文档']);
    expect(planStageNames({ prompt: 'analyze, implement' })).toEqual(['analyze', 'implement']);
    expect(stageNamesFromText('aa/bb、cc+dd')).toEqual(['aa', 'bb', 'cc', 'dd']);
    // No hint at all: a small default plan beats "nothing to plan".
    expect(planStageNames({})).toEqual([...DEFAULT_STAGE_NAMES]);
  });
});

describe('the shared plan store: one answer, every subscriber', () => {
  it('publishes, notifies, and resets', () => {
    expect(latestPlanView()).toBeUndefined();
    const seen: unknown[] = [];
    const unsubscribe = subscribePlanView((view) => seen.push(view));

    const view = publishPlanView({ state: 'error', message: '加载失败：boom' });
    expect(latestPlanView()).toBe(view);
    expect(seen).toEqual([view]);

    resetPlanView();
    expect(latestPlanView()).toBeUndefined();
    expect(seen).toEqual([view, undefined]);

    unsubscribe();
    resetPlanView();
    expect(seen).toHaveLength(2);
  });
});
