import { nowIso } from '../core/types.js';
import { buildPlanCard } from '../core/card.js';
import { buildWizardView, confirmWizard, PluginHost, RouterError, RouterSession, } from './index.js';
/**
 * The four HTTP endpoints the client half talks to — **and nothing else**.
 *
 * Goal of this file: the client never imports core, never computes money, never
 * touches the kernel. It POSTs a request, gets JSON, renders it. Every decision
 * (which model, how much, may we switch) is made here, by the same host object
 * the CLI and the tests use, so reading the card through HTTP cannot show
 * different numbers from the ones the ledger books.
 *
 * Transport-agnostic on purpose: `dispatch` takes `{method, path, body}` and
 * returns `{status, body}`. A host adapter (a web server, a CLI harness, a test)
 * is three lines of glue, and the router itself stays unit-testable.
 */
export const ROUTER_PREFIX = '/router';
const json = (status, body) => ({ status, body });
function parse(url) {
    const index = url.indexOf('?');
    const pathname = index < 0 ? url : url.slice(0, index);
    return { pathname: pathname.replace(/\/+$/, '') || '/', query: new URLSearchParams(index < 0 ? '' : url.slice(index + 1)) };
}
function asObject(body) {
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}
function requireString(source, field) {
    const value = source[field];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new RouterError('bad-request', `missing "${field}"`);
    }
    return value;
}
/** An optional non-empty string; anything else that is present is a bad request. */
function optionalString(source, field) {
    const value = source[field];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string') {
        throw new RouterError('bad-request', `"${field}" must be a string`);
    }
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
function optionalNumber(source, field) {
    const value = source[field];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new RouterError('bad-request', `"${field}" must be a non-negative number`);
    }
    return value;
}
/**
 * 铁律 5, honest-degradation form: the per-request opt-in flag.
 *
 * Only an actual `true` counts. A string `"true"` from a sloppy client is
 * **not** treated as consent to run an unpriceable plan — quietly widening
 * this is how a warning flag turns into wallpaper.
 */
function optionalBoolean(source, field) {
    const value = source[field];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'boolean') {
        throw new RouterError('bad-request', `"${field}" must be true or false`);
    }
    return value;
}
/** HTTP status per stable machine code; everything else is a 400. */
const FAILURE_STATUS = {
    // `getCard` promises "404 no-plan" and the client half keys its "draw nothing"
    // on exactly that: `requestCard()` maps **404** to `idle`. The code answered
    // 400 (the fallback), so a fresh session's dock printed
    // `加载失败：no plan yet` — an error banner for the normal state. Same value the
    // two neighbours already use.
    'no-plan': 404,
    'unknown-plan': 404,
    'unknown-stage': 404,
    // A switch whose session cannot be named is a conflict with the host's state
    // (not a malformed request), and it is the exact answer the M2 build lacked:
    // it used to invent `'current'` and let the platform fail with not-found.
    'session-unknown': 409,
};
/** Turns a thrown error into a response the client can print verbatim. */
function failure(error) {
    if (error instanceof RouterError) {
        const needsWizard = error.details.needsWizard === true;
        return json(FAILURE_STATUS[error.code] ?? 400, {
            ok: false,
            code: error.code,
            error: error.message,
            ...(needsWizard ? { needsWizard: true } : {}),
            ...error.details,
        });
    }
    const message = error instanceof Error ? error.message : String(error);
    return json(500, { ok: false, code: 'internal', error: message });
}
/**
 * Handles one request. Returns 404 for anything not under our four paths, so a
 * host can mount this next to other plugins without a routing table.
 */
