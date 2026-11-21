import { costOf, pricingKnown } from './types.js';
/** Uncertainty we advertise while prices are not calibrated against real usage. */
export const DEFAULT_UNCERTAINTY = 0.35;
/**
 * Estimates one call on one model and its delta versus the baseline model.
 *
 * Unknown prices produce `null` costs and a listed reason — never a zero that
 * would read as "free" and "saved 100%".
 */
export function estimateStage(input) {
    const { model, baseline, inputTokens, outputTokens } = input;
    const unknown = [];
    const cost = costOf(model.pricing, inputTokens, outputTokens);
    if (!pricingKnown(model.pricing))
        unknown.push(model.id);
    let baselineCost = null;
    if (baseline) {
        baselineCost = costOf(baseline.pricing, inputTokens, outputTokens);
        if (!pricingKnown(baseline.pricing))
            unknown.push(baseline.id);
    }
    const estimate = {
        inputTokens,
        outputTokens,
        cost: cost === null ? null : round6(cost),
        baselineCost: baselineCost === null ? null : round6(baselineCost),
        savings: cost === null || baselineCost === null ? null : round6(baselineCost - cost),
        uncertainty: input.uncertainty ?? DEFAULT_UNCERTAINTY,
    };
    if (unknown.length > 0)
        estimate.unknownPricing = [...new Set(unknown)];
    const reason = priceUnknownReason({ model: model.pricing, baseline: baseline?.pricing ?? null });
    if (reason.model)
        estimate.priceUnknownReason = reason.model;
    if (reason.baseline)
        estimate.baselinePriceUnknownReason = reason.baseline;
    return estimate;
}
/**
 * An estimate for a stage that has **no model at all** (empty registry, or no
 * candidate ever passed the gates).
 *
 * It is not an error and not a zero: the token counts are real, the money is
 * unknown, and the reason says so. That is what lets the plan card still tell
 * the user "3 stages, no model, price unknown, finish the wizard" instead of
 * throwing and leaving the UI blank (N-3).
 */
export function estimateWithoutModel(input) {
    return {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cost: null,
        baselineCost: null,
        savings: null,
        uncertainty: input.uncertainty ?? DEFAULT_UNCERTAINTY,
        priceUnknownReason: 'no-model',
        baselinePriceUnknownReason: 'baseline-price',
    };
}
/**
 * Which side of an estimate is unpriced.
 *
 * Kept apart on purpose: "our model has no price" and "your usual model has no
 * price" block different things (the second only hides the savings figure), so
 * one flag cannot describe both.
 */
export function priceUnknownReason(input) {
    const out = {};
    if (input.model === null)
        out.model = 'no-model';
    else if (!pricingKnown(input.model))
        out.model = 'model-price';
    if (input.baseline === null)
        out.baseline = 'baseline-price';
    else if (!pricingKnown(input.baseline))
        out.baseline = 'baseline-price';
    return out;
}
/**
 * Sums estimates. Savings of the parts equals savings of the whole.
 *
 * Any unknown price makes the total unknown: a partial sum silently understates
 * the bill, which is the one direction a cost estimate must never fail in.
 * The band is combined in quadrature (sqrt of summed squares), not taken as the
 * widest part — six ±35% stages are not ±35% together. Stage estimates share
 * the same "how long is this task" assumption, so the combined band is floored
 * at the widest part instead of shrinking below what any single stage claims.
 */
export function sumEstimates(estimates) {
    const total = { inputTokens: 0, outputTokens: 0 };
    let cost = 0;
    let baselineCost = 0;
    let savings = 0;
    let widest = 0;
    let squares = 0;
    const unknown = new Set();
    for (const e of estimates) {
        total.inputTokens += e.inputTokens;
        total.outputTokens += e.outputTokens;
        cost = addOrNull(cost, e.cost);
        baselineCost = addOrNull(baselineCost, e.baselineCost);
        savings = addOrNull(savings, e.savings);
        widest = Math.max(widest, e.uncertainty);
        squares += e.uncertainty * e.uncertainty;
        for (const key of e.unknownPricing ?? [])
            unknown.add(key);
    }
    const combined = Math.max(widest, Math.sqrt(squares));
    const reasons = new Set();
    const baselineReasons = new Set();
    for (const e of estimates) {
        if (e.priceUnknownReason)
            reasons.add(e.priceUnknownReason);
        if (e.baselinePriceUnknownReason)
            baselineReasons.add(e.baselinePriceUnknownReason);
    }
    const result = {
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        cost: cost === null ? null : round6(cost),
        baselineCost: baselineCost === null ? null : round6(baselineCost),
        savings: savings === null ? null : round6(savings),
        uncertainty: round6(estimates.length === 0 ? 0 : Math.min(combined, 1)),
    };
    // Nothing to add up is not "costs nothing": an empty sum must stay unpriced.
    if (estimates.length === 0) {
        result.cost = null;
        result.baselineCost = null;
        result.savings = null;
        result.priceUnknownReason = 'no-model';
    }
    if (unknown.size > 0)
        result.unknownPricing = [...unknown];
    const modelReason = pickReason(reasons);
    const baselineReason = pickReason(baselineReasons);
    if (modelReason)
        result.priceUnknownReason = modelReason;
    if (baselineReason)
        result.baselinePriceUnknownReason = baselineReason;
    return result;
}
/**
 * `no-model` outranks `model-price`: an empty registry is the stronger fact, and
 * the total is only as priced as its least-known stage.
 */
