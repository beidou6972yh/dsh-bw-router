import { readDshConfig } from '../adapters/dsh-config.js';
import { readFile } from 'node:fs/promises';
import { discoverHostModels } from '../adapters/dsh-host-models.js';
import { defaultProfileCandidates, isLegacyCandidate, readProfileConfigFiles, } from '../adapters/dsh-profile-config.js';
import { DshModelAdapter, createGlobalDefaultGuard } from '../adapters/dsh-model.js';
import { emptyHandover } from '../core/context-guard.js';
import { dispatch } from './endpoints.js';
import { createHostCompaction } from './compaction-bridge.js';
import { PluginHost, RouterSession, } from './index.js';
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
// [2026-11-22 DSH 市场维护者要求] connection = DSH 连接信任闸；路由 handler 进门先验票。
export const inject = ['webServer', 'connection'];
/** Reads a request body as JSON. An unparseable body is `{}`, never a throw. */
export function readJsonBody(req) {
    return new Promise((resolve) => {
        let text = '';
        req.on('data', (chunk) => {
            text += chunk.toString();
        });
        req.on('end', () => {
            if (!text.trim())
                return resolve({});
            try {
                const parsed = JSON.parse(text);
                resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
            }
            catch {
                resolve({});
            }
        });
    });
}
/**
 * Service names that may carry session-level model selection, probed in order.
 *
 * DSH 0.2.1-rc.2 registers it as `sessionController`; the M0 host exposed it as
 * `session`; a minimal host may only carry the session store as `sessions`.
 * Probing beats assuming — the M2 trial install crashed on exactly this
 * assumption (`cannot get property "session" without inject`).
 */
