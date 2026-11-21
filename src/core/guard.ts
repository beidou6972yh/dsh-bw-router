import type { CapabilityKind, GuardResult, ModelEntry } from './types.js';
import { pricingKnown } from './types.js';

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

export const DEFAULT_HEADROOM = 0.9;

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
export const SINGLE_SHOT_SHARE = 0.5;

/** Headroom is a fraction of the window. Garbage in must not become a wider gate. */
export function clampHeadroom(headroom: number | undefined): number {
  const value = headroom === undefined || !Number.isFinite(headroom) ? DEFAULT_HEADROOM : headroom;
  return Math.min(1, Math.max(0.1, value));
}

/**
 * Decides whether switching to `target` is safe.
 *
 * Never truncates. If it does not fit, the caller gets a blocking result with a
 * number and a message it can show the user (compress / pick another / abort).
 */
export function guardSwitch(input: GuardInput): GuardResult {
  const { target } = input;
  const headroom = clampHeadroom(input.headroom);

  if (input.requiredCapabilities?.length) {
    const missing = input.requiredCapabilities.filter(
      (c) => !target.capabilities.includes(c),
    );
    if (missing.length > 0) {
      return {
        code: 'missing-capability',
        allowed: false,
        message: `${target.label} cannot do: ${missing.join(', ')}`,
      };
    }
  }

  // A window we had to guess cannot authorise a switch. It can still refuse one.
  if (target.limitsGuessed) {
    return {
      code: 'limits-unconfirmed',
      allowed: false,
      message:
        `${target.label} has an unconfirmed context window (no window in the provider config). ` +
        `Fill in its limits, or pick a model whose window we know.`,
    };
  }

  const usable = Math.floor(target.limits.contextWindow * headroom);
  const needed = input.contextTokens + input.expectedOutputTokens;
  if (needed > usable) {
    const overflow = needed - usable;
    return {
      code: 'context-overflow',
      allowed: false,
      message:
        `${target.label} has ~${usable} usable tokens, this turn needs ${needed} ` +
        `(over by ${overflow}). Compress the context or pick a bigger model.`,
      overflowTokens: overflow,
    };
  }

  if (input.expectedOutputTokens > target.limits.maxOutputTokens) {
    return {
      code: 'output-limit-too-small',
      allowed: false,
      message:
        `${target.label} emits at most ${target.limits.maxOutputTokens} tokens; ` +
        `this stage needs ~${input.expectedOutputTokens}.`,
    };
  }

  if ((input.requireKnownPricing ?? true) && !pricingKnown(target.pricing)) {
    return {
      code: 'price-unknown',
      allowed: false,
      message:
        `${target.label} has no price configured, so the run cannot be costed. ` +
        `Add its price, or explicitly allow a model with unknown pricing.`,
    };
  }

  return { code: 'ok', allowed: true, message: '' };
}

/**
 * Largest single reply a stage plausibly needs, in tokens.
 *
 * `outputBudget` is the stage's whole output allowance; a single request gets a
 * share of it, never more than `maxOutputTokens` (an unclamped number here is
 * exactly the 409 that killed stage 2 at 60k).
 */
export function singleShotMaxTokens(
  outputBudget: number,
  target: ModelEntry,
  share: number = SINGLE_SHOT_SHARE,
): number {
  const bounded = Math.max(1, Math.floor(outputBudget * Math.min(1, Math.max(0.01, share))));
  const cap = Math.max(1, target.limits.maxOutputTokens);
  return Math.min(bounded, cap);
}

/** Largest context a model can take for a given expected reply. */
export function usableContext(
  target: ModelEntry,
  expectedOutputTokens: number,
  headroom?: number,
): number {
  const usable = Math.floor(target.limits.contextWindow * clampHeadroom(headroom));
  return Math.max(0, usable - expectedOutputTokens);
}

/**
 * The same number the gate uses, so the UI can never drift from the verdict.
 * Unknown (guessed) limits answer 0: we do not promise space we have not seen.
 */
export function displayContext(target: ModelEntry, expectedOutputTokens: number, headroom?: number): number {
  if (target.limitsGuessed) return 0;
  return usableContext(target, expectedOutputTokens, headroom);
}
