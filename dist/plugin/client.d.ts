import type { StagePlan } from '../core/types.js';
import { type PlanCard, type RouterState } from '../core/card.js';
/**
 * Client half (UI).
 *
 * Two jobs, and nothing else:
 *  1. turn **already-built** data into the strings/boxes a UI draws;
 *  2. ask the host over HTTP for that data, and turn a failure into
 *     "加载失败：<原因>" instead of an empty shell.
 *
 * Two rules this file enforces, both learned the hard way:
 *  - the client makes **no decisions and computes no money**. It does import
 *    `core/` for *pure formatting* (`formatEstimate`, `sumEstimates`,
 *    `buildPlanCard`) — one implementation shared by both halves, which is the
 *    single-source-of-truth answer and strictly safer than copying the logic.
 *    What it must never do is run its own cost model (M-6): the local
 *    `totalOf()` re-added and re-formatted an amount the host had already
 *    decided, giving a bill that could disagree with the ledger;
 *  - the client renders **nothing** when it has no data. "Loading…" forever and
 *    a bar showing stage 1 of a task nobody started are the same lie: an empty
 *    shell that looks like state.
 */
export type { PlanCard, PlanCardRow, RouterState } from '../core/card.js';
/** Endpoint base. Same origin as the host half: no cross-origin hop, no CORS. */
export declare const ROUTER_BASE = "/router";
/** Minimal fetch shape, injected so tests never touch the network. */
export type FetchLike = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}) => Promise<{
    ok: boolean;
    status?: number;
    json: () => Promise<unknown>;
}>;
/** What the UI knows at any moment: either data, or a reason there is none. */
export type View<T> = {
    state: 'idle';
} | {
    state: 'loading';
} | {
    state: 'ready';
    value: T;
} | {
    state: 'error';
    message: string;
    status?: number;
};
/** Wraps a fetch failure in the one sentence the UI is allowed to invent. */
export declare function describeFailure(error: unknown): string;
/**
 * One call to the host half. Never throws: a dead endpoint, a 500, or a body
 * that is not JSON all come back as `state: 'error'` with the reason attached,
 * because a UI that throws cannot tell the user anything.
 */
export declare function fetchView<T>(path: string, options?: {
    fetchImpl?: FetchLike;
    method?: string;
    body?: unknown;
}): Promise<View<T>>;
/**
 * What a plan request answers: the host-built card, plus two fields the bare
 * card cannot carry.
 *
 * `notice` is the host's own sentence for a plan that answered 200 but has
 * nothing to start (an empty stage list is the reported case); `empty` is the
 * same fact as data, for a caller that should not match prose. `planId` is `''`
 * when no plan was created — never a made-up id that `confirm` would 404 on.
 */
export interface PlanPayload {
    planId: string;
    card: PlanCard;
    notice?: string;
    empty?: boolean;
}
/** Plan card request: the whole happy path for the composer dock. */
export declare function requestPlan(input: {
    taskId: string;
    summary?: string;
    stageNames: string[];
    estimatedInputTokens?: number;
    usage?: Record<string, number>;
}, options?: {
    fetchImpl?: FetchLike;
}): Promise<View<PlanPayload>>;
/** Confirm-开工. A 400 here means the card was not startable; show why. */
export declare function confirmPlan(planId: string, options?: {
    fetchImpl?: FetchLike;
}): Promise<View<{
    planId: string;
    card: PlanCard;
    state: RouterState;
}>>;
/** Status bar data. `state.active === false` => render nothing. */
export declare function requestState(planId?: string, options?: {
    fetchImpl?: FetchLike;
}): Promise<View<{
    state: RouterState;
}>>;
/**
 * The host-built plan card for the dock.
 *
 * `404 no-plan` is turned into `idle`, not `error`: "there is no plan yet" is
 * the normal state of a fresh session, and rendering it as a failure would put
 * an error banner in every new conversation. Every *other* failure stays an
 * error, because a dock that hides a broken endpoint is worse than one that
 * says so.
 */
export declare function requestCard(planId?: string, options?: {
    fetchImpl?: FetchLike;
}): Promise<View<{
    planId: string;
    card: PlanCard;
}>>;
/** The model scan ("扫到 N 个模型") for a settings page or a diagnostics line. */
export declare function requestModels(options?: {
    fetchImpl?: FetchLike;
}): Promise<View<{
    count: number;
    sources: {
        runtime: number;
        config: number;
    };
    models: unknown[];
}>>;
/**
 * The plan card, rendered from a plan the host built.
 *
 * Kept for hosts that already hold the plan in-process (CLI, tests). The HTTP
 * path returns the card pre-built (`buildPlanCard` on the host), and this
 * function is the same code, so both show the same thing.
 */
export declare function renderPlanCard(plan: StagePlan): PlanCard;
/**
 * The plan card as plain lines, top to bottom, in the order the dock draws them.
 *
 * Text, not JSX: the React component is a thin map over these lines, so the
 * wording can be tested without a DOM — and can't drift between the two halves.
 */
export declare function planCardLines(card: PlanCard): string[];
/**
 * Status bar text. `null` when there is nothing honest to say.
 *
 * That null is the contract: the dock checks it and draws nothing, rather than
 * mounting a bar with placeholders.
 */
export declare function renderStatusBar(state: RouterState | null | undefined): string | null;
/** The bar plus its one-off notices (a switch that dragged the global default). */
export declare function statusBarLines(state: RouterState | null | undefined): string[];
/**
 * What a dock view should draw, given a fetch result.
 *
 * `ready` with `active: false` is still "draw nothing": the request succeeded
 * and the honest answer is that no run is in flight.
 */
export declare function statusBarFor(view: View<{
    state: RouterState;
}>): string[];
/** What a plan-card dock should draw, given a fetch result. */
export declare function planCardFor(view: View<{
    planId: string;
    card: PlanCard;
}>): string[];
/**
 * Renders a total the **host** already computed (M-6).
 *
 * `totalOf(estimates)` used to add up stage estimates on the client and format
 * the result — a second cost calculation in the half that is not allowed to make
 * decisions, and the one place the "second number that will disagree with the
 * bill" warning in this file's header actually applied. It now only formats a
 * string the host sent: the client cannot arrive at a figure the host did not.
 */
export declare function totalOf(total: string): string;
//# sourceMappingURL=client.d.ts.map