export async function dispatch(request, deps) {
    // F5: the compressor lives on the host so both the dry-run endpoint and the
    // real switch share one behaviour. Wired here because `deps` is the boundary.
    if (deps.compressor)
        deps.host.setCompressor(deps.compressor);
    const { pathname, query } = parse(request.path);
    const method = request.method.toUpperCase();
    try {
        switch (`${method} ${pathname}`) {
            case `POST ${ROUTER_PREFIX}/plan`:
                return await postPlan(request.body, deps);
            case `POST ${ROUTER_PREFIX}/plan/confirm`:
                return await postConfirm(request.body, deps);
            case `POST ${ROUTER_PREFIX}/plan/swap`:
                return await postSwap(request.body, deps);
            case `POST ${ROUTER_PREFIX}/switch`:
                return await postSwitch(request.body, deps);
            case `GET ${ROUTER_PREFIX}/state`:
                return getState(query, deps);
            case `GET ${ROUTER_PREFIX}/models`:
                return await getModels(deps);
            case `GET ${ROUTER_PREFIX}/card`:
                return getCard(query, deps);
            case `POST ${ROUTER_PREFIX}/stage/finish`:
                return postStageFinish(request.body, deps);
            case `GET ${ROUTER_PREFIX}/wizard`:
                return await getWizard(deps);
            case `POST ${ROUTER_PREFIX}/wizard/confirm`:
                return postWizardConfirm(request.body, deps);
            case `GET ${ROUTER_PREFIX}/context`:
                return getContext(query, deps);
            case `POST ${ROUTER_PREFIX}/handover`:
                return postHandover(request.body, deps);
            case `GET ${ROUTER_PREFIX}/reconcile`:
                return getReconcile(query, deps);
            default:
                return json(404, { ok: false, code: 'no-route', error: `no route for ${method} ${pathname}` });
        }
    }
    catch (error) {
        return failure(error);
    }
}
/**
 * Builds the plan card. Never 500s on "no models": that is a card with every
 * stage unassigned and `needsWizard: true`, which the UI knows how to show.
 */
async function postPlan(body, deps) {
    const payload = asObject(body);
    const taskId = requireString(payload, 'taskId');
    const stageNames = payload.stageNames;
    if (!Array.isArray(stageNames) || stageNames.some((s) => typeof s !== 'string')) {
        throw new RouterError('bad-request', '"stageNames" must be an array of strings');
    }
    const inputTokens = optionalNumber(payload, 'estimatedInputTokens') ?? 20_000;
    const summary = typeof payload.summary === 'string' ? payload.summary : taskId;
    // `true` = "I know this plan contains unpriced models, plan it anyway". On a
    // host with no prices at all this is already the default (and the card says
    // so); on a mixed catalog it is the only way past `price-unknown`.
    const allowUnknownPricing = optionalBoolean(payload, 'allowUnknownPricing');
    // 空清单 (blocker B, 灰狼 2026-11-15): "the user gave no stages" is a normal
    // request, not a programming error. `buildStages()` treats an empty list as a
    // contract violation (and keeps doing so — the planner's contract is not what
    // this fix is allowed to change); the HTTP boundary answers it with a 200 and a
    // card that says why nothing can start, because a 500 here is an error banner
    // the UI cannot turn into words.
    if (stageNames.length === 0) {
        const notice = '空清单：未提供阶段（请至少给出一个阶段名）';
        // Reused, not hand-written: the empty card goes through the same builder as
        // every other card so its shape (pricing stance, `canStart: false`, no rows)
        // cannot drift. Only the footer is replaced — an empty sum would otherwise
        // print `合计 ~¥0.000`, which reads like a real, free plan.
        const built = buildPlanCard({
            plan: {
                taskId,
                planId: '',
                summary,
                stages: [],
                baselineModelKey: '',
                baselineIsGuess: true,
                createdAt: nowIso(),
            },
            pricing: deps.host.pricing,
        });
        return json(200, {
            ok: true,
            // No plan was created: `planId: ''` (not a made-up id that `/plan/confirm`
            // would answer with `unknown-plan`), plus the same fact as data.
            planId: '',
            empty: true,
            notice,
            stages: [],
            modelCount: 0,
            pricing: deps.host.pricing,
            card: { ...built, footer: notice, blockers: [] },
        });
    }
    // How many models this scan found — the number `/router/plan` reports. The
    // registry's size would be the union of every scan this process ever did.
    let modelCount = 0;
    if (deps.models) {
        const models = await deps.models();
        modelCount = models.length;
        if (models.length > 0)
            deps.host.registerModels(models);
    }
    const plan = deps.host.plan({
        taskId,
        summary,
        stageNames: stageNames,
        estimatedInputTokens: inputTokens,
        ...(optionalNumber(payload, 'estimatedOutputTokens') === undefined
            ? {}
            : { estimatedOutputTokens: optionalNumber(payload, 'estimatedOutputTokens') }),
        ...(isCountMap(payload.usage) ? { usage: payload.usage } : {}),
        ...(allowUnknownPricing === undefined ? {} : { allowUnknownPricing }),
    });
    const card = deps.host.planCard(plan.planId);
    return json(200, {
        ok: true,
        planId: plan.planId,
        // The count is part of the answer, not something the caller derives from an
        // empty card: "0 models" and "no answer" must not look the same.
        modelCount,
        // The money stance travels with the plan: the caller must be able to tell
        // "this host prices nothing" from "the plan was allowed to be unpriced".
        pricing: deps.host.pricingFor(plan.planId),
        card,
        plan: serializePlan(deps.host, plan),
    });
}
/**
 * The user pressed 确认开工. Approval is what unlocks switching (D-004); a card
 * with unassigned stages refuses here, with `needsWizard` when that is the fix.
 */
