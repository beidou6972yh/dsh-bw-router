import { type EstimateWithInterval } from '../core/budget.js';
import { type CompactionNotice, type ContextDecision, type ContextThresholds, type HandoverProblem, type StageHandover } from '../core/context-guard.js';
import { type CalibrationState, type SavingsExclusion } from '../core/calibration.js';
import { Ledger } from '../core/ledger.js';
import { type PricingStatus } from '../core/pricing.js';
import { Registry } from '../core/registry.js';
import { type SessionCallRecord } from '../core/usage-stats.js';
import { type PlanCard, type RouterState } from '../core/card.js';
import { type WizardDraft } from '../core/wizard-draft.js';
import type { CapabilityEntry, CapabilityKind, CapabilitySource, CostEstimate, GuardResult, ModelEntry, Stage, StageAssignment, StagePlan } from '../core/types.js';
import type { DshModelSelection } from '../adapters/dsh-model.js';
/** Thrown when a caller asks for something the host cannot do. */
export declare class RouterError extends Error {
    /** Stable machine code the HTTP layer turns into a status. */
    readonly code: string;
    /** Extra fields the endpoint returns alongside the message. */
    readonly details: Record<string, unknown>;
    constructor(
    /** Stable machine code the HTTP layer turns into a status. */
    code: string, message: string, 
    /** Extra fields the endpoint returns alongside the message. */
    details?: Record<string, unknown>);
}
/** Why the host cannot act, in the words the UI prints after "加载失败：". */
export interface RouterFailure {
    code: string;
    message: string;
    /**
     * Set when the fix is "finish the wizard". The UI shows the hint and stops
     * retrying a request that cannot succeed until models are registered.
     */
    needsWizard?: boolean;
}
/** One stage's estimate vs its bill (F6 §4). */
export interface ReconcileRow {
    stageId: string;
    /** What the plan said; null when the model had no price. */
    estimated: number | null;
    /** What was booked; null when the stage reported no usage. */
    actual: number | null;
    /** Advertised interval, or null when there is nothing to compare. */
    interval: {
        low: number;
        high: number;
    } | null;
    /** null = cannot say (unknown price / no usage), never "fine". */
    within: boolean | null;
}
export interface ReconcileReport {
    planId: string;
    rows: ReconcileRow[];
    within: number;
    outside: number;
    /** Stages that cannot be compared at all: the total is a floor, not a bill. */
    unknown: number;
    /** True only when every comparable stage landed inside its advertised band. */
    ok: boolean;
    statement: string;
}
/**
 * Marker for a run that has no plan at all. Only `switchWithoutPlan` uses it:
 * the plan gate refuses a missing planId, and an explicit opt-in has to be
 * spelled out rather than defaulted into.
 */
export declare const UNPLANNED_RUN = "unplanned";
/** What the host hands the plugin when a task starts. */
export interface RunRequest {
    taskId: string;
    summary: string;
    stageNames: string[];
    estimatedInputTokens: number;
    estimatedOutputTokens?: number;
    /** Usage counts per model key; the wizard supplies them. */
    usage?: Record<string, number>;
    pinned?: Record<string, string>;
    /** Tokens already in the session when the run starts. */
    contextTokens?: number;
    /**
     * Explicit opt-in to a plan that contains unpriced models
     * (`POST /router/plan` body field of the same name).
     *
     * Only needed on a **mixed** catalog: when no model states a price at all the
     * host relaxes the guard by itself and says so (see `src/core/pricing.ts`).
     * Recorded per plan, never globally.
     */
    allowUnknownPricing?: boolean;
}
/** Outcome of asking to move the session onto a stage's model. */
export interface SwitchResult {
    switched: boolean;
    message: string;
    /**
     * The guard code behind a refusal (`price-unknown`, `context-overflow`, …).
     *
     * Returned as data, not implied by the English in `message`: the acceptance
     * criteria quote `price-unknown`, and a caller that has to grep prose for it
     * will eventually grep the wrong sentence.
     */
    code?: GuardResult['code'];
    /** True when the session was already on the target model (a no-op success). */
    alreadyInUse?: boolean;
    /**
     * True when the platform changed the user's **global default model** while
     * switching this session (K-003). We cannot prevent it, we can see it, and
     * seeing it is what keeps the host environment from degrading unnoticed.
     */
    globalDefaultWrittenBack?: boolean;
    /**
     * F5: what happened to the context on the way. Present on every switch this
     * host performs, because "nothing was cut" is information too.
     */
    context?: ContextDecision;
    /** F5: the notice the user must see when the context was compressed. */
    compaction?: CompactionNotice;
    /**
     * Whether the user's global default could actually be read around this switch.
     *
     * `false` is "未能观测" — the guard had no readable cell (no
     * `agentDefaultModel.currentSelection()`, no legacy read), so the absence of
     * `globalDefaultWrittenBack` must NOT be read as "nothing happened" (K-003).
     * Present on every switch that reached the platform, success or failure.
     */
    globalDefaultObserved?: boolean;
}
/**
 * What one compression pass produced (F5).
 *
 * `inputTokens` / `outputTokens` / `cost` are the **real** usage of the compress
 * call. The kernel does not measure them — the host's compressor did the work and
 * reports what it cost, which is why this is an interface rather than code here
 * (F5 §7: the plugin owns timing, shape, checks, notice and booking; it does not
 * own a second compaction engine).
 */
