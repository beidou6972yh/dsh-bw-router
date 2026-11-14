import { formatEstimate, sumEstimates } from '../core/budget.js';
import { buildPlanCard, renderStatusBar as renderBarFromState, } from '../core/card.js';
/** Endpoint base. Same origin as the host half: no cross-origin hop, no CORS. */
export const ROUTER_BASE = '/router';
/** Wraps a fetch failure in the one sentence the UI is allowed to invent. */
export function describeFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    return `加载失败：${message || '未知原因'}`;
}
/**
 * One call to the host half. Never throws: a dead endpoint, a 500, or a body
 * that is not JSON all come back as `state: 'error'` with the reason attached,
 * because a UI that throws cannot tell the user anything.
 */
export async function fetchView(path, options = {}) {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl)
        return { state: 'error', message: '加载失败：当前环境没有 fetch' };
    const method = options.method ?? 'GET';
    const init = {
        method,
        headers: { accept: 'application/json' },
    };
    if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.body);
    }
    try {
        const response = await fetchImpl(`${ROUTER_BASE}${path}`, init);
        const payload = (await response.json());
        if (!response.ok || payload?.ok === false) {
            // The host's own sentence beats anything we could guess: it knows which
            // gate refused. Nothing is invented here.
            return {
                state: 'error',
                message: `加载失败：${payload?.error ?? `HTTP ${response.status ?? '?'}`}`,
                ...(typeof response.status === 'number' ? { status: response.status } : {}),
            };
        }
        return { state: 'ready', value: payload };
    }
    catch (error) {
        return { state: 'error', message: describeFailure(error) };
    }
}
/** Plan card request: the whole happy path for the composer dock. */
export function requestPlan(input, options = {}) {
    return fetchView('/plan', {
        ...options,
        method: 'POST',
        body: input,
    });
}
/** Confirm-开工. A 400 here means the card was not startable; show why. */
export function confirmPlan(planId, options = {}) {
    return fetchView('/plan/confirm', { ...options, method: 'POST', body: { planId } });
}
/** Status bar data. `state.active === false` => render nothing. */
export function requestState(planId, options = {}) {
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
export async function requestCard(planId, options = {}) {
    const query = planId ? `?planId=${encodeURIComponent(planId)}` : '';
    const view = await fetchView(`/card${query}`, options);
    if (view.state === 'error' && view.status === 404)
        return { state: 'idle' };
    return view;
}
/** The model scan ("扫到 N 个模型") for a settings page or a diagnostics line. */
export function requestModels(options = {}) {
    return fetchView('/models', options);
}
/**
 * The plan card, rendered from a plan the host built.
 *
 * Kept for hosts that already hold the plan in-process (CLI, tests). The HTTP
 * path returns the card pre-built (`buildPlanCard` on the host), and this
 * function is the same code, so both show the same thing.
 */
export function renderPlanCard(plan) {
    return buildPlanCard({ plan });
}
/**
 * The plan card as plain lines, top to bottom, in the order the dock draws them.
 *
 * Text, not JSX: the React component is a thin map over these lines, so the
 * wording can be tested without a DOM — and can't drift between the two halves.
 */
export function planCardLines(card) {
    const lines = [`执行计划（可改）｜${card.title}`];
    for (const row of card.rows) {
        lines.push(rowLine(row));
    }
    lines.push(card.footer);
    if (card.needsWizard) {
        lines.push('未配置任何模型，请先完成向导');
    }
    else if (card.blockers.length > 0) {
        // A1: the reason is printed, not just "cannot start". "可开工" on a card
        // whose next switch is refused was the defect; the fix is the same words
        // the switch will say.
        lines.push(`无法开工：${card.blockers.join('；')}`);
    }
    else if (!card.checked) {
        lines.push('无法开工：本计划没有预检窗口，模型是否吃不下未确认');
    }
    lines.push(card.canStart ? '[确认开工] [取消]' : '[取消]');
    return lines;
}
/** One row: `① 需求文档 → 千问 Qwen ▾  ¥0.3`. */
function rowLine(row) {
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
export function renderStatusBar(state) {
    if (!state)
        return null;
    return renderBarFromState(state);
}
/** The bar plus its one-off notices (a switch that dragged the global default). */
export function statusBarLines(state) {
    const bar = renderStatusBar(state);
    if (!bar)
        return [];
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
export function statusBarFor(view) {
    if (view.state === 'error')
        return [view.message];
    if (view.state !== 'ready')
        return [];
    return statusBarLines(view.value.state);
}
/** What a plan-card dock should draw, given a fetch result. */
export function planCardFor(view) {
    if (view.state === 'error')
        return [view.message];
    if (view.state !== 'ready')
        return [];
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
export function totalOf(total) {
    return total;
}
//# sourceMappingURL=client.js.map