async function postConfirm(body, deps) {
    const payload = asObject(body);
    const planId = requireString(payload, 'planId');
    const plan = deps.host.getPlan(planId);
    if (!plan)
        throw new RouterError('unknown-plan', `unknown plan "${planId}"`);
    // The client's slot scope is a session, so confirm is where the id normally
    // arrives. Binding it to the plan lets the following `/router/switch` (which
    // may not repeat it) use the same session instead of guessing one.
    const statedSession = optionalString(payload, 'sessionId');
    if (statedSession)
        deps.sessions?.bind(planId, statedSession);
    // Same opt-in as `/router/plan`, so a caller that only learns about the price
    // rule at confirm time can still say yes without re-planning.
    const allowUnknownPricing = optionalBoolean(payload, 'allowUnknownPricing');
    const approved = deps.host.approvePlan(plan, {
        ...(allowUnknownPricing === undefined ? {} : { allowUnknownPricing }),
    });
    const state = deps.session.start(planId);
    return json(200, {
        ok: true,
        planId,
        approvedAt: approved.approvedAt,
        pricing: deps.host.pricingFor(planId),
        card: deps.host.planCard(planId),
        state,
    });
}
/** Changing a row's model before start: recomputes that row and the total. */
async function postSwap(body, deps) {
    const payload = asObject(body);
    const planId = requireString(payload, 'planId');
    const stageId = requireString(payload, 'stageId');
    const modelKey = requireString(payload, 'modelKey');
    const card = deps.host.swapStageModel(planId, stageId, modelKey);
    // The whole plan comes back, not just the card: "改后回读生效" has to be
    // checkable from the same answer, or a caller has to trust the ack.
    const plan = deps.host.getPlan(planId);
    return json(200, { ok: true, planId, card, ...(plan ? { plan: serializePlan(deps.host, plan) } : {}) });
}
/**
 * Switch the session to the model a stage needs.
 *
 * The whole path is the kernel's: plan gate (default-deny) → availability →
 * window/capability guard → adapter → read-back. This function only moves data,
 * so there is exactly one place where a switch can be authorised.
 */
