import type { CostEstimate } from './types.js';
/**
 * F6 — the honest half of a cost estimate: the band, the statement, and the
 * correction that comes from real usage.
 *
 * Three facts this file refuses to let the UI blur:
 *  1. an estimate is an **interval**, never a number that looks exact;
 *  2. the band has to be *stated* ("our band means this, measured against X"),
 *     because a ± with no meaning is decoration;
 *  3. once real usage arrives, the next estimate is narrower **and** the last
 *     one is checked against the bill — an estimate that never gets compared to
 *     reality is a guess wearing a suit.
 */
/** One calibrated observation: what we said, what it was. */
export interface CalibrationSample {
    /** Predicted/actual for one dimension. Predicted must be > 0 to be usable. */
    ratio: number;
    /** Stage this sample came from, for the audit trail. */
    stageId?: string;
}
/**
 * Running calibration state for a run.
 *
 * Deliberately small and local: no persistence, no cross-project learning. One
 * run's errors improve the same run's next band — that is the whole promise
 * ("逐步收窄"), and it is checkable by a test instead of a claim.
 */
export interface CalibrationState {
    /** Samples of actual/predicted for token counts. */
    tokenSamples: CalibrationSample[];
    /** Samples of actual/predicted for money, only where both sides are known. */
    costSamples: CalibrationSample[];
    /** How many comparisons ran outside the band the estimate advertised. */
    outOfBand: number;
    /** Stage ids that fell outside their advertised band. */
    outOfBandStages: string[];
}
export declare function emptyCalibration(): CalibrationState;
/** Advertised band before any real usage is known. */
export declare const BASE_UNCERTAINTY = 0.35;
/** Below this the band stops being informative and becomes a boast. */
export declare const FLOOR_UNCERTAINTY = 0.15;
/** Never promise more than this; a huge band is honest, a fake tight one is not. */
export declare const CEILING_UNCERTAINTY = 1;
/**
 * Records one finished stage against its estimate.
 *
 * `actualCost` is the real charge (null when the model has no price — then only
 * tokens are compared, because comparing an unknown amount would be inventing
 * one). Returns the fields the caller books; the state is mutated in place
 * because it belongs to the run, not to the ledger.
 */
export declare function observeStage(state: CalibrationState, params: {
    stageId: string;
    /** Real usage. */
    actualInputTokens: number;
    actualOutputTokens: number;
    actualCost: number | null;
    estimate: CostEstimate;
}): CalibrationState;
/**
 * The band to advertise for the **next** estimate of this run.
 *
 * Before any sample: the base 35%. After: the widest observed error, plus a
 * margin, because one stage is a sample and not a distribution — and never below
 * the floor. It can grow as easily as it shrinks: an estimate that was wrong by
 * 3× this run must not advertise ±15% next stage.
 */
export declare function calibratedUncertainty(state: CalibrationState, base?: number): number;
/** `±35%` for a band. One function, so no two screens print it differently. */
export declare function bandText(uncertainty: number): string;
/** Interval for one amount: `$0.0120 ~ $0.0240` (band on the amount, not on the savings). */
export declare function costInterval(cost: number, uncertainty: number): {
    low: number;
    high: number;
};
/** Interval for a token count: `~18k (11.7k–24.3k)`. */
export declare function tokenInterval(tokens: number, uncertainty: number): {
    low: number;
    high: number;
};
/**
 * The error statement that goes next to every estimate (F6 §1).
 *
 * A number without this is a promise nobody can check. The statement names the
 * **basis** (how many real stages it has been compared against) and what the band
 * covers (token counts, and money when prices are known). It never says "准确".
 */
export declare function errorStatement(state: CalibrationState, uncertainty: number): string;
/** Why an amount is not in the savings figure (F6 §3, the "省 100%" accident). */
export interface SavingsExclusion {
    /** Model keys whose price we do not know. */
    unpriced: string[];
    /** Human sentence: why the savings figure is missing. */
    reason: string;
}
/**
 * Savings must never be computed from an unpriced side.
 *
 * The historic accident: no price configured ⇒ cost rendered `$0.0000` ⇒ "节省
 * 100%". An unknown price is not zero, so it is excluded from the savings sum and
 * named, and the caller prints "未知" instead of a number.
 */
export declare function savingsExclusion(estimates: CostEstimate[]): SavingsExclusion;
//# sourceMappingURL=calibration.d.ts.map