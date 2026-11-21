import type { CostEstimate, ModelEntry, PriceUnknownReason } from './types.js';
/** Uncertainty we advertise while prices are not calibrated against real usage. */
export declare const DEFAULT_UNCERTAINTY = 0.35;
/** F6 §1: token interval + cost interval + the sentence that says what they mean. */
export interface EstimateWithInterval {
    estimate: CostEstimate;
    tokens: {
        input: {
            low: number;
            high: number;
        };
        output: {
            low: number;
            high: number;
        };
    };
    /** null when the price is unknown: an interval around a guess would be worse. */
    cost: {
        low: number;
        high: number;
    } | null;
    /** The error statement, already worded; safe to print under the row. */
    statement: string;
}
export interface EstimateInput {
    model: ModelEntry;
    /**
     * The model the user usually runs. `null` when there is no usable baseline at
     * all (empty registry): the estimate is still well-formed, it just cannot
     * claim savings. Passing a made-up baseline instead would print a saving
     * against a model nobody owns.
     */
    baseline: ModelEntry | null;
    inputTokens: number;
    outputTokens: number;
    /** Override the advertised uncertainty (tests, calibrated profiles). */
    uncertainty?: number;
}
/**
 * Estimates one call on one model and its delta versus the baseline model.
 *
 * Unknown prices produce `null` costs and a listed reason — never a zero that
 * would read as "free" and "saved 100%".
 */
export declare function estimateStage(input: EstimateInput): CostEstimate;
/**
 * An estimate for a stage that has **no model at all** (empty registry, or no
 * candidate ever passed the gates).
 *
 * It is not an error and not a zero: the token counts are real, the money is
 * unknown, and the reason says so. That is what lets the plan card still tell
 * the user "3 stages, no model, price unknown, finish the wizard" instead of
 * throwing and leaving the UI blank (N-3).
 */
export declare function estimateWithoutModel(input: {
    inputTokens: number;
    outputTokens: number;
    uncertainty?: number;
}): CostEstimate;
/**
 * Which side of an estimate is unpriced.
 *
 * Kept apart on purpose: "our model has no price" and "your usual model has no
 * price" block different things (the second only hides the savings figure), so
 * one flag cannot describe both.
 */
export declare function priceUnknownReason(input: {
    model: {
        inputPerMTok: number | null;
        outputPerMTok: number | null;
    } | null;
    baseline: {
        inputPerMTok: number | null;
        outputPerMTok: number | null;
    } | null;
}): {
    model?: PriceUnknownReason;
    baseline?: PriceUnknownReason;
};
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
export declare function sumEstimates(estimates: CostEstimate[]): CostEstimate;
/** Savings as a 0..1 fraction of the baseline cost. Unknown => null. */
export declare function savingsRatio(estimate: CostEstimate): number | null;
/** One-line, user-facing money sentence. Never claims more precision than ±. */
export declare function formatEstimate(estimate: CostEstimate): string;
/**
 * The parenthetical after "price unknown". A reason we can name beats a list of
 * ids, and naming no model at all is the honest answer for an empty registry.
 */
export declare function describeUnknownPrice(estimate: CostEstimate): string;
/**
 * Savings in words, for the plan card footer and the status bar.
 *
 * Three answers, never mixed: a number with its ± band, "both unknown" when we
 * cannot price either side, and "savings unknown" when only the baseline is
 * unpriced (our cost is known, the comparison is not).
 */
export declare function describeSavings(estimate: CostEstimate): string;
/** `$0.0600` — a plain amount with no claim about the future. */
export declare function formatUSD(amount: number): string;
//# sourceMappingURL=budget.d.ts.map