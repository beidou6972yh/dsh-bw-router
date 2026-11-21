import type { CapabilityEntry, ModelEntry } from '../core/types.js';
import type { DshConfigPaths } from '../adapters/dsh-config.js';
import { readDshConfig } from '../adapters/dsh-config.js';
import type { DshProviderConfig } from '../adapters/dsh-discovery.js';
import { discoverHostModels, type HostModelAnswer, type HostResolvedModel } from '../adapters/dsh-host-models.js';
import {
  defaultProfileCandidates,
  isLegacyCandidate,
  readProfileConfigFiles,
} from '../adapters/dsh-profile-config.js';
import { DshModelAdapter, createGlobalDefaultGuard, type DshModelSelection } from '../adapters/dsh-model.js';
import { emptyHandover } from '../core/context-guard.js';
import { dispatch, type RouterDeps, type RouterRequest, type RouterResponse } from './endpoints.js';
import { createHostCompaction, type HostCompactionEngine, type HostAgentRegistry, type HostTokenMeter } from './compaction-bridge.js';
import {
  PluginHost,
  RouterSession,
  type CompressionResult,
  type ContextCompressor,
} from './index.js';

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    listProviders?: () => { id: string; name?: string }[];
    listModels?: (provider: string) => Promise<{ id: string; name?: string; inputModalities?: readonly string[] }[]>;
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
      default?: { provider?: string; model?: string };
      groups?: { id: string; name?: string; models?: { id: string; name?: string }[] }[];
      failures?: { id: string; message?: string }[];
    }>;
  };
  /** DSH's settings service (`ctx.settings`): live values of every plugin config. */
  settings?: {
    describe?: () => { ns?: string; value?: unknown }[];
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
    currentSelection?: () => { provider?: unknown; model?: unknown } | undefined;
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
  contextThresholds?: { directShare?: number; summaryShare?: number; refuseShare?: number };
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
  on(event: 'data', cb: (chunk: { toString(): string }) => void): void;
  on(event: 'end', cb: () => void): void;
}

export interface DshHttpResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(payload: string): void;
}

export const PLUGIN_NAME = 'dsh-bw-router';

/**
 * Injects the web server; without it the plugin has no HTTP surface.
 *
 * The session/model-selection service is deliberately NOT injected: which name
 * a host registers it under differs between builds (`session` on the M0 host,
 * `sessionController` on DSH 0.2.x, `sessions` for the bare store), and Cordis
 * 4 has no "optional inject" — declaring a name a host lacks keeps the plugin
 * waiting forever. It is probed per call instead (see `resolveHostSession`).
 */
export const inject = ['webServer'];

