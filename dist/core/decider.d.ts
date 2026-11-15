import type { CapabilityEntry, Stage } from './types.js';
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
    assignments: {
        stage: Stage;
        decision: Decision;
    }[];
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
export declare function decideModel(stage: Stage, candidates: CapabilityEntry[], options?: DecideOptions): Decision;
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
export declare function decidePlan(stages: Stage[], candidates: CapabilityEntry[], options?: DecideOptions): PlanDecision;
//# sourceMappingURL=decider.d.ts.map