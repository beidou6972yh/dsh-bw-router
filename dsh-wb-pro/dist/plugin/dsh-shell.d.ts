import type { CapabilityEntry, ModelEntry } from '../core/types.js';
import type { DshConfigPaths } from '../adapters/dsh-config.js';
import type { DshProviderConfig } from '../adapters/dsh-discovery.js';
import { type HostResolvedModel } from '../adapters/dsh-host-models.js';
import { type DshModelSelection } from '../adapters/dsh-model.js';
import { type RouterDeps, type RouterRequest, type RouterResponse } from './endpoints.js';
import { type HostCompactionEngine, type HostAgentRegistry, type HostTokenMeter } from './compaction-bridge.js';
import { PluginHost, RouterSession, type CompressionResult, type ContextCompressor } from './index.js';
/**
 * The DSH plugin shell: the ~80 lines that wire an injected host to the router.
 *
 * Everything platform-specific arrives through `ctx` and stays here. The kernel
 * (`core/`) and the endpoints (`endpoints.ts`) know nothing about Cordis, DSH,
 * HTTP servers, or where config lives, which is what keeps them portable and
 * unit-testable — the same reason `adapters/` exists.
 *
 * Shape of the host contract, as verified on the previous plugin (M0 §3):
 *   ctx.webServer.register({ kind: 'prefix', path, handler(req, res) })
 *   ctx.effect(fn)  →  registers a disposable
 *   ctx.session     →  { readCurrent(), selectModel(provider, model), sessionId }
 * If a host offers less, the shell degrades to "not observable" instead of
 * pretending: a missing watcher reports `undefined`, a missing readCurrent
 * reports an empty model key.
 */
