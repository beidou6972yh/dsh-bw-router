import { modelKey } from './types.js';
export const DEFAULT_USAGE_DAYS = 30;
/** Projects a richer log onto the privacy-safe shape this module accepts. */
export function toCallRecord(entry) {
    return { at: entry.at, provider: entry.provider, model: entry.model };
}
/**
 * Counts calls per model inside the window. Pure: same input, same output.
 * Unparseable timestamps are dropped rather than guessed at.
 */
export function collectUsage(records, query = {}) {
    const windowDays = query.days ?? DEFAULT_USAGE_DAYS;
    const parsed = records
        .map((record) => ({ record, ts: Date.parse(record.at) }))
        .filter((row) => !Number.isNaN(row.ts));
    const anchor = query.now
        ? Date.parse(query.now)
        : parsed.reduce((max, row) => (row.ts > max ? row.ts : max), Number.NEGATIVE_INFINITY);
    const cutoff = Number.isFinite(anchor) ? anchor - windowDays * 86_400_000 : Number.NEGATIVE_INFINITY;
    const counts = new Map();
    let totalCalls = 0;
    let skipped = 0;
    for (const row of parsed) {
        if (row.ts < cutoff || row.ts > anchor) {
            skipped += 1;
            continue;
        }
        const key = modelKey(row.record.provider, row.record.model);
        const bucket = counts.get(key) ?? { provider: row.record.provider, model: row.record.model, calls: 0 };
        bucket.calls += 1;
        counts.set(key, bucket);
        totalCalls += 1;
    }
    const rows = [...counts.entries()]
        .map(([key, bucket]) => ({
        provider: bucket.provider,
        model: bucket.model,
        key,
        calls: bucket.calls,
        share: totalCalls === 0 ? 0 : bucket.calls / totalCalls,
    }))
        .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
    return {
        totalCalls,
        rows,
        topKey: rows[0]?.key,
        topShare: rows[0]?.share ?? 0,
        skipped,
        windowDays,
    };
}
/**
 * Usage as a plain `{ key: count }` map — the shape the baseline picker wants.
 */
export function usageCounts(summary) {
    const out = {};
    for (const row of summary.rows)
        out[row.key] = row.calls;
    return out;
}
/**
 * The model the user runs most, but only if it is actually in the capability
 * list. Returns undefined when usage and registry disagree — the wizard then
 * asks instead of guessing.
 */
export function inferBaseline(summary, entries) {
    // `rows` is already sorted by calls desc, so the first known key wins. Share
    // is taken from that row, not recomputed — callers compare it to 0.5.
    const row = summary.rows.find((candidate) => entries.some((entry) => entry.key === candidate.key));
    return row ? { key: row.key, calls: row.calls, share: row.share, known: true } : undefined;
}
/** One-line, user-facing sentence: "最常用 deepseek/chat，占 62%". */
export function describeUsage(summary, limit = 3) {
    if (summary.totalCalls === 0)
        return `最近 ${summary.windowDays} 天没有调用记录`;
    const top = summary.rows
        .slice(0, limit)
        .map((row) => `${row.key} ${Math.round(row.share * 100)}%`)
        .join('、');
    return `最近 ${summary.windowDays} 天共 ${summary.totalCalls} 次调用，最常用：${top}`;
}
//# sourceMappingURL=usage-stats.js.map