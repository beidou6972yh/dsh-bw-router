import { pricingKnown } from './types.js';
/**
 * The sentence every surface prints when a run cannot be costed.
 *
 * One wording, one place: card footer, status bar, HTTP response and ledger
 * reader all quote this string, so "we did not price this" can never drift into
 * "it was free" on one surface while another says otherwise.
 */
export const UNPRICED_HOST_NOTICE = '预估不可用：宿主未配价（按 token 记账）';
export const UNPRICED_OPT_IN_NOTICE = '预估不可用：已显式允许无价模型（按 token 记账）';
export const UNPRICED_POLICY_NOTICE = '预估不可用：配置允许无价模型（按 token 记账）';
/** Models whose price we actually know. Zero means "this host prices nothing". */
export function catalogHasPrices(entries) {
    return entries.some((entry) => pricingKnown(entry.pricing));
}
/**
 * Reads the host/config setting without trusting it.
 *
 * A config file is user input: an unknown string must not silently become
 * `strict` (which would kill a real host) or silently become `allow-unknown`
 * (which would repeal 铁律 5 by typo). Garbage means `auto`, the documented
 * default.
 */
export function parsePricingPolicy(value) {
    const text = typeof value === 'string' ? value.trim().toLowerCase().replace(/_/g, '-') : '';
    if (text === 'strict')
        return 'strict';
    if (text === 'allow-unknown' || text === 'allowunknown' || text === 'lenient')
        return 'allow-unknown';
    return 'auto';
}
/**
 * The single place that decides whether an unpriced model may be used.
 *
 * Precedence, highest first:
 *  1. an explicit host policy (`strict` / `allow-unknown`) — the operator spoke;
 *  2. `auto`: a catalog that prices **nothing** allows the run and says the
 *     estimate is unavailable (the real-host case);
 *  3. `auto`: a **mixed** catalog stays strict (铁律 5) unless the request
 *     opted in with `allowUnknownPricing: true`.
 *
 * Note the deliberate ordering of 2 before 3: a catalog with no prices at all
 * cannot be "mixed", and asking the user to opt in on **every** call would be
 * theatre — the notice is the honest part, not the click.
 */
export function resolvePricing(input) {
    const policy = parsePricingPolicy(input.policy);
    const catalog = input.catalogHasPrices;
    if (policy === 'strict') {
        return { policy, mode: 'strict', catalogHasPrices: catalog, requireKnownPricing: true };
    }
    if (policy === 'allow-unknown') {
        return {
            policy,
            mode: 'policy-allow',
            catalogHasPrices: catalog,
            requireKnownPricing: false,
            notice: UNPRICED_POLICY_NOTICE,
            reason: 'policy-allow',
        };
    }
    if (!catalog) {
        return {
            policy,
            mode: 'host-unpriced',
            catalogHasPrices: false,
            requireKnownPricing: false,
            notice: UNPRICED_HOST_NOTICE,
            reason: 'host-unpriced',
        };
    }
    if (input.requestedAllowUnknown === true) {
        return {
            policy,
            mode: 'opt-in',
            catalogHasPrices: catalog,
            requireKnownPricing: false,
            notice: UNPRICED_OPT_IN_NOTICE,
            reason: 'opt-in',
        };
    }
    return { policy, mode: 'strict', catalogHasPrices: catalog, requireKnownPricing: true };
}
/**
 * True when this stance means "the money line will say unavailable".
 *
 * Used by the card/state builders so a relaxed guard always ships with its
 * notice: a relaxed guard with a silent card would be an estimate that quietly
 * stopped existing.
 */
export function hasPricingNotice(status) {
    return typeof status.notice === 'string' && status.notice.length > 0;
}
//# sourceMappingURL=pricing.js.map