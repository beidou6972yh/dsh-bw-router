import type { ModelEntry } from '../core/types.js';
import { type DshProviderConfig } from './dsh-discovery.js';
/**
 * Turns the **host's own model answers** into router entries.
 *
 * The four real DSH sources are plain data here, so this file stays portable
 * (no Cordis, no HTTP) and testable without a host:
 *
 *  1. `sessionController.modelCatalog()` — the Host-generation catalog the GUI
 *     model selector reads: `{ default, groups: [{ id, name, models: [...] }] }`.
 *     This is *the* answer to "what can this host route right now"; it is what
 *     the catalog-driven selectors treat as selectable.
 *  2. `llm.listProviders()` + `llm.listModels(provider)` — the adapter-side
 *     catalog, used when the session controller is not reachable.
 *  3. `llm.resolveModelInfo(provider, model)` — the only source that states a
 *     **context window** for a live route, which the guard needs before it can
 *     allow a switch.
 *  4. Provider config objects (settings / profile files) — the only source that
 *     states prices and windows on a deployment that does not expose them at
 *     runtime.
 *
 * Merging rule: a key seen twice stays one model; every field is taken from the
 * first source that actually states it, and `limitsGuessed` is cleared only when
 * a real window **and** a real output cap were seen. Nothing is invented: an
 * unknown price stays `null` and an unknown window stays flagged, which is what
 * makes the guard able to say "no" instead of pretending.
 */
/**
 * One exact-model answer from `llm.resolveModelInfo()`, as plain data.
 *
 * The **real** shape on DSH 0.2.1-rc.2 is `LlmResolvedModelInfo`:
 * `context: { contextWindow }` and `defaultMaxTokens`
 * (`@org/dsh-llm/lib/types/types.d.ts:394-404`; the pi-ai adapter
 * returns exactly that, never a top-level `contextWindow`). Reading only the
 * top-level names meant every runtime model arrived window-less and
 * `limitsGuessed`, so the guard refused the whole catalog as
 * `limits-unconfirmed` the moment the profile YAML was not parsed.
 *
 * The old names stay declared and are read **after** the real ones, so a host
 * that does hand them over keeps working.
 */
export interface HostResolvedModel {
    /** Real shape: provider-owned context capacity. */
    context?: {
        contextWindow?: number;
    };
    /** Real shape: adapter-configured per-request output cap. */
    defaultMaxTokens?: number;
    /** Legacy/shallow shape, read only when the real fields are absent. */
    contextWindow?: number;
    /** Legacy/shallow shape, read only when `defaultMaxTokens` is absent. */
    maxOutputTokens?: number;
    inputModalities?: readonly string[];
    name?: string;
}
/**
 * The two numbers the guard needs, from whichever shape the host answered.
 *
 * Pure and exported so a regression can drive the *real* function with the
 * *real* shape, and an A/B can show the legacy read (`resolved.contextWindow`)
 * returning `undefined` for the same input.
 */
export declare function resolvedLimits(resolved: HostResolvedModel | undefined): {
    contextWindow?: number;
    maxOutputTokens?: number;
};
/** Everything the host can tell us about its models, already read. */
export interface HostModelAnswer {
    /** `sessionController.modelCatalog()` — provider-grouped routable models. */
    catalog?: {
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
        /** Providers whose catalog lookup failed, kept as a note rather than hidden. */
        failures?: {
            id: string;
            message?: string;
        }[];
    };
    /** `llm.listProviders()` — routes with a registered adapter. */
    providers?: {
        id: string;
        name?: string;
    }[];
    /** `llm.listModels(provider)` keyed by provider id. */
    modelsByProvider?: Record<string, {
        id: string;
        name?: string;
        inputModalities?: readonly string[];
    }[]>;
    /** `llm.resolveModelInfo(provider, model)` keyed by `provider/model`. */
    resolved?: Record<string, HostResolvedModel>;
    /** Provider config objects (settings or profile files). */
    config?: DshProviderConfig[];
}
export interface HostModelDiscovery {
    models: ModelEntry[];
    /** Models that only a runtime source (catalog/llm) produced. */
    runtimeModels: number;
    /** Models that only a config source produced. */
    configModels: number;
    providers: string[];
    /** The host's own default route, when it states one. */
    defaultModelKey?: string;
    /** Non-fatal oddities, for `/router/models` and the wizard's sources line. */
    notes: string[];
}
/** Builds the merged model list. Pure: same answer in, same entries out. */
export declare function discoverHostModels(answer: HostModelAnswer): HostModelDiscovery;
//# sourceMappingURL=dsh-host-models.d.ts.map