export interface CompressionResult {
    /** Context size after compression, in tokens. */
    tokensAfter: number;
    /** Real input tokens the compression call used. */
    inputTokens: number;
    /** Real output tokens the compression call used. */
    outputTokens: number;
    /** Which model compressed (the big one, or the user's choice). */
    modelKey: string;
    /** USD charged; omit/null when that model has no price. */
    cost?: number | null;
    /** The structured handover the compressor produced, when it spread it out. */
    handover?: StageHandover;
    /** False when the transcript cannot be reopened from the session. */
    reopenable?: boolean;
}
/**
 * The host's compaction hook — normally a thin call into DSH's own
 * `compaction-basic` / `/compact` / `summarizationProvider`.
 */
export interface ContextCompressor {
    compress(input: {
        handover: StageHandover;
        /** The rendered five-section text the compressor is asked to preserve. */
        rendered: string;
        tokensBefore: number;
    }): CompressionResult;
}
/**
 * One stage of a plan as the HTTP layer shows it.
 *
 * `assignment` is absent exactly when the stage has no model yet; the reason
 * travels alongside so the row can say why instead of rendering a blank.
 */
export interface PlanStageRow {
    stage: Stage;
    assignment?: StageAssignment;
    unassignedReason?: string;
}
/** Host half of the DSH plugin: wires core modules to one adapter. */
export declare class PluginHost {
    private readonly selection;
    readonly registry: Registry;
    readonly ledger: Ledger;
    /** Plans this host built, by planId. A switch must belong to one of them. */
    private readonly plans;
    /** Per-plan, per-stage explanation for stages with no model (N-4). */
    private readonly unassigned;
    /**
     * Every stage of every plan, assigned or not.
     *
     * The plan used to keep only the **assigned** stages, so a host with no models
     * produced `stages: []` — the external tester's fourth defect ("只有卡片行，
     * 换模型也改不了"). The full list is what lets `/router/plan` answer one row per
     * stage and lets `swapStageModel` fill a gap instead of answering
     * `unknown-stage`.
     */
    private readonly stageDefs;
    /** Per-plan, per-stage numbers the guard will be asked with (A1/A2). */
    private readonly stageInputs;
    /** Which plan the status bar is following. Last plan built or switched wins. */
    private activePlanId?;
    private planSeq;
    /** F5 thresholds (70/50/16 by default, configurable, never hardcoded). */
    private contextThresholds;
    /** Notes about thresholds a config asked for and could not have, for the UI. */
    private readonly thresholdNotes;
    /** The host's compaction hook; undefined = "this host cannot compress". */
    private compressor?;
    /** Whether an over-full switch can compress here (F5 / DEF-1). Public: it is a fact, not a nicety. */
    get compressorWired(): boolean;
    /** Handovers written for a stage, keyed `${planId}:${stageId}`. */
    private readonly handovers;
    /** Notice produced by the compression belt of the switch in flight (F5 §5). */
    private pendingCompactionNotice?;
    /** F6: what this run's estimates have been compared against, so far. */
    private calibration;
    /**
     * How hard this host insists on a known price (铁律 5, honest-degradation
     * form). `auto` = let the catalog decide; see `src/core/pricing.ts`.
     */
    private pricingPolicy;
    /**
     * Plans a caller explicitly allowed to use unpriced models.
     *
     * Keyed by planId on purpose: "I accept an unpriceable run for this task" is a
     * decision about one plan. A global flag would let one prompt repeal 铁律 5
     * for every later run in the process.
     */
    private readonly pricingOptIn;
    constructor(selection: DshModelSelection, options?: {
        /** Subset of 70/50/16 from config; anything nonsense is clamped and noted. */
        contextThresholds?: Partial<Record<keyof ContextThresholds, unknown>>;
        /** The host's compaction implementation (DSH compaction, in practice). */
        compressor?: ContextCompressor;
        /**
         * `auto` (default) | `strict` | `allow-unknown`. Garbage means `auto`:
         * a typo must neither repeal 铁律 5 nor kill a host that prices nothing.
         * Typed `unknown` because it comes from user config.
         */
        pricingPolicy?: unknown;
    });
    /**
     * Sets the pricing stance after construction (the shell reads it from the
     * host's config; a test sets it directly). Same parsing as the constructor.
     */
    setPricingPolicy(policy: unknown): void;
    /** The stance in force, without a plan/request context. */
    get pricing(): PricingStatus;
    /**
     * The stance that applies to one plan: host policy + catalog + that plan's
     * opt-in (and, when given, an explicit flag on this very request).
     *
     * One function for card, confirm and switch, so the three cannot disagree
     * about whether this run may contain an unpriced model.
     */
    pricingFor(planId?: string, requestedAllowUnknown?: boolean): PricingStatus;
    /** Records (or clears) a plan's explicit permission to run unpriced models. */
    allowUnknownPricingFor(planId: string, allowed: boolean): void;
    /** Thresholds in force, as fractions of the target window. */
    get thresholds(): ContextThresholds;
    /** What a config asked for and did not get (empty in the normal case). */
    get thresholdAdjustments(): string[];
    /** Wires a compressor after construction (the DSH shell does this). */
    setCompressor(compressor: ContextCompressor | undefined): void;
    /** Wires the host's async compaction hook (DEF-1); undefined = cannot compress. */
    setCompactionHook(hook: ((input: {
        rendered: string;
        tokensBefore: number;
        targetModelKey?: string;
        /** The session this switch belongs to, when the request named one. */
        sessionId?: string;
    }) => Promise<CompressionResult>) | undefined): void;
    /** True when an over-full switch can actually compress here (DEF-1). */
    get canCompress(): boolean;
    /**
     * DEF-1: the wiring that makes F5's compress branch reachable at all.
     *
     * `createCompressor()` produced a *synchronous* `compress()` from an *async*
     * host call, and nothing ever connected the two, so `host.compressor` was
     * undefined on every real host and every over-full switch refused. Both halves
     * are connected here:
     *
     *  1. a host compaction hook (`compactHook`) runs the async call and keeps the
     *     result, exactly once, **before** the switch decides its branch;
     *  2. the compressor reads that kept result.
     *
     * When no hook is wired the compressor is the host's own synchronous one (a
     * test rig, or a host that compresses inline). When neither exists nothing is
     * warmed and `decideContextFor` keeps the safe refusal — with three options,
     * never a silent hard switch.
     */
    private warmCompression;
    /** Why the last warm-up produced nothing, for the refusal sentence. */
    private warmFailure?;
    /** The compaction warmed for the switch in flight, consumed once (DEF-1). */
    private warmed?;
    /** Host's async compaction (DEF-1). */
    private compactHook?;
    /** Records the staged handover a compression will be asked to preserve (F5 §3). */
    setHandover(stageId: string, handover: StageHandover, planId?: string): StageHandover;
    /** F5 §4: which of the five fields this stage's handover is missing (empty = ok). */
    handoverProblems(planId: string | undefined, stageId: string): HandoverProblem[];
    /**
     * F5 dry run: what a switch of this stage to this model would do to the context.
     *
     * DEF-5: "dry run" has to mean it. The compress branch used to be taken for
     * real here (the compressor ran, the call was booked), so asking "what would
     * happen?" spent money and moved the numbers. The two branches are now told
     * apart by `dryRun`: no compressor call, no ledger event, and — when a
     * compression would be needed — a `predictedCompactionCost` estimate instead of
     * a booked charge.
     */
    contextVerdict(stageId: string, modelKey: string, contextTokens: number, planId?: string, options?: {
        dryRun?: boolean;
    }): ContextDecision;
    /**
     * The dry-run answer: the branch the switch **would** take, and what compressing
     * would cost — with zero side effects (no compressor call, no ledger event).
     *
     * When a compressor is wired the context is assumed to reach the compression
     * target (`refuseShare×W`, the number the compressor is given and the one its
     * own check is measured against), so the projection is the switch that will
     * actually happen if compression succeeds; the real `compress()` result can
     * still come back worse, and the live path refuses then. When no compressor is
     * wired the projection says what the switch says today: refused, three options.
     */
    private predictContext;
    /**
     * Builds the plan card. Nothing runs yet: the caller must get the plan
     * approved (`approvePlan`) before switching, which is the D-004 gate.
     *
     * N-3: an empty registry — or a registry where **no model states a price** —
     * must still produce a card. It used to throw `no baseline model`, and the UI
     * can only render a throw as a blank error, which made "you have not
     * configured anything yet" look exactly like a bug. Now the card comes back
     * with the missing stages named, `price unknown` on the money, and a reason
     * the UI turns into "先完成向导".
     */
    plan(request: RunRequest): StagePlan;
    /** Why a stage of this plan has no model, in the words the card shows. */
    unassignedReason(planId: string, stageId: string): string | undefined;
    /**
     * Every stage of a plan, in task order, **assigned or not**.
     *
     * This is what `/router/plan` serializes. Returning only the assigned stages
     * made the endpoint answer `stages: []` on a host whose models were not
     * discovered — a card with rows and a payload with nothing, which is both the
     * reported "阶段列表是空的" and the reason the per-stage model change had no
     * row to change.
     */
    planStageRows(planId: string): PlanStageRow[];
    /**
     * The card the UI renders: rows, alternatives per row, totals with the ± band.
     *
     * Built from the plan, never from scratch: the client is not allowed to
     * compute money, so the numbers it shows are the numbers the ledger will
     * compare against.
     */
    planCard(planId: string): PlanCard;
    /** Card for a plan this host already holds. */
    private cardFor;
    /**
     * The guard's answer for one row of a plan, asked with that plan's own
     * numbers. A model nobody holds is a refusal, not an unanswerable question.
     *
     * The price rule comes from the plan's pricing stance, not from the guard's
     * own default: on a host that prices nothing the guard is relaxed **here** and
     * the card says the estimate is unavailable. On a mixed catalog it stays
     * strict unless the plan opted in — `price-unknown` is unchanged (灰狼's
     * acceptance item quotes it).
     */
    stageVerdict(planId: string, stageId: string, modelKey: string): GuardResult;
    /**
     * The user picked another model for one stage, before starting.
     *
     * Allowed only while the plan is unapproved: once a run is approved, changing
     * a row would silently rewrite what the user agreed to. After approval the
     * route is `switchForStage`, which records a deviation.
     */
    swapStageModel(planId: string, stageId: string, modelKey: string): PlanCard;
    /**
     * Arms the global-default watch (K-003) and returns what it saw.
     *
     * `DshModelAdapter.primeGlobalDefault()` has existed since M1-3FIX but nothing
     * ever called it, so the first switch of every session compared against a
     * baseline captured at construction. A default edited in settings meanwhile
     * would be blamed on the switch, or a real write-back missed. Called at the
     * start of a run and before each switch, the warning stays honest.
     */
    primeGlobalDefault(): string | undefined;
    /**
     * The user confirmed the plan. Until this runs, no switch is honoured.
     *
     * A plan with stages that have no model cannot be approved: "确认开工" on a
     * card that cannot run would start a run that stalls on stage 1. The refusal
     * carries the reason, so the UI can point at the wizard.
     *
     * `options.allowUnknownPricing` is the confirm-time opt-in: it is recorded on
     * the plan **before** the pre-check, so the check that runs here is the same
     * one the next switch will run. Absent, the plan's own stance decides — which
     * on a host with no prices at all is already "allow, and say so".
     */
    approvePlan(plan: StagePlan, options?: {
        allowUnknownPricing?: boolean;
    }): StagePlan;
    getPlan(planId: string): StagePlan | undefined;
    /** Plan-card footer: total cost and savings with the advertised ± band. */
    planTotals(plan: StagePlan): {
        total: CostEstimate;
        line: string;
    };
    /**
     * Moves the session onto the model a stage needs.
     *
     * The plan gate is **default-deny** (D-004): a switch with no planId is not
     * "unmanaged", it is refused. Auto-switching without a plan the user saw is
     * exactly the "发消息即跑" behaviour this project keeps out.
     *
     * Also refuses (instead of truncating) when the target cannot hold the
     * context, or when the stage is not part of the plan. After the platform says
     * yes we read the session back: "switched: true" is only reported for a
     * switch we can observe.
     */
    switchForStage(stageId: string, targetKey: string, contextTokens: number, expectedOutputTokens: number, requiredCapabilities?: CapabilityKind[], planId?: string, options?: {
        allowUnknownPricing?: boolean;
        /**
         * The session the request resolved. Passed down explicitly so a concurrent
         * request cannot change which session this switch acts on between the
         * resolve and the platform call.
         */
        sessionId?: string;
    }): Promise<SwitchResult>;
    /**
     * F5 for one switch: reads the target window, picks the branch, and — when the
     * branch is `compress` — asks the host's compressor for the handover.
     *
     * The compressor is injected (`RouterDeps.compress`) because the kernel may not
     * own a compaction engine (F5 §7): DSH already has `compaction-basic`,
     * `/compact` and `summarizationProvider/Model`. This function is the *timing*
     * and the *checks*; `NoneCompressor` is what runs when no host supplies one,
     * and it refuses rather than pretending the context got smaller.
     */
    private decideContextFor;
    /** The five-field handover for a stage; an empty skeleton when nobody wrote one. */
    private handoverFor;
    /** Runs the switch, reporting whether the global default moved with it. */
    private selectAndWatchGlobalDefault;
    /** User-facing sentence for a global-default write-back (never silent). */
    private writeBackWarning;
    /**
     * Explicit opt-out of the plan gate, for a stepper with no planning step at
     * all (a CLI one-off, tests). It is deliberately a different method name: a
     * caller has to type "noPlan" to run unmanaged, and the ledger says so.
     */
    switchWithoutPlan(stageId: string, targetKey: string, contextTokens: number, expectedOutputTokens: number, requiredCapabilities?: CapabilityKind[]): Promise<SwitchResult>;
    /**
     * Records a finished stage using **actual** usage and the real price.
     * A stage whose model has no price is counted, not priced.
     */
    recordStageEnd(params: {
        stageId: string;
        modelKey: string;
        inputTokens: number;
        outputTokens: number;
        planId?: string;
    }): void;
    /** F6: the band this run's next estimate should advertise, from what it learned. */
    calibratedBand(): number;
    /**
     * F6 §1: one row's estimate with its token and money intervals.
     *
     * The card shows the amount; this is what a caller shows when it needs to say
     * "about this much, somewhere between these two numbers, and here is why".
     */
    estimateInterval(planId: string, stageId: string): EstimateWithInterval | undefined;
    /** F6 §1: the sentence that says what the band means, next to every estimate. */
    estimateErrorStatement(): string;
    /** F6: the raw calibration state, for the acceptance test and the status bar. */
    calibrationState(): CalibrationState;
    /**
     * F6 §4 as a checkable sentence: does the real bill sit inside the interval the
     * plan advertised?
     *
     * Returned as data (not a boolean) because the honest answer has three cases:
     * inside, outside, and "cannot say, price unknown" — and the last one must not
     * be rendered as "inside".
     */
    reconcile(planId: string): ReconcileReport;
    /** F6 §3: which models never enter the savings figure, and why. */
    savingsExclusions(planId: string): SavingsExclusion;
    /**
     * Plan gate: approved? stage ours? model on plan?
     *
     * `planId === undefined` is a refusal, not a bypass. The one exception is the
     * explicit `UNPLANNED_RUN` marker from `switchWithoutPlan`.
     */
    private planGate;
    /** Baseline the wizard confirmed, if any. Overrides usage-based guessing. */
    private baselineOverride?;
    /**
     * Pins the savings baseline (the wizard's "你过去最常用" answer).
     *
     * In memory only: the host never writes DSH settings, so confirming a wizard
     * and walking away leaves the user's environment untouched (铁律 3).
     */
    setBaseline(key: string | undefined): void;
    /** The baseline a plan would use right now, wizard answer first. */
    baselineFor(usage?: Record<string, number>): string | undefined;
    /** The plan the status bar follows: last one built or started, if approved. */
    activePlan(): StagePlan | undefined;
    /** Model the session is on right now, straight from the adapter. */
    currentModel(): string;
    /** Human label for a model key; the key itself when we have no entry. */
    labelOf(modelKey: string): string;
    /** Global default as the adapter can see it, or undefined when it cannot. */
    observeGlobalDefault(): string | undefined;
    /** Actual charge booked for one stage of one plan, or null when unknown. */
    stageCost(stageId: string, planId: string): number | null;
    /** Registers discovered models, letting adapters stay the only source. */
    registerModels(models: ModelEntry[], availableKeys?: string[]): void;
    /** Key the registry would use for a model, exposed for hosts and tests. */
    static keyOf(provider: string, model: string): string;
    /**
     * Registers models from several sources at once, merging duplicates.
     * Deliberately does not touch DSH config: sources arrive already read.
     *
     * Availability travels with each entry: a probe verdict ("dead") is never
     * lost because a merge forgot to carry `availableKeys` (N-1). Two signals are
     * ANDed — the caller's list and what the merge worked out per entry — so a
     * model only counts as available when both say yes.
     */
    registerFromSources(batches: {
        source: CapabilitySource;
        models: ModelEntry[];
    }[], availableKeys?: string[]): {
        entries: CapabilityEntry[];
        conflicts: number;
    };
    /** Data layer for the install wizard. Read-only: renders, never writes. */
    wizardDraft(input?: {
        logs?: SessionCallRecord[];
        days?: number;
        deadEndpoints?: string[];
    }): WizardDraft;
    /** Usage counts in the shape `plan()` wants — one hop, no re-parsing. */
    usageCountsFrom(logs: SessionCallRecord[], days?: number): Record<string, number>;
}
export type { ModelEntry, StagePlan, CostEstimate } from '../core/types.js';
export declare class RouterSession {
    private readonly host;
    /** Per-plan cursor, per-stage status, and the stages whose money is unknown. */
    private readonly cursors;
    constructor(host: PluginHost);
    /** The plan the status bar follows. */
    activePlan(): StagePlan | undefined;
    state(planId?: string): RouterState;
    /** Marks the plan as started: stage 1 becomes current. Idempotent. */
    start(planId: string): RouterState;
    /**
     * The stage ended. Moves the cursor, and books the money if tokens are given.
     *
     * `actual` usage wins over any plan-time estimate. A stage that reports done
     * **without** token counts is not booked, and the state says so (`unbooked`):
     * recording "done, $0.0000" made the wallet look free (B2). The stage still
     * finishes — a host that cannot count tokens must not be stuck — but nothing
     * on screen may imply the run was costed.
     */
    finish(params: {
        planId: string;
        stageId: string;
        modelKey: string;
        inputTokens?: number;
        outputTokens?: number;
        failed?: boolean;
    }): RouterState;
    /**
     * Marks a stage as the running one. Called when its switch succeeds.
     *
     * Idempotent and order-tolerant: asking for a stage that already ran is not an
     * error, it just does not move anything backwards.
     */
    advance(planId: string, stageId: string): RouterState;
}
/** One stage in the wizard, as shown. Read-only data: nothing is written. */
export interface WizardStageRow {
    provider: string;
    count: number;
    keys: string[];
    sources: string[];
    reachable: boolean;
    /** True when the user still has to decide something about this provider. */
    needsAttention: boolean;
}
/** The wizard, minimal version: show what was found, confirm the two guesses. */
export interface WizardView {
    /** Models found, grouped by provider. */
    stages: WizardStageRow[];
    totalModels: number;
    /** Guessed most-used model, or undefined when there is nothing to guess. */
    baselineKey?: string;
    baselineBasis: 'usage' | 'price-fallback' | 'none';
    /** One line about usage, safe to show (counts only, never prompt text). */
    usageLine: string;
    /** Questions the user must answer; each maps to one checkbox/confirm. */
    questions: {
        kind: string;
        title: string;
        detail: string;
        keys: string[];
    }[];
    /** False when there is nothing to confirm yet (no models, no baseline). */
    ready: boolean;
    /** The draft this view came from — carried back on confirm. */
    draft: WizardDraft;
}
/**
 * Read-only wizard view. The host renders this; it never writes DSH config.
 *
 * Minimal on purpose (P1): "能看能确认". The draft answers *what was found and
 * what we guessed*; confirming records the outcome so the next task is planned
 * with the user's baseline instead of our fallback.
 */
export declare function buildWizardView(draft: WizardDraft): WizardView;
/** What confirming the wizard changes. One field, so it is easy to reason about. */
export interface WizardConfirmation {
    baselineKey: string;
    basis: 'usage' | 'price-fallback' | 'none';
    confirmedAt: string;
    totalModels: number;
}
/**
 * Records the wizard outcome and switches the host's baseline to it.
 *
 * Confirming is not writing settings: the host stores the baseline in memory,
 * so an install that is confirmed and then abandoned leaves the user's DSH
 * exactly as it was (铁律 3). The baseline is also refused when it names a
 * model the registry does not have — a typo must not become the savings anchor.
 */
export declare function confirmWizard(host: PluginHost, draft: WizardDraft, baselineKey?: string): {
    confirmation: WizardConfirmation;
    card: PlanCard | null;
};
//# sourceMappingURL=index.d.ts.map