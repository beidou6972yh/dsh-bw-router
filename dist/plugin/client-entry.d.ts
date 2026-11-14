import { type FetchLike, type PlanCard, type View } from './client.js';
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
 */
/** One slot entry this plugin registers. Ids/orders come from the product spec. */
export interface SlotRegistration {
    name: string;
    id: string;
    order: number;
    /** Which component mounts there, for tests and diagnostics. */
    component: 'RouterPlanCard' | 'RouterStatusBar';
}
/**
 * The two composer-dock entries (`package.json` declared these before the code
 * could fulfil them): the plan card above the status bar, 60 then 61.
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
/** The host module table's React, or `undefined` when this is not a browser. */
export interface ReactLike {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
    useState<T>(initial: T): [T, (next: T) => void];
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}
/** The components, built against the host's React. Exported for tests. */
export declare function createComponents(react: ReactLike): {
    RouterPlanCard: (props?: Record<string, unknown>) => unknown;
    RouterStatusBar: (props?: Record<string, unknown>) => unknown;
};
/**
 * Client entry the host calls.
 *
 * Registers both components into `conversation.composer.dock`. When React is not
 * reachable (an ESM import outside the browser) the function registers nothing
 * rather than throwing: a client plugin that breaks activation takes the whole
 * web UI's plugin table with it.
 */
export declare function apply(ctx: ClientSlotsContext, options?: {
    react?: ReactLike;
    fetchImpl?: FetchLike;
}): void;
//# sourceMappingURL=client-entry.d.ts.map