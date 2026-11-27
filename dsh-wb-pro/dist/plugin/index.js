import { estimateStage, estimateWithoutModel, formatEstimate, sumEstimates, } from '../core/budget.js';
import { normalizeModelKey } from '../adapters/dsh-model.js';
import { decideModel, decidePlan } from '../core/decider.js';
import { guardSwitch, singleShotMaxTokens } from '../core/guard.js';
import { DEFAULT_CONTEXT_THRESHOLDS, compactionNotice, decideContext, emptyHandover, handoverComplete, readThresholds, renderHandover, validateHandover, } from '../core/context-guard.js';
import { BASE_UNCERTAINTY, calibratedUncertainty, costInterval, emptyCalibration, errorStatement, observeStage, savingsExclusion, tokenInterval, } from '../core/calibration.js';
import { Ledger } from '../core/ledger.js';
import { buildStages } from '../core/planner.js';
import { catalogHasPrices, parsePricingPolicy, resolvePricing, } from '../core/pricing.js';
import { Registry, buildCapabilityList, pickBaseline } from '../core/registry.js';
import { collectUsage, usageCounts } from '../core/usage-stats.js';
import { buildPlanCard, } from '../core/card.js';
import { buildWizardDraft } from '../core/wizard-draft.js';
import { availableAnd, costOf, modelKey, nowIso } from '../core/types.js';
/** Thrown when a caller asks for something the host cannot do. */
export class RouterError extends Error {
    code;
    details;
    constructor(
    /** Stable machine code the HTTP layer turns into a status. */
    code, message, 
    /** Extra fields the endpoint returns alongside the message. */
    details = {}) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'RouterError';
    }
}
/**
 * Marker for a run that has no plan at all. Only `switchWithoutPlan` uses it:
 * the plan gate refuses a missing planId, and an explicit opt-in has to be
 * spelled out rather than defaulted into.
 */
