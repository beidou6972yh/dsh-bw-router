/**
 * Core data structures for the model router.
 *
 * This file is pure data + pure helpers. No platform API, no network, no fs.
 * Everything the plugin needs to talk to the outside world goes through
 * `src/adapters/`.
 */

/** The kind of work a stage is made of. Drives model selection. */
export type CapabilityKind =
  | 'reasoning'
  | 'coding'
  | 'writing'
  | 'summarizing'
  | 'vision'
  | 'image-generation'
  | 'cheap-bulk';

/** Where a capability entry came from. Provenance is never dropped. */
export type CapabilitySource =
  | 'dsh-config'
  | 'dsh-runtime'
  | 'local-endpoint'
  | 'manual-import';

/**
 * Per-million-token price. USD, so comparisons stay currency-agnostic.
 *
 * `null` means "unknown", and unknown is never treated as free: a model whose
 * price we do not know cannot claim savings, it says "price unknown".
 */
export interface ModelPricing {
  /** USD per 1M input tokens; null = not known. */
  inputPerMTok: number | null;
  /** USD per 1M output tokens; null = not known. */
  outputPerMTok: number | null;
}

/** Hard limits a model imposes on a request. Used by the guard. */
export interface ModelLimits {
  /** Total context window in tokens (input + output). */
  contextWindow: number;
  /** Max tokens the model can emit in one response. */
  maxOutputTokens: number;
  /**
   * Whether the model can take tool/function definitions at all.
   *
   * `null` means "the provider config does not say" — the honest value, and the
   * one discovery now produces instead of the constant `true` it used to write
   * (C-4). Unknown never authorises anything, and the guard refuses **every**
   * value that is not a stated `true`: `null` and `false` are both refusals for
   * a stage that needs tools (NV-4 — the old comment here said the guard only
   * refused an explicit `false`, which is not what `guardSwitch` does).
   */
  supportsTools: boolean | null;
  /** Whether the model accepts image input. */
  supportsImages: boolean;
}

/** One model as the router sees it. */
export interface ModelEntry {
  id: string;
  provider: string;
  /** Model name as the provider knows it (e.g. `deepseek-v3.2`). */
  model: string;
  /** Human label for UI. */
  label: string;
  capabilities: CapabilityKind[];
  limits: ModelLimits;
  pricing: ModelPricing;
  /**
   * Limits the discovery layer could not read and had to guess (e.g.
   * `contextWindow`, `maxOutputTokens`). The guard treats a guessed window as
   * "unconfirmed": it can still say no, but never says yes on a guess.
   * `null` would be ambiguous on `number` fields, so provenance is the signal.
   */
  limitsGuessed?: boolean;
  /** 0..1, how good the model is at what it advertises. Used by the decider. */
  strength: number;
  source: CapabilitySource;
}

/**
 * How a stage will be fed to `guardSwitch` when its turn comes.
 *
 * The card must answer the same question the switch will ask, or it says "可开工"
 * for a plan whose every stage is refused (A1). Rather than let the host guess
 * the two numbers independently in two places, the assignment carries them:
 *
 *  - `contextTokens` is what the session will hold when this stage starts —
 *    the task input plus whatever earlier stages emitted, because a stage runs on
 *    the conversation the previous stage left behind (上下文不断片);
 *  - `expectedOutputTokens` is what **this one switch** will ask for, which is
 *    not the stage's whole output budget (see `singleShotOutputTokens`).
 */
export interface StageGuardInputs {
  contextTokens: number;
  expectedOutputTokens: number;
}

/** A model plus the provenance/health metadata the registry tracks. */
export interface CapabilityEntry {
  key: string;
  model: ModelEntry;
  /** True when the source answered a health probe in this process. */
  available: boolean;
  /** Free-form notes: why it was excluded, when it was last seen, etc. */
  notes: string[];
}

/** A phase of the task. Stages are ordered and executed one after another. */
export interface Stage {
  /** Stable id, e.g. `stage-1`. */
  id: string;
  /** Short machine-ish name, e.g. `analyze`. */
  name: string;
  /** What this stage must produce. Shown to the user on the plan card. */
  goal: string;
  /** Capability this stage leans on. */
  capability: CapabilityKind;
  /** Rough size of the stage's input, in tokens. */
  estimatedInputTokens: number;
  /** Rough size of what the stage should emit, in tokens. */
  estimatedOutputTokens: number;
  /** True when the user can skip this stage in the plan card. */
  optional: boolean;
}

