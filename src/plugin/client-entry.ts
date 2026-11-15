import {
  planCardLines,
  requestCard,
  requestPlan,
  requestState,
  statusBarLines,
  type FetchLike,
  type PlanCard,
  type PlanPayload,
  type View,
} from './client.js';
import type { RouterState } from '../core/card.js';

/**
 * The **client half** as the DSH web loader consumes it.
 *
 * The external tester's third defect was that this half did not exist in the
 * shape the host loads: `package.json` declared slot names but the module only
 * exported copy functions, so the loader skipped it and nothing mounted even
 * when it was installed. What the host actually wants (verified against
 * `@deepseek-ai/dsh-client-ui-deepseek-model-label-1017/lib/client.js` and the
 * bundled `cordis-plugin-development` template):
 *
 *   // built bundle, served as <pkg>/client
 *   window.__ModuleLoader__.load({ id: '<pkg>', factory(require) { ... return module.exports } })
 *   // module.exports = { inject: ['slots'], apply(ctx) { ctx.slots.inject(...) } }
 *   ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
 *     { name: 'conversation.composer.dock', id, order }, Component));
 *
 * This file is that module **in source form**: `apply` + `inject` are real
 * exports, and `scripts/client-bundle.mjs` wraps the compiled body in the
 * `__ModuleLoader__` factory the browser expects. Keeping the components here
 * (not in a separate package) is what lets them share the host half's
 * formatting functions — one implementation, so the dock and the card cannot
 * disagree about a number.
 *
 * Two rules survive into JSX-less React:
 *  - **no data, no render**: `loading`/`idle` return `null`, never a skeleton
 *    that pretends to be state;
 *  - **no money on the client**: every figure printed here was computed by the
 *    host and arrives inside `card`/`state`; this half only arranges strings.
 *
 * 生成计划触发 (blocker B, 灰狼 2026-11-15): the dock had a card and a status bar
 * but **no way to start a plan** — `requestPlan` existed and nobody called it, so
 * the only way to get a card was to `curl` the endpoint. Three additions, and
 * nothing else:
 *  1. `router-plan-trigger` (order 59): a real `[生成计划]` button that POSTs
 *     `/router/plan` with a client-generated `ui-<timestamp>` task id;
 *  2. a **module-level plan store** (`publishPlanView`/`subscribePlanView`): the
 *     trigger publishes what the host answered, and the existing
 *     `router-plan-card` slot renders exactly that — one answer, one renderer,
 *     so the dock can never show two versions of the same card;
 *  3. …and the card slot only falls back to its own `GET /router/card` when
 *     nobody has published yet, so a click does not cause a second fetch.
 */

/** One slot entry this plugin registers. Ids/orders come from the product spec. */
export interface SlotRegistration {
  name: string;
  id: string;
  order: number;
  /** Which component mounts there, for tests and diagnostics. */
  component: 'RouterPlanCard' | 'RouterStatusBar' | 'RouterPlanTrigger';
}

/**
 * The composer-dock entries: the trigger first (the thing the user presses),
 * then the card it fills (60) and the run's status bar (61).
 *
 * The two original entries keep their ids **and** their orders: a host that
 * already renders them must not see the card jump above/below the bar.
 */
export const SLOT_REGISTRATIONS: readonly SlotRegistration[] = [
  { name: 'conversation.composer.dock', id: 'router-plan-trigger', order: 59, component: 'RouterPlanTrigger' },
  { name: 'conversation.composer.dock', id: 'router-plan-card', order: 60, component: 'RouterPlanCard' },
  { name: 'conversation.composer.dock', id: 'router-status-bar', order: 61, component: 'RouterStatusBar' },
];

/** The cordis services this client plugin needs (`ctx.slots`). */
export const inject = ['slots'];

