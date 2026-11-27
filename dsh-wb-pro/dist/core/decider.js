import { pricingKnown } from './types.js';
/**
 * Rule engine: pick a model for a stage.
 *
 * Three gates, then a score:
 *  1. must advertise the capability,
 *  2. must be available and not excluded (probe failures land here),
 *  3. must swallow the stage in an empty window — plus the caller's `settle`
 *     list, so a run does not ping back and forth between models for no gain.
 *
 * A pinned model gets priority, but it still has to pass gates 1–2. If the pin
 * is unusable we fall back to scoring and say why — a pin must never disable
 * health and capability checks.
 *
 * Score = strength − tightness-penalty×0.3, where tightness starts once the
 * stage would occupy more than half the window. Fit is a penalty, never a
 * bonus: a model does not win just by being big; it loses by cutting it close.
 * Price never enters the score — the plan card shows the money, and near-ties
 * are broken deterministically (cheaper first, then key) so the same task on
 * the same list always picks the same model.
 */
export function decideModel(stage, candidates, options = {}) {
    const excluded = new Set(options.exclude ?? []);
    const settled = new Set(options.settle ?? []);
    const blocker = (c) => {
        if (excluded.has(c.key))
            return 'was excluded (failed a health probe)';
        if (!c.available)
            return 'is unavailable';
        if (!c.model.capabilities.includes(stage.capability)) {
            return `does not do ${stage.capability}`;
        }
        return undefined;
    };
    const usable = candidates.filter((c) => blocker(c) === undefined);
    if (usable.length === 0) {
        throw new Error(`decideModel: no available model can do "${stage.capability}" for stage ${stage.id}`);
    }
    const pinnedKey = options.pinned?.[stage.capability];
    const pinned = pinnedKey ? usable.find((c) => c.key === pinnedKey) : undefined;
    const pinReason = pinnedKey
        ? `you pinned ${pinnedKey}, but it ${blocker(candidates.find((c) => c.key === pinnedKey) ?? pinned) ?? 'is not usable'}`
        : undefined;
    const needs = stage.estimatedInputTokens + stage.estimatedOutputTokens;
    const fits = fitsEmptyWindow;
    if (pinned) {
        return {
            modelKey: pinned.key,
            reason: `pinned by your settings · ${explain(pinned, stage, needs)}`,
            score: round3(scoreEntry(pinned, needs)),
            basis: 'pinned',
            overflow: !fits(pinned.model, needs),
        };
    }
    const inUse = usable.filter((c) => !settled.has(c.key));
    const pool = inUse.filter((c) => fits(c.model, needs));
    const finalists = pool.length > 0 ? pool : inUse.length > 0 ? inUse : usable;
    const ranked = [...finalists].sort((a, b) => scoreEntry(b, needs) - scoreEntry(a, needs) ||
        priceOf(a.model) - priceOf(b.model) ||
        a.key.localeCompare(b.key));
    const winner = ranked[0];
    const overflowing = !fits(winner.model, needs);
    const head = pinReason ?? `${winner.model.label}: best ${stage.capability} fit`;
    return {
        modelKey: winner.key,
        reason: `${head} · ${explain(winner, stage, needs)}`,
        score: round3(scoreEntry(winner, needs)),
        basis: pinnedKey ? 'pinned-overridden' : 'scored',
        overflow: overflowing,
    };
}
function scoreEntry(entry, needs) {
    const strength = entry.model.strength;
    const window = entry.model.limits.contextWindow;
    // Use under half the window = comfortable = no penalty. Above that the
    // penalty grows linearly, so a tight fit still loses to a stronger model that
    // fits comfortably — but a great model that can't breathe gets demoted.
    const half = window * 0.5;
    const tightness = Math.max(0, Math.min(1, (Math.max(needs, 1) - half) / half));
    return strength - tightness * 0.3;
}
/** Output price for tie-breaking; unknown sorts last without pretending to be free. */
function priceOf(model) {
    return pricingKnown(model.pricing) ? model.pricing.outputPerMTok : Number.MAX_SAFE_INTEGER;
}
function explain(entry, stage, needs) {
    const windowK = Math.round(entry.model.limits.contextWindow / 1000);
    // 早期约定：单位价（¥/百万 token）也按小数点后 3 位计；比较/排序仍用全精度原值。
    // Q2-7：未定价不再只说 "price unknown" —— 本地显式 0（本地），云端显式「待录入」。
    const pricing = entry.model.pricing || {};
    const stateSuffix = pricing.state === 'local' ? ' · 本地'
        : pricing.state === 'unpriced' ? ' · 待录入' : '';
    const out = (pricingKnown(pricing)
        ? `¥${Number(pricing.outputPerMTok).toFixed(3)}/Mtok out`
        : (pricing.state === 'local' ? '¥0.000/Mtok out · 本地'
            : pricing.state === 'unpriced' ? '0（待用户录入）· 未定价' : 'price unknown')) + stateSuffix;
    const fit = fitsEmptyWindow(entry.model, needs) ? 'fits' : 'TIGHT: over the safe window';
    return (`${Math.round(needs / 1000)}k of ${windowK}k window (${fit}), ` +
        `${out} · ${stage.name}`);
}
/** Empty-window check: can this model hold the stage at a 0.9 headroom? */
function fitsEmptyWindow(model, needs) {
    return model.limits.contextWindow * 0.9 >= needs;
}
function round3(n) {
    return Math.round(n * 1000) / 1000;
}
/**
 * Picks a model for every stage, and says which stages it could not fill.
 *
 * This is the entry the plan card uses. `decideModel` throws when nothing fits,
 * which is right for a single stage but wrong for a whole task: an empty
 * registry would turn into a stack trace instead of "no models configured, run
 * the wizard" (the N-3 defect). Here an unfillable stage becomes an
 * `UnassignedStage`, the runnable stages still get their models, and the caller
 * shows the card either way.
 *
 * Choosing is not remembering: every stage is scored on its own, then a model
 * already settled on a sibling stage loses exact ties (`decideModel` breaks
 * those by price and key). Reusing a model just because it ran a minute ago is
 * how a run ends up on the wrong model for stage 4.
 */
