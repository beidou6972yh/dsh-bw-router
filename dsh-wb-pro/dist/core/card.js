import { nowIso } from './types.js';
import { describeSavings, formatEstimate, formatUSD, sumEstimates } from './budget.js';
/** The default stance when nobody resolved one: strictly 铁律 5. */
const STRICT_PRICING = {
    policy: 'auto',
    mode: 'strict',
    catalogHasPrices: true,
    requireKnownPricing: true,
};
/** Builds the card. Pure: the same plan always produces the same card. */
export function buildPlanCard(input) {
    const { plan } = input;
    const labels = input.labels ?? {};
    const pricing = input.pricing ?? STRICT_PRICING;
    const rows = plan.stages.map((assignment, index) => {
        const guard = input.guards?.[assignment.stage.id];
        return {
            stageId: assignment.stage.id,
            index: index + 1,
            title: assignment.stage.name,
            optional: assignment.stage.optional,
            goal: assignment.stage.goal,
            capability: assignment.stage.capability,
            modelKey: assignment.modelKey,
            modelLabel: labels[assignment.modelKey] ?? assignment.modelKey,
            reason: assignment.reason,
            cost: formatEstimate(assignment.estimate),
            estimate: assignment.estimate,
            alternatives: input.alternatives?.[assignment.stage.id] ?? [],
            ...(guard ? { guard } : {}),
        };
    });
    const unassigned = plan.unassignedStages ?? [];
    for (const gap of unassigned) {
        const guard = input.guards?.[gap.stageId];
        rows.push({
            stageId: gap.stageId,
            index: rows.length + 1,
            // The stage's own name when the plan still knows it: the reported defect
            // was a card whose unassigned rows were titled `stage-2`, so the user
            // could not tell which piece of work had no model.
            title: gap.name ?? gap.stageId,
            optional: false,
            goal: '',
            capability: gap.capability ?? '',
            modelKey: null,
            modelLabel: '未分配',
            reason: gap.reason,
            cost: 'price unknown',
            estimate: {
                inputTokens: 0,
                outputTokens: 0,
                cost: null,
                baselineCost: null,
                savings: null,
                uncertainty: 0,
                priceUnknownReason: 'no-model',
            },
            // An unassigned row is the row the user must fix, so it needs the same
            // picker an assigned row has; an empty list is why "换模型" did nothing.
            alternatives: input.alternatives?.[gap.stageId] ?? [],
            ...(guard ? { guard } : {}),
        });
    }
    rows.sort((a, b) => a.stageId.localeCompare(b.stageId));
    const total = sumEstimates(plan.stages.map((s) => s.estimate));
    const footerParts = [`合计 ${footerMoney(total)}`];
    const baseline = plan.baselineModelKey
        ? `${labels[plan.baselineModelKey] ?? plan.baselineModelKey}${plan.baselineIsGuess ? ' (guessed)' : ''}`
        : null;
    if (baseline)
        footerParts.push(`baseline ${baseline}`);
    // A stage with no model makes the total a lie: say which number is missing.
    if (unassigned.length > 0)
        footerParts.push(`${unassigned.length} 段未分配模型`);
    // 铁律 5, honest-degradation form: when the money line cannot be a number, the
    // footer says why instead of leaving "price unknown" to be read as "free".
    if (pricing.notice)
        footerParts.push(pricing.notice);
    // Rows the guard already refused. Named by model and reason, because the fix
    // differs: fill in a window, pick another model, or compress the context.
    const refused = rows.filter((row) => row.guard !== undefined && !row.guard.allowed);
    const blockers = [
        ...unassigned.map((gap) => `${gap.stageId}: ${gap.reason}`),
        ...refused.map((row) => `${row.stageId}: ${row.guard.message}`),
    ];
    // A checked row needs a verdict, and a verdict needs the numbers the switch
    // will use. A plan that carries no `guardInputs` was built by someone who
    // never intended to run it, so the card refuses rather than promises (A1).
    const unchecked = plan.stages.some((assignment) => !assignment.guardInputs);
    return {
        planId: plan.planId,
        title: plan.summary,
        rows,
        footer: footerParts.join(' · '),
        blockers,
        canStart: plan.stages.length > 0 &&
            unassigned.length === 0 &&
            refused.length === 0 &&
            !unchecked,
        checked: !unchecked,
        needsWizard: unassigned.some((gap) => gap.reason === 'no-model'),
        skippable: plan.stages.some((s) => s.stage.optional),
        baselineModelKey: plan.baselineModelKey ? plan.baselineModelKey : null,
        pricing,
        ...(pricing.notice ? { pricingNotice: pricing.notice } : {}),
    };
}
/** Wallet line for the status bar: what has actually been booked so far. */
export function formatSpent(actualCost, unpricedStages) {
    if (unpricedStages > 0)
        return `已花 ${formatUSD(actualCost)}+（${unpricedStages} 段无价）`;
    return `已花 ${formatUSD(actualCost)}`;
}
/**
 * Re-issues a card after the user picks another model for one stage.
 *
 * The estimate is recomputed with the **same** token counts and baseline, so
 * "change the model, the number follows" is a property of this function rather
 * than something the UI has to remember to do. An unknown key is refused: the
 * card never shows a model that is not in the capability list.
 */