/** The slice of the client slot service this module calls. */
export interface ClientSlotsContext {
  slots: {
    /** Installs an effect for the slot declaration lifetime; returns a disposer. */
    inject(name: string, callback: () => unknown): unknown;
    register(spec: { name: string; id?: string; order?: number }, component: unknown): unknown;
  };
}

/** What a dock component draws, or `null` for "nothing at all". */
export type DockLines = string[] | null;

/**
 * Plan-card lines from a fetch result.
 *
 * Exported and pure so the wording is testable without a DOM. `null` is the
 * contract: the dock draws nothing while the plan is unknown, rather than a
 * card with no rows (which is what the reported defect looked like).
 */
export function planCardView(view: View<{ planId: string; card: PlanCard }>): DockLines {
  if (view.state === 'error') return [view.message];
  if (view.state !== 'ready') return null;
  const lines = planCardLines(view.value.card);
  return lines.length > 0 ? lines : null;
}

/** Status-bar lines from a fetch result; `null` when there is nothing honest to say. */
export function statusBarView(view: View<{ state: RouterState }>): DockLines {
  if (view.state === 'error') return [view.message];
  if (view.state !== 'ready') return null;
  const lines = statusBarLines(view.value.state);
  return lines.length > 0 ? lines : null;
}

/**
 * What the dock knows about the newest plan.
 *
 * Same four states as every other fetch (`idle`/`loading`/`ready`/`error`) plus
 * the host's `notice`/`empty` for a 200 that created no plan. `undefined` — the
 * store's "nobody asked yet" — is deliberately distinct from `idle` ("the host
 * answered: no plan yet"), because only the first one should trigger the card's
 * own initial `GET /router/card`.
 */
export type PlanView = View<PlanPayload>;

/**
 * The dock's one plan: the trigger writes it, the card slot reads it.
 *
 * Two components in the same dock must not each fetch their own copy — that is
 * how a card and the thing that created it end up disagreeing. A tiny
 * module-level store (this module is one instance per web page) is enough, and
 * it needs no context plumbing through the slot service.
 */
let sharedPlanView: PlanView | undefined;
const planViewListeners = new Set<(view: PlanView | undefined) => void>();

/** The newest plan view this page has seen; `undefined` = nobody asked. */
export function latestPlanView(): PlanView | undefined {
  return sharedPlanView;
}

/** Publishes a plan view to every mounted dock component and returns it. */
export function publishPlanView(view: PlanView): PlanView {
  sharedPlanView = view;
  for (const listener of [...planViewListeners]) listener(view);
  return view;
}

/** Subscribes to plan-view changes. The returned function unsubscribes. */
export function subscribePlanView(listener: (view: PlanView | undefined) => void): () => void {
  planViewListeners.add(listener);
  return () => {
    planViewListeners.delete(listener);
  };
}

/** Forgets the shared plan (plugin dispose, and test isolation). */
export function resetPlanView(): void {
  sharedPlanView = undefined;
  for (const listener of [...planViewListeners]) listener(undefined);
}

/** Stage names a click plans when the caller gave none. */
export const DEFAULT_STAGE_NAMES: readonly string[] = ['analyze', 'implement'];

