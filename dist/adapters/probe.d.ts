import type { CapabilityEntry } from '../core/types.js';
export interface ProbeTarget {
    /** Key used in logs and UI, e.g. `ollama`. */
    name: string;
    url: string;
}
/** Default local endpoints the wizard offers to check. */
export declare const DEFAULT_TARGETS: ProbeTarget[];
export interface ProbeResult {
    name: string;
    url: string;
    reachable: boolean;
    latencyMs: number;
    detail: string;
}
export interface ProbeOptions {
    /** Per-target timeout. Must stay small; the wizard blocks on this. */
    timeoutMs?: number;
    /** Injected fetch, so tests never touch the network. */
    fetchImpl?: FetchLike;
    now?: () => number;
}
/** Minimal abort-signal shape, so this file needs no DOM/Node type libs. */
export interface AbortSignalLike {
    readonly aborted: boolean;
}
export type FetchLike = (url: string, init?: {
    signal?: AbortSignalLike;
}) => Promise<{
    ok: boolean;
    status: number;
}>;
export declare const DEFAULT_TIMEOUT_MS = 2000;
/**
 * Probes one endpoint. Never throws: a dead port and a timeout both come back
 * as `reachable: false` with a reason, because the wizard must keep going.
 */
export declare function probeEndpoint(target: ProbeTarget, options?: ProbeOptions): Promise<ProbeResult>;
/** Probes every target concurrently; results keep input order. */
export declare function probeAll(targets?: ProbeTarget[], options?: ProbeOptions): Promise<ProbeResult[]>;
/** Applies probe results to registry entries by provider name. */
export declare function applyProbeResults(entries: CapabilityEntry[], results: ProbeResult[]): CapabilityEntry[];
//# sourceMappingURL=probe.d.ts.map