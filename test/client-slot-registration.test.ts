import { describe, expect, it } from 'vitest';
import {
  SLOT_REGISTRATIONS,
  apply,
  createComponents,
  inject,
  planCardView,
  statusBarView,
  type ClientSlotsContext,
  type ReactLike,
} from '../src/plugin/client-entry.js';
import type { PlanCard, RouterState } from '../src/core/card.js';

/**
 * 灰狼 DEF-3 回归：**客户端半**。
 *
 * 报告原文要点："它的导出写法让加载器直接跳过；而且客户端只有文案函数，没有注册
 * React 组件——现在即使挂上去，也没有内容可以渲染"。
 *
 * The host's client contract (verified in
 * `@org/dsh-client-ui-deepseek-model-label-1017/lib/client.js` and the
 * bundled `cordis-plugin-development` template):
 *
 *   bundle:  window.__ModuleLoader__.load({ id, factory(require) { … } })
 *   module:  exports.inject = ['slots']; exports.apply = apply
 *   apply:   ctx.slots.inject(name, () => ctx.slots.register({ name, id, order }, Component))
 *
 * These tests assert that shape (which the loader reads) and that the mounted
 * components render **nothing** without data — no placeholder, no fake loading.
 */

/** Minimal stand-in for the module table's React. */
function fakeReact(): ReactLike & { rendered: unknown[] } {
  const rendered: unknown[] = [];
  return {
    rendered,
    useState: <T,>(initial: T) => [initial, () => {}],
    useEffect: () => {},
    createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => {
      const node = { type, props, children };
      rendered.push(node);
      return node;
    },
  };
}

function recorder(): {
  ctx: ClientSlotsContext;
  injects: string[];
  registers: { spec: { name: string; id?: string; order?: number }; component: unknown }[];
} {
  const injects: string[] = [];
  const registers: { spec: { name: string; id?: string; order?: number }; component: unknown }[] = [];
  const ctx: ClientSlotsContext = {
    slots: {
      inject(name, callback) {
        injects.push(name);
        return callback();
      },
      register(spec, component) {
        registers.push({ spec, component });
        return () => {};
      },
    },
  };
  return { ctx, injects, registers };
}

const READY_CARD: PlanCard = {
  planId: 'plan-t1-1',
  title: '给需求文档出 PPT',
  rows: [
    {
      stageId: 'stage-1',
      index: 1,
      title: 'analyze',
      optional: false,
      goal: '',
      capability: 'reasoning',
      modelKey: 'deepseek/flash',
      modelLabel: 'DeepSeek Flash',
      reason: 'best reasoning fit',
      cost: '$0.0100',
      estimate: {
        inputTokens: 1,
        outputTokens: 1,
        cost: 0.01,
        baselineCost: 0.02,
        savings: 0.01,
        uncertainty: 0.35,
      },
      alternatives: [],
    },
  ],
  footer: '合计 $0.0100',
  blockers: [],
  canStart: true,
  needsWizard: false,
  checked: true,
  skippable: false,
  baselineModelKey: 'deepseek/flash',
  // A hand-built card must state its pricing stance: the field is required so
  // no surface can show money without saying whether it is a number.
  pricing: { policy: 'auto', mode: 'priced', catalogHasPrices: true, requireKnownPricing: true },
};

const RUNNING_STATE: RouterState = {
  active: true,
  planId: 'plan-t1-1',
  total: 1,
  cursor: 0,
  stages: [
    {
      stageId: 'stage-1',
      index: 1,
      title: 'analyze',
      modelKey: 'deepseek/flash',
      modelLabel: 'DeepSeek Flash',
      status: 'running',
    },
  ],
  sessionModel: 'deepseek/flash',
  sessionModelLabel: 'DeepSeek Flash',
  spent: { actualCost: 0.01, unpricedStages: 0, estimatedCost: 0.01, savings: 0.01 },
  globalDefault: 'deepseek/flash',
  globalDefaultWriteBacks: 0,
  notices: [],
};