export const UNPLANNED_RUN = 'unplanned';
/** Host half of the DSH plugin: wires core modules to one adapter. */
export class PluginHost {
    selection;
    registry = new Registry();
    ledger = new Ledger();
    /** Plans this host built, by planId. A switch must belong to one of them. */
    plans = new Map();
    /** Per-plan, per-stage explanation for stages with no model (N-4). */
    unassigned = new Map();
    /**
     * Every stage of every plan, assigned or not.
     *
     * The plan used to keep only the **assigned** stages, so a host with no models
     * produced `stages: []` — the external tester's fourth defect ("只有卡片行，
     * 换模型也改不了"). The full list is what lets `/router/plan` answer one row per
     * stage and lets `swapStageModel` fill a gap instead of answering
     * `unknown-stage`.
     */
    stageDefs = new Map();
    /** Per-plan, per-stage numbers the guard will be asked with (A1/A2). */
    stageInputs = new Map();
    /** Which plan the status bar is following. Last plan built or switched wins. */
    activePlanId;
    planSeq = 0;
    /** F5 thresholds (70/50/16 by default, configurable, never hardcoded). */
    contextThresholds = DEFAULT_CONTEXT_THRESHOLDS;
    /** Notes about thresholds a config asked for and could not have, for the UI. */
    thresholdNotes = [];
    /** The host's compaction hook; undefined = "this host cannot compress". */
    compressor;
    /** Whether an over-full switch can compress here (F5 / DEF-1). Public: it is a fact, not a nicety. */
    get compressorWired() {
        return this.compressor !== undefined;
    }
    /** Handovers written for a stage, keyed `${planId}:${stageId}`. */
    handovers = new Map();
    /** Notice produced by the compression belt of the switch in flight (F5 §5). */
    pendingCompactionNotice;
    /** F6: what this run's estimates have been compared against, so far. */
    calibration = emptyCalibration();
    /**
     * How hard this host insists on a known price (铁律 5, honest-degradation
     * form). `auto` = let the catalog decide; see `src/core/pricing.ts`.
     */
    pricingPolicy;
    /**
     * Plans a caller explicitly allowed to use unpriced models.
     *
     * Keyed by planId on purpose: "I accept an unpriceable run for this task" is a
     * decision about one plan. A global flag would let one prompt repeal 铁律 5
     * for every later run in the process.
     */
    pricingOptIn = new Map();
    constructor(selection, options = {}) {
        this.selection = selection;
        if (options.contextThresholds) {
            const { thresholds, adjusted } = readThresholds(options.contextThresholds);
            this.contextThresholds = thresholds;
            this.thresholdNotes.push(...adjusted);
        }
        if (options.compressor)
            this.compressor = options.compressor;
        this.pricingPolicy = parsePricingPolicy(options.pricingPolicy);
    }
    /**
     * Sets the pricing stance after construction (the shell reads it from the
     * host's config; a test sets it directly). Same parsing as the constructor.
     */
    setPricingPolicy(policy) {
        this.pricingPolicy = parsePricingPolicy(policy);
    }
    /** The stance in force, without a plan/request context. */
    get pricing() {
        return resolvePricing({
            catalogHasPrices: catalogHasPrices(this.registry.all().map((entry) => entry.model)),
            policy: this.pricingPolicy,
        });
    }
    /**
     * The stance that applies to one plan: host policy + catalog + that plan's
     * opt-in (and, when given, an explicit flag on this very request).
     *
     * One function for card, confirm and switch, so the three cannot disagree
     * about whether this run may contain an unpriced model.
     */
    pricingFor(planId, requestedAllowUnknown) {
        return resolvePricing({
            catalogHasPrices: catalogHasPrices(this.registry.all().map((entry) => entry.model)),
            policy: this.pricingPolicy,
            // An explicit request flag wins over a stored plan flag in the "allow"
            // direction only; neither can override a host `strict` (see resolvePricing).
            requestedAllowUnknown: requestedAllowUnknown === true || (planId !== undefined && this.pricingOptIn.get(planId) === true),
        });
    }
    /** Records (or clears) a plan's explicit permission to run unpriced models. */
    allowUnknownPricingFor(planId, allowed) {
        if (allowed)
            this.pricingOptIn.set(planId, true);
        else
            this.pricingOptIn.delete(planId);
    }
    /** Thresholds in force, as fractions of the target window. */
    get thresholds() {
        return this.contextThresholds;
    }
    /** What a config asked for and did not get (empty in the normal case). */
    get thresholdAdjustments() {
        return [...this.thresholdNotes];
    }
    /** Wires a compressor after construction (the DSH shell does this). */
    setCompressor(compressor) {
        this.compressor = compressor;
    }
    /** Wires the host's async compaction hook (DEF-1); undefined = cannot compress. */
    setCompactionHook(hook) {
        this.compactHook = hook;
    }
    /** True when an over-full switch can actually compress here (DEF-1). */
    get canCompress() {
        return this.compressorWired;
    }
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
    async warmCompression(stageId, target, contextTokens, planId, sessionId) {
        const hook = this.compactHook;
        if (!hook)
            return;
        const branch = decideContext({
            contextTokens,
            windowTokens: target.limits.contextWindow,
            thresholds: this.contextThresholds,
        });
        // Only the compress band needs a compaction. `direct`/`summary` switch as-is,
        // and `refuse` is decided by `decideContextFor` (which books it).
        if (branch.action !== 'compress')
            return;
        const handover = this.handoverFor(stageId, planId);
        const rendered = renderHandover(handover, validateHandover(handover));
        try {
            const result = await hook({
                rendered,
                tokensBefore: contextTokens,
                targetModelKey: target.id,
                // Threaded through rather than read from mutable state: a concurrent
                // request must not be able to change which session this compresses.
                ...(sessionId === undefined ? {} : { sessionId }),
            });
            this.warmed = result;
            this.warmFailure = undefined;
        }
        catch (error) {
            // Kept for the refusal sentence; nothing is warmed, so `decideContextFor`
            // cannot mismeasure a compression that did not happen.
            this.warmed = undefined;
            this.warmFailure = error instanceof Error ? error.message : String(error);
        }
    }
    /** Why the last warm-up produced nothing, for the refusal sentence. */
    warmFailure;
    /** The compaction warmed for the switch in flight, consumed once (DEF-1). */
    warmed;
    /** Host's async compaction (DEF-1). */
    compactHook;
    /** Records the staged handover a compression will be asked to preserve (F5 §3). */
    setHandover(stageId, handover, planId) {
        const problems = validateHandover(handover);
        this.handovers.set(`${planId ?? ''}:${stageId}`, handover);
        this.ledger.append({
            type: 'stage-start',
            ...(planId === undefined ? {} : { planId }),
            stageId,
            detail: `handover recorded (${problems.length === 0 ? 'all five fields present' : `missing: ${problems
                .map((p) => p.field)
                .join(',')}`})`,
        });
        return handover;
    }
    /** F5 §4: which of the five fields this stage's handover is missing (empty = ok). */
    handoverProblems(planId, stageId) {
        return validateHandover(this.handoverFor(stageId, planId));
    }
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
    contextVerdict(stageId, modelKey, contextTokens, planId, options = {}) {
        const entry = this.registry.get(modelKey);
        if (!entry) {
            return decideContext({
                contextTokens,
                windowTokens: 1,
                thresholds: this.contextThresholds,
            });
        }
        if (options.dryRun)
            return this.predictContext(entry.model, contextTokens);
        return this.decideContextFor(stageId, entry.model, contextTokens, planId);
    }
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
    predictContext(target, contextTokens) {
        const first = decideContext({
            contextTokens,
            windowTokens: target.limits.contextWindow,
            thresholds: this.contextThresholds,
        });
        if (first.action !== 'compress')
            return first;
        if (!this.compressor) {
            const blocked = decideContext({
                contextTokens,
                windowTokens: target.limits.contextWindow,
                thresholds: this.contextThresholds,
                tokensAfterCompaction: contextTokens,
            });
            return { ...blocked, message: `${blocked.message} (dry run: no compressor is wired)` };
        }
        // What compressing would bill for re-reading this context. The compressing
        // model is the host's choice (D-006 is still open), so the projection uses the
        // target model's price for the input side and says the figure is predicted —
        // it is never booked, and `null` when that price is unknown is honest.
        const window = target.limits.contextWindow;
        const projected = Math.max(1, Math.floor(window * this.contextThresholds.refuseShare));
        const decision = decideContext({
            contextTokens,
            windowTokens: window,
            thresholds: this.contextThresholds,
            tokensAfterCompaction: projected,
        });
        return {
            ...decision,
            predictedCompactionCost: costOf(target.pricing, contextTokens, 0),
            dryRun: true,
            message: `${decision.message} (dry run: nothing compressed, nothing booked)`,
        };
    }
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
    plan(request) {
        const planId = `plan-${request.taskId}-${++this.planSeq}`;
        const stages = buildStages({
            taskId: request.taskId,
            planId,
            summary: request.summary,
            stageNames: request.stageNames,
            estimatedInputTokens: request.estimatedInputTokens,
            estimatedOutputTokens: request.estimatedOutputTokens,
        });
        const entries = this.registry.all();
        const baseline = pickBaseline(entries, request.usage ?? {});
        // The wizard's answer wins over the usage guess: the user said so out loud.
        const baselineKey = this.baselineOverride ?? baseline.key;
        const baselineIsGuess = this.baselineOverride
            ? false
            : baselineKey !== undefined && baseline.isGuess;
        const baselineModel = baselineKey ? this.registry.get(baselineKey)?.model : undefined;
        // F6: the band the card advertises is the band this run has earned. On a
        // fresh run that is the base ±35%; after a stage has been billed it is the
        // measured error, so the second card is narrower (or honestly wider) than the
        // first. A constant band is a decoration; a calibrated one is a claim.
        const band = this.calibratedBand();
        const unavailable = entries.filter((e) => !e.available).map((e) => e.key);
        const decided = decidePlan(stages, entries, {
            pinned: request.pinned,
            exclude: unavailable,
        });
        // What the session will hold when each stage starts: the task input plus
        // every token the earlier stages have burned, since a stage runs on the
        // conversation its predecessor left behind (上下文不断片). The card is
        // checked with these numbers and the switch is asked with the same ones
        // (A1) — two places guessing separately is how the card said "可开工" while
        // the switch was refused for an unconfirmed window on every stage.
        //
        // Computed for **every** stage, assigned or not: a stage that has no model
        // yet still needs the numbers it will be checked with the moment the user
        // picks one (`swapStageModel` fills the gap), and the numbers must not
        // depend on whether a *neighbour* happened to be assigned.
        let carriedInput = Math.max(0, request.contextTokens ?? 0);
        let carriedOutput = 0;
        const guardInputsByStage = new Map();
        for (const stage of stages) {
            guardInputsByStage.set(stage.id, {
                contextTokens: carriedInput + carriedOutput,
                // The model is not known yet for an unassigned stage; the stage's own
                // budget is the honest upper bound, and `swapStageModel` re-derives it
                // from the model the user actually picks.
                expectedOutputTokens: stage.estimatedOutputTokens,
            });
            carriedInput += stage.estimatedInputTokens;
            carriedOutput += stage.estimatedOutputTokens;
        }
        this.stageDefs.set(planId, stages);
        this.stageInputs.set(planId, guardInputsByStage);
        const assignments = decided.assignments.map(({ stage, decision }) => {
            const model = this.registry.get(decision.modelKey)?.model;
            const planned = guardInputsByStage.get(stage.id);
            const guardInputs = {
                contextTokens: planned?.contextTokens ?? 0,
                expectedOutputTokens: model
                    ? singleShotMaxTokens(stage.estimatedOutputTokens, model)
                    : (planned?.expectedOutputTokens ?? stage.estimatedOutputTokens),
            };
            return {
                stage,
                modelKey: decision.modelKey,
                reason: decision.reason,
                estimate: model
                    ? estimateStage({
                        model,
                        baseline: baselineModel ?? null,
                        inputTokens: stage.estimatedInputTokens,
                        outputTokens: stage.estimatedOutputTokens,
                        uncertainty: band,
                    })
                    : estimateWithoutModel({
                        inputTokens: stage.estimatedInputTokens,
                        outputTokens: stage.estimatedOutputTokens,
                        uncertainty: band,
                    }),
                guardInputs,
            };
        });
        // A stage nobody could take is reported, never dropped: a card that quietly
        // loses a stage looks complete while the run can never start (N-4). The
        // stage's own name and capability travel with the gap so the row can be
        // titled with the work and can offer the models that would fill it.
        const stageById = new Map(stages.map((stage) => [stage.id, stage]));
        const gaps = decided.unassigned.map((gap) => ({
            stageId: gap.stageId,
            reason: gap.reason,
            message: gap.message,
            ...(stageById.has(gap.stageId)
                ? { name: stageById.get(gap.stageId).name, capability: stageById.get(gap.stageId).capability }
                : {}),
        }));
        const plan = {
            taskId: request.taskId,
            planId,
            summary: request.summary,
            stages: assignments,
            baselineModelKey: baselineKey ?? '',
            baselineIsGuess: baselineKey ? baselineIsGuess : true,
            createdAt: nowIso(),
            errorStatement: this.estimateErrorStatement(),
            ...(gaps.length > 0
                ? {
                    unassignedStages: gaps.map(({ stageId, reason, ...rest }) => ({
                        stageId,
                        reason,
                        ...('name' in rest && rest.name ? { name: rest.name } : {}),
                        ...('capability' in rest && rest.capability ? { capability: rest.capability } : {}),
                    })),
                }
                : {}),
        };
        this.plans.set(planId, plan);
        this.unassigned.set(planId, new Map(gaps.map((gap) => [gap.stageId, gap.message])));
        // The opt-in travels with the plan, so the card and the confirm that follow
        // ask the same question with the same answer instead of re-deciding it.
        if (request.allowUnknownPricing === true)
            this.pricingOptIn.set(planId, true);
        this.activePlanId = planId;
        const detail = gaps.length > 0
            ? `${assignments.length}/${stages.length} stages assigned, no usable model for the rest`
            : `${assignments.length} stages, baseline ${baselineKey}${baselineIsGuess ? ' (guessed)' : ''}`;
        this.ledger.append({ type: 'plan-created', planId, detail });
        return plan;
    }
    /** Why a stage of this plan has no model, in the words the card shows. */
    unassignedReason(planId, stageId) {
        return this.unassigned.get(planId)?.get(stageId);
    }
    /**
     * Every stage of a plan, in task order, **assigned or not**.
     *
     * This is what `/router/plan` serializes. Returning only the assigned stages
     * made the endpoint answer `stages: []` on a host whose models were not
     * discovered — a card with rows and a payload with nothing, which is both the
     * reported "阶段列表是空的" and the reason the per-stage model change had no
     * row to change.
     */
    planStageRows(planId) {
        const plan = this.plans.get(planId);
        if (!plan)
            throw new RouterError('unknown-plan', `unknown plan "${planId}", ask for a plan first`);
        const definitions = this.stageDefs.get(planId) ?? plan.stages.map((assignment) => assignment.stage);
        const assigned = new Map(plan.stages.map((assignment) => [assignment.stage.id, assignment]));
        return definitions.map((stage) => {
            const assignment = assigned.get(stage.id);
            return {
                stage,
                ...(assignment ? { assignment } : {}),
                ...(assignment
                    ? {}
                    : {
                        unassignedReason: this.unassigned.get(planId)?.get(stage.id) ??
                            plan.unassignedStages?.find((gap) => gap.stageId === stage.id)?.reason ??
                            'no model assigned',
                    }),
            };
        });
    }
    /**
     * The card the UI renders: rows, alternatives per row, totals with the ± band.
     *
     * Built from the plan, never from scratch: the client is not allowed to
     * compute money, so the numbers it shows are the numbers the ledger will
     * compare against.
     */
    planCard(planId) {
        const plan = this.plans.get(planId);
        if (!plan)
            throw new RouterError('unknown-plan', `unknown plan "${planId}", ask for a plan first`);
        return this.cardFor(plan);
    }
    /** Card for a plan this host already holds. */
    cardFor(plan) {
        const labels = {};
        for (const entry of this.registry.all())
            labels[entry.key] = entry.model.label;
        // Each row offers every **available** model that does the same capability,
        // which is what "每段可换模型" means: not just the recommended one.
        const alternatives = {};
        // Where each row stands with the guard, checked now with the same inputs the
        // switch will use. A model per stage is not "可开工" (A1).
        const guards = {};
        const assigned = new Map(plan.stages.map((assignment) => [assignment.stage.id, assignment]));
        // Every stage, assigned or not: an unassigned row is precisely the row the
        // user has to pick a model for, so it needs the picker too (DEF-4).
        const definitions = this.stageDefs.get(plan.planId) ?? plan.stages.map((assignment) => assignment.stage);
        for (const stage of definitions) {
            alternatives[stage.id] = this.registry
                .byCapability(stage.capability)
                .filter((entry) => entry.available)
                .map((entry) => ({ key: entry.key, label: entry.model.label }));
            const assignment = assigned.get(stage.id);
            if (assignment) {
                guards[stage.id] = this.stageVerdict(plan.planId, stage.id, assignment.modelKey);
            }
        }
        // 铁律 5, honest-degradation form: the card is checked with one stance and
        // carries that same stance (and its notice), so a relaxed guard is never a
        // silent one and a strict refusal is never unexplained.
        return buildPlanCard({
            plan,
            labels,
            alternatives,
            guards,
            pricing: this.pricingFor(plan.planId),
        });
    }
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
    stageVerdict(planId, stageId, modelKey) {
        const entry = this.registry.get(modelKey);
        if (!entry) {
            return { code: 'model-unavailable', allowed: false, message: `unknown model "${modelKey}"` };
        }
        const assignment = this.plans.get(planId)?.stages.find((s) => s.stage.id === stageId);
        return guardSwitch({
            target: entry.model,
            contextTokens: assignment?.guardInputs?.contextTokens ?? 0,
            expectedOutputTokens: assignment?.guardInputs?.expectedOutputTokens ??
                singleShotMaxTokens(assignment?.stage.estimatedOutputTokens ?? 1_000, entry.model),
            requireKnownPricing: this.pricingFor(planId).requireKnownPricing,
        });
    }
    /**
     * The user picked another model for one stage, before starting.
     *
     * Allowed only while the plan is unapproved: once a run is approved, changing
     * a row would silently rewrite what the user agreed to. After approval the
     * route is `switchForStage`, which records a deviation.
     */
    swapStageModel(planId, stageId, modelKey) {
        const plan = this.plans.get(planId);
        if (!plan)
            throw new RouterError('unknown-plan', `unknown plan "${planId}"`);
        if (plan.approvedAt) {
            throw new RouterError('plan-locked', `plan ${planId} is already approved; switch the running stage instead`, { planId });
        }
        // The stage is looked up in the plan's **full** stage list, not in the
        // assignments: a stage with no model yet is exactly the row the user needs
        // to change (灰狼 DEF-4: "只有卡片行，因此换模型也改不了"). Answering
        // `unknown-stage` there made the one repair the card offers unusable.
        const definitions = this.stageDefs.get(planId) ?? plan.stages.map((assignment) => assignment.stage);
        const stage = definitions.find((candidate) => candidate.id === stageId);
        if (!stage) {
            throw new RouterError('unknown-stage', `stage "${stageId}" is not part of plan ${planId}`, {
                planId,
            });
        }
        const entry = this.registry.get(modelKey);
        if (!entry)
            throw new RouterError('unknown-model', `unknown model "${modelKey}"`, { planId });
        if (!entry.model.capabilities.includes(stage.capability)) {
            throw new RouterError('missing-capability', `${entry.model.label} cannot do ${stage.capability}`, { planId, stageId, modelKey });
        }
        if (!entry.available) {
            throw new RouterError('model-unavailable', `${entry.model.label} is unavailable`, {
                planId,
                stageId,
                modelKey,
            });
        }
        const baseline = plan.baselineModelKey ? this.registry.get(plan.baselineModelKey)?.model : undefined;
        const estimate = estimateStage({
            model: entry.model,
            baseline: baseline ?? null,
            inputTokens: stage.estimatedInputTokens,
            outputTokens: stage.estimatedOutputTokens,
            uncertainty: this.calibratedBand(),
        });
        const guardInputs = {
            contextTokens: this.stageInputs.get(planId)?.get(stageId)?.contextTokens ?? 0,
            expectedOutputTokens: singleShotMaxTokens(stage.estimatedOutputTokens, entry.model),
        };
        const assignment = {
            stage,
            modelKey,
            // The reason has to change too, or the card would credit the new model
            // with the old model's argument.
            reason: `chosen by you · ${entry.model.label}`,
            estimate,
            guardInputs,
        };
        // Replace in place when the stage was assigned; otherwise insert at the
        // stage's own position so the card keeps the task's order.
        const existed = plan.stages.some((current) => current.stage.id === stageId);
        const stages = existed
            ? plan.stages.map((current) => (current.stage.id === stageId ? assignment : current))
            : [...plan.stages, assignment].sort((a, b) => definitions.findIndex((candidate) => candidate.id === a.stage.id) -
                definitions.findIndex((candidate) => candidate.id === b.stage.id));
        // A stage that just got a model is no longer a gap: keeping it in
        // `unassignedStages` would refuse approval for a plan the user just fixed.
        const remainingGaps = (plan.unassignedStages ?? []).filter((gap) => gap.stageId !== stageId);
        this.unassigned.get(planId)?.delete(stageId);
        const { unassignedStages: _previousGaps, ...rest } = plan;
        void _previousGaps;
        const updated = {
            ...rest,
            stages,
            ...(remainingGaps.length > 0 ? { unassignedStages: remainingGaps } : {}),
        };
        this.plans.set(planId, updated);
        this.ledger.append({
            type: 'plan-created',
            planId,
            stageId,
            modelKey,
            detail: `stage ${stageId} model changed to ${modelKey} before start`,
        });
        return this.cardFor(updated);
    }
    /**
     * Arms the global-default watch (K-003) and returns what it saw.
     *
     * `DshModelAdapter.primeGlobalDefault()` has existed since M1-3FIX but nothing
     * ever called it, so the first switch of every session compared against a
     * baseline captured at construction. A default edited in settings meanwhile
     * would be blamed on the switch, or a real write-back missed. Called at the
     * start of a run and before each switch, the warning stays honest.
     */
    primeGlobalDefault() {
        const prime = this.selection.primeGlobalDefault?.bind(this.selection);
        if (!prime)
            return undefined;
        return prime();
    }
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
    approvePlan(plan, options = {}) {
        if (options.allowUnknownPricing === true)
            this.pricingOptIn.set(plan.planId, true);
        const gaps = plan.unassignedStages ?? [];
        if (gaps.length > 0) {
            throw new RouterError('plan-incomplete', `plan ${plan.planId} cannot start: ${gaps.length} stage(s) have no model`, {
                planId: plan.planId,
                stages: gaps,
                reasons: gaps.map((gap) => this.unassignedReason(plan.planId, gap.stageId) ?? gap.reason),
                needsWizard: gaps.some((gap) => gap.reason === 'no-model'),
            });
        }
        if (plan.stages.length === 0) {
            throw new RouterError('plan-empty', `plan ${plan.planId} has no stages`, { planId: plan.planId });
        }
        // The same pre-check the card shows. Approving a plan whose stage 1 switch
        // is already refused would start a run that stalls one call later (A1).
        const refused = plan.stages
            .map((assignment) => ({
            stageId: assignment.stage.id,
            modelKey: assignment.modelKey,
            verdict: this.stageVerdict(plan.planId, assignment.stage.id, assignment.modelKey),
        }))
            .filter((row) => !row.verdict.allowed);
        if (refused.length > 0) {
            throw new RouterError('plan-blocked', `plan ${plan.planId} cannot start: ` +
                refused.map((row) => `${row.stageId} ${row.verdict.message}`).join('; '), {
                planId: plan.planId,
                stages: refused.map((row) => ({
                    stageId: row.stageId,
                    modelKey: row.modelKey,
                    code: row.verdict.code,
                })),
                // Why the price rule refused: a refusal that does not name its stance
                // looks like a bug to whoever reads `price-unknown` next.
                pricing: this.pricingFor(plan.planId),
            });
        }
        const approved = { ...plan, approvedAt: nowIso() };
        this.plans.set(plan.planId, approved);
        this.activePlanId = plan.planId;
        this.ledger.append({ type: 'plan-approved', planId: plan.planId });
        return approved;
    }
    getPlan(planId) {
        return this.plans.get(planId);
    }
    /** Plan-card footer: total cost and savings with the advertised ± band. */
    planTotals(plan) {
        const total = sumEstimates(plan.stages.map((s) => s.estimate));
        return { total, line: formatEstimate(total) };
    }
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
    async switchForStage(stageId, targetKey, contextTokens, expectedOutputTokens, requiredCapabilities = [], planId, options = {}) {
        // 2026-11-26 修复：selection.current() 已剥 `wb-gateway/` 前缀，targetKey 未剥 ⇒
        // 「计划用 wb-gateway/x、回读得 x」永远不等，误报切换失败。两侧统一到注册键空间再比。
        const normalizedTargetKey = normalizeModelKey(targetKey);
        const gate = this.planGate(planId, stageId, targetKey);
        if (!gate.ok) {
            this.ledger.recordBlocked(stageId, targetKey, gate.message, planId);
            return { switched: false, message: gate.message };
        }
        const entry = this.registry.get(targetKey);
        if (!entry) {
            const message = `unknown model "${targetKey}"`;
            this.ledger.recordBlocked(stageId, targetKey, message, planId);
            return { switched: false, message, code: 'model-unavailable' };
        }
        // 铁律 5, honest-degradation form: the price rule comes from the plan's
        // stance (host policy + catalog + opt-in), never from the guard's default.
        // On a host that prices nothing this is why a real switch can now happen;
        // on a mixed catalog it is still `price-unknown` unless asked otherwise.
        const pricing = this.pricingFor(planId, options.allowUnknownPricing);
        const verdict = guardSwitch({
            target: entry.model,
            contextTokens,
            expectedOutputTokens,
            requiredCapabilities,
            requireKnownPricing: pricing.requireKnownPricing,
        });
        if (!verdict.allowed) {
            this.ledger.recordBlocked(stageId, targetKey, verdict.message, planId);
            return { switched: false, message: verdict.message, code: verdict.code };
        }
        // F5: the context decision comes **before** the switch, never after it.
        // A switch that quietly leaves half the conversation behind is the failure
        // this whole file is built to prevent (原则 3), so the branch is decided here
        // and a refusal returns before the platform is touched.
        //
        // DEF-1: the compress branch needs the host's **async** compaction, and this
        // decision is synchronous. So the compression is warmed first (one compaction
        // call, kept off to the side), and only then is the branch asked for — a
        // switch to a model that fits cannot trigger a pointless (and billable)
        // compaction, and a switch that does not fit has its result ready.
        await this.warmCompression(stageId, entry.model, contextTokens, planId, options.sessionId);
        const context = this.decideContextFor(stageId, entry.model, contextTokens, planId);
        if (context.action === 'refuse') {
            this.ledger.recordBlocked(stageId, targetKey, `refused instead of truncating: ${context.message}`, planId);
            return {
                switched: false,
                message: `${context.message} — options: ${(context.options ?? []).map((o) => o.label).join(' / ')}`,
                context,
            };
        }
        const from = this.selection.current(options.sessionId);
        if (from === normalizedTargetKey) {
            // B1: the session is already on the model this stage needs. That is the
            // outcome asked for, so it is a success, not a refusal — reporting 409
            // here made a retried switch look like a failure and, worse, taught
            // callers to treat a 409 as "fine, retry". Idempotent: no extra ledger
            // event, because nothing moved.
            return { switched: true, alreadyInUse: true, message: `${entry.model.label} already in use` };
        }
        if (gate.plannedKey && gate.plannedKey !== targetKey) {
            this.ledger.recordDeviation(stageId, gate.plannedKey, targetKey, planId);
        }
        // Arm the watch right before the switch: a default edited in settings since
        // the last switch must not be blamed on this one (K-003).
        this.primeGlobalDefault();
        // `selectGuarded` is optional on the interface; hosts that do not provide it
        // simply get "not observed" rather than a fake all-clear.
        const writeBack = await this.selectAndWatchGlobalDefault(targetKey, options.sessionId);
        if (writeBack.error) {
            const message = `the platform refused the switch: ${writeBack.error}`;
            // A-6 / N-4 ③: a failed switch can still have dragged the global default
            // along. The old code carried that fact in the return value only, so the
            // book said "nothing happened" while the user's next session started on a
            // different model. Both facts are recorded now.
            if (writeBack.wroteBackGlobalDefault) {
                this.ledger.recordGlobalDefaultWriteBack(writeBack.from, writeBack.to, planId);
            }
            this.ledger.recordBlocked(stageId, targetKey, message, planId);
            return {
                switched: false,
                message,
                globalDefaultObserved: writeBack.observed,
                ...(writeBack.wroteBackGlobalDefault ? { globalDefaultWrittenBack: true } : {}),
            };
        }
        if (writeBack.wroteBackGlobalDefault) {
            this.ledger.recordGlobalDefaultWriteBack(writeBack.from, writeBack.to, planId);
        }
        // Platforms may accept `select` and ignore it. Trust the read-back, not the ack.
        const after = this.selection.current(options.sessionId);
        if (after !== normalizedTargetKey) {
            const message = `the platform accepted the switch but the session still runs ${after} ` +
                `(wanted ${targetKey}); ledger records it as unverified.`;
            this.ledger.recordUnverified(stageId, targetKey, after, planId);
            return {
                switched: false,
                message: writeBack.wroteBackGlobalDefault
                    ? `${message} Also: ${this.writeBackWarning(writeBack.from, writeBack.to)}`
                    : message,
                globalDefaultObserved: writeBack.observed,
                ...(writeBack.wroteBackGlobalDefault ? { globalDefaultWrittenBack: true } : {}),
            };
        }
        this.ledger.recordSwitch(stageId, from, targetKey, planId);
        // F6 §5: the switch re-sends the prompt to the new model, and that prefill is
        // billed like any other input. Booked against the *target* model's price; an
        // unpriced model books the tokens with no money rather than `¥0`.
        const prefillTokens = context.carriedTokens;
        const prefillCost = costOf(entry.model.pricing, prefillTokens, 0);
        this.ledger.recordContextCarry({
            stageId,
            modelKey: targetKey,
            action: context.action,
            tokensBefore: context.contextTokens,
            tokensAfter: context.carriedTokens,
            prefillTokens,
            prefillCost,
            ...(planId === undefined ? {} : { planId }),
        });
        if (planId && planId !== UNPLANNED_RUN)
            this.activePlanId = planId;
        const base = `switched to ${entry.model.label}`;
        const carried = ` · ${context.message}`;
        const notice = this.pendingCompactionNotice;
        this.pendingCompactionNotice = undefined;
        if (!writeBack.wroteBackGlobalDefault) {
            return {
                switched: true,
                message: base + carried + (notice ? ` · ${notice.text}` : ''),
                globalDefaultObserved: writeBack.observed,
                context,
                ...(notice ? { compaction: notice } : {}),
            };
        }
        return {
            switched: true,
            message: `${base}${carried}. ${this.writeBackWarning(writeBack.from, writeBack.to)}` +
                (notice ? ` · ${notice.text}` : ''),
            globalDefaultWrittenBack: true,
            globalDefaultObserved: writeBack.observed,
            context,
            ...(notice ? { compaction: notice } : {}),
        };
    }
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
    decideContextFor(stageId, target, contextTokens, planId) {
        const first = decideContext({
            contextTokens,
            windowTokens: target.limits.contextWindow,
            thresholds: this.contextThresholds,
        });
        if (first.action !== 'compress')
            return first;
        const compressor = this.compressor;
        if (!compressor) {
            // No compressor wired: the honest answer is "I cannot compress this", and
            // the switch is refused with the three options instead of truncating.
            const blocked = decideContext({
                contextTokens,
                windowTokens: target.limits.contextWindow,
                thresholds: this.contextThresholds,
                // Pretend nothing was gained: that is exactly what happened.
                tokensAfterCompaction: contextTokens,
            });
            this.ledger.recordCompactionBlocked(stageId, target.id, contextTokens, planId);
            return blocked;
        }
        const handover = this.handoverFor(stageId, planId);
        const rendered = renderHandover(handover, validateHandover(handover));
        // DEF-1: a warmed compaction (async host call already done) is the result. The
        // synchronous compressor is the fallback for hosts that compress inline; it
        // consumes what `warm()` left, and throws when nothing was warmed — which
        // refuses rather than pretending the context got smaller.
        //
        // 灰狼 DEF-2: a host compaction that *failed* (no safe range, no token
        // meter, provider error) must end in this same safe refusal. It used to
        // escape as an exception and turn the whole switch into a 500 — the host's
        // "I cannot shrink this" is an answer, not a crash.
        const warmed = this.warmed;
        this.warmed = undefined;
        let result;
        try {
            result = warmed ?? compressor.compress({ handover, rendered, tokensBefore: contextTokens });
        }
        catch (error) {
            this.warmed = undefined;
            const reason = error instanceof Error ? error.message : String(error);
            const failure = this.warmFailure ?? reason;
            this.warmFailure = undefined;
            this.ledger.recordCompactionBlocked(stageId, target.id, contextTokens, planId);
            const blocked = decideContext({
                contextTokens,
                windowTokens: target.limits.contextWindow,
                thresholds: this.contextThresholds,
                // Nothing was gained: that is exactly what happened.
                tokensAfterCompaction: contextTokens,
            });
            return { ...blocked, message: `${blocked.message}（宿主压缩未完成：${failure}）` };
        }
        const problems = validateHandover(result.handover ?? handover);
        const notice = compactionNotice({
            tokensBefore: contextTokens,
            tokensAfter: result.tokensAfter,
            problems,
            ...(result.reopenable === undefined ? {} : { reopenable: result.reopenable }),
        });
        // F5 §6: compression is a real call with real tokens — it goes in the book.
        const cost = result.cost ?? null;
        this.ledger.recordCompaction({
            stageId,
            modelKey: result.modelKey,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cost,
            tokensBefore: contextTokens,
            tokensAfter: result.tokensAfter,
            targetModelKey: target.id,
            handoverOk: problems.length === 0,
            ...(planId === undefined ? {} : { planId }),
        });
        this.pendingCompactionNotice = notice;
        // DEF-7: the notice is NOT glued onto the message here. It already travels
        // as its own field (`SwitchResult.compaction`) and `switchForStage` appends
        // it once — bolting it on twice printed the same sentence twice, which is how
        // a warning becomes wallpaper. The decision carries the sizes; the notice
        // carries the sentence; the switch says it once.
        return decideContext({
            contextTokens,
            windowTokens: target.limits.contextWindow,
            thresholds: this.contextThresholds,
            tokensAfterCompaction: result.tokensAfter,
        });
    }
    /** The five-field handover for a stage; an empty skeleton when nobody wrote one. */
    handoverFor(stageId, planId) {
        const stored = this.handovers.get(`${planId ?? ''}:${stageId}`);
        if (stored)
            return stored;
        const assignment = planId ? this.plans.get(planId)?.stages.find((s) => s.stage.id === stageId) : undefined;
        return {
            ...emptyHandover(),
            goal: assignment?.stage.goal ?? '',
        };
    }
    /** Runs the switch, reporting whether the global default moved with it. */
    async selectAndWatchGlobalDefault(targetKey, sessionId) {
        // Bind first: the method must run on the adapter, not on a detached reference.
        // `await this.exec` caught this once — it reported "no write-back" forever
        // because the call threw inside and the error was flattened into a boolean.
        const guarded = this.selection.selectGuarded?.bind(this.selection);
        if (guarded) {
            const outcome = await guarded(targetKey, sessionId);
            // `globalDefaultObservable` is read **after** the compare, so it reports
            // whether this switch's watch really saw a value.
            const observed = this.selection.globalDefaultObservable?.() === true;
            return { ...outcome, observed };
        }
        // A selection with no guard at all: nothing could be watched, and that is
        // reported as "unobserved" rather than as an all-clear.
        await this.selection.select(sessionId ?? '', targetKey);
        return { wroteBackGlobalDefault: false, observed: false };
    }
    /** User-facing sentence for a global-default write-back (never silent). */
    writeBackWarning(from, to) {
        return (`warning: the global default model changed from ${from ?? '?'} to ${to ?? '?'} ` +
            `during this switch (K-003). Your new sessions will start on it — restore it in DSH settings.`);
    }
    /**
     * Explicit opt-out of the plan gate, for a stepper with no planning step at
     * all (a CLI one-off, tests). It is deliberately a different method name: a
     * caller has to type "noPlan" to run unmanaged, and the ledger says so.
     */
    async switchWithoutPlan(stageId, targetKey, contextTokens, expectedOutputTokens, requiredCapabilities = []) {
        return this.switchForStage(stageId, targetKey, contextTokens, expectedOutputTokens, requiredCapabilities, UNPLANNED_RUN);
    }
    /**
     * Records a finished stage using **actual** usage and the real price.
     * A stage whose model has no price is counted, not priced.
     */
    recordStageEnd(params) {
        const model = this.registry.get(params.modelKey)?.model;
        const cost = model
            ? costOf(model.pricing, params.inputTokens, params.outputTokens)
            : null;
        const plan = params.planId ? this.plans.get(params.planId) : undefined;
        const assignment = plan?.stages.find((s) => s.stage.id === params.stageId);
        this.ledger.recordStageEnd({
            stageId: params.stageId,
            modelKey: params.modelKey,
            inputTokens: params.inputTokens,
            outputTokens: params.outputTokens,
            cost,
            ...(assignment ? { estimate: assignment.estimate } : {}),
            ...(params.planId === undefined ? {} : { planId: params.planId }),
        });
        if (plan && assignment && assignment.modelKey !== params.modelKey) {
            this.ledger.recordDeviation(params.stageId, assignment.modelKey, params.modelKey, plan.planId);
        }
        // F6 §4: the estimate is compared to the bill **at the moment the bill
        // exists**. Without this the band on the next card is the same guess as the
        // first one, forever — "校准" would be a word in a document.
        if (assignment) {
            observeStage(this.calibration, {
                stageId: params.stageId,
                actualInputTokens: params.inputTokens,
                actualOutputTokens: params.outputTokens,
                actualCost: cost,
                estimate: assignment.estimate,
            });
        }
    }
    /** F6: the band this run's next estimate should advertise, from what it learned. */
    calibratedBand() {
        return calibratedUncertainty(this.calibration, BASE_UNCERTAINTY);
    }
    /**
     * F6 §1: one row's estimate with its token and money intervals.
     *
     * The card shows the amount; this is what a caller shows when it needs to say
     * "about this much, somewhere between these two numbers, and here is why".
     */
    estimateInterval(planId, stageId) {
        const assignment = this.plans.get(planId)?.stages.find((s) => s.stage.id === stageId);
        if (!assignment)
            return undefined;
        const estimate = assignment.estimate;
        const band = estimate.uncertainty;
        const input = tokenInterval(estimate.inputTokens, band);
        const output = tokenInterval(estimate.outputTokens, band);
        return {
            estimate,
            tokens: { input, output },
            cost: estimate.cost === null ? null : costInterval(estimate.cost, band),
            statement: this.estimateErrorStatement(),
        };
    }
    /** F6 §1: the sentence that says what the band means, next to every estimate. */
    estimateErrorStatement() {
        return errorStatement(this.calibration, this.calibratedBand());
    }
    /** F6: the raw calibration state, for the acceptance test and the status bar. */
    calibrationState() {
        return {
            tokenSamples: [...this.calibration.tokenSamples],
            costSamples: [...this.calibration.costSamples],
            outOfBand: this.calibration.outOfBand,
            outOfBandStages: [...this.calibration.outOfBandStages],
        };
    }
    /**
     * F6 §4 as a checkable sentence: does the real bill sit inside the interval the
     * plan advertised?
     *
     * Returned as data (not a boolean) because the honest answer has three cases:
     * inside, outside, and "cannot say, price unknown" — and the last one must not
     * be rendered as "inside".
     */
    reconcile(planId) {
        const plan = this.plans.get(planId);
        const stages = plan?.stages ?? [];
        const rows = [];
        let within = 0;
        let outside = 0;
        let unknown = 0;
        for (const assignment of stages) {
            const entries = this.ledger
                .forPlan(planId)
                .filter((e) => e.type === 'stage-end' && e.stageId === assignment.stage.id);
            const booked = entries.filter((e) => typeof e.cost === 'number');
            const actual = booked.reduce((sum, e) => sum + e.cost, 0);
            const estimated = assignment.estimate.cost;
            if (booked.length === 0 || estimated === null) {
                unknown += 1;
                rows.push({
                    stageId: assignment.stage.id,
                    estimated: estimated === null ? null : estimated,
                    actual: booked.length === 0 ? null : actual,
                    interval: null,
                    within: null,
                });
                continue;
            }
            const interval = costInterval(estimated, assignment.estimate.uncertainty);
            const inside = actual >= interval.low && actual <= interval.high;
            if (inside)
                within += 1;
            else
                outside += 1;
            rows.push({
                stageId: assignment.stage.id,
                estimated,
                actual,
                interval,
                within: inside,
            });
        }
        const total = within + outside + unknown;
        return {
            planId,
            rows,
            within,
            outside,
            unknown,
            ok: total > 0 && outside === 0 && unknown === 0,
            statement: this.estimateErrorStatement(),
        };
    }
    /** F6 §3: which models never enter the savings figure, and why. */
    savingsExclusions(planId) {
        const plan = this.plans.get(planId);
        return savingsExclusion((plan?.stages ?? []).map((s) => s.estimate));
    }
    /**
     * Plan gate: approved? stage ours? model on plan?
     *
     * `planId === undefined` is a refusal, not a bypass. The one exception is the
     * explicit `UNPLANNED_RUN` marker from `switchWithoutPlan`.
     */
    planGate(planId, stageId, targetKey) {
        if (planId === undefined) {
            return {
                ok: false,
                message: `no plan given for stage "${stageId}": switches must belong to an approved plan ` +
                    `(D-004). Show the plan card first, or call switchWithoutPlan on purpose.`,
            };
        }
        if (planId === UNPLANNED_RUN)
            return { ok: true, planId: UNPLANNED_RUN };
        const plan = this.plans.get(planId);
        if (!plan)
            return { ok: false, message: `unknown plan "${planId}", ask for a plan first` };
        if (!plan.approvedAt) {
            return { ok: false, message: `plan ${planId} is not approved yet, show it to the user first` };
        }
        const assignment = plan.stages.find((s) => s.stage.id === stageId);
        if (!assignment) {
            return { ok: false, message: `stage "${stageId}" is not part of plan ${planId}` };
        }
        return { ok: true, plannedKey: assignment.modelKey, planId };
    }
    /** Baseline the wizard confirmed, if any. Overrides usage-based guessing. */
    baselineOverride;
    /**
     * Pins the savings baseline (the wizard's "你过去最常用" answer).
     *
     * In memory only: the host never writes DSH settings, so confirming a wizard
     * and walking away leaves the user's environment untouched (铁律 3).
     */
    setBaseline(key) {
        this.baselineOverride = key;
    }
    /** The baseline a plan would use right now, wizard answer first. */
    baselineFor(usage = {}) {
        return this.baselineOverride ?? pickBaseline(this.registry.all(), usage).key;
    }
    /** The plan the status bar follows: last one built or started, if approved. */
    activePlan() {
        const plan = this.activePlanId ? this.plans.get(this.activePlanId) : undefined;
        return plan?.approvedAt ? plan : undefined;
    }
    /** Model the session is on right now, straight from the adapter. */
    currentModel() {
        try {
            return this.selection.current();
        }
        catch {
            return '';
        }
    }
    /** Human label for a model key; the key itself when we have no entry. */
    labelOf(modelKey) {
        return this.registry.get(modelKey)?.model.label ?? modelKey;
    }
    /** Global default as the adapter can see it, or undefined when it cannot. */
    observeGlobalDefault() {
        return this.selection.globalDefault?.();
    }
    /** Actual charge booked for one stage of one plan, or null when unknown. */
    stageCost(stageId, planId) {
        const entries = this.ledger
            .forPlan(planId)
            .filter((e) => e.type === 'stage-end' && e.stageId === stageId);
        let sum = 0;
        let priced = false;
        for (const entry of entries) {
            if (typeof entry.cost === 'number') {
                sum += entry.cost;
                priced = true;
            }
        }
        return priced ? sum : null;
    }
    /** Registers discovered models, letting adapters stay the only source. */
    registerModels(models, availableKeys) {
        this.registry.register({ models, availableKeys });
    }
    /** Key the registry would use for a model, exposed for hosts and tests. */
    static keyOf(provider, model) {
        return modelKey(provider, model);
    }
    /**
     * Registers models from several sources at once, merging duplicates.
     * Deliberately does not touch DSH config: sources arrive already read.
     *
     * Availability travels with each entry: a probe verdict ("dead") is never
     * lost because a merge forgot to carry `availableKeys` (N-1). Two signals are
     * ANDed — the caller's list and what the merge worked out per entry — so a
     * model only counts as available when both say yes.
     */
    registerFromSources(batches, availableKeys) {
        const { registry, report } = buildCapabilityList(batches, availableKeys === undefined ? {} : { availableKeys });
        const caller = availableKeys === undefined ? undefined : new Set(availableKeys);
        for (const entry of registry.all()) {
            const unknown = caller === undefined && entry.available === true;
            this.registry.register({
                models: [entry.model],
                ...(unknown ? {} : { availableKeys: [entry.key] }),
            });
            const target = this.registry.get(entry.key);
            if (!target)
                continue;
            target.available = availableAnd(target.available, entry.available);
            target.notes.push(...entry.notes);
        }
        return { entries: this.registry.all(), conflicts: report.conflicts.length };
    }
    /** Data layer for the install wizard. Read-only: renders, never writes. */
    wizardDraft(input = {}) {
        const usage = input.logs
            ? collectUsage(input.logs, input.days === undefined ? {} : { days: input.days })
            : undefined;
        return buildWizardDraft({
            entries: this.registry.all(),
            ...(usage ? { usage } : {}),
            ...(input.deadEndpoints ? { deadEndpoints: input.deadEndpoints } : {}),
        });
    }
    /** Usage counts in the shape `plan()` wants — one hop, no re-parsing. */
    usageCountsFrom(logs, days) {
        return usageCounts(collectUsage(logs, days === undefined ? {} : { days }));
    }
}
/**
 * Plan state machine: which stage is current, which are done.
 *
 * Kept as data (`stageStatus`) so the status bar and the ledger cannot drift:
 * a stage is "done" because the ledger says it ended, not because a timer fired.
 */
