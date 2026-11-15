import type { CompressionResult } from './index.js';
/**
 * Bridges DSH's **real** compaction service into the router's compressor contract.
 *
 * The external tester's second defect: "本版宿主提供的是 `compaction`，它要的是
 * `compact`，所以上下文达到八成时只会安全拒绝". Grepping the host package
 * (`@deepseek-ai/dsh-compaction` 0.2.1-rc.2) confirms the name and the shape:
 *
 *   declare module '@deepseek-ai/cordis' { interface Context { compaction: CompactionEngine } }
 *   abstract class CompactionEngine {
 *     compactIfNeeded(agent, trigger, signal): Promise<CompactionResult | null>
 *     compactNow(agent, signal, sourceCommandId?): Promise<CompactionResult | null>
 *     compactRegion(start, end, agent, signal?): Promise<CompactionResult>
 *   }
 *
 * The router's kernel is synchronous about the *decision* and asynchronous about
 * the *work*, so this bridge is called from `warmCompression()` (before the
 * branch is decided) and its result is handed to the synchronous compressor —
 * "压缩，然后再切换". `compactIfNeeded` is the right entry point, not
 * `compactNow`: the host owns the pressure policy, and `compactNow` demands an
 * idle-agent maintenance lock (`ManualCompactAgentContext.runMaintenance`) that a
 * plugin driving a live session must not take.
 *
 * Everything below is structurally typed: no import of a DSH package, so the
 * plugin keeps working against a host that renames or reshapes a field, and the
 * kernel's portability rule (no platform API in `src/core/`) stays intact.
 */
/** What `CompactionEngine.compactIfNeeded()` answers, as far as we read it. */
export interface HostCompactionResult {
    readonly compactionId: unknown;
    readonly summarySeq: number;
    readonly summary: readonly unknown[];
    readonly shadowedRange: {
        start: number;
        end: number;
    };
    readonly shadowedSeqs: readonly number[];
    readonly shadowedTokenCount: number;
}
/** The slice of `ctx.compaction` this bridge calls. */
export interface HostCompactionEngine {
    compactIfNeeded?(agent: unknown, trigger: 'pressure' | 'context-overflow', signal: AbortSignal): Promise<HostCompactionResult | null>;
    compactNow?(agent: unknown, signal: AbortSignal): Promise<HostCompactionResult | null>;
}
/** The slice of `ctx.agents` this bridge reads. */
export interface HostAgentRegistry {
    get?(id: string): unknown;
    currentInitiator?(): unknown;
    list?(): readonly unknown[];
}
/** The slice of `ctx.tokenMeter` this bridge reads (the honest "size after"). */
export interface HostTokenMeter {
    measure(session: unknown): {
        totalTokens: number;
    };
}
/** The slice of `Session` this bridge reads (to find the summary event). */
export interface HostSession {
    id?: unknown;
    eventAt?(seq: number): {
        type?: string;
        data?: unknown;
    } | undefined;
}
/** The slice of `Agent` compaction needs: a session, and the routed options. */
export interface HostAgentContext {
    session?: HostSession;
    options?: {
        provider?: string;
        model?: string;
    };
}
/** Everything the bridge probes on the host context, read per call. */
export interface HostCompactionProbe {
    engine?: HostCompactionEngine;
    agents?: HostAgentRegistry;
    tokenMeter?: HostTokenMeter;
    /**
     * Session this router is driving, when the host names one.
     *
     * A **thunk** on purpose: an HTTP handler has no initiating turn, so the id is
     * only known once a request resolved it (see `createSessionResolver`).
     */
    sessionId?: string | (() => string | undefined);
}
/**
 * Builds the `RouterDeps.compact` hook from the host's own compaction service.
 *
 * @returns `undefined` when the host offers no compaction — the caller then
 *   falls back to the legacy `ctx.compact`, and failing that the switch keeps
 *   its safe refusal instead of pretending the context shrank.
 */
export declare function createHostCompaction(probe: HostCompactionProbe): ((input: {
    rendered: string;
    tokensBefore: number;
    /** The session the switch belongs to, when the request named one. */
    sessionId?: string;
    targetModelKey?: string;
}) => Promise<CompressionResult>) | undefined;
/**
 * Finds the agent that owns the session being routed.
 *
 * Order matters and is honest about why:
 *  1. the session this request resolved (`sessionId` thunk → `agents.get(id)`);
 *     an HTTP handler has no initiating agent, so a request-supplied id is the
 *     only reliable way in on a real host;
 *  2. the agent initiating the current operation (`currentInitiator()`), which
 *     is what a plugin acting inside a turn should use;
 *  3. the only **running** agent, when there is exactly one — a single-agent
 *     host names nothing because there is nothing to name;
 *  4. otherwise nothing: guessing between several sessions would compress the
 *     wrong conversation, which is worse than refusing.
 */
export declare function resolveAgent(probe: HostCompactionProbe): HostAgentContext | undefined;
//# sourceMappingURL=compaction-bridge.d.ts.map