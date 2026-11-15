import type { ContextAction } from './types.js';
/**
 * F5 — context protection before a model switch.
 *
 * The rule the project is built on: switching models must not lose the thread
 * (原则 3), and it must never lose it **silently**. So this module answers one
 * question with four possible answers, and the caller has to act on the answer
 * it got instead of truncating the conversation to make it fit:
 *
 *  - `direct`   — hold on, nothing is cut;
 *  - `summary`  — travel with the stage-summary chain only (details stay in the
 *                 session, but the new model's prompt starts from the chain);
 *  - `compress` — the context is too big: compress first, then go;
 *  - `refuse`   — even after compressing it does not fit: **do not switch**, and
 *                 offer the user three ways out.
 *
 * Nothing here compresses anything. DSH already ships compaction
 * (`compaction-basic`, `/compact`, `summarizationProvider/Model`); this file
 * owns the *timing*, the *shape* of the handover, the *checks* on it, the
 * *notice* the user sees, and the *booking* of what the compression cost. Writing
 * a second compressor would be a second engine to keep honest, for no gain
 * (派工单 §二 A.7).
 */
/**
 * The three thresholds, as fractions of the target model's context window.
 *
 * Defaults follow 决策记录 D-006. They are fractions of the **window**, not of
 * the usable/headroom window, because that is how the decision was written down
 * ("C ≤ W×50%"); the guard's own headroom is applied on top when the switch is
 * finally asked, so this file can only make the switch *more* conservative,
 * never less.
 *
 * `refuseShare` (16%) is the floor compression must reach: compress to
 * `≤ refuseShare×W` and the switch is comfortable; fail to get under it and the
 * switch is refused rather than attempted.
 */
export interface ContextThresholds {
    /** C ≤ W×directShare → switch as is. */
    directShare: number;
    /** C ≤ W×summaryShare → switch with the summary chain only. */
    summaryShare: number;
    /** Compression must reach ≤ W×refuseShare; otherwise refuse. */
    refuseShare: number;
}
export declare const DEFAULT_CONTEXT_THRESHOLDS: ContextThresholds;
/**
 * Reads the thresholds from a plain config object, clamping instead of trusting.
 *
 * A config file is user input. `directShare: 2` must not turn the protection
 * into "always fine", and a `refuseShare` above `directShare` would make the
 * compression target unreachable by construction — both are corrected here, and
 * the caller is told (via the returned `adjusted` list) that it happened, because
 * silently rewriting a user's setting is the same class of bug as silently
 * truncating their context.
 */
export declare function readThresholds(config: Partial<Record<keyof ContextThresholds, unknown>> | undefined, fallback?: ContextThresholds): {
    thresholds: ContextThresholds;
    adjusted: string[];
};
/** One of the three ways out when the context still does not fit (F5 §1). */
export interface ContextOption {
    kind: 'bigger-window' | 'stay' | 'split';
    /** User-facing one-liner. Answers "what do I do now". */
    label: string;
}
export interface ContextDecisionInput {
    /** Context size the session is holding, in tokens. */
    contextTokens: number;
    /** Context window of the model we are switching **to**. */
    windowTokens: number;
    thresholds?: ContextThresholds;
    /**
     * What compression actually achieved, in tokens. Present only when the caller
     * already ran a compression pass and is asking "is this enough?".
     */
    tokensAfterCompaction?: number;
    /** Tokens the compressed handover is expected to carry. Defaults to the target. */
    targetTokens?: number;
}
export interface ContextDecision {
    action: ContextAction;
    /** Share of the window the context is using: C / W. */
    share: number;
    /** Tokens the conversation holds now. */
    contextTokens: number;
    /** Tokens the switch may carry after whatever this decision asks for. */
    carriedTokens: number;
    /** Tokens compression must bring the context down to (`refuseShare×W`). */
    targetTokens: number;
    /** User-visible sentence. Never empty: even `direct` says nothing was cut. */
    message: string;
    /**
     * How the next prompt is assembled. `full` = the whole conversation goes;
     * `summary-chain` = only the stage handovers go; `none` = no switch.
     */
    carry: 'full' | 'summary-chain' | 'none';
    /** Set only for `refuse`: the three choices the user gets instead of a cut. */
    options?: ContextOption[];
    /**
     * True when this decision was produced by a dry run (DEF-5): nothing was
     * compressed, nothing was booked, and `predictedCompactionCost` is a forecast.
     */
    dryRun?: boolean;
    /**
     * What compressing **would** cost, in USD; `null` when that price is unknown.
     * Only set on a dry run — a real compression books its real cost in the ledger
     * instead of predicting it here.
     */
    predictedCompactionCost?: number | null;
}
/** Absolute token thresholds for one window, printed in messages and tests. */
export declare function contextThresholdsFor(windowTokens: number, thresholds?: ContextThresholds): {
    direct: number;
    summary: number;
    compressTo: number;
};
/**
 * Decides what to do with the context before switching to a model of `windowTokens`.
 *
 * Pure and total: every input (including a nonsense window) produces a decision,
 * because the alternative is a caller that falls through to "just switch" when a
 * number was missing.
 */
