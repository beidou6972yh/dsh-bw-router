import type { CostEstimate, GuardResult, StagePlan } from './types.js';
import type { PricingStatus } from './pricing.js';
/**
 * The plan card as **data**, before any rendering.
 *
 * Host half and client half must agree on what a card says, and the client is
 * not allowed to invent numbers: every figure here comes from an estimate. So
 * the shape lives in core, is built once by the host, and the UI only arranges
 * it. That also makes "card and execution stages are 1:1" testable without a
 * browser — every row carries the `stageId` the switch call will use.
 */
/** One stage row. A row without a model is a row the user must resolve. */
export interface PlanCardRow {
    stageId: string;
    /** 1-based position, so the card and the status bar count the same way. */
    index: number;
    title: string;
    optional: boolean;
    goal: string;
    capability: string;
    /** null = no model assigned (empty registry, or nothing qualified). */
    modelKey: string | null;
    /** Human label for the picker; falls back to the key when we have no entry. */
    modelLabel: string;
    reason: string;
    /** Formatted cost line for this stage. */
    cost: string;
    /** Raw numbers, for a caller that wants to re-render or re-total. */
    estimate: CostEstimate;
    /** Set when the user swapped this stage's model; provenance for the ledger. */
    switchedAt?: string;
    /** Models the user may switch this row to: same capability, still available. */
    alternatives: {
        key: string;
        label: string;
    }[];
    /**
     * What `guardSwitch` will answer when this stage's switch runs — same
     * function, same numbers. Absent means nobody pre-checked the row, and an
     * unchecked row is not a promise.
     */
    guard?: GuardResult;
}
export interface PlanCard {
    planId: string;
    title: string;
    rows: PlanCardRow[];
    /** `合计 ~$0.1234 ±35% (save 41% vs baseline) · baseline deepseek/flash` */
    footer: string;
    /** Stages with no model, in the words the card uses. */
    blockers: string[];
    /**
     * True only when nothing blocks: the confirm button is meaningful.
     *
     * A1: a model per stage is not enough. Every row is pre-checked with the same
     * guard the switch uses, so a card cannot say "可开工" for a plan whose next
     * switch is refused for an unconfirmed window. When nobody pre-checked the
     * rows (a caller that built the plan without a registry), the old rule holds:
     * one model per stage.
     */
    canStart: boolean;
    /** True when the wizard must run first (no models known at all). */
    needsWizard: boolean;
    /**
     * Whether every row was pre-checked with the guard. False means the numbers
     * were missing (a plan built without a registry), so `canStart` is false for
     * the reason "unchecked", not "broken" — the card says which.
     */
    checked: boolean;
    skippable: boolean;
    baselineModelKey: string | null;
    /**
     * The pricing stance this card was checked with (铁律 5, honest-degradation
     * form). Present on every card; the money line is only a number when
     * `requireKnownPricing` is true **and** every row has a price.
     *
     * 灰狼真机硬阻断: a host whose provider config states no prices used to make
     * every plan unstartable. The card now says out loud that the estimate is
     * unavailable and the tokens are still booked — silence there would let a
     * reader take "price unknown" for "free".
     */
    pricing: PricingStatus;
    /**
     * `pricing.notice` when the stance is relaxed (also appended to `footer`).
     * Absent means "the money line is real", not "we did not think about money".
     */
    pricingNotice?: string;
}
export interface BuildPlanCardInput {
    plan: StagePlan;
    /** Labels by model key; missing keys fall back to the key itself. */
    labels?: Record<string, string>;
    /** Candidate keys per stage, already filtered to same-capability and available. */
    alternatives?: Record<string, {
        key: string;
        label: string;
    }[]>;
    /** Pre-checked verdict per stage id; see `PlanCardRow.guard`. */
    guards?: Record<string, GuardResult>;
    /** The pricing stance the guards were checked with (see `PlanCard.pricing`). */
    pricing?: PricingStatus;
}
/** Builds the card. Pure: the same plan always produces the same card. */
export declare function buildPlanCard(input: BuildPlanCardInput): PlanCard;
/** Wallet line for the status bar: what has actually been booked so far. */
export declare function formatSpent(actualCost: number, unpricedStages: number): string;
/**
 * Re-issues a card after the user picks another model for one stage.
 *
 * The estimate is recomputed with the **same** token counts and baseline, so
 * "change the model, the number follows" is a property of this function rather
 * than something the UI has to remember to do. An unknown key is refused: the
 * card never shows a model that is not in the capability list.
 */
export declare function withSwappedModel(card: PlanCard, stageId: string, swap: {
    modelKey: string;
    modelLabel: string;
    estimate: CostEstimate;
}): PlanCard;
/** One stage in the status bar, as data. */
export interface StatusStage {
    stageId: string;
    /** 1-based. */
    index: number;
    title: string;
    modelKey: string;
    modelLabel: string;
    status: 'pending' | 'running' | 'done' | 'failed';
    /** Money already booked for this stage; absent until it finishes priced. */
    actualCost?: number;
}
/**
 * Everything the status bar draws, and nothing it does not know.
 *
 * `active: false` means "render nothing". A bar that says "第 1/3 段" for a task
 * the user never started is fake information — the previous project shipped
 * exactly that (every session saw the newest plan).
 */
export interface RouterState {
    /** False when there is no approved plan: the UI renders no bar at all. */
    active: boolean;
    planId?: string;
    total: number;
    /** 0-based index of the current stage; 0 with nothing started looks the same. */
    cursor: number;
    stages: StatusStage[];
    current?: StatusStage;
    next?: {
        stageId: string;
        title: string;
        modelKey: string;
        modelLabel: string;
    };
    /** Model the session is on right now, read back from the adapter. */
    sessionModel: string;
    sessionModelLabel: string;
    spent: {
        actualCost: number;
        unpricedStages: number;
        estimatedCost: number;
        savings: number | null;
    };
    /**
     * The pricing stance in force (see `PlanCard.pricing`).
     *
     * Present even when no plan is approved: "this host states no prices, so the
     * bar's money is tokens-only" is a property of the machine, not of the run.
     * `spent.actualCost` stays `0` with `unpricedStages > 0` — never a total that
     * looks like a bill when some stages had no price.
     */
    pricing?: PricingStatus;
    /** undefined when the watcher cannot see it — never a fake "unchanged". */
    globalDefault: string | undefined;
    globalDefaultWriteBacks: number;
    /** One-off notices, e.g. the global default moving with a switch (K-003). */
    notices: string[];
    /**
     * Stages that ended without token counts, so their cost is missing from
     * `spent.actualCost`. Empty is the normal case; non-empty means the total is a
     * floor, and the bar must not print it as if it were the bill (B2).
     */
    unbookedStages?: string[];
}
/**
 * `[路由] 第 2/3 段 · 当前 DeepSeek Flash · 已花 $0.0060 · 下一段：出图/PPT`
 *
 * The spec's one-line bar. Kept honest where the spec is loose: it says "待开工"
 * before stage 1 rather than pretending a stage is running, and it prints the
 * real booked amount, not the plan-time guess.
 */
export declare function renderStatusBar(state: RouterState): string | null;
//# sourceMappingURL=card.d.ts.map