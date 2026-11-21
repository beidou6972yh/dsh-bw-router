import { type FetchLike, type PlanCard, type PlanPayload, type View } from './client.js';
import type { RouterState } from '../core/card.js';
/**
 * The **client half** as the DSH web loader consumes it.
 *
 * The external tester's third defect was that this half did not exist in the
 * shape the host loads: `package.json` declared slot names but the module only
 * exported copy functions, so the loader skipped it and nothing mounted even
 * when it was installed. What the host actually wants (verified against
 * `@org/dsh-client-ui-deepseek-model-label-1017/lib/client.js` and the
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
export declare const SLOT_REGISTRATIONS: readonly SlotRegistration[];
/** The cordis services this client plugin needs (`ctx.slots`). */
export declare const inject: string[];
/** The slice of the client slot service this module calls. */
export interface ClientSlotsContext {
    slots: {
        /** Installs an effect for the slot declaration lifetime; returns a disposer. */
        inject(name: string, callback: () => unknown): unknown;
        register(spec: {
            name: string;
            id?: string;
            order?: number;
        }, component: unknown): unknown;
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
export declare function planCardView(view: View<{
    planId: string;
    card: PlanCard;
}>): DockLines;
/** Status-bar lines from a fetch result; `null` when there is nothing honest to say. */
export declare function statusBarView(view: View<{
    state: RouterState;
}>): DockLines;
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
/** The newest plan view this page has seen; `undefined` = nobody asked. */
export declare function latestPlanView(): PlanView | undefined;
/** Publishes a plan view to every mounted dock component and returns it. */
export declare function publishPlanView(view: PlanView): PlanView;
/** Subscribes to plan-view changes. The returned function unsubscribes. */
export declare function subscribePlanView(listener: (view: PlanView | undefined) => void): () => void;
/** Forgets the shared plan (plugin dispose, and test isolation). */
export declare function resetPlanView(): void;
/** Stage names a click plans when the caller gave none. */
export declare const DEFAULT_STAGE_NAMES: readonly string[];
/** Splits a composer draft into stage names on the separators people type. */
export declare function stageNamesFromText(text: string): string[];
/**
 * Stage names for one click, most explicit source first.
 *
 * An explicitly empty list stays empty: that is the user (or a host test) really
 * saying "no stages", and the host answers it with a 200 + notice the card can
 * print. Falling back to a default there would hide the case instead of showing
 * it.
 */
export declare function planStageNames(props?: Record<string, unknown> | null): string[];
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
export declare function planRequestFor(props?: Record<string, unknown> | null, now?: number): PlanRequestInput;
/**
 * One click: POST `/router/plan`, publish the answer to the dock, return it.
 *
 * Never throws (`requestPlan` → `fetchView` already maps every failure to
 * `state: 'error'` with the host's sentence), and always publishes — a failure
 * has to reach the card slot too, otherwise the button would appear to do
 * nothing.
 */
export declare function requestPlanForTrigger(props?: Record<string, unknown> | null, options?: {
    fetchImpl?: FetchLike;
    now?: number;
}): Promise<PlanView>;
/** The host module table's React, or `undefined` when this is not a browser. */
export interface ReactLike {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
    useState<T>(initial: T): [T, (next: T) => void];
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}
/** The components, built against the host's React. Exported for tests. */
export declare function createComponents(react: ReactLike, options?: {
    fetchImpl?: FetchLike;
}): {
    RouterPlanCard: (props?: Record<string, unknown>) => unknown;
    RouterStatusBar: (props?: Record<string, unknown>) => unknown;
    RouterPlanTrigger: (props?: Record<string, unknown>) => unknown;
};
/**
 * Client entry the host calls.
 *
 * Registers the three components into `conversation.composer.dock`. When React
 * is not reachable (an ESM import outside the browser) the function registers
 * nothing rather than throwing: a client plugin that breaks activation takes the
 * whole web UI's plugin table with it.
 */
export declare function apply(ctx: ClientSlotsContext, options?: {
    react?: ReactLike;
    fetchImpl?: FetchLike;
}): void;
//# sourceMappingURL=client-entry.d.ts.map