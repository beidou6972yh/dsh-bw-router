import type { CapabilityEntry, ModelEntry, Stage } from './types.js';
import { pricingKnown } from './types.js';

/**
 * A stage no model could be assigned to, as data rather than an exception.
 *
 * `no-model` is the empty-registry case (N-3/N-4): the answer to "which model?"
 * is "you have none", which the plan card turns into "完成向导" instead of an
 * error page. `capability-unmet` and `all-excluded` mean models exist but none
 * qualifies — a different fix, so a different code.
 */
export interface UnassignedStage {
  stageId: string;
  reason: 'no-model' | 'capability-unmet' | 'all-excluded';
  /** User-facing one-liner; safe to print as-is. */
  message: string;
}

export interface PlanDecision {
  /** Assignments in stage order. A stage with no model is absent, not faked. */
  assignments: { stage: Stage; decision: Decision }[];
  /** Stages that got no model. Empty means every stage has one. */
  unassigned: UnassignedStage[];
  /** The first blocker, when nothing at all could be assigned. */
  blocked?: UnassignedStage;
}

export interface DecideOptions {
  /** Model keys the user pinned for a stage capability. Highest priority, not免检. */
  pinned?: Record<string, string>;
  /** Entries to exclude (e.g. failed a health probe). */
  exclude?: string[];
  /** Model keys already picked for a sibling stage; avoid repeating them. */
  settle?: string[];
}

/** Why a decision ended up where it did — the plan card shows this. */
export type DecisionBasis = 'pinned' | 'pinned-overridden' | 'scored';

export interface Decision {
  modelKey: string;
  reason: string;
  /** Score of the winner, for debugging and tests. */
  score: number;
  /** How the winner was chosen. */
  basis: DecisionBasis;
  /**
   * True when the winner cannot comfortably hold the stage. The plan card must
   * say so instead of calling it a good fit.
   */
  overflow: boolean;
}

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
export function decideModel(
  stage: Stage,
  candidates: CapabilityEntry[],
  options: DecideOptions = {},
): Decision {
  const excluded = new Set(options.exclude ?? []);
  const settled = new Set(options.settle ?? []);
  const blocker = (c: CapabilityEntry): string | undefined => {
    if (excluded.has(c.key)) return 'was excluded (failed a health probe)';
    if (!c.available) return 'is unavailable';
    if (!c.model.capabilities.includes(stage.capability)) {
      return `does not do ${stage.capability}`;
    }
    return undefined;
  };

  const usable = candidates.filter((c) => blocker(c) === undefined);

  if (usable.length === 0) {
    throw new Error(
      `decideModel: no available model can do "${stage.capability}" for stage ${stage.id}`,
    );
  }

  const pinnedKey = options.pinned?.[stage.capability];
  const pinned = pinnedKey ? usable.find((c) => c.key === pinnedKey) : undefined;
  const pinReason = pinnedKey
    ? `you pinned ${pinnedKey}, but it ${blocker(candidates.find((c) => c.key === pinnedKey) ?? pinned!) ?? 'is not usable'}`
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

  const ranked = [...finalists].sort(
    (a, b) =>
      scoreEntry(b, needs) - scoreEntry(a, needs) ||
      priceOf(a.model) - priceOf(b.model) ||
      a.key.localeCompare(b.key),
  );
  const winner = ranked[0]!;
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

function scoreEntry(entry: CapabilityEntry, needs: number): number {
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
function priceOf(model: ModelEntry): number {
  return pricingKnown(model.pricing) ? model.pricing.outputPerMTok! : Number.MAX_SAFE_INTEGER;
}

function explain(entry: CapabilityEntry, stage: Stage, needs: number): string {
  const windowK = Math.round(entry.model.limits.contextWindow / 1000);
  const out = pricingKnown(entry.model.pricing)
    ? `$${entry.model.pricing.outputPerMTok}/Mtok out`
    : 'price unknown';
  const fit = fitsEmptyWindow(entry.model, needs) ? 'fits' : 'TIGHT: over the safe window';
  return (
    `${Math.round(needs / 1000)}k of ${windowK}k window (${fit}), ` +
    `${out} · ${stage.name}`
  );
}

/** Empty-window check: can this model hold the stage at a 0.9 headroom? */
function fitsEmptyWindow(model: ModelEntry, needs: number): boolean {
  return model.limits.contextWindow * 0.9 >= needs;
}

function round3(n: number): number {
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
export function decidePlan(
  stages: Stage[],
  candidates: CapabilityEntry[],
  options: DecideOptions = {},
): PlanDecision {
  const assignments: PlanDecision['assignments'] = [];
  const unassigned: UnassignedStage[] = [];
  const settled: string[] = [...(options.settle ?? [])];

  for (const stage of stages) {
    try {
      const decision = decideModel(stage, candidates, { ...options, settle: settled });
      settled.push(decision.modelKey);
      assignments.push({ stage, decision });
    } catch {
      unassigned.push(unassignedFor(stage, candidates, options));
    }
  }

  const blocked = unassigned.length > 0 && assignments.length === 0 ? unassigned[0] : undefined;
  return { assignments, unassigned, ...(blocked ? { blocked } : {}) };
}

/** Names the real blocker instead of one vague "no model" for every cause. */
function unassignedFor(
  stage: Stage,
  candidates: CapabilityEntry[],
  options: DecideOptions,
): UnassignedStage {
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