const emptyRun = () => ({ cursor: 0, status: new Map(), unbooked: new Set(), notes: new Map() });
export class RouterSession {
    host;
    /** Per-plan cursor, per-stage status, and the stages whose money is unknown. */
    cursors = new Map();
    constructor(host) {
        this.host = host;
    }
    /** The plan the status bar follows. */
    activePlan() {
        return this.host.activePlan();
    }
    state(planId) {
        const plan = planId ? this.host.getPlan(planId) : this.host.activePlan();
        const sessionModel = this.host.currentModel();
        const totals = this.host.ledger.totals();
        const writeBacks = this.host.ledger
            .all()
            .filter((e) => e.type === 'global-default-writeback')
            .map((e) => String(e.detail ?? ''));
        const base = {
            active: Boolean(plan?.approvedAt),
            total: plan?.stages.length ?? 0,
            cursor: 0,
            stages: [],
            sessionModel,
            sessionModelLabel: this.host.labelOf(sessionModel),
            spent: {
                actualCost: totals.actualCost,
                unpricedStages: totals.unpricedStages,
                estimatedCost: totals.estimatedCost,
                savings: totals.savings,
            },
            globalDefault: this.host.observeGlobalDefault(),
            globalDefaultWriteBacks: totals.globalDefaultWriteBacks,
            notices: writeBacks.slice(-1),
            // The bar's money is only a bill when prices exist; `spent.actualCost`
            // stays a floor with `unpricedStages > 0`, and this stance (plus its
            // notice) is what keeps "价格未知" from reading as "free".
            pricing: this.host.pricingFor(plan?.planId),
        };
        if (!plan?.approvedAt)
            return base;
        const run = this.cursors.get(plan.planId) ?? emptyRun();
        this.cursors.set(plan.planId, run);
        const stages = plan.stages.map((assignment, index) => {
            const status = run.status.get(assignment.stage.id) ?? 'pending';
            const spent = this.host.stageCost(assignment.stage.id, plan.planId);
            return {
                stageId: assignment.stage.id,
                index: index + 1,
                title: assignment.stage.name,
                modelKey: assignment.modelKey,
                modelLabel: this.host.labelOf(assignment.modelKey),
                status,
                ...(spent === null ? {} : { actualCost: spent }),
            };
        });
        const current = stages[run.cursor];
        const next = stages[run.cursor + 1];
        // Stages that finished without token counts (B2). Exposed as data so the bar
        // can say "已花 ¥X+（1 段未记账）" instead of printing a total that silently
        // treats those stages as free.
        const unbooked = [...run.unbooked];
        const notes = unbooked
            .map((stageId) => run.notes.get(stageId))
            .filter((note) => typeof note === 'string');
        return {
            ...base,
            planId: plan.planId,
            cursor: run.cursor,
            stages,
            unbookedStages: unbooked,
            notices: [...base.notices, ...notes],
            ...(current ? { current } : {}),
            ...(next
                ? { next: { stageId: next.stageId, title: next.title, modelKey: next.modelKey, modelLabel: next.modelLabel } }
                : {}),
        };
    }
    /** Marks the plan as started: stage 1 becomes current. Idempotent. */
    start(planId) {
        const plan = this.host.getPlan(planId);
        if (!plan?.approvedAt) {
            throw new RouterError('plan-not-approved', `plan ${planId} is not approved yet: show it first`);
        }
        const run = this.cursors.get(planId) ?? emptyRun();
        const first = plan.stages[0];
        if (first && !run.status.has(first.stage.id))
            run.status.set(first.stage.id, 'running');
        this.cursors.set(planId, run);
        return this.state(planId);
    }
    /**
     * The stage ended. Moves the cursor, and books the money if tokens are given.
     *
     * `actual` usage wins over any plan-time estimate. A stage that reports done
     * **without** token counts is not booked, and the state says so (`unbooked`):
     * recording "done, $0.0000" made the wallet look free (B2).（该 `$0.0000` 为
     * 早期之前的历史渲染文字，保留以记录事故；现口径 `¥` + 3 位小数。）The stage still
     * finishes — a host that cannot count tokens must not be stuck — but nothing
     * on screen may imply the run was costed.
     */
    finish(params) {
        const plan = this.host.getPlan(params.planId);
        if (!plan)
            throw new RouterError('unknown-plan', `unknown plan "${params.planId}"`);
        const run = this.cursors.get(params.planId) ?? emptyRun();
        run.status.set(params.stageId, params.failed ? 'failed' : 'done');
        if (params.inputTokens !== undefined && params.outputTokens !== undefined) {
            this.host.recordStageEnd({
                stageId: params.stageId,
                modelKey: params.modelKey,
                inputTokens: params.inputTokens,
                outputTokens: params.outputTokens,
                planId: params.planId,
            });
            run.unbooked.delete(params.stageId);
            run.notes.delete(params.stageId);
        }
        else if (!params.failed) {
            // Named, once: the bar and the reader both need to know this stage's
            // money is missing from the total, not that it was free.
            run.unbooked.add(params.stageId);
            run.notes.set(params.stageId, `stage ${params.stageId} finished without token counts: its cost is not booked`);
            this.host.ledger.recordUnpricedStage(params.planId, params.stageId, params.modelKey);
        }
        else {
            run.unbooked.delete(params.stageId);
            run.notes.delete(params.stageId);
        }
        // No cursor bump here on purpose: a finished stage means the *next* one is
        // about to run, not that it has. The bar said "第 2/3 段 · 当前 DeepSeek
        // Flash" while nothing had switched to stage 2 yet — a number that runs
        // ahead of reality is the same lie as a bar for a task nobody started.
        // `advance()` moves the cursor when the switch actually happens.
        this.cursors.set(params.planId, run);
        return this.state(params.planId);
    }
    /**
     * Marks a stage as the running one. Called when its switch succeeds.
     *
     * Idempotent and order-tolerant: asking for a stage that already ran is not an
     * error, it just does not move anything backwards.
     */
    advance(planId, stageId) {
        const plan = this.host.getPlan(planId);
        if (!plan?.approvedAt) {
            throw new RouterError('plan-not-approved', `plan ${planId} is not approved yet: show it first`);
        }
        const index = plan.stages.findIndex((s) => s.stage.id === stageId);
        if (index < 0)
            throw new RouterError('unknown-stage', `stage "${stageId}" is not part of plan ${planId}`);
        const run = this.cursors.get(planId) ?? emptyRun();
        run.cursor = Math.max(run.cursor, index);
        if (!run.status.has(stageId) || run.status.get(stageId) !== 'done')
            run.status.set(stageId, 'running');
        this.cursors.set(planId, run);
        return this.state(planId);
    }
}
/**
 * Read-only wizard view. The host renders this; it never writes DSH config.
 *
 * Minimal on purpose (P1): "能看能确认". The draft answers *what was found and
 * what we guessed*; confirming records the outcome so the next task is planned
 * with the user's baseline instead of our fallback.
 */