export function withSwappedModel(card, stageId, swap) {
    const rows = card.rows.map((row) => {
        if (row.stageId !== stageId)
            return row;
        // The old verdict was about the old model: keeping it would let the card
        // show "可开工" for a row nobody re-checked. Dropped, not carried over.
        const { guard: _stale, ...rest } = row;
        return {
            ...rest,
            modelKey: swap.modelKey,
            modelLabel: swap.modelLabel,
            estimate: swap.estimate,
            cost: formatEstimate(swap.estimate),
            switchedAt: row.switchedAt ?? nowIso(),
        };
    });
    const total = sumEstimates(rows.map((r) => r.estimate));
    const footerParts = [`合计 ${footerMoney(total)}`];
    if (card.baselineModelKey)
        footerParts.push(`baseline ${card.baselineModelKey}`);
    if (card.blockers.length > 0)
        footerParts.push(`${card.blockers.length} 段有问题`);
    // The stance does not change because a row was swapped: if the money was
    // unavailable before, it still is, and the re-issued footer must keep saying so.
    if (card.pricing.notice)
        footerParts.push(card.pricing.notice);
    // A swapped row has no verdict any more, so the card may not claim `canStart`
    // until that row is checked again — the host re-checks it on the next card.
    const recheck = rows.every((row) => row.modelKey === null || row.guard !== undefined);
    return {
        ...card,
        rows,
        footer: footerParts.join(' · '),
        canStart: recheck ? card.canStart : false,
    };
}
/**
 * `[路由] 第 2/3 段 · 当前 DeepSeek Flash · 已花 ¥0.006 · 下一段：出图/PPT`
 *
 * The spec's one-line bar. Kept honest where the spec is loose: it says "待开工"
 * before stage 1 rather than pretending a stage is running, and it prints the
 * real booked amount, not the plan-time guess.
 */
export function renderStatusBar(state) {
    // No approved plan => nothing to say. Rendering an empty shell is the defect
    // this function exists to prevent.
    if (!state.active || state.total === 0)
        return null;
    const head = state.cursor >= state.total ? '已完成' : `第 ${Math.min(state.cursor + 1, state.total)}/${state.total} 段`;
    const running = state.current?.status === 'running' ? state.current : undefined;
    const model = running
        ? `${running.modelLabel}`
        : state.sessionModelLabel || state.current?.modelLabel || '—';
    const unbooked = state.unbookedStages?.length ?? 0;
    const money = unbooked > 0
        ? `${formatSpent(state.spent.actualCost, state.spent.unpricedStages)}（${unbooked} 段未记账）`
        : formatSpent(state.spent.actualCost, state.spent.unpricedStages);
    const tail = state.next ? `下一段：${state.next.title}` : '已是最后一段';
    return `[路由] ${head} · 当前 ${model} · ${money} · ${tail}`;
}
/**
 * The money half of the footer.
 *
 * `formatEstimate` and `describeSavings` say the same sentence for a priced
 * total, so printing both repeated it verbatim ("合计 ~$0.13 ±61% (save 81% …
 * · ~$0.13 ±61% (save 81% …") — a reader skims that and trusts the number less.
 * One of the two is enough: the priced one, or the reason it is not priced.
 *
 * （上面那行引用的是 261117 之前的历史渲染：旧版用 `$` + 4 位小数；
 * 现口径为 `¥` + 3 位小数，重复问题与符号无关，故保留原样作历史说明。）
 */
function footerMoney(total) {
    // Same function for both cases: the priced branch answers with the amount and
    // the band, the unpriced branch with the reason. The duplication came from
    // calling two formatters that agree, not from the wording.
    return describeSavings(total);
}
//# sourceMappingURL=card.js.map