describe('DEF-3: the client half has the shape the loader reads', () => {
  it('exports a cordis client plugin: `inject` is the slots service, `apply` registers the trigger + both docks', () => {
    expect(inject).toEqual(['slots']);
    expect(typeof apply).toBe('function');

    // 生成计划触发 (blocker B, 灰狼 2026-11-15) added a third entry *in front*:
    // the button that POSTs /router/plan. The two entries package.json used to
    // *declare* keep their ids AND their orders (60/61) — a host that already
    // renders the card above the bar must not see them move.
    expect(SLOT_REGISTRATIONS.map((slot) => slot.name)).toEqual([
      'conversation.composer.dock',
      'conversation.composer.dock',
      'conversation.composer.dock',
    ]);
    expect(SLOT_REGISTRATIONS.map((slot) => slot.id)).toEqual([
      'router-plan-trigger',
      'router-plan-card',
      'router-status-bar',
    ]);
    expect(SLOT_REGISTRATIONS.map((slot) => slot.order)).toEqual([59, 60, 61]);

    const { ctx, injects, registers } = recorder();
    apply(ctx, { react: fakeReact() });

    expect(injects).toEqual([
      'conversation.composer.dock',
      'conversation.composer.dock',
      'conversation.composer.dock',
    ]);
    expect(registers).toHaveLength(3);
    expect(registers.map((entry) => entry.spec)).toEqual([
      { name: 'conversation.composer.dock', id: 'router-plan-trigger', order: 59 },
      { name: 'conversation.composer.dock', id: 'router-plan-card', order: 60 },
      { name: 'conversation.composer.dock', id: 'router-status-bar', order: 61 },
    ]);
    // A real component goes in, not a string: the loader mounts what it gets.
    for (const entry of registers) expect(typeof entry.component).toBe('function');
  });

  it('registers nothing (and does not throw) when React is not reachable', () => {
    // This is the Node-ESM import path: an activation must never take the web
    // UI's plugin table down because `require('react')` is absent.
    const { ctx, injects } = recorder();
    expect(() => apply(ctx)).not.toThrow();
    expect(injects).toHaveLength(0);
  });

  it('mounts nothing while there is no data — no skeleton, no placeholder', () => {
    const react = fakeReact();
    const { RouterPlanCard, RouterStatusBar } = createComponents(react);
    // The fetch is in flight (the test never resolves it), so the view stays
    // `loading` and the component must draw nothing at all.
    expect(RouterPlanCard()).toBeNull();
    expect(RouterStatusBar()).toBeNull();
    expect(react.rendered).toHaveLength(0);
  });

  it('draws the host-built card/bar once data arrives, and nothing when idle', () => {
    expect(planCardView({ state: 'idle' })).toBeNull();
    expect(planCardView({ state: 'loading' })).toBeNull();
    const card = planCardView({ state: 'ready', value: { planId: 'plan-t1-1', card: READY_CARD } });
    expect(card?.[0]).toContain('执行计划');
    expect(card?.join('\n')).toContain('DeepSeek Flash');
    // Money shown is the host's string, not a client computation.
    expect(card?.join('\n')).toContain('$0.0100');

    expect(statusBarView({ state: 'ready', value: { state: { ...RUNNING_STATE, active: false } } })).toBeNull();
    const bar = statusBarView({ state: 'ready', value: { state: RUNNING_STATE } });
    expect(bar?.join('\n')).toContain('DeepSeek Flash');
    // A failure is information, not an empty shell.
    expect(statusBarView({ state: 'error', message: '加载失败：boom' })).toEqual(['加载失败：boom']);
  });

  it('the built bundle is wrapped in the loader factory the browser executes', async () => {
    // The wrapper is pure string work, so its shape is asserted without running
    // a build (the project keeps build as a gate, not a test step).
    const { wrapClientBundle } = await import(
      new URL('../scripts/client-bundle.mjs', import.meta.url).href
    );
    const script = wrapClientBundle('dsh-bw-router', 'exports.apply = function apply() {};');
    expect(script).toContain('window.__ModuleLoader__.load(');
    expect(script).toContain('id: "dsh-bw-router"');
    expect(script).toContain('factory(require)');
    expect(script).toContain('const module = { exports: {} };');
    expect(script).toContain('return module.exports;');
    // The CJS body is inside the factory, so `exports`/`require` are the host's.
    expect(script).toContain('exports.apply = function apply() {};');
    expect(script.indexOf('window.__ModuleLoader__.load(')).toBeLessThan(script.indexOf('exports.apply'));
  });
});