function pickReason(reasons) {
    if (reasons.has('no-model'))
        return 'no-model';
    if (reasons.has('model-price'))
        return 'model-price';
    if (reasons.has('baseline-price'))
        return 'baseline-price';
    return undefined;
}
/** Savings as a 0..1 fraction of the baseline cost. Unknown => null. */
export function savingsRatio(estimate) {
    if (estimate.savings === null || estimate.baselineCost === null)
        return null;
    if (estimate.baselineCost <= 0)
        return 0;
    return estimate.savings / estimate.baselineCost;
}
/** One-line, user-facing money sentence. Never claims more precision than ±. */
export function formatEstimate(estimate) {
    const pct = Math.round(estimate.uncertainty * 100);
    if (estimate.cost === null || estimate.savings === null) {
        return `price unknown${describeUnknownPrice(estimate)}`;
    }
    const ratio = savingsRatio(estimate);
    const saved = Math.round((ratio ?? 0) * 100);
    const sign = estimate.savings >= 0 ? 'save' : 'spend';
    const baseline = estimate.baselineCost === null
        ? 'baseline price unknown'
        : `${sign} ${Math.abs(saved)}% vs baseline`;
    return `~¥${estimate.cost.toFixed(3)} ±${pct}% (${baseline})`;
}
/**
 * The parenthetical after "price unknown". A reason we can name beats a list of
 * ids, and naming no model at all is the honest answer for an empty registry.
 */
export function describeUnknownPrice(estimate) {
    if (estimate.unknownPricing?.length)
        return ` (${estimate.unknownPricing.join(', ')})`;
    if (estimate.priceUnknownReason === 'no-model')
        return ' (no model assigned yet)';
    if (estimate.priceUnknownReason === 'model-price')
        return ' (model has no price)';
    if (estimate.baselinePriceUnknownReason === 'baseline-price')
        return ' (baseline has no price)';
    return '';
}
function addOrNull(a, b) {
    return a === null || b === null ? null : a + b;
}
function round6(n) {
    return Math.round(n * 1e6) / 1e6;
}
/**
 * Savings in words, for the plan card footer and the status bar.
 *
 * Three answers, never mixed: a number with its ± band, "both unknown" when we
 * cannot price either side, and "savings unknown" when only the baseline is
 * unpriced (our cost is known, the comparison is not).
 */
export function describeSavings(estimate) {
    const pct = Math.round(estimate.uncertainty * 100);
    if (estimate.cost === null) {
        // One sentence, one prefix: the money is unknown for a reason we can name,
        // and "savings unknown" next to an amount nobody computed reads as if the
        // cost were known. It is not.
        return `price unknown${describeUnknownPrice(estimate)}`;
    }
    if (estimate.savings === null) {
        return estimate.baselinePriceUnknownReason === 'baseline-price'
            ? 'savings unknown (baseline has no price)'
            : 'savings unknown';
    }
    const ratio = savingsRatio(estimate) ?? 0;
    const signed = Math.round(ratio * 100);
    const verb = signed >= 0 ? 'save' : 'spend';
    return `~¥${estimate.cost.toFixed(3)} ±${pct}% (${verb} ${Math.abs(signed)}% vs baseline)`;
}
/**
 * `¥0.060` — a plain amount with no claim about the future.
 *
 * 261117: 金额口径统一人民币 ¥ + 3 位小数（原 `$0.0600`）。函数名保留 `formatUSD`
 * 以免动到已导出的包 API（dist/index.js 仍导出它），实际输出已是 CNY。
 */
export function formatUSD(amount) {
    return `¥${amount.toFixed(3)}`;
}
//# sourceMappingURL=budget.js.map