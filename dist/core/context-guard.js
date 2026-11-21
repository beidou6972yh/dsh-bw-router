export const DEFAULT_CONTEXT_THRESHOLDS = Object.freeze({
    directShare: 0.5,
    summaryShare: 0.7,
    refuseShare: 0.16,
});
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
export function readThresholds(config, fallback = DEFAULT_CONTEXT_THRESHOLDS) {
    const adjusted = [];
    const pick = (key) => {
        const raw = config?.[key];
        if (raw === undefined)
            return fallback[key];
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw >= 1) {
            adjusted.push(`${key}: ${String(raw)} is not a fraction in (0,1), kept ${fallback[key]}`);
            return fallback[key];
        }
        return raw;
    };
    let refuseShare = pick('refuseShare');
    let directShare = pick('directShare');
    let summaryShare = pick('summaryShare');
    if (summaryShare < directShare) {
        adjusted.push(`summaryShare ${summaryShare} < directShare ${directShare}: swapped so the summary band cannot be empty`);
        [directShare, summaryShare] = [summaryShare, directShare];
    }
    // The three bands only make sense ordered: compressing must land *below* the
    // comfortable line. A config that inverts that would let a "compressed" context
    // still be too big — a silent hole in the protection — so it is repaired here.
    if (refuseShare > directShare) {
        adjusted.push(`refuseShare ${refuseShare} > directShare ${directShare}: raised directShare so compressed stays comfortable`);
        directShare = refuseShare;
    }
    if (summaryShare < directShare) {
        adjusted.push(`summaryShare ${summaryShare} < directShare ${directShare}: raised to keep the bands ordered`);
        summaryShare = directShare;
    }
    return { thresholds: { directShare, summaryShare, refuseShare }, adjusted };
}
/** Absolute token thresholds for one window, printed in messages and tests. */
export function contextThresholdsFor(windowTokens, thresholds = DEFAULT_CONTEXT_THRESHOLDS) {
    const floor = (share) => Math.max(1, Math.floor(windowTokens * share));
    return {
        direct: floor(thresholds.directShare),
        summary: floor(thresholds.summaryShare),
        compressTo: floor(thresholds.refuseShare),
    };
}
const fmtK = (tokens) => `${Math.round(tokens / 100) / 10}k`;
/**
 * Decides what to do with the context before switching to a model of `windowTokens`.
 *
 * Pure and total: every input (including a nonsense window) produces a decision,
 * because the alternative is a caller that falls through to "just switch" when a
 * number was missing.
 */
export function decideContext(input) {
    const thresholds = input.thresholds ?? DEFAULT_CONTEXT_THRESHOLDS;
    const window = Math.max(1, Math.floor(input.windowTokens));
    const contextTokens = Math.max(0, Math.floor(input.contextTokens));
    const limits = contextThresholdsFor(window, thresholds);
    const share = contextTokens / window;
    const base = {
        share,
        contextTokens,
        targetTokens: limits.compressTo,
    };
    // Comfortable: nothing is cut, and the sentence says so instead of staying silent.
    if (contextTokens <= limits.direct) {
        return {
            ...base,
            action: 'direct',
            carriedTokens: contextTokens,
            carry: 'full',
            message: `context ${fmtK(contextTokens)} of ${fmtK(window)} (${pct(share)}) — fits directly, nothing cut`,
        };
    }
    // Middle band: go, but only with the structured handover chain.
    if (contextTokens <= limits.summary) {
        return {
            ...base,
            action: 'summary',
            carriedTokens: contextTokens,
            carry: 'summary-chain',
            message: `context ${fmtK(contextTokens)} of ${fmtK(window)} (${pct(share)}) — switching with the ` +
                `stage-summary chain only; the full transcript stays behind in the session`,
        };
    }
    // Compression was already run: is the result good enough?
    const after = input.tokensAfterCompaction;
    if (after !== undefined) {
        const afterTokens = Math.max(0, Math.floor(after));
        if (afterTokens <= limits.direct) {
            return {
                ...base,
                action: 'compress',
                contextTokens: afterTokens,
                carriedTokens: afterTokens,
                carry: 'summary-chain',
                message: `context compressed ${fmtK(contextTokens)} → ${fmtK(afterTokens)} ` +
                    `(target ≤ ${fmtK(limits.compressTo)}) — details may be lost, the transcript can still be reopened`,
            };
        }
        return {
            ...base,
            action: 'refuse',
            contextTokens: afterTokens,
            carriedTokens: 0,
            carry: 'none',
            message: `compression reached ${fmtK(afterTokens)}, still over ${fmtK(limits.direct)} ` +
                `(${pct(afterTokens / window)} of ${fmtK(window)}) — refusing to switch instead of truncating`,
            options: refusalOptions(window, afterTokens),
        };
    }
    // Over the compress band: compress, then ask again with `tokensAfterCompaction`.
    return {
        ...base,
        action: 'compress',
        carriedTokens: contextTokens,
        carry: 'summary-chain',
        message: `context ${fmtK(contextTokens)} of ${fmtK(window)} (${pct(share)}) — must be compressed to ` +
            `≤ ${fmtK(limits.compressTo)} before switching; if it cannot get there the switch is refused`,
    };
}
/** The three choices F5 §1 requires instead of a hard cut. */
export function refusalOptions(windowTokens, contextTokens) {
    return [
        {
            kind: 'bigger-window',
            label: `switch to a model with a bigger window (this stage needs more than ${fmtK(windowTokens)})`,
        },
        { kind: 'stay', label: 'stay on the current model and finish this stage here' },
        {
            kind: 'split',
            label: `split the task and open a new session for the rest (${fmtK(contextTokens)} carried over)`,
        },
    ];
}
function pct(share) {
    return `${Math.round(share * 100)}%`;
}
export const HANDOVER_LABELS = {
    goal: '任务目标',
    done: '已完成与结论',
    artifacts: '产物清单（文件路径）',
    keyFacts: '关键数字与决定',
    open: '未决问题与下一步',
};
export function emptyHandover() {
    return { goal: '', done: [], artifacts: [], keyFacts: [], open: [] };
}
/** True when a handover has all five fields filled (each with at least one item). */
export function handoverComplete(handover) {
    return validateHandover(handover).length === 0;
}
/**
 * Checks the three things §3/§4 say must survive: the artifact list, the key
 * numbers, and the outstanding work. The other two fields are checked as well —
 * a handover with no goal is not a handover — but the three are what "缺则重压或
 * 标红" is about.
 *
 * A path is not "named" unless it looks like one: "改了核心模块" is exactly the
 * sentence that makes a compressed context useless six turns later.
 */
