import { nowIso } from './types.js';
/**
 * Append-only run ledger. It is the single source of truth for "what did this
 * run cost", and it cannot be rewritten after the fact: every entry is frozen
 * on append, and `all()` hands out frozen copies.
 */
export class Ledger {
    clock;
    entries = [];
    seq = 0;
    baselineCost = 0;
    estimatedCost = 0;
    unpricedStages = 0;
    compactionCost = 0;
    compactionInputTokens = 0;
    compactionOutputTokens = 0;
    prefillInputTokens = 0;
    prefillCost = 0;
    constructor(clock = nowIso) {
        this.clock = clock;
    }
    append(event) {
        const entry = Object.freeze({
            ...event,
            at: event.at ?? this.clock(),
            seq: ++this.seq,
        });
        this.entries.push(entry);
        return entry;
    }
    /**
     * Records a finished stage with its **actual** usage.
     *
     * `cost` must be the real charge, computed from actual tokens × real prices.
     * The plan's `estimate` is kept for comparison under `costEstimated`, so the
     * book never shows an estimate as if it were the bill.
     */
    recordStageEnd(params) {
        const priced = params.cost !== null;
        const entry = this.append({
            type: 'stage-end',
            ...(params.planId === undefined ? {} : { planId: params.planId }),
            stageId: params.stageId,
            modelKey: params.modelKey,
            inputTokens: params.inputTokens,
            outputTokens: params.outputTokens,
            ...(priced ? { cost: params.cost } : {}),
            ...(priced ? {} : { costEstimated: false }),
            ...(params.estimate
                ? {
                    detail: `estimated ¥${fmt(params.estimate.cost)} (actual ¥${fmt(params.cost)}), ` +
                        `baseline ¥${fmt(params.estimate.baselineCost)}`,
                }
                : {}),
        });
        if (!priced)
            this.unpricedStages++;
        if (params.estimate) {
            this.estimatedCost += params.estimate.cost ?? 0;
            this.baselineCost =
                this.baselineCost === null || params.estimate.baselineCost === null
                    ? null
                    : this.baselineCost + params.estimate.baselineCost;
        }
        return entry;
    }
    /**
     * A stage ended but its usage never arrived, so **nothing** is booked.
     *
     * Distinct from "ran, price unknown": there we have the tokens and not the
     * price, here we have neither. Booking it silently as 0 would make the run
     * look cheaper than it was, and it would also hide that the host stopped
     * reporting usage (B2).
     */
    recordUnpricedStage(planId, stageId, modelKey) {
        return this.append({
            type: 'stage-end',
            ...(planId === undefined ? {} : { planId }),
            stageId,
            ...(modelKey === undefined ? {} : { modelKey }),
            detail: 'finished without token counts: usage unknown, nothing booked',
        });
    }
    recordSwitch(stageId, fromKey, toKey, planId) {
        return this.append({
            type: 'model-switch',
            ...(planId === undefined ? {} : { planId }),
            stageId,
            modelKey: toKey,
            detail: `${fromKey} -> ${toKey}`,
        });
    }
    recordBlocked(stageId, toKey, reason, planId) {
        return this.append({
            type: 'switch-blocked',
            ...(planId === undefined ? {} : { planId }),
            stageId,
            modelKey: toKey,
            detail: reason,
        });
    }
    /**
     * A switch carried its context to the new model (F5). Records which branch was
     * taken and how big the context was, so "did this run truncate anything?" is
     * answerable from the book instead of from memory.
     *
     * The **prefill** of that switch is booked here too: moving the session to
     * another model re-sends the prompt, and the provider bills it. Leaving it out
     * is how a run looks cheaper than the invoice (报告 §8.4). Unpriced models book
     * the tokens with no money — never `¥0` (F6 §3).
     */
    recordContextCarry(params) {
        const prefillTokens = Math.max(0, Math.floor(params.prefillTokens ?? 0));
        const priced = typeof params.prefillCost === 'number';
        if (prefillTokens > 0)
            this.prefillInputTokens += prefillTokens;
        // DEF-2: the prefill is billed (it lands in `actualCost`) but it is **not**
        // compression. Keeping it in `compactionCost` made that bucket answer "how
        // much did context protection cost" with a number that grew even when no
        // compression ran at all. It has its own bucket now.
        if (priced && prefillTokens > 0)
            this.prefillCost += params.prefillCost;
        return this.append({
            // `stage-start` on purpose: this event is the context ride, and it carries
            // the prefill cost. Booking it as `model-switch` would count one switch
            // twice (the move and its carry) and inflate `totals().switches`.
            type: 'stage-start',
            ...(params.planId === undefined ? {} : { planId: params.planId }),
            stageId: params.stageId,
            modelKey: params.modelKey,
            contextAction: params.action,
            tokensBefore: params.tokensBefore,
            tokensAfter: params.tokensAfter,
            ...(prefillTokens > 0
                ? {
                    inputTokens: prefillTokens,
                    ...(priced ? { cost: params.prefillCost } : {}),
                    prefill: true,
                }
                : {}),
            detail: `${params.action}: context ${params.tokensBefore} -> ${params.tokensAfter}` +
                (prefillTokens > 0
                    ? `, prefill ${prefillTokens} in (${priced ? '¥' + fmt(params.prefillCost) : 'price unknown'})`
                    : ''),
        });
    }
    /**
     * The compression step itself, with its **real** token counts (F5 §6).
     *
     * `compaction` had a type and no producer, so "compressing costs money" was a
     * claim the ledger could not confirm. The numbers booked here are the usage the
     * compressor reported — not a share of the stage, not an estimate.
     */
    recordCompaction(params) {
        const inputTokens = Math.max(0, Math.floor(params.inputTokens));
        const outputTokens = Math.max(0, Math.floor(params.outputTokens));
        const priced = typeof params.cost === 'number';
        this.compactionInputTokens += inputTokens;
        this.compactionOutputTokens += outputTokens;
        if (priced) {
            this.compactionCost += params.cost;
        }
        // Unpriced compression books its tokens with no money — never ¥0 as a claim.
        // The event itself carries no `cost`, so `totals().actualCost` misses nothing
        // that was known, and `compactionCost` shows what it would have added.
        return this.append({
            type: 'compaction',
            ...(params.planId === undefined ? {} : { planId: params.planId }),
            stageId: params.stageId,
            modelKey: params.modelKey,
            inputTokens,
            outputTokens,
            ...(priced ? { cost: params.cost } : {}),
            contextAction: 'compress',
            tokensBefore: params.tokensBefore,
            tokensAfter: params.tokensAfter,
            detail: `compacted ${params.tokensBefore} -> ${params.tokensAfter} tokens with ${params.modelKey}` +
                (params.targetModelKey ? ` for ${params.targetModelKey}` : '') +
                `, used ${inputTokens} in / ${outputTokens} out ` +
                `(${priced ? '¥' + fmt(params.cost) : 'price unknown'})` +
                (params.handoverOk === false ? ', handover check FAILED' : ''),
        });
    }
    /**
     * A compression was needed and could not be run (no compressor wired) — or ran
     * and did not get the context small enough.
     *
     * Booked as its own event so the run can answer "how often were we unable to
     * make room?" without inferring it from a `switch-blocked` message string.
     */
    recordCompactionBlocked(stageId, targetModelKey, tokensBefore, planId) {
        return this.append({
            type: 'compaction-blocked',
            ...(planId === undefined ? {} : { planId }),
            stageId,
            modelKey: targetModelKey,
            contextAction: 'refuse',
            tokensBefore,
            detail: `no compression available to fit ${tokensBefore} tokens onto ${targetModelKey}: switch refused, nothing truncated`,
        });
    }
    /** The platform said yes but the session still runs the old model. */
    recordUnverified(stageId, expected, actual, planId) {
        return this.append({
            type: 'switch-unverified',
            ...(planId === undefined ? {} : { planId }),
            stageId,
            modelKey: expected,
            detail: `expected ${expected}, session still ${actual}`,
        });
    }
    /**
     * The platform dragged the user's global default model along with the session
     * switch (K-003). Recorded so the run can answer "did we degrade the host?".
     */
    recordGlobalDefaultWriteBack(from, to, planId) {
        return this.append({
            type: 'global-default-writeback',
            ...(planId === undefined ? {} : { planId }),
            detail: `global default ${from ?? '?'} -> ${to ?? '?'}`,
        });
    }
    /** A stage ran on a model that is not what the approved plan said. */
    recordDeviation(stageId, planned, actual, planId) {
        return this.append({
            type: 'plan-deviation',
            ...(planId === undefined ? {} : { planId }),
            stageId,
            modelKey: actual,
            detail: `plan said ${planned}, ran ${actual}`,
        });
    }
    all() {
        return this.entries.map((e) => Object.freeze({ ...e }));
    }
    forStage(stageId) {
        return this.all().filter((e) => e.stageId === stageId);
    }
    forPlan(planId) {
        return this.all().filter((e) => e.planId === planId);
    }
    /** Stages that ended with no usage at all; their cost is missing, not zero. */
    unbookedStages() {
        return this.entries.filter((e) => e.type === 'stage-end' && typeof e.cost !== 'number' && e.inputTokens === undefined).length;
    }
    totals() {
        let inputTokens = 0;
        let outputTokens = 0;
        let actualCost = 0;
        let switches = 0;
        let blocked = 0;
        let unverified = 0;
        let deviations = 0;
        let globalDefaultWriteBacks = 0;
        let compactionCost = 0;
        let prefillCost = 0;
        for (const e of this.entries) {
            inputTokens += e.inputTokens ?? 0;
            outputTokens += e.outputTokens ?? 0;
            if (e.type === 'stage-end' && typeof e.cost === 'number')
                actualCost += e.cost;
            // Compression and prefill are money too (F5 §6 / F6 §5). Both land in
            // `actualCost` — it is one invoice — but in **different** buckets: a
            // switch prefill is not a compression (DEF-2), and a bucket that mixed the
            // two could not answer "what did compressing cost" at all.
            if (typeof e.cost === 'number') {
                if (e.type === 'compaction') {
                    actualCost += e.cost;
                    compactionCost += e.cost;
                }
                else if (e.prefill === true) {
                    actualCost += e.cost;
                    prefillCost += e.cost;
                }
            }
            if (e.type === 'model-switch')
                switches++;
            if (e.type === 'switch-blocked')
                blocked++;
            if (e.type === 'switch-unverified')
                unverified++;
            if (e.type === 'plan-deviation')
                deviations++;
            if (e.type === 'global-default-writeback')
                globalDefaultWriteBacks++;
        }
        return {
            inputTokens,
            outputTokens,
            actualCost: round6(actualCost),
            compactionCost: round6(compactionCost),
            compactionInputTokens: this.compactionInputTokens,
            compactionOutputTokens: this.compactionOutputTokens,
            prefillInputTokens: this.prefillInputTokens,
            prefillCost: round6(prefillCost),
            estimatedCost: round6(this.estimatedCost),
            unpricedStages: this.unpricedStages,
            baselineCost: this.baselineCost === null ? null : round6(this.baselineCost),
            savings: this.baselineCost === null || this.unpricedStages > 0
                ? null
                : round6(this.baselineCost - actualCost),
            switches,
            blocked,
            unverified,
            deviations,
            globalDefaultWriteBacks,
        };
    }
    size() {
        return this.entries.length;
    }
    /** @internal test/user-reset seam only — a real run never calls this. */
    clear() {
        this.entries.length = 0;
        this.seq = 0;
        this.baselineCost = 0;
        this.estimatedCost = 0;
        this.unpricedStages = 0;
        this.compactionCost = 0;
        this.compactionInputTokens = 0;
        this.compactionOutputTokens = 0;
        this.prefillInputTokens = 0;
        this.prefillCost = 0;
    }
}
/** Money inside `detail` strings: `¥` + 3 decimals (261117 口径；数值字段仍保留全精度). */
function fmt(value) {
    return value === null ? 'null' : value.toFixed(3);
}
function round6(n) {
    return Math.round(n * 1e6) / 1e6;
}
//# sourceMappingURL=ledger.js.map