const SESSION_SERVICE_NAMES = ['session', 'sessionController', 'sessions'];
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
function serviceOf(ctx, name) {
    // Even reading `get` is a property access, and a Cordis proxy throws for
    // anything it does not resolve — so the probe itself is guarded.
    let get;
    try {
        get = ctx.get;
    }
    catch {
        get = undefined;
    }
    if (typeof get === 'function') {
        try {
            const value = get.call(ctx, name);
            if (value !== null && value !== undefined)
                return value;
        }
        catch {
            // A host whose `get()` refuses this name: fall through to the property.
        }
    }
    try {
        const value = ctx[name];
        return value === null || value === undefined ? undefined : value;
    }
    catch {
        // Cordis throws for a service the fiber cannot reach; that is "not here",
        // and it must not escape activation.
        return undefined;
    }
}
/** First method among `names` that the service really implements, bound to it. */
function methodOf(service, names) {
    for (const name of names) {
        const fn = service[name];
        if (typeof fn === 'function')
            return fn.bind(service);
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
function hostProp(ctx, name) {
    try {
        const value = ctx[name];
        return value === null || value === undefined ? undefined : value;
    }
    catch {
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
export function resolveHostSession(ctx) {
    for (const name of SESSION_SERVICE_NAMES) {
        const service = serviceOf(ctx, name);
        if (!service || typeof service !== 'object')
            continue;
        const sessionId = typeof service.sessionId === 'string' ? service.sessionId : undefined;
        const readCurrent = methodOf(service, ['readCurrent', 'currentModel', 'getCurrentModel']);
        const selectModel = methodOf(service, ['selectModel', 'setModel']);
        const readGlobalDefault = methodOf(service, ['readGlobalDefault']);
        if (!readCurrent && !selectModel && !readGlobalDefault)
            continue;
        return {
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(readCurrent === undefined ? {} : { readCurrent: () => String(readCurrent() ?? '') }),
            ...(selectModel === undefined ? {} : { selectModel: selectModel }),
            ...(readGlobalDefault === undefined
                ? {}
                : { readGlobalDefault: () => readGlobalDefault() }),
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
function callHostSelect(select, sessionId, provider, model) {
    const arity = select.length;
    const call = arity >= 3
        ? select(sessionId, provider, model)
        : arity === 2
            ? select(provider, model)
            : select({ sessionId, provider, model });
    return Promise.resolve(call);
}
/** Normalizes a (possibly absent, possibly non-string) reading into a model key. */
function modelKeyOf(value) {
    return typeof value === 'string' ? value : '';
}
/** The session id an agent carries, whichever field this host fills. */
export function agentSessionId(agent) {
    if (!agent || typeof agent !== 'object')
        return undefined;
    const record = agent;
    const fromSession = record.session?.id;
    if (typeof fromSession === 'string' && fromSession)
        return fromSession;
    const own = record.id;
    return typeof own === 'string' && own ? own : undefined;
}
/** Whether an agent entry is in the `running` lifecycle state (never inferred). */
function isRunningAgent(agent) {
    return Boolean(agent) && typeof agent === 'object' && agent.status === 'running';
}
/** Builds the resolver; exported so a probe/test can ask the same question. */
export function createSessionResolver(ctx) {
    /** planId → the session that confirmed/started it. */
    const bound = new Map();
    let current;
    const hostServiceId = () => {
        const named = resolveHostSession(ctx)?.sessionId ?? hostProp(ctx, 'sessionId');
        return typeof named === 'string' && named.trim() !== '' ? named : undefined;
    };
    const initiatorId = () => {
        const agents = serviceOf(ctx, 'agents');
        return agentSessionId(agents?.currentInitiator?.());
    };
    const runningAgentId = () => {
        const agents = serviceOf(ctx, 'agents');
        const live = (agents?.list?.() ?? []);
        // Requiring `running` **and** a length of exactly one is the whole safety
        // argument: with two live sessions there is no honest way to pick one.
        const running = live.filter(isRunningAgent);
        if (running.length !== 1)
            return undefined;
        return agentSessionId(running[0]);
    };
    return {
        bind(planId, sessionId) {
            const id = typeof sessionId === 'string' ? sessionId.trim() : '';
            if (id)
                bound.set(planId, id);
        },
        resolve(planId, requested) {
            const asked = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : undefined;
            // Lazy on purpose: a request that names its session must not depend on
            // `agents.list()` being reachable, and a throwing probe is "that source
            // said nothing", not a failed switch.
            const candidates = [
                ['request', () => asked],
                ['plan', () => (planId ? bound.get(planId) : undefined)],
                ['host-service', hostServiceId],
                ['initiator', initiatorId],
                ['running-agent', runningAgentId],
            ];
            for (const [source, read] of candidates) {
                let id;
                try {
                    id = read();
                }
                catch {
                    id = undefined;
                }
                if (!id)
                    continue;
                current = id;
                if (planId && asked)
                    bound.set(planId, asked);
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
            if (current)
                return current;
            for (const read of [hostServiceId, initiatorId, runningAgentId]) {
                try {
                    const id = read();
                    if (id)
                        return id;
                }
                catch {
                    // "not observable" is not an error.
                }
            }
            return undefined;
        },
        describe: () => "the request carried no sessionId, no plan bound one, the host's session service named none, " +
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
export function observeGlobalDefault(ctx) {
    const service = serviceOf(ctx, 'agentDefaultModel');
    let selection;
    try {
        selection = service?.currentSelection?.();
    }
    catch {
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
export function selectionFrom(ctx, resolver = createSessionResolver(ctx)) {
    /**
     * Model key of the last switch this plugin made.
     *
     * DSH 0.2.x can switch but does not publish a `readCurrent()`; falling back to
     * what we last wrote keeps the router honest after its own switch instead of
     * reporting "unknown" forever. It never overrides a host that can report.
     */
    let lastKnown = '';
    const deps = {
        selectModel: async (sessionId, provider, model) => {
            if (!sessionId) {
                throw new Error('session-unknown: the switch has no session id (the request did not state one and the host named none)');
            }
            const session = resolveHostSession(ctx);
            const select = session?.selectModel;
            if (!select)
                throw new Error('this host offers no selectModel');
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
export function modelReport(ctx) {
    return async () => {
        const notes = [];
        const answer = {};
        const config = [];
        const filesRead = [];
        const skipped = [];
        /** The default route a profile file states (`agent-default-model`). */
        let configDefaultModelKey;
        // 1. The in-memory provider snapshot, when the host hands one over.
        const inMemory = hostProp(ctx, 'providers');
        if (inMemory?.length)
            config.push(...inMemory);
        // 2. The LLM runtime: routes, their models, and each model's real window.
        const llm = serviceOf(ctx, 'llm');
        if (llm?.listProviders) {
            try {
                answer.providers = llm.listProviders();
            }
            catch (error) {
                notes.push(`llm.listProviders failed: ${messageOf(error)}`);
            }
        }
        if (llm?.listModels && answer.providers?.length) {
            const modelsByProvider = {};
            const resolved = {};
            for (const provider of answer.providers) {
                try {
                    const models = await llm.listModels(provider.id);
                    modelsByProvider[provider.id] = models;
                    if (llm.resolveModelInfo) {
                        for (const model of models) {
                            try {
                                resolved[`${provider.id}/${model.id}`] = await llm.resolveModelInfo(provider.id, model.id);
                            }
                            catch {
                                // A route whose exact metadata is unavailable stays "window
                                // unconfirmed" — the guard may refuse it, never assume it.
                            }
                        }
                    }
                }
                catch (error) {
                    notes.push(`llm.listModels(${provider.id}) failed: ${messageOf(error)}`);
                }
            }
            answer.modelsByProvider = modelsByProvider;
            if (Object.keys(resolved).length > 0)
                answer.resolved = resolved;
        }
        // 3. The session controller's catalog: what the GUI can actually select.
        const controller = serviceOf(ctx, 'sessionController');
        if (controller?.modelCatalog) {
            try {
                answer.catalog = await controller.modelCatalog();
            }
            catch (error) {
                notes.push(`sessionController.modelCatalog failed: ${messageOf(error)}`);
            }
        }
        // 4. Live settings values (the profile's own plugin configs).
        const settings = serviceOf(ctx, 'settings');
        if (settings?.describe) {
            try {
                for (const descriptor of settings.describe()) {
                    for (const provider of providersFromSettingsValue(descriptor.value)) {
                        config.push(provider);
                    }
                }
            }
            catch (error) {
                notes.push(`settings.describe failed: ${messageOf(error)}`);
            }
        }
        // 5. Config files: the profile patch, settings.yaml, and the legacy JSON trio.
        //    The active profile is named by the settings service when it is
        //    reachable; otherwise the `$DSH_HOME/profiles` scan stands in.
        try {
            const declared = hostProp(ctx, 'profileCandidates');
            let activeDocument;
            try {
                activeDocument = declaredDocumentPath(settings?.documentPath);
            }
            catch (error) {
                notes.push(`settings.documentPath failed: ${messageOf(error)}`);
            }
            const scannedFiles = declared ?? (await defaultProfileCandidates());
            // With the active profile known, read **that** patch plus the legacy
            // fallbacks — not every sibling profile. A sibling profile describes a
            // different DSH process; advertising its routes here would offer models
            // this process cannot route.
            const candidates = declared || !activeDocument
                ? scannedFiles
                : [
                    activeDocument,
                    ...scannedFiles.filter((file) => file !== activeDocument && isLegacyCandidate(file)),
                ];
            const scanned = await readProfileConfigFiles(candidates);
            config.push(...scanned.providers);
            filesRead.push(...scanned.filesRead);
            skipped.push(...scanned.skipped);
            if (scanned.defaultModelKey)
                configDefaultModelKey = scanned.defaultModelKey;
            const profileFiles = scanned.filesRead.filter((file) => !isLegacyCandidate(file));
            if (!activeDocument && profileFiles.length > 1) {
                // Honest about the weaker evidence: without `settings.documentPath()` the
                // scan cannot tell the active profile from a sibling one, so it reads
                // every real profile and says so instead of silently merging them.
                notes.push(`the host did not name its active profile; read ${profileFiles.length} profile files`);
            }
        }
        catch (error) {
            skipped.push(`profile scan failed: ${messageOf(error)}`);
        }
        const configPaths = hostProp(ctx, 'configPaths');
        if (configPaths) {
            const fromJson = await readDshConfig(configPaths);
            config.push(...fromJson.configs);
            filesRead.push(...fromJson.filesRead);
            skipped.push(...fromJson.skipped);
        }
        if (config.length > 0)
            answer.config = config;
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
export function declaredDocumentPath(declared) {
    if (typeof declared === 'function') {
        const value = declared();
        return typeof value === 'string' && value.trim() !== '' ? value : undefined;
    }
    return typeof declared === 'string' && declared.trim() !== '' ? declared : undefined;
}
/** Discovery is read-only and never fatal: a broken config is "no models yet". */
const PRICE_FILE = `${process.env.DSH_HOME || '/opt/wb-router'}/config/wb-model-prices.json`;
let _priceCache = { mtime: -1, map: {} };
async function priceOverrides() {
    try {
        const mtime = (await import('node:fs')).statSync(PRICE_FILE).mtimeMs;
        if (mtime !== _priceCache.mtime) {
            const doc = JSON.parse(await readFile(PRICE_FILE, 'utf8'));
            _priceCache = { mtime, map: doc.prices || {} };
        }
    } catch { /* missing file = no overrides */ }
    return _priceCache.map;
}
/** 官方 DeepSeek 峰谷：工作日 09:00-12:00、14:00-18:00；周末全天低谷。 */
function isPeakNow(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    const weekday = get('weekday');
    const hour = Number(get('hour'));
    const minute = Number(get('minute'));
    if (['Sat', 'Sun'].includes(weekday)) return false;
    const minutes = hour * 60 + minute;
    return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}
export function modelSource(ctx) {
    const report = modelReport(ctx);
    return async () => {
        const models = (await report()).models;
        const prices = await priceOverrides();
        const peak = isPeakNow();
        return models.map((model) => {
            // DSH 的模型键是 `<provider>/<upstream>/<model>`（provider=wb-gateway），
            // 而价格表键是 `<upstream>/<model>` ⇒ 双重查找，避免价格永远配不上。
            const bareId = String(model.id || '').replace(/^wb-gateway\//, '');
            let row = prices[model.id] || prices[bareId];
            // Q2-7（2026-11-18）：价格三态随行进入 DSH —— priced / local / unpriced。
            // 本地模型显式 0 + 「本地」标签；云端未填价显式「待录入」，数字为 null（不是免费）。
            let priceState = row && (row.price_state || row.priceState);
            let priceLabel = row && (row.price_label || row.priceLabel);
            if (!row && /^llama-(local|current|review)\//.test(bareId)) {
                row = { inputPeakPerMTok: 0, outputPeakPerMTok: 0, inputOffpeakPerMTok: 0, outputOffpeakPerMTok: 0 };
                priceState = 'local';
                priceLabel = '0（本地）';
            }
            if (!row) return model;
            const inputPerMTok = peak ? row.inputPeakPerMTok : row.inputOffpeakPerMTok;
            const outputPerMTok = peak ? row.outputPeakPerMTok : row.outputOffpeakPerMTok;
            if (!priceState) {
                priceState = (inputPerMTok ?? null) === null && (outputPerMTok ?? null) === null
                    ? 'unpriced' : 'priced';
            }
            if (!priceLabel) {
                priceLabel = priceState === 'local' ? '0（本地）'
                    : priceState === 'unpriced' ? '0（待用户录入）' : '';
            }
            return {
                ...model,
                pricing: {
                    inputPerMTok: inputPerMTok ?? row.inputPeakPerMTok ?? null,
                    outputPerMTok: outputPerMTok ?? row.outputPeakPerMTok ?? null,
                    state: priceState,
                    label: priceLabel,
                },
            };
        });
    };
}
/**
 * Provider objects out of one `settings.describe()` value.
 *
 * A settings descriptor's `value` is the live config of one profile entry, so
 * the providers may sit at its root (`{ providers: {...} }`) or one section deep
 * (a plugin whose config is `{ llm: { providers } }`). Anything else is "this
 * entry has no providers" — not an error.
 */
export function providersFromSettingsValue(value) {
    if (!value || typeof value !== 'object')
        return [];
    const record = value;
    const direct = record.providers;
    const out = [];
    const collect = (providers) => {
        if (!providers || typeof providers !== 'object')
            return;
        const entries = Array.isArray(providers)
            ? providers.map((item) => [undefined, item])
            : Object.entries(providers);
        for (const [key, item] of entries) {
            if (!item || typeof item !== 'object')
                continue;
            const provider = item;
            const id = key ?? (typeof provider.id === 'string' ? provider.id : typeof provider.provider === 'string' ? provider.provider : undefined);
            if (!id)
                continue;
            const models = Array.isArray(provider.models) ? provider.models : [];
            out.push({
                id,
                name: (typeof provider.displayName === 'string' && provider.displayName) ||
                    (typeof provider.name === 'string' && provider.name) ||
                    id,
                models: models
                    .map((model) => {
                    if (typeof model === 'string')
                        return { id: model };
                    if (!model || typeof model !== 'object')
                        return undefined;
                    const shape = model;
                    const modelId = typeof shape.id === 'string' ? shape.id : undefined;
                    if (!modelId)
                        return undefined;
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
                    .filter((model) => Boolean(model)),
            });
        }
    };
    collect(direct);
    if (out.length === 0) {
        for (const nested of Object.values(record)) {
            if (nested && typeof nested === 'object' && 'providers' in nested) {
                collect(nested.providers);
            }
        }
    }
    return out;
}
function messageOf(error) {
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
export function resolveHostCompaction(ctx, resolver = createSessionResolver(ctx)) {
    const engine = serviceOf(ctx, 'compaction');
    if (engine) {
        const agents = serviceOf(ctx, 'agents');
        const tokenMeter = serviceOf(ctx, 'tokenMeter');
        const bridged = createHostCompaction({
            engine,
            ...(agents ? { agents } : {}),
            ...(tokenMeter ? { tokenMeter } : {}),
            // A thunk, not a value read at activation: the session is only known when
            // a request has resolved it (HTTP handlers have no initiating agent).
            sessionId: () => resolver.current(),
        });
        if (bridged)
            return bridged;
    }
    return hostProp(ctx, 'compact');
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
export function createRouter(ctx) {
    const contextThresholds = hostProp(ctx, 'contextThresholds');
    // 铁律 5, honest-degradation form: the host may pin the price stance
    // (`auto` | `strict` | `allow-unknown`). Absent means `auto`, which is what a
    // real host needs: provider config states no prices, so the guard relaxes and
    // every surface says the estimate is unavailable.
    const pricingPolicy = hostProp(ctx, 'pricingPolicy');
    // One resolver per host: the HTTP layer, the adapter and the compaction bridge
    // all ask the same object, so "which session" has exactly one answer.
    const sessions = createSessionResolver(ctx);
    const host = new PluginHost(selectionFrom(ctx, sessions), {
        ...(contextThresholds ? { contextThresholds } : {}),
        ...(pricingPolicy === undefined ? {} : { pricingPolicy }),
    });
    const compact = resolveHostCompaction(ctx, sessions);
    const deps = {
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
export function apply(ctx) {
    const router = createRouter(ctx);
    // [2026-11-22 DSH 市场维护者要求] 路由接入 DSH 连接信任闸：未信任/未认证直接拒。
    // fail-closed：inject 已声明 connection，插件跑到 handler 却读不到校验能力（服务缺失/异常）时，
    // 按不可信处理（403）且不执行任何后续业务逻辑——宁可拒绝，也不放行。
    const rejected = (req, res) => {
        const connection = hostProp(ctx, 'connection');
        const reject = connection?.requestRejection;
        if (typeof reject !== 'function') {
            res.statusCode = 403;
            res.end();
            return true;
        }
        let rejection;
        try {
            rejection = reject.call(connection, req);
        }
        catch {
            rejection = 403;
        }
        if (rejection === undefined)
            return false;
        res.statusCode = typeof rejection === 'number' ? rejection : 403;
        res.end();
        return true;
    };
    const register = () => {
        ctx.webServer?.register({
            kind: 'prefix',
            path: '/router',
            handler: async (req, res) => {
                if (rejected(req, res))
                    return;
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
    const effect = hostProp(ctx, 'effect');
    if (effect)
        effect(() => register());
    else
        register();
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
export function createCompressor(input) {
    let ready;
    return {
        compressor: {
            compress: ({ handover: _handover, rendered, tokensBefore }) => {
                if (!ready) {
                    throw new Error(`no compaction was pre-computed for ${tokensBefore} tokens: call warm() before switching ` +
                        `(the switch refuses rather than truncating)`);
                }
                const result = ready;
                ready = undefined;
                void rendered;
                return result;
            },
        },
        warm: async (rendered, tokensBefore, sessionId) => {
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
export async function listModels(ctx) {
    const host = new PluginHost(selectionFrom(ctx));
    host.registerModels(await modelSource(ctx)());
    return host.registry.all();
}
//# sourceMappingURL=dsh-shell.js.map