import type { ModelPricing } from './types.js';
import { pricingKnown } from './types.js';

/**
 * What happens when a model states **no price**.
 *
 * 铁律 5 (事前可算账) says a switch must be costable *before* it happens. On a
 * real host that law collided with a fact: neither the local profile nor the
 * external tester's machine writes `inputPerMTok`/`outputPerMTok` into provider
 * config (real billing lives in the gateway, e.g. LiteLLM). With the guard's old
 * `requireKnownPricing ?? true` default, **every** plan was refused at confirm
 * time — "plan-blocked: … has no price configured, so the run cannot be costed"
 * — so the router could change models but never start a run.
 *
 * The law is not repealed, it is made **honest per catalog**:
 *
 *  - the law is about *not pretending* to know a number. An estimate that says
 *    "unavailable, tokens are still booked" pretends nothing, so it satisfies
 *    the law's purpose;
 *  - a host that prices **nothing** cannot be asked to price one model, so
 *    refusing there does not protect anyone — it only makes the product dead;
 *  - a host that prices **some** models keeps the strict rule by default: a
 *    mixed catalog means prices *can* be stated, and running unpriced next to
 *    priced work is exactly the quietly-understated bill the law forbids —
 *    unless the caller says `allowUnknownPricing: true` out loud.
 *
 * `strict` and `allow-unknown` exist so a host can pin the decision instead of
 * inheriting the catalog's shape; the default is `auto` (the two rules above).
 */
export type PricingPolicy = 'auto' | 'strict' | 'allow-unknown';

/**
 * Which rule produced the current answer (returned, never inferred from text).
 *
 *  - `priced`:  every model involved states a price; nothing to warn about;
 *  - `host-unpriced`: no model in the catalog states a price, so the guard is
 *    relaxed and the estimate says "unavailable" (the real-host default);
 *  - `opt-in`: the request carried `allowUnknownPricing: true`;
 *  - `policy-allow`: the host/config chose `pricingPolicy: 'allow-unknown'`;
 *  - `strict`: 铁律 5 in force — an unpriced model is refused (`price-unknown`).
 */
export type PricingMode = 'priced' | 'host-unpriced' | 'opt-in' | 'policy-allow' | 'strict';

/** Why the estimate is unavailable, in machine-readable form. */
export type PricingNoticeReason = 'host-unpriced' | 'opt-in' | 'policy-allow';

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

/** The resolved pricing stance, returned by the host and carried on responses. */
export interface PricingStatus {
  /** What the host/config asked for; `auto` = let the catalog decide. */
  policy: PricingPolicy;
  /** Which rule won. */
  mode: PricingMode;
  /**
   * True when at least one model in the catalog states a price. A machine with
   * no prices at all is a different situation from "we happened to pick an
   * unpriced model", and the two must not share an answer.
   */
  catalogHasPrices: boolean;
  /** True => the guard refuses an unpriced target with `price-unknown`. */
  requireKnownPricing: boolean;
  /** The sentence to show when estimates are unavailable; absent when priced. */
  notice?: string;
  /** Machine-readable reason for `notice`. */
  reason?: PricingNoticeReason;
}

/** Models whose price we actually know. Zero means "this host prices nothing". */
export function catalogHasPrices(entries: readonly { pricing: ModelPricing }[]): boolean {
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
export function parsePricingPolicy(value: unknown): PricingPolicy {
  const text = typeof value === 'string' ? value.trim().toLowerCase().replace(/_/g, '-') : '';
  if (text === 'strict') return 'strict';
  if (text === 'allow-unknown' || text === 'allowunknown' || text === 'lenient') return 'allow-unknown';
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
export function resolvePricing(input: {
  catalogHasPrices: boolean;
  policy?: PricingPolicy | string | null;
  requestedAllowUnknown?: boolean;
}): PricingStatus {
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
export function hasPricingNotice(status: PricingStatus): boolean {
  return typeof status.notice === 'string' && status.notice.length > 0;
}