/** The plan card: stages + the model picked for each. */
export interface StagePlan {
  taskId: string;
  /** Stable id of this plan. Every ledger event of the run carries it. */
  planId: string;
  /** One-line restatement of the task. */
  summary: string;
  stages: StageAssignment[];
  /** Model the user usually runs, used as the savings baseline. */
  baselineModelKey: string;
  /** True when the baseline was guessed (no usage data) instead of measured. */
  baselineIsGuess: boolean;
  createdAt: string;
  /** Set when the user confirmed the plan. Nothing may run before this. */
  approvedAt?: string;
  /**
   * F6 §1: what the advertised ± band means, in words, next to the money.
   * The band is on every estimate; the statement is what stops it reading as a
   * promise. Carried on the plan so every renderer prints the same sentence.
   */
  errorStatement?: string;
  /**
   * Stages with no model. Never empty on success: when the list is non-empty the
   * plan card shows these stages as "unassigned" and refuses to start, instead of
   * a hollow "0 stages" card that pretends the task has no plan.
   *
   * `name`/`capability` are the stage's own, carried so the card can title the
   * row with the work rather than with an id — and so the row can offer the
   * models that could fill it.
   */
  unassignedStages?: {
    stageId: string;
    reason: string;
    name?: string;
    capability?: CapabilityKind;
  }[];
}

/** A stage bound to a model, with the estimate that justified the choice. */
export interface StageAssignment {
  stage: Stage;
  modelKey: string;
  /** Why this model — one sentence, user-facing. */
  reason: string;
  estimate: CostEstimate;
  /** The numbers the guard will be asked with for this stage (A1/A2). */
  guardInputs?: StageGuardInputs;
}

/** Cost estimate for one stage, and the delta versus the baseline. */
export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  /** USD, or null when the price is unknown (never silently 0). */
  cost: number | null;
  /** USD the same stage would cost on the baseline model; null = unknown. */
  baselineCost: number | null;
  /** USD saved (can be negative); null = unknown. */
  savings: number | null;
  /** ±fraction, e.g. 0.35 means "give or take 35%". Honest by construction. */
  uncertainty: number;
  /** Keys whose price we do not know. Non-empty => cost/savings are null. */
  unknownPricing?: string[];
  /**
   * Why the copy says "price unknown" instead of a number. `no-model` is the
   * register-nothing case (N-3/N-4): there is no price to know, and numbering
   * that as "unknown price of model X" would invent a model that does not exist.
   */
  priceUnknownReason?: PriceUnknownReason;
  /** Same question for the savings baseline. Independent of `priceUnknownReason`. */
  baselinePriceUnknownReason?: PriceUnknownReason;
}

/**
 * Why an amount is unknown.
 *  - `model-price`: the model exists but states no price;
 *  - `baseline-price`: only the baseline model's price is missing;
 *  - `no-model`: nothing is registered, so there is no model to price at all.
 */
export type PriceUnknownReason = 'model-price' | 'baseline-price' | 'no-model';

/** Anything that must block a model switch instead of silently truncating. */
export type GuardCode =
  | 'ok'
  | 'context-overflow'
  | 'missing-capability'
  | 'model-unavailable'
  | 'output-limit-too-small'
  | 'limits-unconfirmed'
  | 'price-unknown';

export interface GuardResult {
  code: GuardCode;
  allowed: boolean;
  /** User-facing explanation; empty only when allowed and nothing to say. */
  message: string;
  /** Tokens over the window when code is `context-overflow`. */
  overflowTokens?: number;
}

/**
 * What happened to the context right before a switch (F5).
 *
 *  - `direct`:   C ≤ W×directShare — the context fits comfortably, nothing is cut;
 *  - `summary`:  C ≤ W×compressShare — only the stage-summary chain travels;
 *  - `compress`: C was compressed (by the host's compressor) down to ≤ W×directShare;
 *  - `refuse`:   still too big after compressing — the switch does **not** happen.
 */
export type ContextAction = 'direct' | 'summary' | 'compress' | 'refuse';

