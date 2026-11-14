/**
 * Public entry of the dsh-model-router package.
 *
 * Everything a host (the DSH plugin shell, a CLI, a test) may import lives here.
 * `src/adapters/` stays out on purpose: platform code is handed to the plugin,
 * never pulled in by it.
 */
export { addCost, availableAnd, costOf, modelKey, nowIso, pricingKnown } from './core/types.js';
export { Registry, buildCapabilityList, pickBaseline, SOURCE_PRECEDENCE } from './core/registry.js';
export { buildPlanCard, formatSpent, withSwappedModel } from './core/card.js';
export { buildStages, pruneOptional } from './core/planner.js';
export { decideModel, decidePlan } from './core/decider.js';
export { DEFAULT_UNCERTAINTY, describeSavings, describeUnknownPrice, estimateStage, estimateWithoutModel, formatEstimate, formatUSD, priceUnknownReason, savingsRatio, sumEstimates, } from './core/budget.js';
export { DEFAULT_CONTEXT_THRESHOLDS, HANDOVER_LABELS, compactionNotice, contextThresholdsFor, decideContext, emptyHandover, handoverComplete, readThresholds, refusalOptions, renderHandover, validateHandover, } from './core/context-guard.js';
export { BASE_UNCERTAINTY, CEILING_UNCERTAINTY, FLOOR_UNCERTAINTY, bandText, calibratedUncertainty, costInterval, emptyCalibration, errorStatement, observeStage, savingsExclusion, tokenInterval, } from './core/calibration.js';
export { DEFAULT_HEADROOM, clampHeadroom, displayContext, guardSwitch, usableContext, } from './core/guard.js';
export { UNPRICED_HOST_NOTICE, UNPRICED_OPT_IN_NOTICE, UNPRICED_POLICY_NOTICE, catalogHasPrices, hasPricingNotice, parsePricingPolicy, resolvePricing, } from './core/pricing.js';
export { Ledger } from './core/ledger.js';
export { PluginHost, RouterError, RouterSession, UNPLANNED_RUN, buildWizardView, confirmWizard, } from './plugin/index.js';
export { ROUTER_PREFIX, dispatch } from './plugin/endpoints.js';
export { ROUTER_BASE, confirmPlan, describeFailure, fetchView, planCardFor, planCardLines, renderPlanCard, renderStatusBar, requestPlan, requestState, statusBarFor, statusBarLines, totalOf, } from './plugin/client.js';
//# sourceMappingURL=index.js.map