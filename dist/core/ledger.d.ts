import type { ContextAction, CostEstimate, LedgerEntry, LedgerEvent, LedgerTotals } from './types.js';
/**
 * Append-only run ledger. It is the single source of truth for "what did this
 * run cost", and it cannot be rewritten after the fact: every entry is frozen
 * on append, and `all()` hands out frozen copies.
 */
export declare class Ledger {
    private readonly clock;
    private readonly entries;
    private seq;
    private baselineCost;
    private estimatedCost;
    private unpricedStages;
    private compactionCost;
    private compactionInputTokens;
    private compactionOutputTokens;
    private prefillInputTokens;
    private prefillCost;
    constructor(clock?: () => string);
    append(event: LedgerEvent): LedgerEntry;
    /**
     * Records a finished stage with its **actual** usage.
     *
     * `cost` must be the real charge, computed from actual tokens × real prices.
     * The plan's `estimate` is kept for comparison under `costEstimated`, so the
     * book never shows an estimate as if it were the bill.
     */
    recordStageEnd(params: {
        stageId: string;
        modelKey: string;
        inputTokens: number;
        outputTokens: number;
        /** USD actually charged; null when the model's price is unknown. */
        cost: number | null;
        /** Plan-time estimate for the same stage, kept for calibration. */
        estimate?: CostEstimate;
        planId?: string;
    }): LedgerEntry;
    /**
     * A stage ended but its usage never arrived, so **nothing** is booked.
     *
     * Distinct from "ran, price unknown": there we have the tokens and not the
     * price, here we have neither. Booking it silently as 0 would make the run
     * look cheaper than it was, and it would also hide that the host stopped
     * reporting usage (B2).
     */
    recordUnpricedStage(planId: string | undefined, stageId: string, modelKey?: string): LedgerEntry;
    recordSwitch(stageId: string, fromKey: string, toKey: string, planId?: string): LedgerEntry;
    recordBlocked(stageId: string, toKey: string, reason: string, planId?: string): LedgerEntry;
    /**
     * A switch carried its context to the new model (F5). Records which branch was
     * taken and how big the context was, so "did this run truncate anything?" is
     * answerable from the book instead of from memory.
     *
     * The **prefill** of that switch is booked here too: moving the session to
     * another model re-sends the prompt, and the provider bills it. Leaving it out
     * is how a run looks cheaper than the invoice (报告 §8.4). Unpriced models book
     * the tokens with no money — never `$0` (F6 §3).
     */
    recordContextCarry(params: {
        stageId: string;
        modelKey: string;
        action: ContextAction;
        tokensBefore: number;
        tokensAfter: number;
        /** Prompt tokens the switch re-sent; 0 when nothing was re-sent. */
        prefillTokens?: number;
        /** USD for the prefill, from real tokens × real price; null = price unknown. */
        prefillCost?: number | null;
        planId?: string;
    }): LedgerEntry;
    /**
     * The compression step itself, with its **real** token counts (F5 §6).
     *
     * `compaction` had a type and no producer, so "compressing costs money" was a
     * claim the ledger could not confirm. The numbers booked here are the usage the
     * compressor reported — not a share of the stage, not an estimate.
     */
    recordCompaction(params: {
        stageId: string;
        /** Model that did the compressing. */
        modelKey: string;
        inputTokens: number;
        outputTokens: number;
        /** USD actually charged; null when the compressor's model has no price. */
        cost: number | null;
        tokensBefore: number;
        tokensAfter: number;
        /** Model that will take the compressed context. */
        targetModelKey?: string;
        /** True when the five-field check passed; a red compression is visible in the book. */
        handoverOk?: boolean;
        planId?: string;
    }): LedgerEntry;
    /**
     * A compression was needed and could not be run (no compressor wired) — or ran
     * and did not get the context small enough.
     *
     * Booked as its own event so the run can answer "how often were we unable to
     * make room?" without inferring it from a `switch-blocked` message string.
     */
    recordCompactionBlocked(stageId: string, targetModelKey: string, tokensBefore: number, planId?: string): LedgerEntry;
    /** The platform said yes but the session still runs the old model. */
    recordUnverified(stageId: string, expected: string, actual: string, planId?: string): LedgerEntry;
    /**
     * The platform dragged the user's global default model along with the session
     * switch (K-003). Recorded so the run can answer "did we degrade the host?".
     */
    recordGlobalDefaultWriteBack(from: string | undefined, to: string | undefined, planId?: string): LedgerEntry;
    /** A stage ran on a model that is not what the approved plan said. */
    recordDeviation(stageId: string, planned: string, actual: string, planId?: string): LedgerEntry;
    all(): LedgerEntry[];
    forStage(stageId: string): LedgerEntry[];
    forPlan(planId: string): LedgerEntry[];
    /** Stages that ended with no usage at all; their cost is missing, not zero. */
    unbookedStages(): number;
    totals(): LedgerTotals;
    size(): number;
    /** @internal test/user-reset seam only — a real run never calls this. */
    clear(): void;
}
//# sourceMappingURL=ledger.d.ts.map