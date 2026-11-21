import type { CapabilityEntry } from './types.js';
/**
 * "Which model do you actually run?" — answered from session logs.
 *
 * Privacy boundary, by construction: this module only ever sees
 * `{ at, provider, model }`. There is no field here that could hold message
 * content, and no field for prompt text to sneak into. Callers projecting a
 * richer log must strip it before calling `collectUsage`.
 */
/** The only shape this module accepts from a session log. */
export interface SessionCallRecord {
    /** ISO timestamp of the call. */
    at: string;
    provider: string;
    model: string;
    /** Optional token counts; never used for ranking, only for cost context. */
    inputTokens?: number;
    outputTokens?: number;
}
export interface UsageQuery {
    /** Window length in days, counted back from `now`. */
    days?: number;
    /** Reference point; defaults to the newest record's timestamp. */
    now?: string;
}
export interface UsageRow {
    provider: string;
    model: string;
    key: string;
    calls: number;
    /** 0..1, share of all calls inside the window. */
    share: number;
}
export interface UsageSummary {
    /** Total calls counted inside the window. */
    totalCalls: number;
    /** Rows, most-used first; ties broken by key for stable output. */
    rows: UsageRow[];
    /** Most-used model key, or undefined when nothing was counted. */
    topKey?: string;
    /** Share of the top model, 0..1. */
    topShare: number;
    /** Records dropped for being outside the window. */
    skipped: number;
    windowDays: number;
}
export declare const DEFAULT_USAGE_DAYS = 30;
/** Projects a richer log onto the privacy-safe shape this module accepts. */
export declare function toCallRecord(entry: {
    at: string;
    provider: string;
    model: string;
}): SessionCallRecord;
/**
 * Counts calls per model inside the window. Pure: same input, same output.
 * Unparseable timestamps are dropped rather than guessed at.
 */
export declare function collectUsage(records: SessionCallRecord[], query?: UsageQuery): UsageSummary;
/**
 * Usage as a plain `{ key: count }` map — the shape the baseline picker wants.
 */
export declare function usageCounts(summary: UsageSummary): Record<string, number>;
/**
 * The model the user runs most, but only if it is actually in the capability
 * list. Returns undefined when usage and registry disagree — the wizard then
 * asks instead of guessing.
 */
export declare function inferBaseline(summary: UsageSummary, entries: CapabilityEntry[]): {
    key: string;
    calls: number;
    share: number;
    known: boolean;
} | undefined;
/** One-line, user-facing sentence: "最常用 deepseek/chat，占 62%". */
export declare function describeUsage(summary: UsageSummary, limit?: number): string;
//# sourceMappingURL=usage-stats.d.ts.map