/** Splits a composer draft into stage names on the separators people type. */
export function stageNamesFromText(text: string): string[] {
  return text
    .split(/\s*(?:→|->|=>|,|，|、|\+|＋|\/)\s*/)
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/** A string list from untyped props; `undefined` when the prop was not a list. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Stage names for one click, most explicit source first.
 *
 * An explicitly empty list stays empty: that is the user (or a host test) really
 * saying "no stages", and the host answers it with a 200 + notice the card can
 * print. Falling back to a default there would hide the case instead of showing
 * it.
 */
export function planStageNames(props?: Record<string, unknown> | null): string[] {
  const source = props ?? {};
  const explicit = stringList(source.stageNames);
  if (explicit) return explicit;
  for (const key of ['text', 'prompt', 'draft'] as const) {
    const value = source[key];
    if (typeof value === 'string') {
      const parsed = stageNamesFromText(value);
      if (parsed.length > 0) return parsed;
    }
  }
  return [...DEFAULT_STAGE_NAMES];
}

/** The POST `/router/plan` body one click sends. Pure, so it is testable. */
export interface PlanRequestInput {
  taskId: string;
  summary: string;
  stageNames: string[];
  estimatedInputTokens: number;
}

/**
 * Builds the request body for the button.
 *
 * The **client** owns the task id (`ui-<timestamp>`): the host requires one but
 * must not have to invent a name for a plan the UI started, and a `ui-` prefix
 * is what lets the ledger tell a click from a CLI call. The host's contract
 * (taskId required, non-empty) is unchanged.
 */
export function planRequestFor(
  props?: Record<string, unknown> | null,
  now: number = Date.now(),
): PlanRequestInput {
  const source = props ?? {};
  const stageNames = planStageNames(source);
  const statedSummary = typeof source.summary === 'string' ? source.summary.trim() : '';
  const statedTokens = source.estimatedInputTokens;
  const inputTokens =
    typeof statedTokens === 'number' && Number.isFinite(statedTokens) && statedTokens > 0
      ? Math.round(statedTokens)
      : 20_000;
  return {
    taskId: `ui-${now}`,
    summary:
      statedSummary ||
      (stageNames.length > 0 ? `UI 生成计划：${stageNames.join(' → ')}` : 'UI 生成计划：空清单'),
    stageNames,
    estimatedInputTokens: inputTokens,
  };
}

/**
 * One click: POST `/router/plan`, publish the answer to the dock, return it.
 *
 * Never throws (`requestPlan` → `fetchView` already maps every failure to
 * `state: 'error'` with the host's sentence), and always publishes — a failure
 * has to reach the card slot too, otherwise the button would appear to do
 * nothing.
 */
export async function requestPlanForTrigger(
  props?: Record<string, unknown> | null,
  options: { fetchImpl?: FetchLike; now?: number } = {},
): Promise<PlanView> {
  const input = planRequestFor(props, options.now ?? Date.now());
  const view = await requestPlan(
    input,
    options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
  );
  return publishPlanView(view);
}

/** The host module table's React, or `undefined` when this is not a browser. */
export interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  useState<T>(initial: T): [T, (next: T) => void];
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}

function reactRuntime(): ReactLike | undefined {
  // `require` is the module-table reader the loader passes into the bundle
  // factory, so it only exists inside the browser bundle. `typeof` keeps an
  // ESM import of this module (unit tests) from throwing at parse time.
  if (typeof require !== 'function') return undefined;
  try {
    return require('react') as ReactLike;
  } catch {
    return undefined;
  }
}

/**
 * Fetch-on-mount, in one place.
 *
 * While the request is in flight the view stays `loading`, and every consumer
 * renders nothing for it — no spinner, no placeholder text. That is deliberate:
 * a skeleton that never resolves is indistinguishable from a stuck plugin.
 */
function useRouterView<T>(
  react: ReactLike,
  load: () => Promise<View<T>>,
): View<T> {
  const [view, setView] = react.useState<View<T>>({ state: 'loading' });
  react.useEffect(() => {
    let live = true;
    void load().then((next) => {
      if (live) setView(next);
    });
    return () => {
      live = false;
    };
    // `load` is a stable module-level function per path; the array keeps React
    // from re-fetching on every render.
  }, []);
  return view;
}