/** Reads a request body as JSON. An unparseable body is `{}`, never a throw. */
export function readJsonBody(req: DshHttpRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk.toString();
    });
    req.on('end', () => {
      if (!text.trim()) return resolve({});
      try {
        const parsed: unknown = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** A host service method invoked as `fn(...)`; the call shape is detected by arity. */
type HostSelectModel = (...args: unknown[]) => unknown;

/**
 * Service names that may carry session-level model selection, probed in order.
 *
 * DSH 0.2.1-rc.2 registers it as `sessionController`; the M0 host exposed it as
 * `session`; a minimal host may only carry the session store as `sessions`.
 * Probing beats assuming — the M2 trial install crashed on exactly this
 * assumption (`cannot get property "session" without inject`).
 */
const SESSION_SERVICE_NAMES = ['session', 'sessionController', 'sessions'] as const;

/**
 * Reads a service off the host context, treating "not provided" as absent.
 *
 * `ctx.get(name)` is the Cordis-blessed **inject-free** read
 * (`ReflectService.get`: "Read a service from the store without the inject
 * requirement"), and it is the only portable way to look at a service the
 * plugin cannot list in `inject`: Cordis 4 has no optional inject, so declaring
 * `compaction`/`llm`/`agents` would keep this plugin waiting forever on a host
 * that lacks one, while *reading* `ctx.compaction` on a real context throws
 * `cannot get property "compaction" without inject`. Probing `get()` first and
 * falling back to a property read keeps both real Cordis and the plain-object
 * hosts the unit tests build working.
 */
function serviceOf<T>(ctx: DshHostContext, name: string): T | undefined {
  // Even reading `get` is a property access, and a Cordis proxy throws for
  // anything it does not resolve — so the probe itself is guarded.
  let get: DshHostContext['get'];
  try {
    get = ctx.get;
  } catch {
    get = undefined;
  }
  if (typeof get === 'function') {
    try {
      const value = get.call(ctx, name);
      if (value !== null && value !== undefined) return value as T;
    } catch {
      // A host whose `get()` refuses this name: fall through to the property.
    }
  }
  try {
    const value = (ctx as unknown as Record<string, unknown>)[name];
    return value === null || value === undefined ? undefined : (value as T);
  } catch {
    // Cordis throws for a service the fiber cannot reach; that is "not here",
    // and it must not escape activation.
    return undefined;
  }
}

/** First method among `names` that the service really implements, bound to it. */
function methodOf(service: Record<string, unknown>, names: readonly string[]): HostSelectModel | undefined {
  for (const name of names) {
    const fn = service[name];
    if (typeof fn === 'function') return (fn as HostSelectModel).bind(service);
  }
  return undefined;
}

/**
 * Reads an optional property off the host context.
 *
 * A real Cordis context is a proxy that throws
 * `cannot get property "<name>" without inject` for **anything** it cannot
 * resolve — including plain host-side options such as `ctx.compact` or
 * `ctx.contextThresholds`, and services the host does not provide. Every
 * optional read therefore goes through here: a missing capability is
 * "not observable", never a startup crash. This is the same class of defect as
 * the eager `ctx.session` read, one layer down.
 */
function hostProp<T>(ctx: DshHostContext, name: string): T | undefined {
  try {
    const value = (ctx as unknown as Record<string, unknown>)[name];
    return value === null || value === undefined ? undefined : (value as T);
  } catch {
    return undefined;
  }
}

/**
 * Resolves the host's session/model-selection surface, or `undefined` when this
 * host offers none.
 *
 * Runs per call on purpose: Cordis registers services asynchronously, and
 * activation is when they are least likely to be reachable. The old eager
 * `ctx.session ?? {}` turned that timing into a startup crash instead of the
 * "not observable" degradation this shell promises.
 */
export function resolveHostSession(ctx: DshHostContext): DshHostContext['session'] | undefined {
  for (const name of SESSION_SERVICE_NAMES) {
    const service = serviceOf<Record<string, unknown>>(ctx, name);
    if (!service || typeof service !== 'object') continue;
    const sessionId = typeof service.sessionId === 'string' ? service.sessionId : undefined;
    const readCurrent = methodOf(service, ['readCurrent', 'currentModel', 'getCurrentModel']);
    const selectModel = methodOf(service, ['selectModel', 'setModel']);
    const readGlobalDefault = methodOf(service, ['readGlobalDefault']);
    if (!readCurrent && !selectModel && !readGlobalDefault) continue;
    return {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(readCurrent === undefined ? {} : { readCurrent: () => String(readCurrent() ?? '') }),
      ...(selectModel === undefined ? {} : { selectModel: selectModel as HostSelectModel }),
      ...(readGlobalDefault === undefined
        ? {}
        : { readGlobalDefault: () => readGlobalDefault() as string | undefined }),
    };
  }
  return undefined;
}

/**
 * Calls the host's selection method in whichever shape that host uses.
 *
 * Arity is the only portable signal without importing host types: the DSH 0.2.x
 * request-object form takes one parameter, the M0 host takes `(provider, model)`,
 * and a variant takes the session id first.
 */
function callHostSelect(
  select: HostSelectModel,
  sessionId: string,
  provider: string,
  model: string,
): Promise<unknown> {
  const arity = select.length;
  const call =
    arity >= 3
      ? select(sessionId, provider, model)
      : arity === 2
        ? select(provider, model)
        : select({ sessionId, provider, model });
  return Promise.resolve(call);
}

/** Normalizes a (possibly absent, possibly non-string) reading into a model key. */
function modelKeyOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

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
export function agentSessionId(agent: unknown): string | undefined {
  if (!agent || typeof agent !== 'object') return undefined;
  const record = agent as { session?: { id?: unknown }; id?: unknown };
  const fromSession = record.session?.id;
  if (typeof fromSession === 'string' && fromSession) return fromSession;
  const own = record.id;
  return typeof own === 'string' && own ? own : undefined;
}

/** Whether an agent entry is in the `running` lifecycle state (never inferred). */
function isRunningAgent(agent: unknown): boolean {
  return Boolean(agent) && typeof agent === 'object' && (agent as { status?: unknown }).status === 'running';
}

/** Builds the resolver; exported so a probe/test can ask the same question. */
export function createSessionResolver(ctx: DshHostContext): HostSessionResolver {
  /** planId → the session that confirmed/started it. */
  const bound = new Map<string, string>();
  let current: string | undefined;

  const hostServiceId = (): string | undefined => {
    const named = resolveHostSession(ctx)?.sessionId ?? hostProp<string>(ctx, 'sessionId');
    return typeof named === 'string' && named.trim() !== '' ? named : undefined;
  };
  const initiatorId = (): string | undefined => {
    const agents = serviceOf<HostAgentRegistry>(ctx, 'agents');
    return agentSessionId(agents?.currentInitiator?.());
  };
  const runningAgentId = (): string | undefined => {
    const agents = serviceOf<HostAgentRegistry>(ctx, 'agents');
    const live = (agents?.list?.() ?? []) as unknown[];
    // Requiring `running` **and** a length of exactly one is the whole safety
    // argument: with two live sessions there is no honest way to pick one.
    const running = live.filter(isRunningAgent);
    if (running.length !== 1) return undefined;
    return agentSessionId(running[0]);
  };

  return {
    bind(planId, sessionId) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (id) bound.set(planId, id);
    },
    resolve(planId, requested) {
      const asked = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : undefined;
      // Lazy on purpose: a request that names its session must not depend on
      // `agents.list()` being reachable, and a throwing probe is "that source
      // said nothing", not a failed switch.
      const candidates: [HostSessionSource, () => string | undefined][] = [
        ['request', () => asked],
        ['plan', () => (planId ? bound.get(planId) : undefined)],
        ['host-service', hostServiceId],
        ['initiator', initiatorId],
        ['running-agent', runningAgentId],
      ];
      for (const [source, read] of candidates) {
        let id: string | undefined;
        try {
          id = read();
        } catch {
          id = undefined;
        }
        if (!id) continue;
        current = id;
        if (planId && asked) bound.set(planId, asked);
        return { sessionId: id, source };
      }
      current = undefined;
      return undefined;
    },
    /**
     * The id in effect. When no request/plan resolved one yet (a host calling
     * the adapter directly), fall back to the same host-side probes — never to a
     * literal, and never to a pick between two live sessions.
     */
    current() {
      if (current) return current;
      for (const read of [hostServiceId, initiatorId, runningAgentId]) {
        try {
          const id = read();
          if (id) return id;
        } catch {
          // "not observable" is not an error.
        }
      }
      return undefined;
    },
    describe: () =>
      "the request carried no sessionId, no plan bound one, the host's session service named none, " +
      'agents.currentInitiator() had no session, and agents.list() did not have exactly one running agent',
  };
}

/**
 * The user's global default model, read through the service that really has it.
 *
 * Real host: `ctx.agentDefaultModel.currentSelection()` → `{provider, model}`.
 * The legacy `session.readGlobalDefault()` is kept only as a fallback for hosts
 * that do publish it; `undefined` means "未能观测", and the switch response says
 * so instead of reporting an all-clear nobody verified.
 */
export function observeGlobalDefault(ctx: DshHostContext): string | undefined {
  const service = serviceOf<NonNullable<DshHostContext['agentDefaultModel']>>(ctx, 'agentDefaultModel');
  let selection: { provider?: unknown; model?: unknown } | undefined;
  try {
    selection = service?.currentSelection?.();
  } catch {
    selection = undefined;
  }
  const provider = selection?.provider;
  const model = selection?.model;
  if (typeof provider === 'string' && provider && typeof model === 'string' && model) {
    return `${provider}/${model}`;
  }
  const legacy = resolveHostSession(ctx)?.readGlobalDefault?.();
  return typeof legacy === 'string' && legacy.trim() !== '' ? legacy : undefined;
}

/**
 * Adapter over whatever the host gives us. Missing pieces stay missing.
 *
 * `resolver` is shared with `createRouter` so the adapter and the HTTP layer can
 * never disagree about which session is being switched.
 */
export function selectionFrom(
  ctx: DshHostContext,
  resolver: HostSessionResolver = createSessionResolver(ctx),
): DshModelSelection {
  /**
   * Model key of the last switch this plugin made.
   *
   * DSH 0.2.x can switch but does not publish a `readCurrent()`; falling back to
   * what we last wrote keeps the router honest after its own switch instead of
   * reporting "unknown" forever. It never overrides a host that can report.
   */
  let lastKnown = '';
  const deps = {
    selectModel: async (sessionId: string, provider: string, model: string) => {
      if (!sessionId) {
        throw new Error(
          'session-unknown: the switch has no session id (the request did not state one and the host named none)',
        );
      }
      const session = resolveHostSession(ctx);
      const select = session?.selectModel as HostSelectModel | undefined;
      if (!select) throw new Error('this host offers no selectModel');
      // The id we resolved is the id we hand over: the host's own session field
      // must not silently override what the request said.
      await callHostSelect(select, sessionId, provider, model);
      lastKnown = `${provider}/${model}`;
    },
    readCurrent: () => {
      const reported = modelKeyOf(resolveHostSession(ctx)?.readCurrent?.());
      return reported || lastKnown;
    },
  };
  const guard = createGlobalDefaultGuard(() => observeGlobalDefault(ctx));
  return new DshModelAdapter(deps, () => resolver.current() ?? '', guard);
}

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
export function modelReport(ctx: DshHostContext): () => Promise<ModelReport> {
  return async () => {
    const notes: string[] = [];
    const answer: HostModelAnswer = {};
    const config: DshProviderConfig[] = [];
    const filesRead: string[] = [];
    const skipped: string[] = [];
    /** The default route a profile file states (`agent-default-model`). */
    let configDefaultModelKey: string | undefined;

    // 1. The in-memory provider snapshot, when the host hands one over.
    const inMemory = hostProp<DshHostContext['providers']>(ctx, 'providers');
    if (inMemory?.length) config.push(...(inMemory as DshProviderConfig[]));

    // 2. The LLM runtime: routes, their models, and each model's real window.
    const llm = serviceOf<NonNullable<DshHostContext['llm']>>(ctx, 'llm');
    if (llm?.listProviders) {
      try {
        answer.providers = llm.listProviders();
      } catch (error) {
        notes.push(`llm.listProviders failed: ${messageOf(error)}`);
      }
    }
    if (llm?.listModels && answer.providers?.length) {
      const modelsByProvider: Record<string, { id: string; name?: string; inputModalities?: readonly string[] }[]> = {};
      const resolved: Record<string, HostResolvedModel> = {};
      for (const provider of answer.providers) {
        try {
          const models = await llm.listModels(provider.id);
          modelsByProvider[provider.id] = models;
          if (llm.resolveModelInfo) {
            for (const model of models) {
              try {
                resolved[`${provider.id}/${model.id}`] = await llm.resolveModelInfo(provider.id, model.id);
              } catch {
                // A route whose exact metadata is unavailable stays "window
                // unconfirmed" — the guard may refuse it, never assume it.
              }
            }
          }
        } catch (error) {
          notes.push(`llm.listModels(${provider.id}) failed: ${messageOf(error)}`);
        }
      }
      answer.modelsByProvider = modelsByProvider;
      if (Object.keys(resolved).length > 0) answer.resolved = resolved;
    }

    // 3. The session controller's catalog: what the GUI can actually select.
    const controller = serviceOf<NonNullable<DshHostContext['sessionController']>>(ctx, 'sessionController');
    if (controller?.modelCatalog) {
      try {
        answer.catalog = await controller.modelCatalog();
      } catch (error) {
        notes.push(`sessionController.modelCatalog failed: ${messageOf(error)}`);
      }
    }

    // 4. Live settings values (the profile's own plugin configs).
    const settings = serviceOf<NonNullable<DshHostContext['settings']>>(ctx, 'settings');
    if (settings?.describe) {
      try {
        for (const descriptor of settings.describe()) {
          for (const provider of providersFromSettingsValue(descriptor.value)) {
            config.push(provider);
          }
        }
      } catch (error) {
        notes.push(`settings.describe failed: ${messageOf(error)}`);
      }
    }

    // 5. Config files: the profile patch, settings.yaml, and the legacy JSON trio.
    //    The active profile is named by the settings service when it is
    //    reachable; otherwise the `$DSH_HOME/profiles` scan stands in.
    try {
      const declared = hostProp<string[]>(ctx, 'profileCandidates');
      let activeDocument: string | undefined;
      try {
        activeDocument = declaredDocumentPath(settings?.documentPath);
      } catch (error) {
        notes.push(`settings.documentPath failed: ${messageOf(error)}`);
      }
      const scannedFiles = declared ?? (await defaultProfileCandidates());
      // With the active profile known, read **that** patch plus the legacy
      // fallbacks — not every sibling profile. A sibling profile describes a
      // different DSH process; advertising its routes here would offer models
      // this process cannot route.
      const candidates =
        declared || !activeDocument
          ? scannedFiles
          : [
              activeDocument,
              ...scannedFiles.filter(
                (file) => file !== activeDocument && isLegacyCandidate(file),
              ),
            ];
      const scanned = await readProfileConfigFiles(candidates);
      config.push(...scanned.providers);
      filesRead.push(...scanned.filesRead);
      skipped.push(...scanned.skipped);
      if (scanned.defaultModelKey) configDefaultModelKey = scanned.defaultModelKey;
      const profileFiles = scanned.filesRead.filter((file) => !isLegacyCandidate(file));
      if (!activeDocument && profileFiles.length > 1) {
        // Honest about the weaker evidence: without `settings.documentPath()` the
        // scan cannot tell the active profile from a sibling one, so it reads
        // every real profile and says so instead of silently merging them.
        notes.push(
          `the host did not name its active profile; read ${profileFiles.length} profile files`,
        );
      }
    } catch (error) {
      skipped.push(`profile scan failed: ${messageOf(error)}`);
    }
    const configPaths = hostProp<DshHostContext['configPaths']>(ctx, 'configPaths');
    if (configPaths) {
      const fromJson = await readDshConfig(configPaths);
      config.push(...fromJson.configs);
      filesRead.push(...fromJson.filesRead);
      skipped.push(...fromJson.skipped);
    }

    if (config.length > 0) answer.config = config;
    const discovered = discoverHostModels(answer);
    return {
      models: discovered.models,
      count: discovered.models.length,
      runtimeModels: discovered.runtimeModels,
      configModels: discovered.configModels,
      providers: discovered.providers,
      // The host's live default wins; a profile file's `agent-default-model`
      // entry is the same fact stated on disk, and is used when the host does
      // not expose a catalog.
      ...((discovered.defaultModelKey ?? configDefaultModelKey)
        ? { defaultModelKey: discovered.defaultModelKey ?? configDefaultModelKey }
        : {}),
      filesRead,
      skipped,
      notes: [...notes, ...discovered.notes],
    };
  };
}

/**
 * The active profile's patch path, from whichever shape the host exposes.
 *
 * `get documentPath(): string` is the real DSH 0.2.1-rc.2 shape (a **getter**),
 * so `settings?.documentPath?.()` threw `is not a function` and the pointer was
 * silently lost. All three shapes are accepted here, and anything else is
 * `undefined` (honest "not named") rather than an exception that hides the cause.
 */
export function declaredDocumentPath(
  declared: (() => string) | string | undefined,
): string | undefined {
  if (typeof declared === 'function') {
    const value: unknown = declared();
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  }
  return typeof declared === 'string' && declared.trim() !== '' ? declared : undefined;
}

/** Discovery is read-only and never fatal: a broken config is "no models yet". */
export function modelSource(ctx: DshHostContext): () => Promise<ModelEntry[]> {
  const report = modelReport(ctx);
  return async () => (await report()).models;
}

/**
 * Provider objects out of one `settings.describe()` value.
 *
 * A settings descriptor's `value` is the live config of one profile entry, so
 * the providers may sit at its root (`{ providers: {...} }`) or one section deep
 * (a plugin whose config is `{ llm: { providers } }`). Anything else is "this
 * entry has no providers" — not an error.
 */
export function providersFromSettingsValue(value: unknown): DshProviderConfig[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const direct = record.providers;
  const out: DshProviderConfig[] = [];
  const collect = (providers: unknown): void => {
    if (!providers || typeof providers !== 'object') return;
    const entries = Array.isArray(providers)
      ? providers.map((item) => [undefined, item] as const)
      : Object.entries(providers as Record<string, unknown>);
    for (const [key, item] of entries) {
      if (!item || typeof item !== 'object') continue;
      const provider = item as Record<string, unknown>;
      const id =
        key ?? (typeof provider.id === 'string' ? provider.id : typeof provider.provider === 'string' ? provider.provider : undefined);
      if (!id) continue;
      const models = Array.isArray(provider.models) ? provider.models : [];
      out.push({
        id,
        name:
          (typeof provider.displayName === 'string' && provider.displayName) ||
          (typeof provider.name === 'string' && provider.name) ||
          id,
        models: models
          .map((model) => {
            if (typeof model === 'string') return { id: model };
            if (!model || typeof model !== 'object') return undefined;
            const shape = model as Record<string, unknown>;
            const modelId = typeof shape.id === 'string' ? shape.id : undefined;
            if (!modelId) return undefined;
            return {
              id: modelId,
              ...(typeof shape.name === 'string' ? { name: shape.name } : {}),
              ...(typeof shape.contextWindow === 'number' ? { contextWindow: shape.contextWindow } : {}),
              ...(typeof shape.maxTokens === 'number'
                ? { maxOutputTokens: shape.maxTokens }
                : typeof shape.maxOutputTokens === 'number'
                  ? { maxOutputTokens: shape.maxOutputTokens }
                  : {}),
              ...(typeof shape.inputPerMTok === 'number' ? { inputPerMTok: shape.inputPerMTok } : {}),
              ...(typeof shape.outputPerMTok === 'number' ? { outputPerMTok: shape.outputPerMTok } : {}),
            };
          })
          .filter((model): model is NonNullable<typeof model> => Boolean(model)),
      });
    }
  };
  collect(direct);
  if (out.length === 0) {
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === 'object' && 'providers' in (nested as Record<string, unknown>)) {
        collect((nested as Record<string, unknown>).providers);
      }
    }
  }
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
export function resolveHostCompaction(
  ctx: DshHostContext,
  resolver: HostSessionResolver = createSessionResolver(ctx),
): ((input: { rendered: string; tokensBefore: number; targetModelKey?: string }) => Promise<CompressionResult>) | undefined {
  const engine = serviceOf<HostCompactionEngine>(ctx, 'compaction');
  if (engine) {
    const agents = serviceOf<HostAgentRegistry>(ctx, 'agents');
    const tokenMeter = serviceOf<HostTokenMeter>(ctx, 'tokenMeter');
    const bridged = createHostCompaction({
      engine,
      ...(agents ? { agents } : {}),
      ...(tokenMeter ? { tokenMeter } : {}),
      // A thunk, not a value read at activation: the session is only known when
      // a request has resolved it (HTTP handlers have no initiating agent).
      sessionId: () => resolver.current(),
    });
    if (bridged) return bridged;
  }
  return hostProp<NonNullable<DshHostContext['compact']>>(ctx, 'compact');
}

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
export function createRouter(ctx: DshHostContext): {
  host: PluginHost;
  session: RouterSession;
  deps: RouterDeps;
  handle: (request: RouterRequest) => Promise<RouterResponse>;
} {
  const contextThresholds = hostProp<DshHostContext['contextThresholds']>(ctx, 'contextThresholds');
  // 铁律 5, honest-degradation form: the host may pin the price stance
  // (`auto` | `strict` | `allow-unknown`). Absent means `auto`, which is what a
  // real host needs: provider config states no prices, so the guard relaxes and
  // every surface says the estimate is unavailable.
  const pricingPolicy = hostProp<DshHostContext['pricingPolicy']>(ctx, 'pricingPolicy');
  // One resolver per host: the HTTP layer, the adapter and the compaction bridge
  // all ask the same object, so "which session" has exactly one answer.
  const sessions = createSessionResolver(ctx);
  const host = new PluginHost(selectionFrom(ctx, sessions), {
    ...(contextThresholds ? { contextThresholds } : {}),
    ...(pricingPolicy === undefined ? {} : { pricingPolicy }),
  });
  const compact = resolveHostCompaction(ctx, sessions);
  const deps: RouterDeps = {
    host,
    session: new RouterSession(host),
    models: modelSource(ctx),
    modelReport: modelReport(ctx),
    sessions,
  };
  if (compact) {
    // One compressor per router: `warm` produces, `compress` consumes, and neither
    // outlives this host context.
    const { compressor, warm } = createCompressor({ compact });
    host.setCompressor(compressor);
    // The kernel warms through the host (it owns *when*), so the async compaction
    // is reachable from the switch itself and not only from an endpoint.
    host.setCompactionHook(async (input) => {
      await warm(input.rendered, input.tokensBefore, input.sessionId);
      return compressor.compress({ ...input, handover: emptyHandover() });
    });
  }
  return {
    host,
    session: deps.session,
    deps,
    handle: (request) => dispatch(request, deps),
  };
}


/**
 * Cordis entry. Registers one prefix route and returns nothing: the ledger and
 * the plans live in the closure, so two hosts never share a run.
 */
export function apply(ctx: DshHostContext): void {
  const router = createRouter(ctx);
  const register = () => {
    ctx.webServer?.register({
      kind: 'prefix',
      path: '/router',
      handler: async (req, res) => {
        const body = req.method?.toUpperCase() === 'POST' ? await readJsonBody(req) : undefined;
        const answer = await router.handle({
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          ...(body === undefined ? {} : { body }),
        });
        res.writeHead(answer.status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(answer.body));
      },
    });
  };
  // `effect` gives the host a way to tear the route down with the plugin.
  const effect = hostProp<(fn: () => (() => void) | void) => unknown>(ctx, 'effect');
  if (effect) effect(() => register());
  else register();
}

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
export function createCompressor(input: {
  compact: NonNullable<DshHostContext['compact']>;
  targetModelKey?: string;
}): {
  compressor: ContextCompressor;
  warm: (rendered: string, tokensBefore: number, sessionId?: string) => Promise<void>;
} {
  let ready: CompressionResult | undefined;
  return {
    compressor: {
      compress: ({ handover: _handover, rendered, tokensBefore }) => {
        if (!ready) {
          throw new Error(
            `no compaction was pre-computed for ${tokensBefore} tokens: call warm() before switching ` +
              `(the switch refuses rather than truncating)`,
          );
        }
        const result = ready;
        ready = undefined;
        void rendered;
        return result;
      },
    },
    warm: async (rendered: string, tokensBefore: number, sessionId?: string) => {
      const result = await input.compact({
        rendered,
        tokensBefore,
        ...(input.targetModelKey ? { targetModelKey: input.targetModelKey } : {}),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      ready = {
        tokensAfter: result.tokensAfter,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        modelKey: result.modelKey,
        ...(result.cost === undefined ? {} : { cost: result.cost }),
        ...(result.reopenable === undefined ? {} : { reopenable: result.reopenable }),
      };
    },
  };
}

/** Test seam: the same wiring without a server, for `node -e` smoke checks. */
export const __test = {
  createRouter,
  selectionFrom,
  modelSource,
  modelReport,
  resolveHostCompaction,
  createSessionResolver,
  observeGlobalDefault,
};

/** Entry list as the wizard shows it; convenience for hosts that want one call. */
export async function listModels(ctx: DshHostContext): Promise<CapabilityEntry[]> {
  const host = new PluginHost(selectionFrom(ctx));
  host.registerModels(await modelSource(ctx)());
  return host.registry.all();
}