/** The slice of a DSH host this plugin needs. Everything optional is honest. */
export interface DshHostContext {
    webServer?: {
        register(route: {
            kind: 'prefix';
            path: string;
            handler: (req: DshHttpRequest, res: DshHttpResponse) => void | Promise<void>;
        }): unknown;
    };
    effect?: (fn: () => (() => void) | void) => unknown;
    /** Session id, when the host hands one to the plugin context. */
    sessionId?: string;
    /**
     * Session-level model selection, however this host exposes it.
     *
     * The shape is not fixed across builds: the M0 host takes `(provider, model)`,
     * another takes the session id first, and DSH 0.2.1-rc.2 exposes
     * `sessionController.selectModel({ sessionId, provider, model })`. The shell
     * detects the shape by arity (`callHostSelect`) instead of assuming one, which
     * is what broke the M2 trial install.
     */
    session?: {
        sessionId?: string;
        readCurrent?: () => string;
        selectModel?: (...args: any[]) => Promise<unknown> | unknown;
        /** Global default (agent-default-model) as the host can read it. */
        readGlobalDefault?: () => string | undefined;
    };
    /**
     * Provider config the host already has in memory. Read-only by contract.
     *
     * The optional model fields matter: `limits` and `pricing` are what the guard
     * and the money are computed from. They used to be dropped right here (only
     * `id` was copied through), so every runtime-discovered model arrived with a
     * placeholder window (marked "unconfirmed") and no price — which made the plan
     * gate refuse a plan on a host whose config clearly stated the window.
     */
    providers?: {
        id: string;
        name: string;
        models: {
            id: string;
            name?: string;
            contextWindow?: number;
            maxOutputTokens?: number;
            inputPerMTok?: number;
            outputPerMTok?: number;
            capabilities?: ModelEntry['capabilities'];
            supportsTools?: boolean;
            strength?: number;
        }[];
    }[];
    /** Where DSH keeps its provider config; used for a read-only discovery pass. */
    configPaths?: DshConfigPaths;
    /**
     * Config files the read-only model scan should consider.
     *
     * Default: the real install (`profiles/<profile>/cordis.patch.yml`,
     * `settings.yaml`, the legacy JSON trio). A test — or an embedded host with no
     * filesystem — passes its own list, `[]` included, so "what this host can see"
     * is stated by the host instead of inherited from whatever machine runs the
     * suite.
     */
    profileCandidates?: string[];
    /**
     * Cordis's inject-free service read (`ctx.get(name)`).
     *
     * See {@link serviceOf}: `ctx.<name>` on a real Cordis context throws for
     * anything the fiber did not inject, so every optional service is probed
     * through this first.
     */
    get?: (name: string) => unknown;
    /**
     * DSH's compaction service (`ctx.compaction`, a `CompactionEngine`).
     *
     * Verified against `@org/dsh-compaction@0.2.1-rc.2`, whose module
     * declares `interface Context { compaction: CompactionEngine }` with
     * `compactIfNeeded(agent, trigger, signal)` / `compactNow(agent, signal)` /
     * `compactRegion(start, end, agent, signal)`. The previous bridge looked for
     * `ctx.compact` — a name no modern host registers — which is why an over-full
     * switch could only refuse.
     */
    compaction?: HostCompactionEngine;
    /** DSH's live agent registry (`ctx.agents`): the agent that owns this session. */
    agents?: HostAgentRegistry;
    /** DSH's token meter (`ctx.tokenMeter`): the only honest "size after compaction". */
    tokenMeter?: HostTokenMeter;
    /** DSH's LLM runtime (`ctx.llm`): provider/model catalog and exact model metadata. */
    llm?: {
        listProviders?: () => {
            id: string;
            name?: string;
        }[];
        listModels?: (provider: string) => Promise<{
            id: string;
            name?: string;
            inputModalities?: readonly string[];
        }[]>;
        resolveModelInfo?: (provider: string, model: string) => Promise<HostResolvedModel>;
    };
    /**
     * DSH's session controller (`ctx.sessionController`).
     *
     * `modelCatalog()` is the Host-generation catalog the GUI model selector
     * reads — provider-grouped, with per-provider failures isolated — so it is the
     * authoritative answer to "what can this host route right now".
     */
    sessionController?: {
        modelCatalog?: () => Promise<{
            default?: {
                provider?: string;
                model?: string;
            };
            groups?: {
                id: string;
                name?: string;
                models?: {
                    id: string;
                    name?: string;
                }[];
            }[];
            failures?: {
                id: string;
                message?: string;
            }[];
        }>;
    };
    /** DSH's settings service (`ctx.settings`): live values of every plugin config. */
    settings?: {
        describe?: () => {
            ns?: string;
            value?: unknown;
        }[];
        /**
         * Path of the **active profile's** patch.
         *
         * The real DSH shape is a **getter**, not a method:
         * `get documentPath(): string` in `@org/dsh-settings@0.2.1-rc.2`
         * (compile output: `get documentPath() { return this.ownerContext... }`).
         * Probing it as `documentPath()` threw `documentPath is not a function`,
         * dropped the pointer, and made the scan read every sibling profile — how a
         * deleted provider (`provider_f`/`provider_g`) came back into the model table.
         *
         * All three shapes a host may use are accepted: the real getter (a string
         * on access), an older function-returning host, and a plain string.
         */
        documentPath?: string | (() => string);
    };
    /**
     * DSH's **global default model** service (`ctx.agentDefaultModel`).
     *
     * `currentSelection()` is the only real read of the user's default on
     * 0.2.1-rc.2 (`@org/dsh-agent-default-model/lib/types/index.d.ts`).
     * The M0-era `session.readGlobalDefault()` never existed on this host, so a
     * watcher built on it was blind on every real install and each write-back was
     * silent (K-003).
     */
    agentDefaultModel?: {
        currentSelection?: () => {
            provider?: unknown;
            model?: unknown;
        } | undefined;
    };
    /**
     * DSH's own compaction, if the host exposes it (F5 §7).
     *
     * The plugin does **not** ship a compressor. DSH already has `compaction-basic`,
     * `/compact` and `summarizationProvider/Model`; this hook is how the router asks
     * for one and gets back the real token usage. When it is missing, an over-full
     * switch refuses with three options — which is the honest outcome, and far
     * better than a second engine drifting from the host's.
     */
    compact?: (input: {
        /** The five-section handover the compressed context must preserve. */
        rendered: string;
        tokensBefore: number;
        /** Provider/model to reuse when the host wants a hint. */
        targetModelKey?: string;
        /** The session this switch belongs to, so the agent is located by id. */
        sessionId?: string;
    }) => Promise<{
        tokensAfter: number;
        inputTokens: number;
        outputTokens: number;
        modelKey: string;
        cost?: number | null;
        reopenable?: boolean;
    }>;
    /** F5 thresholds (70/50/16 defaults). Kept here so a host can pass its config. */
    contextThresholds?: {
        directShare?: number;
        summaryShare?: number;
        refuseShare?: number;
    };
    /**
     * 铁律 5, honest-degradation form: how hard to insist on a known price.
     *
     * `auto` (default) — a catalog with **no** prices at all allows the run and
     * every surface says the estimate is unavailable (`预估不可用：宿主未配价（按
     * token 记账）`); a **mixed** catalog stays strict (`price-unknown`) unless the
     * request says `allowUnknownPricing: true`. `strict` always refuses unpriced
     * models, `allow-unknown` never does. A host may pass this from its config.
     */
    pricingPolicy?: 'auto' | 'strict' | 'allow-unknown';
}
/** The bare bits of node's req/res this plugin touches. */
export interface DshHttpRequest {
    method?: string;
    url?: string;
    on(event: 'data', cb: (chunk: {
        toString(): string;
    }) => void): void;
    on(event: 'end', cb: () => void): void;
}
export interface DshHttpResponse {
    writeHead(status: number, headers: Record<string, string>): void;
    end(payload: string): void;
}
export declare const PLUGIN_NAME = "dsh-bw-router";
/**
 * Injects the web server; without it the plugin has no HTTP surface.
 *
 * The session/model-selection service is deliberately NOT injected: which name
 * a host registers it under differs between builds (`session` on the M0 host,
 * `sessionController` on DSH 0.2.x, `sessions` for the bare store), and Cordis
 * 4 has no "optional inject" — declaring a name a host lacks keeps the plugin
 * waiting forever. It is probed per call instead (see `resolveHostSession`).
 */
