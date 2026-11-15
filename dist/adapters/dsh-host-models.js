import { FALLBACK_CONTEXT_WINDOW, FALLBACK_MAX_OUTPUT_TOKENS, capabilitiesForModalities, } from './dsh-discovery.js';
/**
 * The two numbers the guard needs, from whichever shape the host answered.
 *
 * Pure and exported so a regression can drive the *real* function with the
 * *real* shape, and an A/B can show the legacy read (`resolved.contextWindow`)
 * returning `undefined` for the same input.
 */
export function resolvedLimits(resolved) {
    const contextWindow = resolved?.context?.contextWindow ?? resolved?.contextWindow;
    const maxOutputTokens = resolved?.defaultMaxTokens ?? resolved?.maxOutputTokens;
    return {
        ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
        ...(typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {}),
    };
}
/** Builds the merged model list. Pure: same answer in, same entries out. */
export function discoverHostModels(answer) {
    const entries = new Map();
    const notes = [];
    const put = (entry, runtime) => {
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
            put(runtimeEntry({
                provider: group.id,
                providerName: group.name,
                modelId: model.id,
                name: resolved?.name ?? model.name,
                ...(resolved ? { resolved } : {}),
            }), true);
        }
    }
    // 3. The adapter-side catalog, for a host whose session controller is elsewhere.
    for (const provider of answer.providers ?? []) {
        for (const model of answer.modelsByProvider?.[provider.id] ?? []) {
            const resolved = answer.resolved?.[`${provider.id}/${model.id}`];
            put(runtimeEntry({
                provider: provider.id,
                providerName: provider.name,
                modelId: model.id,
                name: resolved?.name ?? model.name,
                ...(resolved ? { resolved } : {}),
                ...(model.inputModalities ? { modalities: modalitiesOf(model.inputModalities) } : {}),
            }), true);
        }
    }
    for (const failure of answer.catalog?.failures ?? []) {
        notes.push(`provider ${failure.id} did not answer its model catalog${failure.message ? `: ${failure.message}` : ''}`);
    }
    const models = [...entries.values()].map((record) => record.entry);
    const runtimeModels = models.filter((m) => entries.get(`${m.provider}/${m.model}`)?.runtime).length;
    const providers = [...new Set(models.map((m) => m.provider))];
    const defaultModelKey = answer.catalog?.default?.provider && answer.catalog.default.model
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
function configEntry(provider, model) {
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
            contextWindow: windowKnown ? model.contextWindow : FALLBACK_CONTEXT_WINDOW,
            maxOutputTokens: outputKnown ? model.maxOutputTokens : FALLBACK_MAX_OUTPUT_TOKENS,
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
function runtimeEntry(input) {
    const resolved = input.resolved;
    const limits = resolvedLimits(resolved);
    const windowKnown = positive(limits.contextWindow);
    const outputKnown = positive(limits.maxOutputTokens);
    const capabilities = capabilitiesForModalities(input.modalities ?? modalitiesOf(resolved?.inputModalities ?? []));
    return {
        id: `${input.provider}/${input.modelId}`,
        provider: input.provider,
        model: input.modelId,
        label: input.name ?? `${input.providerName ?? input.provider} ${input.modelId}`,
        capabilities,
        limits: {
            contextWindow: windowKnown ? limits.contextWindow : FALLBACK_CONTEXT_WINDOW,
            maxOutputTokens: outputKnown ? limits.maxOutputTokens : FALLBACK_MAX_OUTPUT_TOKENS,
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
function mergeEntry(previous, incoming) {
    const known = (entry) => entry.limitsGuessed !== true;
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
function union(a, b) {
    const out = [...a];
    for (const capability of b)
        if (!out.includes(capability))
            out.push(capability);
    return out;
}
function modalitiesOf(modalities) {
    const names = modalities.map((m) => m.toLowerCase());
    if (names.length === 0)
        return { text: true, image: false };
    return {
        text: names.some((n) => n === 'text' || n === 'audio' || n === 'document'),
        image: names.some((n) => n === 'image' || n === 'vision'),
    };
}
function positive(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function price(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
//# sourceMappingURL=dsh-host-models.js.map