export function decidePlan(stages, candidates, options = {}) {
    const assignments = [];
    const unassigned = [];
    const settled = [...(options.settle ?? [])];
    for (const stage of stages) {
        try {
            const decision = decideModel(stage, candidates, { ...options, settle: settled });
            settled.push(decision.modelKey);
            assignments.push({ stage, decision });
        }
        catch {
            unassigned.push(unassignedFor(stage, candidates, options));
        }
    }
    const blocked = unassigned.length > 0 && assignments.length === 0 ? unassigned[0] : undefined;
    return { assignments, unassigned, ...(blocked ? { blocked } : {}) };
}
/** Names the real blocker instead of one vague "no model" for every cause. */
function unassignedFor(stage, candidates, options) {
    if (candidates.length === 0) {
        return {
            stageId: stage.id,
            reason: 'no-model',
            message: `未配置任何模型，请先完成向导（stage ${stage.id} needs ${stage.capability}）`,
        };
    }
    const excluded = new Set(options.exclude ?? []);
    // `candidates` may be fixtures or half-built entries; a missing capabilities
    // array must not crash the very path that exists to avoid crashing.
    const capable = candidates.filter((c) => (c.model?.capabilities ?? []).includes(stage.capability));
    if (capable.length === 0) {
        return {
            stageId: stage.id,
            reason: 'capability-unmet',
            message: `none of your models does ${stage.capability} — add one in the wizard`,
        };
    }
    const alive = capable.filter((c) => c.available && !excluded.has(c.key));
    if (alive.length === 0) {
        return {
            stageId: stage.id,
            reason: 'all-excluded',
            message: `every model that does ${stage.capability} is unavailable right now`,
        };
    }
    return {
        stageId: stage.id,
        reason: 'all-excluded',
        message: `no available model can take stage ${stage.id} as it stands`,
    };
}
//# sourceMappingURL=decider.js.map