export declare const inject: string[];
/** Reads a request body as JSON. An unparseable body is `{}`, never a throw. */
export declare function readJsonBody(req: DshHttpRequest): Promise<Record<string, unknown>>;
/**
 * Resolves the host's session/model-selection surface, or `undefined` when this
 * host offers none.
 *
 * Runs per call on purpose: Cordis registers services asynchronously, and
 * activation is when they are least likely to be reachable. The old eager
 * `ctx.session ?? {}` turned that timing into a startup crash instead of the
 * "not observable" degradation this shell promises.
 */
export declare function resolveHostSession(ctx: DshHostContext): DshHostContext['session'] | undefined;
/** Where a session id came from; part of the answer, never a guess. */
export type HostSessionSource = 'request' | 'plan' | 'host-service' | 'initiator' | 'running-agent';
/** One resolved session and the evidence behind it. */
export interface HostSessionResolution {
    sessionId: string;
    source: HostSessionSource;
}
/**
 * Resolves the session this router is acting on, **per call**, and never
 * invents one.
 *
 * The M2 build fell back to the literal string `'current'`
 * (`sessionId ?? 'current'`). A real DSH host has no such session: its
 * `SessionController` does not even carry a `sessionId` property, and
 * `selectModel({sessionId})` first does `resolveAgent(request.sessionId)`, which
 * answers `RemoteError("session/not-found")` for an unknown id — so every real
 * switch failed with `session "current" not found`.
 *
 * Order (first answer wins, no literal anywhere):
 *  1. `sessionId` stated by the request (the client's slot scope is a session);
 *  2. the session a previous `/router/plan/confirm` bound to this plan;
 *  3. the host's own session service / context (`resolveHostSession().sessionId`);
 *  4. the agent initiating the current operation (`agents.currentInitiator()`);
 *  5. the **only running** agent in `agents.list()` — two live sessions are a
 *     refusal, because compressing or switching the wrong conversation is worse.
 * Anything else is "unknown", and the caller answers 409 `session-unknown`.
 */
