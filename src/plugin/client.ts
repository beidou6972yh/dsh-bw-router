import type { CostEstimate, StagePlan } from '../core/types.js';
import { formatEstimate, sumEstimates } from '../core/budget.js';
import {
  buildPlanCard,
  renderStatusBar as renderBarFromState,
  type PlanCard,
  type PlanCardRow,
  type RouterState,
} from '../core/card.js';

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
export const ROUTER_BASE = '/router';

/** Minimal fetch shape, injected so tests never touch the network. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

/** What the UI knows at any moment: either data, or a reason there is none. */
export type View<T> =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'error'; message: string; status?: number };

/** Wraps a fetch failure in the one sentence the UI is allowed to invent. */
export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `加载失败：${message || '未知原因'}`;
}

/**
 * One call to the host half. Never throws: a dead endpoint, a 500, or a body
 * that is not JSON all come back as `state: 'error'` with the reason attached,
 * because a UI that throws cannot tell the user anything.
 */
export async function fetchView<T>(
  path: string,
  options: { fetchImpl?: FetchLike; method?: string; body?: unknown } = {},
): Promise<View<T>> {
  const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (!fetchImpl) return { state: 'error', message: '加载失败：当前环境没有 fetch' };

  const method = options.method ?? 'GET';
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers: { accept: 'application/json' },
  };
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  try {
    const response = await fetchImpl(`${ROUTER_BASE}${path}`, init);
    const payload = (await response.json()) as { ok?: boolean; error?: string } & Record<string, unknown>;
    if (!response.ok || payload?.ok === false) {
      // The host's own sentence beats anything we could guess: it knows which
      // gate refused. Nothing is invented here.
      return {
        state: 'error',
        message: `加载失败：${payload?.error ?? `HTTP ${response.status ?? '?'}`}`,
        ...(typeof response.status === 'number' ? { status: response.status } : {}),
      };
    }
    return { state: 'ready', value: payload as T };
  } catch (error) {
    return { state: 'error', message: describeFailure(error) };
  }
}

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
export function requestPlan(
  input: {
    taskId: string;
    summary?: string;
    stageNames: string[];
    estimatedInputTokens?: number;
    usage?: Record<string, number>;
  },
  options: { fetchImpl?: FetchLike } = {},
): Promise<View<PlanPayload>> {
  return fetchView<PlanPayload>('/plan', {
    ...options,
    method: 'POST',
    body: input,
  });
}