export function validateHandover(handover) {
    const problems = [];
    if (!nonEmpty(handover.goal)) {
        problems.push({ field: 'goal', kind: 'missing', message: '交接缺「任务目标」' });
    }
    if (!filled(handover.done)) {
        problems.push({ field: 'done', kind: 'missing', message: '交接缺「已完成与结论」' });
    }
    if (!filled(handover.artifacts)) {
        problems.push({ field: 'artifacts', kind: 'missing', message: '交接缺「产物清单」' });
    }
    else if (!handover.artifacts.some(looksLikePath)) {
        problems.push({
            field: 'artifacts',
            kind: 'no-artifact-path',
            message: '产物清单里没有任何文件路径（后续阶段无法据此续做）',
        });
    }
    if (!filled(handover.keyFacts)) {
        problems.push({ field: 'keyFacts', kind: 'missing', message: '交接缺「关键数字与决定」' });
    }
    if (!filled(handover.open)) {
        problems.push({ field: 'open', kind: 'missing', message: '交接缺「未决问题与下一步」' });
    }
    return problems;
}
/**
 * Renders the handover as the text that travels with the switch.
 *
 * Fixed order, fixed headings: the next model (and the user reading the notice)
 * gets the same five sections every time, which is what makes "没丢上下文" a
 * property instead of a hope.
 */
export function renderHandover(handover, problems = []) {
    const list = (items) => (items.length === 0 ? '（无）' : items.map((i) => `- ${i}`).join('\n'));
    const body = [
        `## 任务目标\n${handover.goal || '（缺）'}`,
        `## 已完成与结论\n${list(handover.done)}`,
        `## 产物清单（文件路径）\n${list(handover.artifacts)}`,
        `## 关键数字与决定\n${list(handover.keyFacts)}`,
        `## 未决问题与下一步\n${list(handover.open)}`,
    ].join('\n\n');
    if (problems.length === 0)
        return body;
    const red = problems.map((p) => `- ⚠ red: ${p.message}`).join('\n');
    return `${body}\n\n## 校验未过（需重压）\n${red}`;
}
export function compactionNotice(input) {
    const before = fmtK(input.tokensBefore);
    const after = fmtK(input.tokensAfter);
    const reopen = input.reopenable === false
        ? '原文不可回看'
        : '细节可能丢失；原文可回溯';
    const base = `已把 ${before} 上下文压缩为 ${after} 交接摘要，${reopen}`;
    if (input.problems.length === 0) {
        return { visible: true, warning: false, text: base, problems: [] };
    }
    const missing = input.problems.map((p) => HANDOVER_LABELS[p.field]).join('、');
    return {
        visible: true,
        warning: true,
        text: `${base}。⚠ 交接校验未过：缺 ${missing}，建议重压`,
        problems: input.problems,
    };
}
function nonEmpty(text) {
    return text.trim().length > 0;
}
function filled(items) {
    return items.some((item) => item.trim().length > 0);
}
/** `src/core/card.ts`, `/tmp/out.md`, `docs/a/b.md` — a named file, not a vague noun. */
function looksLikePath(text) {
    return /(^|[\s`'"(])([\w.-]+\/)+[\w.-]+|(^|[\s`'"(])[\w-]+\.(ts|js|tsx|jsx|json|md|yml|yaml|sh|py|txt|csv|png|svg|docx)\b/.test(text);
}
//# sourceMappingURL=context-guard.js.map