export interface HostSessionResolver {
    /** Remembers that `planId` runs in `sessionId` (set by confirm/switch). */
    bind(planId: string, sessionId: string): void;
    /** Resolves for one call; sets {@link current} as a side effect. */
    resolve(planId: string | undefined, requested?: string): HostSessionResolution | undefined;
    /** The id resolved for the call in flight, or undefined. Never `'current'`. */
    current(): string | undefined;
    /** Human-readable account of what was probed, for a refusal message. */
    describe(): string;
}
/** The session id an agent carries, whichever field this host fills. */
export declare function agentSessionId(agent: unknown): string | undefined;
/** Builds the resolver; exported so a probe/test can ask the same question. */
export declare function createSessionResolver(ctx: DshHostContext): HostSessionResolver;
/**
 * The user's global default model, read through the service that really has it.
 *
 * Real host: `ctx.agentDefaultModel.currentSelection()` → `{provider, model}`.
 * The legacy `session.readGlobalDefault()` is kept only as a fallback for hosts
 * that do publish it; `undefined` means "未能观测", and the switch response says
 * so instead of reporting an all-clear nobody verified.
 */
export declare function observeGlobalDefault(ctx: DshHostContext): string | undefined;
/**
 * Adapter over whatever the host gives us. Missing pieces stay missing.
 *
 * `resolver` is shared with `createRouter` so the adapter and the HTTP layer can
 * never disagree about which session is being switched.
 */
export declare function selectionFrom(ctx: DshHostContext, resolver?: HostSessionResolver): DshModelSelection;
/**
 * Everything one model scan found, with the provenance a defect report needs.
 *
 * "扫到 N 个模型" has to be an answer the caller can read, not a number the UI
 * derives from an empty card: the external tester's first defect was invisible
 * precisely because "0 models" and "no answer" looked identical.
 */
export interface ModelReport {
    models: ModelEntry[];
    count: number;
    /** Models only a runtime source produced (host catalog / llm service). */
    runtimeModels: number;
    /** Models only a config source produced (settings / profile files). */
    configModels: number;
    providers: string[];
    /** The host's own default route (`provider/model`), when it states one. */
    defaultModelKey?: string;
    filesRead: string[];
    skipped: string[];
    notes: string[];
}
/**
 * Reads the live model list from the **host's own sources**, read-only.
 *
 * Order of precedence (this is what makes the plugin work on a real install):
 *  1. `ctx.providers` — the in-memory provider snapshot a host may hand over;
 *  2. `ctx.llm` — `listProviders()` / `listModels()` / `resolveModelInfo()`
 *     (grep: dsh-llm `LlmRuntime.listModels(provider)` and
 *     `resolveModelInfo(provider, model)`; the window into the guard comes only
 *     from here on a live route);
 *  3. `ctx.sessionController.modelCatalog()` — the Host-generation catalog the
 *     GUI model selector reads (`{ groups: [{ id, models }] }`);
 *  4. `ctx.settings.describe()` — live plugin config values;
 *  5. the profile YAML files (`profiles/<profile>/cordis.patch.yml`,
 *     `settings.yaml`) and the legacy JSON candidates.
 *
 * Nothing here throws: a source that fails is one `skipped`/`notes` line, and a
 * bad config still means "no models from that file" (项目约定).
 */
export declare function modelReport(ctx: DshHostContext): () => Promise<ModelReport>;
/**
 * The active profile's patch path, from whichever shape the host exposes.
 *
 * `get documentPath(): string` is the real DSH 0.2.1-rc.2 shape (a **getter**),
 * so `settings?.documentPath?.()` threw `is not a function` and the pointer was
 * silently lost. All three shapes are accepted here, and anything else is
 * `undefined` (honest "not named") rather than an exception that hides the cause.
 */
export declare function declaredDocumentPath(declared: (() => string) | string | undefined): string | undefined;
/** Discovery is read-only and never fatal: a broken config is "no models yet". */
export declare function modelSource(ctx: DshHostContext): () => Promise<ModelEntry[]>;
/**
 * Provider objects out of one `settings.describe()` value.
 *
 * A settings descriptor's `value` is the live config of one profile entry, so
 * the providers may sit at its root (`{ providers: {...} }`) or one section deep
 * (a plugin whose config is `{ llm: { providers } }`). Anything else is "this
 * entry has no providers" — not an error.
 */
