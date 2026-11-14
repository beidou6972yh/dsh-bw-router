import type { CapabilityKind, GuardResult, ModelEntry } from './types.js';
export interface GuardInput {
    target: ModelEntry;
    /** Tokens already in the conversation. */
    contextTokens: number;
    /** Tokens the next reply is expected to need. */
    expectedOutputTokens: number;
    /** Capabilities the rest of the task still needs. */
    requiredCapabilities?: CapabilityKind[];
    /** Usable share of the window; default 0.9 to leave headroom. Clamped to (0,1]. */
    headroom?: number;
    /**
     * Spot new money on this model. `true` (default) refuses a model whose price
     * we do not know, because "unknown" must never be rendered as "free".
     */
    requireKnownPricing?: boolean;
}
export declare const DEFAULT_HEADROOM = 0.9;
/**
 * Share of a stage's output budget that one request is expected to emit.
 *
 * A stage is a piece of work, not a single call: "implement" budgets 60% of the
 * task's total output, which is the sum of several replies (edit, run, fix).
 * Feeding that whole budget to the guard as `maxTokens` asked the platform for a
 * 36k reply on a model capped at 8k and got a 409 on stage 2 (A2). One switch =
 * one reply, so the guard gets a per-reply share; `singleShotMaxTokens` caps it
 * at what the model can actually emit in one response.
 */
export declare const SINGLE_SHOT_SHARE = 0.5;
/** Headroom is a fraction of the window. Garbage in must not become a wider gate. */
export declare function clampHeadroom(headroom: number | undefined): number;
/**
 * Decides whether switching to `target` is safe.
 *
 * Never truncates. If it does not fit, the caller gets a blocking result with a
 * number and a message it can show the user (compress / pick another / abort).
 */
export declare function guardSwitch(input: GuardInput): GuardResult;
/**
 * Largest single reply a stage plausibly needs, in tokens.
 *
 * `outputBudget` is the stage's whole output allowance; a single request gets a
 * share of it, never more than `maxOutputTokens` (an unclamped number here is
 * exactly the 409 that killed stage 2 at 60k).
 */
export declare function singleShotMaxTokens(outputBudget: number, target: ModelEntry, share?: number): number;
/** Largest context a model can take for a given expected reply. */
export declare function usableContext(target: ModelEntry, expectedOutputTokens: number, headroom?: number): number;
/**
 * The same number the gate uses, so the UI can never drift from the verdict.
 * Unknown (guessed) limits answer 0: we do not promise space we have not seen.
 */
export declare function displayContext(target: ModelEntry, expectedOutputTokens: number, headroom?: number): number;
//# sourceMappingURL=guard.d.ts.map