export function buildWizardView(draft) {
    return {
        stages: draft.groups.map((group) => ({
            provider: group.provider,
            count: group.count,
            keys: group.keys,
            sources: group.sources,
            reachable: group.reachable,
            needsAttention: draft.questions.some((q) => q.keys.some((key) => group.keys.includes(key))),
        })),
        totalModels: draft.totalModels,
        ...(draft.baselineKey ? { baselineKey: draft.baselineKey } : {}),
        baselineBasis: draft.baselineBasis,
        usageLine: draft.usage.line,
        questions: draft.questions.map((q) => ({
            kind: q.kind,
            title: q.title,
            detail: q.detail,
            keys: q.keys,
        })),
        ready: draft.totalModels > 0 && draft.baselineBasis !== 'none',
        draft,
    };
}
/**
 * Records the wizard outcome and switches the host's baseline to it.
 *
 * Confirming is not writing settings: the host stores the baseline in memory,
 * so an install that is confirmed and then abandoned leaves the user's DSH
 * exactly as it was (铁律 3). The baseline is also refused when it names a
 * model the registry does not have — a typo must not become the savings anchor.
 */
export function confirmWizard(host, draft, baselineKey) {
    const chosen = baselineKey ?? draft.baselineKey;
    if (chosen && !host.registry.has(chosen)) {
        throw new RouterError('unknown-model', `the wizard cannot confirm "${chosen}": not in the model list`);
    }
    if (draft.totalModels === 0) {
        throw new RouterError('no-models', 'no models were found: nothing to confirm yet', {
            needsWizard: true,
        });
    }
    const confirmation = {
        baselineKey: chosen ?? '',
        basis: chosen ? (chosen === draft.baselineKey ? draft.baselineBasis : 'usage') : 'none',
        confirmedAt: nowIso(),
        totalModels: draft.totalModels,
    };
    host.setBaseline(chosen);
    host.ledger.append({
        type: 'run-end',
        detail: `wizard confirmed: ${confirmation.totalModels} models, baseline ` +
            `${confirmation.baselineKey || 'none'} (${confirmation.basis})`,
    });
    return { confirmation, card: null };
}
//# sourceMappingURL=index.js.map