export declare function providersFromSettingsValue(value: unknown): DshProviderConfig[];
/**
 * The host's compaction hook, from the **real** service name first.
 *
 * DSH 0.2.1-rc.2 provides `ctx.compaction` (a `CompactionEngine`); `ctx.compact`
 * is the M0-era name this plugin used to look for, and the external tester's
 * second defect is exactly that mismatch — the host had compaction all along,
 * the plugin asked for a name nothing registers, and an 80%-full context could
 * therefore only be refused. Order: `compaction` (bridged, see
 * `compaction-bridge.ts`), then the legacy `compact`, then nothing — and
 * "nothing" keeps the safe refusal rather than a silent hard switch.
 */
export declare function resolveHostCompaction(ctx: DshHostContext, resolver?: HostSessionResolver): ((input: {
    rendered: string;
    tokensBefore: number;
    targetModelKey?: string;
}) => Promise<CompressionResult>) | undefined;
/**
 * Everything the endpoints need, built once per host context.
 *
 * DEF-1: this is where F5 becomes reachable on a real host. `createCompressor()`
 * used to exist with no caller, so `host.compressor` was permanently undefined
 * and every over-full switch fell into `compaction-blocked` + refuse — the
 * "compress, then go" branch could not run in production at all.
 *
 * The wiring is done here, on `apply → createRouter`, from the host's own
 * `ctx.compact`:
 *
 *  - `RouterDeps.compact` is handed to the kernel, which calls it **before** the
 *    switch (`warm`: ask DSH's compaction for one compression and keep it), then
 *    asks the synchronous compressor for the result. That split exists because
 *    DSH's compaction is async and the switch's decision is not.
 *  - `host.setCompressor(...)` makes the same compressor reachable through the
 *    host, so the two paths cannot disagree about whether this host can compress.
 *  - No `ctx.compact` → nothing is injected, and the existing safe refusal stays
 *    exactly as it was: we do not turn "cannot compress" into a silent hard
 *    switch.
 */
export declare function createRouter(ctx: DshHostContext): {
    host: PluginHost;
    session: RouterSession;
    deps: RouterDeps;
    handle: (request: RouterRequest) => Promise<RouterResponse>;
};
/**
 * Cordis entry. Registers one prefix route and returns nothing: the ledger and
 * the plans live in the closure, so two hosts never share a run.
 */
export declare function apply(ctx: DshHostContext): void;
/**
 * Bridges an **async** host compaction into the synchronous compressor the
 * switch needs (F5).
 *
 * DSH's compaction is asynchronous (`/compact` talks to a model); the switch
 * decides the context branch *before* it moves the session, so the two cannot be
 * interleaved without the switch waiting. `warm()` is the supported order: ask
 * the host for one compression, keep the result, and let the synchronous
 * `compress()` hand back what the host already produced. If `warm()` was never
 * called, `compress()` throws — a switch then refuses rather than pretending the
 * context got smaller, which is the whole point of the gate.
 */
export declare function createCompressor(input: {
    compact: NonNullable<DshHostContext['compact']>;
    targetModelKey?: string;
}): {
    compressor: ContextCompressor;
    warm: (rendered: string, tokensBefore: number, sessionId?: string) => Promise<void>;
};
/** Test seam: the same wiring without a server, for `node -e` smoke checks. */
export declare const __test: {
    createRouter: typeof createRouter;
    selectionFrom: typeof selectionFrom;
    modelSource: typeof modelSource;
    modelReport: typeof modelReport;
    resolveHostCompaction: typeof resolveHostCompaction;
    createSessionResolver: typeof createSessionResolver;
    observeGlobalDefault: typeof observeGlobalDefault;
};
/** Entry list as the wizard shows it; convenience for hosts that want one call. */
export declare function listModels(ctx: DshHostContext): Promise<CapabilityEntry[]>;
//# sourceMappingURL=dsh-shell.d.ts.map