/** Ledger events. Append-only; the ledger never rewrites history. */
export type LedgerEventType =
  | 'plan-created'
  | 'plan-approved'
  | 'stage-start'
  | 'stage-end'
  | 'model-switch'
  | 'switch-blocked'
  | 'switch-unverified'
  | 'global-default-writeback'
  | 'plan-deviation'
  | 'compaction'
  | 'compaction-blocked'
  | 'run-end';

export interface LedgerEvent {
  type: LedgerEventType;
  /** Filled by the ledger when omitted; callers rarely set it. */
  at?: string;
  /** Which plan this event belongs to. Plans and the ledger index each other. */
  planId?: string;
  stageId?: string;
  modelKey?: string;
  /** Tokens actually used, when known. */
  inputTokens?: number;
  outputTokens?: number;
  /** USD actually charged, when pricing is known. Never an estimate. */
  cost?: number;
  /** True when `cost` is only an estimate (dry runs, no real usage). */
  costEstimated?: boolean;
  /** Free-form detail for the ledger reader. */
  detail?: string;
  /** F5: which branch the switch took (only on switch/compaction decisions). */
  contextAction?: ContextAction;
  /** F5: tokens the context held before compression. */
  tokensBefore?: number;
  /** F5: tokens after compression (= booked input of the compaction call). */
  tokensAfter?: number;
  /**
   * F6: true when this event is the switch's prefill — the prompt re-sent to the
   * new model because the session moved. Costed like any other input, because
   * the provider bills it like any other input (报告 §8.4).
   */
  prefill?: boolean;
}

/** One line in the running ledger. */
export interface LedgerEntry extends LedgerEvent {
  seq: number;
}

/**
 * Totals the ledger can always answer, even mid-run.
 *
 * `actualCost` is what was really spent (from real token counts); `estimatedCost`
 * is what stages predicted. They are never added together.
 */
export interface LedgerTotals {
  inputTokens: number;
  outputTokens: number;
  /** USD actually spent (stage bills + compaction + switch prefill). */
  actualCost: number;
  /**
   * Of `actualCost`: money spent **compressing** the context (F5 §6). Only
   * `compaction` events are summed here; a switch prefill is its own bucket
   * (`prefillCost`, DEF-2), because the two answer different questions.
   */
  compactionCost: number;
  /** Real token counts booked for compression calls. */
  compactionInputTokens: number;
  compactionOutputTokens: number;
  /** Real token counts booked for switch prefills. */
  prefillInputTokens: number;
  /**
   * Of `actualCost`: money spent re-sending the prompt on a model switch
   * (F6 §5). Kept apart from `compactionCost` so "what did compressing cost"
   * is answerable from the book (DEF-2).
   */
  prefillCost: number;
  /** USD the plan predicted for the stages that ran. */
  estimatedCost: number;
  /** Stages that ran without a known price; their cost is missing from the sums. */
  unpricedStages: number;
  /** Cost the same work would have had on the baseline model; null if unknown. */
  baselineCost: number | null;
  /** baselineCost − actualCost; null when either side is unknown. */
  savings: number | null;
  switches: number;
  blocked: number;
  /** Switches we asked for but could not verify actually happened. */
  unverified: number;
  /** Stages that ran on a model outside the approved plan. */
  deviations: number;
  /** Switches where the platform dragged the global default along (K-003). */
  globalDefaultWriteBacks: number;
}

export const nowIso = (): string => new Date().toISOString();

/** True when every price we need to price a call is known. */
export function pricingKnown(pricing: ModelPricing): boolean {
  return pricing.inputPerMTok !== null && pricing.outputPerMTok !== null;
}

/**
 * AND two availability signals where "unknown" is not "true".
 *
 * A probe that says false must not be undone by a merge that forgot to pass the
 * signal (N-1); a config that never probed must not mark a dead endpoint alive.
 * Only "both say yes" is available; anything else is not.
 */
export function availableAnd(known: boolean | undefined, incoming: boolean | undefined): boolean {
  return known === true && incoming === true;
}

/** Best-effort USD cost of a single call. Null when the price is unknown. */
export function costOf(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (!pricingKnown(pricing)) return null;
  const micro = pricing.inputPerMTok! * inputTokens + pricing.outputPerMTok! * outputTokens;
  return micro / 1_000_000;
}

/** Adds two optional amounts; null poisons the sum, because unknown is unknown. */
export function addCost(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

/** Stable key for a model, used everywhere instead of provider+model pairs. */
export function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}