async function postSwitch(body, deps) {
    const payload = asObject(body);
    const stageId = requireString(payload, 'stageId');
    const planId = requireString(payload, 'planId');
    // Arming the watch here as well as inside the host: the adapter is the only
    // thing that can read the global default, and this is the HTTP boundary.
    deps.host.primeGlobalDefault();
    const plan = deps.host.getPlan(planId);
    const assignment = plan?.stages.find((s) => s.stage.id === stageId);
    const targetKey = typeof payload.modelKey === 'string' ? payload.modelKey : assignment?.modelKey;
    if (!targetKey) {
        throw new RouterError('bad-request', `no model given and plan ${planId} has none for ${stageId}`);
    }
    // Defaults come from the plan, not from guesses made here: the card checked
    // the stage with these exact numbers, so a switch with no explicit figures has
    // to ask the same question the card answered (A1/A2). An explicit value still
    // wins — the running session knows better than the plan what it holds.
    const contextTokens = optionalNumber(payload, 'contextTokens') ?? assignment?.guardInputs?.contextTokens ?? 0;
    const expectedOutputTokens = optionalNumber(payload, 'expectedOutputTokens') ??
        assignment?.guardInputs?.expectedOutputTokens ??
        assignment?.stage.estimatedOutputTokens ??
        1_000;
    const required = Array.isArray(payload.requiredCapabilities)
        ? payload.requiredCapabilities
        : [];
    // The switch-time opt-in: a caller can allow one unpriced target without
    // re-approving the plan. Recorded per plan so the next switch asks the same
    // question with the same answer.
    const allowUnknownPricing = optionalBoolean(payload, 'allowUnknownPricing');
    // Blocking A: the session is resolved **before** the platform is touched.
    // The old code passed the literal `'current'`, and a real DSH host answers
    // that with `session "current" not found`. No id = 409 `session-unknown`,
    // never a guess.
    const resolution = deps.sessions?.resolve(planId, optionalString(payload, 'sessionId'));
    if (deps.sessions && !resolution) {
        throw new RouterError('session-unknown', 'unable to tell which session this switch belongs to: ' +
            (deps.sessions.describe?.() ?? 'no session was resolved') +
            ' — pass "sessionId" in the /router/switch body, or confirm the plan with one', { sessionIdRequired: true, sessionIdField: 'sessionId' });
    }
    if (resolution)
        deps.sessions?.bind(planId, resolution.sessionId);
    const result = await deps.host.switchForStage(stageId, targetKey, contextTokens, expectedOutputTokens, required, planId, {
        ...(allowUnknownPricing === undefined ? {} : { allowUnknownPricing }),
        ...(resolution ? { sessionId: resolution.sessionId } : {}),
    });
    // A successful switch is what moves the bar forward. "Already in use" is a
    // success too (B1): the session **is** on the model this stage needs, so the
    // cursor moves and the answer is 200. Reporting that as 409 taught callers
    // that a 409 is fine to retry, which is how a real guard refusal gets ignored.
    // A guard refusal (overflow, missing capability, no price) changes nothing:
    // the session did not move, so neither does the bar.
    const state = result.switched ? deps.session.advance(planId, stageId) : deps.session.state(planId);
    return json(result.switched ? 200 : 409, {
        ok: result.switched,
        switched: result.switched,
        // Which session this switch was performed on, and how it was found. Data,
        // not prose: a client can send it back and a reviewer can check it.
        ...(resolution ? { sessionId: resolution.sessionId, sessionSource: resolution.source } : {}),
        // "未能观测" is reported rather than implied: a watcher that could not read
        // the global default must not let its silence read as "nothing happened".
        ...(result.globalDefaultObserved === undefined
            ? {}
            : { globalDefaultObserved: result.globalDefaultObserved }),
        // The refusal's machine code (`price-unknown`, `context-overflow`, …) as
        // data: the acceptance criteria quote `price-unknown`, and a caller should
        // not have to match English prose to find it.
        ...(result.code ? { code: result.code } : {}),
        ...(result.alreadyInUse ? { alreadyInUse: true } : {}),
        // F5: which context branch was taken. Returned, not summarised — callers
        // (and the acceptance tests) must be able to see `compress` vs `direct`
        // instead of reading the English in `message`.
        ...(result.context ? { context: result.context } : {}),
        ...(result.compaction ? { compaction: result.compaction } : {}),
        message: result.message,
        ...(result.globalDefaultWrittenBack ? { globalDefaultWrittenBack: true } : {}),
        // Whether this run may contain an unpriced model, and why — on success and
        // on refusal alike, because "we stopped at price-unknown" needs the stance.
        pricing: deps.host.pricingFor(planId, allowUnknownPricing === true ? true : undefined),
        state,
    });
}
/**
 * The model scan, as data: "扫到 N 个模型", where each one came from, and what
 * was skipped.
 *
 * This is the observable output the first defect demanded. `count: 0` is still
 * a valid answer — but now it comes with the files that were read and the
 * reasons nothing was found, so "no models" can be diagnosed instead of
 * guessed at.
 */
