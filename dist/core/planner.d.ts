import type { CapabilityKind, Stage } from './types.js';
interface StagePreset {
    name: string;
    goal: string;
    capability: CapabilityKind;
    /**
     * A stage's whole output allowance, as a share of the task total. A budget,
     * not a reply size: the guard divides it into single replies (A2).
     */
    outputShare: number;
    optional: boolean;
}
/** Resolves a stage name to a preset key, or undefined when unknown. */
export declare function resolvePresetKey(name: string): string | undefined;
export interface PlanInput {
    taskId: string;
    /** Stable id for this plan; the ledger and the plan card share it. */
    planId: string;
    summary: string;
    /** Stage names in execution order; at least one. */
    stageNames: string[];
    /** Total input tokens the whole task is expected to burn. */
    estimatedInputTokens: number;
    /** Total output tokens the whole task is expected to emit. */
    estimatedOutputTokens?: number;
}
/**
 * Builds the ordered stage list. Rule-based on purpose: v1 must be explainable
 * and testable before anything smart goes in.
 */
export declare function buildStages(input: PlanInput): Stage[];
/** Default output:input ratio for a task nobody sized. */
export declare const DEFAULT_OUTPUT_RATIO = 0.3;
/**
 * Makes the stage output shares sum to exactly 1 (B-2).
 *
 * The presets are per-stage intuition ("implement is most of the work"), so they
 * were never meant to add up — `implement` alone is 0.6 and a task with six
 * stages summed to more than 1. The result was a plan that promised 82% of the
 * task's output to no stage at all: a single `implement` stage was budgeted 18%
 * of the task's *input*, while claiming a 60% share of an output total that was
 * itself derived from that input. The two halves of the same sentence disagreed.
 *
 * Normalising keeps the ratio between stages (which is the meaningful part) and
 * makes the total exact. Largest-remainder rounding, so the last stage does not
 * absorb everyone else's rounding error.
 */
export declare function closeShares(shares: number[]): number[];
/**
 * Splits the task's input tokens across stages by what each stage reads (B-2).
 *
 * Equal shares said an `analyze` stage reads as much as an `implement` stage,
 * which produced "one implement stage on 18k input" while the plan claimed 30k —
 * a 40% understatement on the stage that costs the most. Reading weight is the
 * stage's *input* appetite: everything that must reason over the task reads all
 * of it, a summarising step reads what came before.
 */
export declare function distributeInputs(totalInput: number, shares: number[], presets: StagePreset[]): number[];
export declare function distributeOutputs(totalOutput: number, shares: number[]): number[];
/**
 * Drops optional stages the user unselected, and never leaves nothing behind.
 *
 * B-7: when every stage was skipped this used to return `stages.slice(0, 1)` —
 * the **first** stage — while the comment promised "never drops the last one".
 * On a `write → implement` task that meant keeping `write` and losing
 * `implement`: the plan silently became "plan the work" with no work in it.
 *
 * The mandatory stage is the one the task exists for, and in a task order that is
 * the **last** mandatory stage (later stages consume earlier ones). Only when
 * every stage is optional does position decide, and then the last one is still the
 * better answer than the first: it is the one whose output the user can use.
 */
export declare function pruneOptional(stages: Stage[], skippedIds: string[]): Stage[];
export {};
//# sourceMappingURL=planner.d.ts.map