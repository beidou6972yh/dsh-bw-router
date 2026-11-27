/**
 * Core data structures for the model router.
 *
 * This file is pure data + pure helpers. No platform API, no network, no fs.
 * Everything the plugin needs to talk to the outside world goes through
 * `src/adapters/`.
 */
export const nowIso = () => new Date().toISOString();
/** True when every price we need to price a call is known. */
export function pricingKnown(pricing) {
    return pricing.inputPerMTok !== null && pricing.outputPerMTok !== null;
}
/**
 * AND two availability signals where "unknown" is not "true".
 *
 * A probe that says false must not be undone by a merge that forgot to pass the
 * signal (N-1); a config that never probed must not mark a dead endpoint alive.
 * Only "both say yes" is available; anything else is not.
 */
export function availableAnd(known, incoming) {
    return known === true && incoming === true;
}
/** Best-effort cost of a single call（早期起金额口径为人民币 CNY；裸数值不带符号）. Null when the price is unknown. */
export function costOf(pricing, inputTokens, outputTokens) {
    if (!pricingKnown(pricing))
        return null;
    const micro = pricing.inputPerMTok * inputTokens + pricing.outputPerMTok * outputTokens;
    return micro / 1_000_000;
}
/** Adds two optional amounts; null poisons the sum, because unknown is unknown. */
export function addCost(a, b) {
    return a === null || b === null ? null : a + b;
}
/** Stable key for a model, used everywhere instead of provider+model pairs. */
export function modelKey(provider, model) {
    return `${provider}/${model}`;
}
//# sourceMappingURL=types.js.map