/** The components, built against the host's React. Exported for tests. */
export function createComponents(
  react: ReactLike,
  options: { fetchImpl?: FetchLike } = {},
): {
  RouterPlanCard: (props?: Record<string, unknown>) => unknown;
  RouterStatusBar: (props?: Record<string, unknown>) => unknown;
  RouterPlanTrigger: (props?: Record<string, unknown>) => unknown;
} {
  const fetchOptions = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
  const h = react.createElement;

  const lineList = (id: string, lines: string[]): unknown =>
    h(
      'div',
      {
        'data-dsh-router': id,
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
          fontSize: '12px',
          lineHeight: '18px',
          whiteSpace: 'pre-wrap',
        },
      },
      ...lines.map((line, index) => h('div', { key: `${id}-${index}` }, line)),
    );

  /**
   * The plan card's view: the store's answer if the trigger produced one, else
   * its own mount-time `GET /router/card`.
   *
   * The GET is the page-load path ("the host already holds a plan"), not a second
   * source of truth: as soon as a plan is published the subscription takes over,
   * and a GET that was in flight when the click happened loses to the store
   * (`latestPlanView()` is read again before every write, so a slow initial read
   * cannot overwrite the plan the user just made).
   */
  function usePlanCardView(): PlanView {
    const [view, setView] = react.useState<PlanView>(latestPlanView() ?? { state: 'loading' });
    react.useEffect(() => {
      const unsubscribe = subscribePlanView((next) => setView(next ?? { state: 'loading' }));
      if (latestPlanView() === undefined) {
        let live = true;
        void requestCard(undefined, fetchOptions).then((next) => {
          if (!live) return;
          setView(latestPlanView() ?? next);
        });
        return () => {
          live = false;
          unsubscribe();
        };
      }
      return unsubscribe;
    }, []);
    return view;
  }

  function RouterPlanCard(): unknown {
    const view = usePlanCardView();
    const lines = planCardView(view);
    return lines === null ? null : lineList('router-plan-card', lines);
  }

  function RouterStatusBar(): unknown {
    const view = useRouterView(react, () => requestState());
    const lines = statusBarView(view);
    return lines === null ? null : lineList('router-status-bar', lines);
  }

  /**
   * `[生成计划]` — the missing way to start a plan from inside the client.
   *
   * It draws a button and nothing else: the card it produces is rendered by the
   * `router-plan-card` slot from the shared store (one card, one renderer, no
   * duplicate rows in the dock). Failures reach that slot too, which is what the
   * "加载失败：…" line in `planCardView` prints.
   */
  function RouterPlanTrigger(props?: Record<string, unknown>): unknown {
    const [pending, setPending] = react.useState(false);
    const onClick = (): void => {
      setPending(true);
      void requestPlanForTrigger(props, fetchOptions).finally(() => setPending(false));
    };
    return h(
      'button',
      {
        type: 'button',
        'data-dsh-router': 'router-plan-trigger',
        disabled: pending === true,
        title: '让宿主为当前任务生成执行计划（POST /router/plan）',
        onClick,
        style: {
          alignSelf: 'flex-start',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '18px',
          padding: '2px 8px',
          cursor: pending === true ? 'progress' : 'pointer',
        },
      },
      pending === true ? '生成计划中…' : '[生成计划]',
    );
  }

  return { RouterPlanCard, RouterStatusBar, RouterPlanTrigger };
}

/**
 * Client entry the host calls.
 *
 * Registers the three components into `conversation.composer.dock`. When React
 * is not reachable (an ESM import outside the browser) the function registers
 * nothing rather than throwing: a client plugin that breaks activation takes the
 * whole web UI's plugin table with it.
 */
export function apply(ctx: ClientSlotsContext, options: { react?: ReactLike; fetchImpl?: FetchLike } = {}): void {
  // The bundle gets React from the module table; a test (or an embedded host)
  // injects it, so slot registration is testable without a browser. `fetchImpl`
  // is the same idea for transport: an embedded host can mount the dock without
  // a global `fetch`.
  const react = options.react ?? reactRuntime();
  if (!react || !ctx?.slots) return;
  const components = createComponents(react, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  for (const slot of SLOT_REGISTRATIONS) {
    const component = components[slot.component];
    ctx.slots.inject(slot.name, () =>
      ctx.slots.register({ name: slot.name, id: slot.id, order: slot.order }, component),
    );
  }
}