async function getModels(deps) {
    let report;
    if (deps.modelReport) {
        report = await deps.modelReport();
    }
    else {
        const models = deps.models ? await deps.models() : [];
        report = {
            models,
            count: models.length,
            runtimeModels: models.filter((model) => model.source === 'dsh-runtime').length,
            configModels: models.filter((model) => model.source !== 'dsh-runtime').length,
            providers: [...new Set(models.map((model) => model.provider))],
            filesRead: [],
            skipped: [],
            notes: [],
        };
    }
    // Q2-7（2026-11-18）：模型选择器的价格来自 modelSource（它读 wb-model-prices.json 并做
    // wb-gateway/ 前缀归一）；而 modelReport 只给元数据、不带价。这里按 key 合并价格，
    // 再统一注册/返回，否则 /router/models 会永远 priceKnown=false（面板看不到三态）。
    let pricedById = new Map();
    if (deps.models) {
        try {
            const priced = await deps.models();
            if (Array.isArray(priced)) pricedById = new Map(priced.map((m) => [m.id, m.pricing]));
        } catch { /* 价格源不可用 ⇒ 保持 null，不猜价 */ }
    }
    const withPricing = report.models.map((model) => {
        const key = `${model.provider}/${model.model}`;
        const bare = key.replace(/^wb-gateway\//, '');
        const pricing = pricedById.get(key) || pricedById.get(bare) || model.pricing || null;
        const merged = pricing ? { ...model, pricing } : model;
        return { key, bare, model: merged };
    });
    if (withPricing.length > 0)
        deps.host.registerModels(withPricing.map((x) => x.model));
    return json(200, {
        ok: true,
        count: report.count,
        sources: { runtime: report.runtimeModels, config: report.configModels },
        providers: report.providers,
        ...(report.defaultModelKey ? { defaultModelKey: report.defaultModelKey } : {}),
        // "This host prices nothing" is a catalog fact, answered once here instead
        // of being re-derived by every caller from 16 `priceKnown:false` rows.
        pricing: deps.host.pricing,
        models: withPricing.map(({ key, model }) => ({
            key,
            provider: model.provider,
            model: model.model,
            label: model.label,
            capabilities: model.capabilities,
            source: model.source,
            // null, not a placeholder: a window we did not read is not a window.
            contextWindow: model.limitsGuessed ? null : model.limits.contextWindow,
            limitsGuessed: model.limitsGuessed === true,
            priceKnown: model.pricing.inputPerMTok !== null && model.pricing.outputPerMTok !== null,
            // Q2-7：三态与标签一并给 UI（local=0 本地；unpriced=待录入，不当作免费）
            priceState: model.pricing.state ?? null,
            priceLabel: model.pricing.label ?? null,
        })),
        filesRead: report.filesRead,
        skipped: report.skipped,
        notes: report.notes,
    });
}
/**
 * The plan card for a plan the host holds (the dock's read path).
 *
 * `planId` is optional: without it, the host's active plan. No plan at all is
 * `404 no-plan` rather than an empty card — the dock renders nothing on that,
 * which is the difference between "no plan yet" and "a plan with no rows".
 */
function getCard(query, deps) {
    const requested = query.get('planId') ?? undefined;
    const plan = requested ? deps.host.getPlan(requested) : deps.host.activePlan();
    if (!plan) {
        throw new RouterError('no-plan', requested ? `unknown plan "${requested}"` : 'no plan yet', {
            ...(requested ? { planId: requested } : {}),
        });
    }
    return json(200, { ok: true, planId: plan.planId, card: deps.host.planCard(plan.planId) });
}
/**
 * Status bar data. `active: false` means "draw nothing".
 *
 * B3: a `planId` we never issued is a 404. Answering 200 with `active: false`
 * made a typo (or a plan from a restarted host) look exactly like "no run yet",
 * so a caller could not tell "nothing to show" from "you asked about nothing".
 * No planId at all still answers 200 — that is a real question with a real
 * answer: whatever run is in flight.
 */
function getState(query, deps) {
    const planId = query.get('planId') ?? undefined;
    if (planId !== undefined && !deps.host.getPlan(planId)) {
        throw new RouterError('unknown-plan', `unknown plan "${planId}"`, { planId });
    }
    const state = deps.session.state(planId);
    return json(200, { ok: true, state });
}
/**
 * A stage ended. Books actual usage.
 *
 * B2: reporting "done" without token counts used to be accepted silently and
 * booked as 0 — the bar then said "已花 $0.0000" for work that really cost
 * money.（`$0.0000` 是 早期之前的历史渲染文字，保留原样以记录当时的事故；
 * 现口径 `¥` + 3 位小数。）A finish that claims success must carry usage; a `failed: true` finish
 * may omit it, because nothing ran. The action stays idempotent-friendly by
 * naming exactly what is missing, so a caller can fix one field.
 */
function postStageFinish(body, deps) {
    const payload = asObject(body);
    const planId = requireString(payload, 'planId');
    const stageId = requireString(payload, 'stageId');
    // Unknown plan is 404, not a 200 with an empty state: an id we never issued
    // cannot be answered for, and "ok" for it is a misleading success (B3).
    const plan = deps.host.getPlan(planId);
    if (!plan)
        throw new RouterError('unknown-plan', `unknown plan "${planId}"`);
    const modelKey = typeof payload.modelKey === 'string'
        ? payload.modelKey
        : plan.stages.find((s) => s.stage.id === stageId)?.modelKey;
    if (!modelKey)
        throw new RouterError('unknown-model', `no model for stage ${stageId}`);
    const inputTokens = optionalNumber(payload, 'inputTokens');
    const outputTokens = optionalNumber(payload, 'outputTokens');
    const failed = payload.failed === true;
    const counting = inputTokens !== undefined || outputTokens !== undefined;
    if (!failed && !counting) {
        throw new RouterError('usage-required', `stage ${stageId} cannot be booked as done without token counts: ` +
            `send inputTokens and outputTokens, or failed: true when nothing ran`, { planId, stageId, missing: ['inputTokens', 'outputTokens'] });
    }
    if (!failed && (inputTokens === undefined || outputTokens === undefined)) {
        throw new RouterError('usage-required', `stage ${stageId} needs both inputTokens and outputTokens to be booked`, {
            planId,
            stageId,
            missing: [
                ...(inputTokens === undefined ? ['inputTokens'] : []),
                ...(outputTokens === undefined ? ['outputTokens'] : []),
            ],
        });
    }
    const state = deps.session.finish({
        planId,
        stageId,
        modelKey,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(failed ? { failed: true } : {}),
    });
    return json(200, { ok: true, state });
}
/** Read-only wizard: what was found, what we guessed, what needs confirming. */
async function getWizard(deps) {
    if (deps.models) {
        const models = await deps.models();
        if (models.length > 0)
            deps.host.registerModels(models);
    }
    const draft = deps.host.wizardDraft();
    return json(200, { ok: true, wizard: buildWizardView(draft) });
}
/** The user pressed 完成: records the baseline, never rewrites DSH settings. */
function postWizardConfirm(body, deps) {
    const payload = asObject(body);
    const draft = deps.host.wizardDraft();
    const baselineKey = typeof payload.baselineKey === 'string' ? payload.baselineKey : undefined;
    const { confirmation } = confirmWizard(deps.host, draft, baselineKey);
    return json(200, { ok: true, confirmation, wizard: buildWizardView(deps.host.wizardDraft()) });
}
/**
 * F5 dry run: "if this stage switched to this model now, what happens to the
 * context?" — answered by the same function the switch itself uses.
 *
 * A card or a UI can ask before it acts, and gets one of four words plus the
 * sentence to show. `tokensAfterCompaction` may be supplied to ask the second
 * question ("is this enough?") without running a compression.
 */
function getContext(query, deps) {
    const stageId = query.get('stageId');
    const modelKey = query.get('modelKey');
    if (!stageId)
        throw new RouterError('bad-request', '"stageId" is required');
    const planId = query.get('planId') ?? undefined;
    if (planId !== undefined && !deps.host.getPlan(planId)) {
        throw new RouterError('unknown-plan', `unknown plan "${planId}"`, { planId });
    }
    const plan = planId ? deps.host.getPlan(planId) : undefined;
    const assignment = plan?.stages.find((s) => s.stage.id === stageId);
    const targetKey = modelKey ?? assignment?.modelKey;
    if (!targetKey) {
        throw new RouterError('bad-request', `no modelKey given and no plan stage "${stageId}"`);
    }
    const contextTokens = optionalNumberFromQuery(query, 'contextTokens') ?? assignment?.guardInputs?.contextTokens ?? 0;
    // DEF-5: this endpoint promises a dry run, so it must be one. The compress
    // branch used to be taken for real here (compressor called, ledger written,
    // money booked) — asking "what would happen?" changed what did happen.
    const decision = deps.host.contextVerdict(stageId, targetKey, contextTokens, planId, { dryRun: true });
    return json(200, { ok: true, decision, thresholds: deps.host.thresholds });
}
/**
 * F5 §3: the structured handover for a stage.
 *
 * Recorded, not generated: the five fields are what the compressing model is
 * asked to preserve, and writing them down before the compression is what makes
 * "缺项就重压或标红" possible afterwards.
 */
function postHandover(body, deps) {
    const payload = asObject(body);
    const stageId = requireString(payload, 'stageId');
    const planId = typeof payload.planId === 'string' ? payload.planId : undefined;
    if (planId !== undefined && !deps.host.getPlan(planId)) {
        throw new RouterError('unknown-plan', `unknown plan "${planId}"`, { planId });
    }
    const textList = (value) => Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
    const handover = {
        goal: typeof payload.goal === 'string' ? payload.goal : '',
        done: textList(payload.done),
        artifacts: textList(payload.artifacts),
        keyFacts: textList(payload.keyFacts),
        open: textList(payload.open),
    };
    const stored = deps.host.setHandover(stageId, handover, planId);
    return json(200, { ok: true, handover: stored, complete: deps.host.handoverProblems(planId, stageId).length === 0,
        problems: deps.host.handoverProblems(planId, stageId) });
}
/** F6 §4: the plan's estimates against the bill, stage by stage. */
function getReconcile(query, deps) {
    const planId = query.get('planId');
    if (!planId)
        throw new RouterError('bad-request', '"planId" is required');
    if (!deps.host.getPlan(planId)) {
        throw new RouterError('unknown-plan', `unknown plan "${planId}"`, { planId });
    }
    return json(200, {
        ok: true,
        reconcile: deps.host.reconcile(planId),
        exclusions: deps.host.savingsExclusions(planId),
    });
}
/** A non-negative number from the query string; anything else is "not given". */
function optionalNumberFromQuery(query, field) {
    const raw = query.get(field);
    if (raw === null || raw === '')
        return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
}
function isCountMap(value) {
    return (Boolean(value) &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.values(value).every((v) => typeof v === 'number'));
}
/**
 * Plan as JSON, with **one stage entry per stage of the task**.
 *
 * The external tester's fourth defect was `stages: []` next to a card full of
 * rows. Two things made that possible and both are fixed here: only the
 * assigned stages were serialized, and a stage with no model could not be
 * changed (the swap answered `unknown-stage`). Now an unassigned stage appears
 * with `modelKey: null`, its own name/capability, and the reason — so the row
 * the user must fix is also the row the UI can act on.
 */
function serializePlan(host, plan) {
    return {
        planId: plan.planId,
        taskId: plan.taskId,
        summary: plan.summary,
        baselineModelKey: plan.baselineModelKey,
        baselineIsGuess: plan.baselineIsGuess,
        createdAt: plan.createdAt,
        ...(plan.approvedAt ? { approvedAt: plan.approvedAt } : {}),
        ...(plan.unassignedStages ? { unassignedStages: plan.unassignedStages } : {}),
        stages: host.planStageRows(plan.planId).map(({ stage, assignment, unassignedReason }) => ({
            stageId: stage.id,
            name: stage.name,
            goal: stage.goal,
            capability: stage.capability,
            optional: stage.optional,
            /** null = this stage has no model yet (the row the user can fix). */
            modelKey: assignment?.modelKey ?? null,
            assigned: Boolean(assignment),
            modelLabel: assignment ? host.labelOf(assignment.modelKey) : null,
            reason: assignment?.reason ?? unassignedReason ?? '',
            /** Estimated input/output for the stage, always present (the plan's own numbers). */
            estimated: {
                inputTokens: stage.estimatedInputTokens,
                outputTokens: stage.estimatedOutputTokens,
            },
            /** The full money estimate, or null when there is no model to price. */
            estimate: assignment?.estimate ?? null,
        })),
    };
}
//# sourceMappingURL=endpoints.js.map