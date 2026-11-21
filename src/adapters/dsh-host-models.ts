import type { CapabilityKind, ModelEntry } from '../core/types.js';
import {
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_OUTPUT_TOKENS,
  capabilitiesForModalities,
  type DshProviderConfig,
} from './dsh-discovery.js';

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
  context?: { contextWindow?: number };
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
export function resolvedLimits(resolved: HostResolvedModel | undefined): {
  contextWindow?: number;
  maxOutputTokens?: number;
} {
  const contextWindow = resolved?.context?.contextWindow ?? resolved?.contextWindow;
  const maxOutputTokens = resolved?.defaultMaxTokens ?? resolved?.maxOutputTokens;
  return {
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
    ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
  };
}

/** Everything the host can tell us about its models, already read. */
export interface HostModelAnswer {
  /** `sessionController.modelCatalog()` — provider-grouped routable models. */
  catalog?: {
    default?: { provider?: string; model?: string };
    groups?: { id: string; name?: string; models?: { id: string; name?: string }[] }[];
    /** Providers whose catalog lookup failed, kept as a note rather than hidden. */
    failures?: { id: string; message?: string }[];
  };
  /** `llm.listProviders()` — routes with a registered adapter. */
  providers?: { id: string; name?: string }[];
  /** `llm.listModels(provider)` keyed by provider id. */
  modelsByProvider?: Record<string, { id: string; name?: string; inputModalities?: readonly string[] }[]>;
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
export function discoverHostModels(answer: HostModelAnswer): HostModelDiscovery {
  const entries = new Map<string, { entry: ModelEntry; runtime: boolean }>();
  const notes: string[] = [];

  const put = (entry: ModelEntry, runtime: boolean): void => {
    const key = `${entry.provider}/${entry.model}`;
    const previous = entries.get(key);
    if (!previous) {
      entries.set(key, { entry, runtime });
      return;
    }
    entries.set(key, { entry: mergeEntry(previous.entry, entry), runtime: previous.runtime || runtime });
  };

  // 1. Config first: it is the only source that may state prices and windows.
  for (const provider of answer.config ?? []) {
    for (const model of provider.models ?? []) {
      put(configEntry(provider, model), false);
    }
  }

  // 2. The session controller's catalog: what the GUI would offer right now.
  for (const group of answer.catalog?.groups ?? []) {
    for (const model of group.models ?? []) {
      const resolved = answer.resolved?.[`${group.id}/${model.id}`];
      put(
        runtimeEntry({
          provider: group.id,
          providerName: group.name,
          modelId: model.id,
          name: resolved?.name ?? model.name,
          ...(resolved ? { resolved } : {}),
        }),
        true,
      );
    }
  }

  // 3. The adapter-side catalog, for a host whose session controller is elsewhere.
  for (const provider of answer.providers ?? []) {
    for (const model of answer.modelsByProvider?.[provider.id] ?? []) {
      const resolved = answer.resolved?.[`${provider.id}/${model.id}`];
      put(
        runtimeEntry({
          provider: provider.id,
          providerName: provider.name,
          modelId: model.id,
          name: resolved?.name ?? model.name,
          ...(resolved ? { resolved } : {}),
          ...(model.inputModalities ? { modalities: modalitiesOf(model.inputModalities) } : {}),
        }),
        true,
      );
    }
  }

  for (const failure of answer.catalog?.failures ?? []) {
    notes.push(`provider ${failure.id} did not answer its model catalog${failure.message ? `: ${failure.message}` : ''}`);
  }

  const models = [...entries.values()].map((record) => record.entry);
  const runtimeModels = models.filter((m) => entries.get(`${m.provider}/${m.model}`)?.runtime).length;
  const providers = [...new Set(models.map((m) => m.provider))];
  const defaultModelKey =
    answer.catalog?.default?.provider && answer.catalog.default.model
      ? `${answer.catalog.default.provider}/${answer.catalog.default.model}`
      : undefined;

  return {
    models,
    runtimeModels,
    configModels: models.length - runtimeModels,
    providers,
    ...(defaultModelKey ? { defaultModelKey } : {}),
    notes,
  };
}

/** One entry from a provider config object (may state prices/windows). */
function configEntry(
  provider: DshProviderConfig,
  model: DshProviderConfig['models'][number],
): ModelEntry {
  const windowKnown = positive(model.contextWindow);
  const outputKnown = positive(model.maxOutputTokens);
  const capabilities = model.capabilities?.length
    ? [...model.capabilities]
    : capabilitiesForModalities({ text: true, image: false });
  return {
    id: `${provider.id}/${model.id}`,
    provider: provider.id,
    model: model.id,
    label: model.name ?? `${provider.name} ${model.id}`,
    capabilities,
    limits: {
      contextWindow: windowKnown ? model.contextWindow! : FALLBACK_CONTEXT_WINDOW,
      maxOutputTokens: outputKnown ? model.maxOutputTokens! : FALLBACK_MAX_OUTPUT_TOKENS,
      supportsTools: typeof model.supportsTools === 'boolean' ? model.supportsTools : null,
      supportsImages: capabilities.includes('vision'),
    },
    pricing: {
      inputPerMTok: price(model.inputPerMTok),
      outputPerMTok: price(model.outputPerMTok),
    },
    ...(windowKnown && outputKnown ? {} : { limitsGuessed: true }),
    strength: 0.5,
    source: 'dsh-config',
  };
}

/** One entry from a runtime catalog answer (limits only via `resolveModelInfo`). */
function runtimeEntry(input: {
  provider: string;
  providerName?: string;
  modelId: string;
  name?: string;
  resolved?: HostResolvedModel;
  modalities?: { text: boolean; image: boolean };
}): ModelEntry {
  const resolved = input.resolved;
  const limits = resolvedLimits(resolved);
  const windowKnown = positive(limits.contextWindow);
  const outputKnown = positive(limits.maxOutputTokens);
  const capabilities = capabilitiesForModalities(
    input.modalities ?? modalitiesOf(resolved?.inputModalities ?? []),
  );
  return {
    id: `${input.provider}/${input.modelId}`,
    provider: input.provider,
    model: input.modelId,
    label: input.name ?? `${input.providerName ?? input.provider} ${input.modelId}`,
    capabilities,
    limits: {
      contextWindow: windowKnown ? limits.contextWindow! : FALLBACK_CONTEXT_WINDOW,
      maxOutputTokens: outputKnown ? limits.maxOutputTokens! : FALLBACK_MAX_OUTPUT_TOKENS,
      supportsTools: null,
      supportsImages: capabilities.includes('vision'),
    },
    ...(windowKnown && outputKnown ? {} : { limitsGuessed: true }),
    pricing: { inputPerMTok: null, outputPerMTok: null },
    strength: 0.5,
    source: 'dsh-runtime',
  };
}

/** Field-level merge: a stated value wins over a placeholder, never the reverse. */
function mergeEntry(previous: ModelEntry, incoming: ModelEntry): ModelEntry {
  const known = (entry: ModelEntry): boolean => entry.limitsGuessed !== true;
  const windowKnown = known(previous) || known(incoming);
  const limits = {
    contextWindow: known(incoming)
      ? incoming.limits.contextWindow
      : previous.limits.contextWindow,
    maxOutputTokens: known(incoming)
      ? incoming.limits.maxOutputTokens
      : previous.limits.maxOutputTokens,
    supportsTools: incoming.limits.supportsTools ?? previous.limits.supportsTools,
    supportsImages: incoming.limits.supportsImages || previous.limits.supportsImages,
  };
  const capabilities = union(previous.capabilities, incoming.capabilities);
  const pricing = {
    inputPerMTok: previous.pricing.inputPerMTok ?? incoming.pricing.inputPerMTok,
    outputPerMTok: previous.pricing.outputPerMTok ?? incoming.pricing.outputPerMTok,
  };
  // `limitsGuessed` must be **removed** when a source really states both
  // numbers, so it cannot survive from the spread of a placeholder entry.
  const { limitsGuessed: _previousGuess, ...rest } = previous;
  void _previousGuess;
  return {
    ...rest,
    label: incoming.label || previous.label,
    capabilities,
    limits: { ...limits, supportsImages: limits.supportsImages || capabilities.includes('vision') },
    pricing,
    source: incoming.source,
    ...(windowKnown ? {} : { limitsGuessed: true }),
  };
}

/** Union of two capability lists, first list's order preserved. */
function union(a: CapabilityKind[], b: CapabilityKind[]): CapabilityKind[] {
  const out = [...a];
  for (const capability of b) if (!out.includes(capability)) out.push(capability);
  return out;
}

function modalitiesOf(modalities: readonly string[]): { text: boolean; image: boolean } {
  const names = modalities.map((m) => m.toLowerCase());
  if (names.length === 0) return { text: true, image: false };
  return {
    text: names.some((n) => n === 'text' || n === 'audio' || n === 'document'),
    image: names.some((n) => n === 'image' || n === 'vision'),
  };
}

function positive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function price(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
