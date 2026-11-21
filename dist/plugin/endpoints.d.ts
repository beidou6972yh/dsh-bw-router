import type { CostEstimate, ModelEntry } from '../core/types.js';
import type { CapabilitySource } from '../core/types.js';
import { PluginHost, RouterSession, type CompressionResult, type ContextCompressor } from './index.js';
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
export declare const ROUTER_PREFIX = "/router";
/** Request as a transport hands it over: URL as a string, body already parsed. */
export interface RouterRequest {
    method: string;
    /** Full path (query string allowed), e.g. `/router/state?planId=plan-t1-1`. */
    path: string;
    body?: unknown;
}
export interface RouterResponse {
    status: number;
    body: Record<string, unknown>;
}
/** What the router needs from its environment; all injectable, no fs, no net. */
export interface RouterDeps {
    host: PluginHost;
    session: RouterSession;
    /**
     * Model entries the host discovered. Needed by `/router/models` (plan card
     * alternatives) and by the wizard. Injected, never imported: adapters own I/O.
     */
    models?: () => ModelEntry[] | Promise<ModelEntry[]>;
    /**
     * Full discovery report (counts, provenance, files, skips) behind `models`.
     *
     * `models` alone cannot answer "扫到 N 个模型" honestly: a scan that read five
     * files and found nothing looks identical to a scan that never ran. The
     * report is what `/router/models` prints.
     */
    modelReport?: () => Promise<ModelReportLike>;
    /** Where the last discovery came from, for the wizard's "sources" line. */
    sources?: CapabilitySource[];
    /**
     * F5: the host's compaction hook. Absent means "this host cannot compress",
     * which makes an over-full switch **refuse** with three options — never
     * truncate. Injected here so the kernel keeps owning timing/checks/booking
     * while DSH keeps owning the compaction engine (F5 §7).
     */
    compressor?: ContextCompressor;
    /**
     * The host's **async** compaction hook (DEF-1), normally DSH's own.
     *
     * The switch's decision is synchronous and DSH's compaction is not, so the
     * switch warms one compression (`warm` → this hook) **before** it asks for a
     * branch, then reads the result synchronously. Absent = "this host cannot
     * compress": the safe refusal stays, never a silent hard switch.
     */
    compact?: (input: {
        rendered: string;
        tokensBefore: number;
        targetModelKey?: string;
        /** The session this switch belongs to (resolved by the shell). */
        sessionId?: string;
    }) => Promise<CompressionResult>;
    /** F5 thresholds from config (70/50/16 defaults). Nonsense is clamped and noted. */
    contextThresholds?: Partial<Record<'directShare' | 'summaryShare' | 'refuseShare', unknown>>;
    /**
     * Which session a switch belongs to, resolved by the host shell.
     *
     * Absent on hand-built deps (a CLI harness that drives the host directly):
     * the switch then asks the host selection, which is still never offered the
     * literal `'current'`. When present, an unresolvable session is a **409
     * `session-unknown`** before the platform is touched — the alternative is a
     * request that fails inside `selectModel` with `session/not-found`.
     */
    sessions?: {
        bind(planId: string, sessionId: string): void;
        resolve(planId: string | undefined, requested?: string): {
            sessionId: string;
            source: string;
        } | undefined;
        current(): string | undefined;
        /** What was probed, for the 409 message (never a guess at a session). */
        describe?(): string;
    };
}
/**
 * The shape of one model scan, as `/router/models` reports it.
 *
 * Structural on purpose: `dsh-shell.ts` builds the real report, and this file
 * must not import it (the shell imports the endpoints). Any object with these
 * fields is a report.
 */
export interface ModelReportLike {
    models: ModelEntry[];
    count: number;
    runtimeModels: number;
    configModels: number;
    providers: string[];
    defaultModelKey?: string;
    filesRead: string[];
    skipped: string[];
    notes: string[];
}
/**
 * Handles one request. Returns 404 for anything not under our four paths, so a
 * host can mount this next to other plugins without a routing table.
 */
export declare function dispatch(request: RouterRequest, deps: RouterDeps): Promise<RouterResponse>;
/** The estimate shape the serialized plan promises (kept named for consumers). */
export type SerializedEstimate = CostEstimate;
//# sourceMappingURL=endpoints.d.ts.map