/** Confirm-开工. A 400 here means the card was not startable; show why. */
export function confirmPlan(
  planId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<View<{ planId: string; card: PlanCard; state: RouterState }>> {
  return fetchView('/plan/confirm', { ...options, method: 'POST', body: { planId } });
}

/** Status bar data. `state.active === false` => render nothing. */
export function requestState(
  planId?: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<View<{ state: RouterState }>> {
  const query = planId ? `?planId=${encodeURIComponent(planId)}` : '';
  return fetchView(`/state${query}`, options);
}

/**
 * The host-built plan card for the dock.
 *
 * `404 no-plan` is turned into `idle`, not `error`: "there is no plan yet" is
 * the normal state of a fresh session, and rendering it as a failure would put
 * an error banner in every new conversation. Every *other* failure stays an
 * error, because a dock that hides a broken endpoint is worse than one that
 * says so.
 */
export async function requestCard(
  planId?: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<View<{ planId: string; card: PlanCard }>> {
  const query = planId ? `?planId=${encodeURIComponent(planId)}` : '';
  const view = await fetchView<{ planId: string; card: PlanCard }>(`/card${query}`, options);
  if (view.state === 'error' && view.status === 404) return { state: 'idle' };
  return view;
}

/** The model scan ("扫到 N 个模型") for a settings page or a diagnostics line. */
export function requestModels(
  options: { fetchImpl?: FetchLike } = {},
): Promise<View<{ count: number; sources: { runtime: number; config: number }; models: unknown[] }>> {
  return fetchView('/models', options);
}

/**
 * The plan card, rendered from a plan the host built.
 *
 * Kept for hosts that already hold the plan in-process (CLI, tests). The HTTP
 * path returns the card pre-built (`buildPlanCard` on the host), and this
 * function is the same code, so both show the same thing.
 */
export function renderPlanCard(plan: StagePlan): PlanCard {
  return buildPlanCard({ plan });
}

/**
 * The plan card as plain lines, top to bottom, in the order the dock draws them.
 *
 * Text, not JSX: the React component is a thin map over these lines, so the
 * wording can be tested without a DOM — and can't drift between the two halves.
 */
export function planCardLines(card: PlanCard): string[] {
  const lines: string[] = [`执行计划（可改）｜${card.title}`];
  for (const row of card.rows) {
    lines.push(rowLine(row));
  }
  lines.push(card.footer);
  if (card.needsWizard) {
    lines.push('未配置任何模型，请先完成向导');
  } else if (card.blockers.length > 0) {
    // A1: the reason is printed, not just "cannot start". "可开工" on a card
    // whose next switch is refused was the defect; the fix is the same words
    // the switch will say.
    lines.push(`无法开工：${card.blockers.join('；')}`);
  } else if (!card.checked) {
    lines.push('无法开工：本计划没有预检窗口，模型是否吃不下未确认');
  }
  lines.push(card.canStart ? '[确认开工] [取消]' : '[取消]');
  return lines;
}

/** One row: `① 需求文档 → 千问 Qwen ▾  ¥0.3`. */
function rowLine(row: PlanCardRow): string {
  const number = `${row.index}`.padStart(2, ' ');
  const mark = row.optional ? '（可选）' : '';
  const model = row.modelKey ? `${row.modelLabel} ▾` : '未分配';
  return `${number}. ${row.title}${mark} → ${model}   ${row.cost}`;
}

/**
 * Status bar text. `null` when there is nothing honest to say.
 *
 * That null is the contract: the dock checks it and draws nothing, rather than
 * mounting a bar with placeholders.
 */
export function renderStatusBar(state: RouterState | null | undefined): string | null {
  if (!state) return null;
  return renderBarFromState(state);
}

/** The bar plus its one-off notices (a switch that dragged the global default). */
export function statusBarLines(state: RouterState | null | undefined): string[] {
  const bar = renderStatusBar(state);
  if (!bar) return [];
  return [
    bar,
    ...(state?.notices ?? []).map((notice) => `⚠ ${notice}`),
    // 铁律 5, honest-degradation form: when the bar's money is tokens-only, say
    // why. A bar that prints "已花 $0.0000+（3 段无价）" and nothing else leaves
    // the reader to guess whether the host has no prices or the run was free.
    ...(state?.pricing?.notice ? [`⚠ ${state.pricing.notice}`] : []),
  ];
}

/**
 * What a dock view should draw, given a fetch result.
 *
 * `ready` with `active: false` is still "draw nothing": the request succeeded
 * and the honest answer is that no run is in flight.
 */
export function statusBarFor(view: View<{ state: RouterState }>): string[] {
  if (view.state === 'error') return [view.message];
  if (view.state !== 'ready') return [];
  return statusBarLines(view.value.state);
}

/** What a plan-card dock should draw, given a fetch result. */
export function planCardFor(view: View<{ planId: string; card: PlanCard }>): string[] {
  if (view.state === 'error') return [view.message];
  if (view.state !== 'ready') return [];
  return planCardLines(view.value.card);
}

/**
 * Renders a total the **host** already computed (M-6).
 *
 * `totalOf(estimates)` used to add up stage estimates on the client and format
 * the result — a second cost calculation in the half that is not allowed to make
 * decisions, and the one place the "second number that will disagree with the
 * bill" warning in this file's header actually applied. It now only formats a
 * string the host sent: the client cannot arrive at a figure the host did not.
 */
export function totalOf(total: string): string {
  return total;
}
