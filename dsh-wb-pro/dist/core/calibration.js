export function emptyCalibration() {
    return { tokenSamples: [], costSamples: [], outOfBand: 0, outOfBandStages: [] };
}
/** Advertised band before any real usage is known. */
export const BASE_UNCERTAINTY = 0.35;
/** Below this the band stops being informative and becomes a boast. */
export const FLOOR_UNCERTAINTY = 0.15;
/** Never promise more than this; a huge band is honest, a fake tight one is not. */
export const CEILING_UNCERTAINTY = 1;
/**
 * Records one finished stage against its estimate.
 *
 * `actualCost` is the real charge (null when the model has no price — then only
 * tokens are compared, because comparing an unknown amount would be inventing
 * one). Returns the fields the caller books; the state is mutated in place
 * because it belongs to the run, not to the ledger.
 */
export function observeStage(state, params) {
    const predictedTokens = params.estimate.inputTokens + params.estimate.outputTokens;
    const actualTokens = params.actualInputTokens + params.actualOutputTokens;
    if (predictedTokens > 0 && actualTokens >= 0) {
        state.tokenSamples.push({ ratio: actualTokens / predictedTokens, stageId: params.stageId });
    }
    if (params.actualCost !== null &&
        params.estimate.cost !== null &&
        params.estimate.cost > 0) {
        const ratio = params.actualCost / params.estimate.cost;
        state.costSamples.push({ ratio, stageId: params.stageId });
        const band = params.estimate.uncertainty;
        // Outside the advertised band is a factual miss. Counted, never hidden: the
        // "账目偏差落在声明区间内" acceptance is only meaningful if misses show up.
        if (Math.abs(1 - ratio) > band) {
            state.outOfBand += 1;
            state.outOfBandStages.push(params.stageId);
        }
    }
    return state;
}
/**
 * The band to advertise for the **next** estimate of this run.
 *
 * Before any sample: the base 35%. After: the widest observed error, plus a
 * margin, because one stage is a sample and not a distribution — and never below
 * the floor. It can grow as easily as it shrinks: an estimate that was wrong by
 * 3× this run must not advertise ±15% next stage.
 */
export function calibratedUncertainty(state, base = BASE_UNCERTAINTY) {
    const ratios = [...state.costSamples, ...state.tokenSamples].map((s) => s.ratio);
    if (ratios.length === 0)
        return clampBand(base);
    const worst = ratios.reduce((max, ratio) => Math.max(max, Math.abs(1 - ratio)), 0);
    // Margin falls with evidence: 1 sample → +60% of the error, many → +15%.
    const margin = 1 + Math.max(0.15, 0.6 / Math.sqrt(ratios.length));
    return clampBand(Math.max(worst * margin, Math.min(worst * 1.15, worst + 0.05)));
}
function clampBand(band) {
    return Math.min(CEILING_UNCERTAINTY, Math.max(FLOOR_UNCERTAINTY, round3(band)));
}
/** `±35%` for a band. One function, so no two screens print it differently. */
export function bandText(uncertainty) {
    return `±${Math.round(clampBand(uncertainty) * 100)}%`;
}
/** Interval for one amount: `¥0.012 ~ ¥0.024` (band on the amount, not on the savings). */
export function costInterval(cost, uncertainty) {
    const band = clampBand(uncertainty);
    return { low: round6(cost * (1 - band)), high: round6(cost * (1 + band)) };
}
/** Interval for a token count: `~18k (11.7k–24.3k)`. */
export function tokenInterval(tokens, uncertainty) {
    const band = clampBand(uncertainty);
    return { low: Math.round(tokens * (1 - band)), high: Math.round(tokens * (1 + band)) };
}
/**
 * The error statement that goes next to every estimate (F6 §1).
 *
 * A number without this is a promise nobody can check. The statement names the
 * **basis** (how many real stages it has been compared against) and what the band
 * covers (token counts, and money when prices are known). It never says "准确".
 */
export function errorStatement(state, uncertainty) {
    const samples = state.tokenSamples.length;
    const band = bandText(uncertainty);
    const basis = samples === 0
        ? '尚未与真实用量对账（首次预估，仅按 token 口径推）'
        : `已与 ${samples} 段真实用量对账${state.outOfBand > 0 ? `（其中 ${state.outOfBand} 段超出声明区间，已计入加宽）` : '，均在声明区间内'}`;
    return (`误差口径：${band}，覆盖输入/输出 token 与（已知价格时的）费用；` +
        `${basis}。这是区间不是承诺，实际结算以宿主用量为准。`);
}
/**
 * Savings must never be computed from an unpriced side.
 *
 * The historic accident: no price configured ⇒ cost rendered `$0.0000` ⇒ "节省
 * 100%". An unknown price is not zero, so it is excluded from the savings sum and
 * named, and the caller prints "未知" instead of a number.
 *
 * （`$0.0000` 是 早期之前的历史渲染；现口径 `¥` + 3 位小数。事故的教训是
 * 「未知不等于 0」，与符号无关，故保留原样作历史说明。）
 */
export function savingsExclusion(estimates) {
    const unpriced = new Set();
    for (const estimate of estimates) {
        if (estimate.cost === null || estimate.savings === null) {
            for (const key of estimate.unknownPricing ?? [])
                unpriced.add(key);
            if ((estimate.unknownPricing ?? []).length === 0 && estimate.priceUnknownReason) {
                unpriced.add(estimate.priceUnknownReason);
            }
        }
    }
    const list = [...unpriced];
    return {
        unpriced: list,
        reason: list.length === 0
            ? ''
            : `节约额不计入：${list.join('、')} 无价格（未知不等于 0 元，故不参与节约额计算）`,
    };
}
function round3(n) {
    return Math.round(n * 1000) / 1000;
}
function round6(n) {
    return Math.round(n * 1e6) / 1e6;
}
//# sourceMappingURL=calibration.js.map