export declare function decideContext(input: ContextDecisionInput): ContextDecision;
/** The three choices F5 §1 requires instead of a hard cut. */
export declare function refusalOptions(windowTokens: number, contextTokens: number): ContextOption[];
/**
 * The structured handover a compression must produce (F5 §3).
 *
 * Five fields, because these are the five things a reader (or the next model)
 * cannot reconstruct from a stream of chat turns: what we are doing, what is
 * settled, what exists on disk, what numbers/decisions are load-bearing, and what
 * is still open. A summary missing any of them is a流水账, not a handover.
 */
export interface StageHandover {
    /** 1. Task goal. */
    goal: string;
    /** 2. Done + the conclusion each stage reached. */
    done: string[];
    /** 3. Artifacts with their file paths. */
    artifacts: string[];
    /** 4. Key numbers and decisions that later stages depend on. */
    keyFacts: string[];
    /** 5. Open questions and the next step. */
    open: string[];
}
/** Which of the five fields a check found missing. */
export type HandoverField = keyof StageHandover;
/** A localised, quotable check result — the "标红" the acceptance asks for. */
export interface HandoverProblem {
    field: HandoverField;
    /** `missing` = the field is absent/empty; `no-artifact-path` = paths not named. */
    kind: 'missing' | 'no-artifact-path';
    message: string;
}
export declare const HANDOVER_LABELS: Record<HandoverField, string>;
export declare function emptyHandover(): StageHandover;
/** True when a handover has all five fields filled (each with at least one item). */
export declare function handoverComplete(handover: StageHandover): boolean;
/**
 * Checks the three things §3/§4 say must survive: the artifact list, the key
 * numbers, and the outstanding work. The other two fields are checked as well —
 * a handover with no goal is not a handover — but the three are what "缺则重压或
 * 标红" is about.
 *
 * A path is not "named" unless it looks like one: "改了核心模块" is exactly the
 * sentence that makes a compressed context useless six turns later.
 */
export declare function validateHandover(handover: StageHandover): HandoverProblem[];
/**
 * Renders the handover as the text that travels with the switch.
 *
 * Fixed order, fixed headings: the next model (and the user reading the notice)
 * gets the same five sections every time, which is what makes "没丢上下文" a
 * property instead of a hope.
 */
export declare function renderHandover(handover: StageHandover, problems?: HandoverProblem[]): string;
/**
 * What the user is told after a compression (F5 §5).
 *
 * "Allowed to fail" is not allowed: a compression the user never heard about is
 * an amnesia with a clean UI. This returns the sentence **and** whether it is a
 * warning (validation failed), so the caller cannot render a red compression as
 * a normal one.
 */
export interface CompactionNotice {
    visible: true;
    warning: boolean;
    text: string;
    problems: HandoverProblem[];
}
export declare function compactionNotice(input: {
    tokensBefore: number;
    tokensAfter: number;
    problems: HandoverProblem[];
    /** Whether the original transcript is still reachable in the session. */
    reopenable?: boolean;
}): CompactionNotice;
/** The compaction call, as it was measured. Real numbers only — never an estimate. */
export interface CompactionUsage {
    inputTokens: number;
    outputTokens: number;
    /** Which model did the compressing (the big one, or the user's choice). */
    modelKey: string;
    /** Model that will receive the handover. */
    targetModelKey: string;
}
//# sourceMappingURL=context-guard.d.ts.map