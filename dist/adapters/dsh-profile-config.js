import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { capabilitiesForModalities } from './dsh-discovery.js';
import { parseYamlLite } from './yaml-lite.js';
/** The live config files a DSH install may keep its providers in. */
export async function defaultProfileCandidates(options = {}) {
    const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const profile = options.profile ?? process.env.DSH_PROFILE;
    const candidates = [];
    // 1. The active profile's patch, which is where DSH 0.2.x keeps provider routes.
    if (profile)
        candidates.push(join(home, 'profiles', profile, 'cordis.patch.yml'));
    // 2. Every installed profile (the host may not say which one is active).
    //    Backup directories are skipped on purpose: this machine keeps
    //    `web.bak-<date>/` copies of old profiles next to the live ones, and
    //    reading them would advertise provider routes that were deleted months
    //    ago — worse than reporting fewer models, because the router would offer a
    //    model the host cannot route.
    try {
        const entries = await readdir(join(home, 'profiles'), { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (isBackupDirectory(entry.name))
                continue;
            const file = join(home, 'profiles', entry.name, 'cordis.patch.yml');
            if (!candidates.includes(file))
                candidates.push(file);
        }
    }
    catch {
        // No profiles directory: a fresh or differently-laid-out install.
    }
    // 3. The legacy single-file settings document (pre-profile installs).
    candidates.push(join(home, 'settings.yaml'));
    // 4. The three JSON files the old adapter knew about, kept as a last resort.
    candidates.push(join(home, 'config.json'), join(home, 'providers.json'), join(home, 'models.json'));
    return candidates;
}
/**
 * True for the non-profile fallbacks: the legacy `settings.yaml` and the three
 * JSON files older adapters knew. They are read even when the active profile is
 * known, because a profile patch may legitimately state no providers.
 */
export function isLegacyCandidate(file) {
    const name = file.split('/').pop() ?? file;
    return name === 'settings.yaml' || name.endsWith('.json');
}
/** `web.bak-20260926` / `web-backup` / `web.old` are copies, not profiles. */
export function isBackupDirectory(name) {
    return /(?:^|[._-])(bak|backup|old|orig|copy)(?:[._-]|$)/i.test(name);
}
/**
 * Reads every readable candidate and merges what they state.
 *
 * A file that is missing, unreadable, or outside the supported YAML subset is
 * one `skipped` line; it never aborts the scan, so one bad profile cannot hide
 * the models declared by another.
 */
export async function readProfileConfigFiles(candidates) {
    const providers = [];
    const seen = new Set();
    const filesRead = [];
    const skipped = [];
    let defaultModelKey;
    for (const file of candidates) {
        let text;
        try {
            text = await readFile(file, 'utf8');
        }
        catch (error) {
            skipped.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        let parsed;
        try {
            parsed = file.endsWith('.json') ? JSON.parse(text) : parseYamlLite(text);
        }
        catch (error) {
            skipped.push(unreadableProfile(file, error));
            continue;
        }
        const found = providerConfigsFromDocument(parsed);
        if (found.providers.length === 0) {
            skipped.push(`${file}: no provider list found`);
            // A file can still state the default model without declaring providers.
            if (found.defaultModelKey && !defaultModelKey)
                defaultModelKey = found.defaultModelKey;
            continue;
        }
        for (const provider of found.providers) {
            // The active profile is listed first, so the first statement of a provider wins.
            if (seen.has(provider.id))
                continue;
            seen.add(provider.id);
            providers.push(provider);
        }
        if (!defaultModelKey && found.defaultModelKey)
            defaultModelKey = found.defaultModelKey;
        filesRead.push(file);
    }
    return {
        providers,
        ...(defaultModelKey ? { defaultModelKey } : {}),
        filesRead,
        skipped,
    };
}
/**
 * Why a config file was not read, in one line that also says **what is lost**.
 *
 * The standing rule for a bad config is「坏配置 = 暂无模型」, but a bare
 * `unexpected indentation (line 732)` let a real defect read as "this host has
 * no prices" for days (灰狼 2026-11-15: `sources.config=0`). The consequence
 * belongs in the same sentence as the cause: `config=0` means **not read**, and
 * "not configured" is a different claim about the host.
 */
function unreadableProfile(file, error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${file}: 未读取（${message}）—— 该文件的 provider/价格/窗口本次不生效；config=0 只说明没读到，不等于没配置`;
}
/**
 * Extracts provider routes from one parsed document.
 *
 * Three shapes occur in the wild, and all three are accepted:
 *  - a profile patch: an **array** of loader entries, providers under
 *    `entry.config.providers` (`- id: llm-pi-ai`);
 *  - a legacy `settings.yaml`: a **map** whose `llm-pi-ai.providers` holds them;
 *  - a bare `{ providers: {...} }` or `providers: [...]` document.
 */
export function providerConfigsFromDocument(document) {
    const providers = [];
    let defaultModelKey;
    const takeProviders = (value) => {
        for (const provider of providersFromValue(value))
            providers.push(provider);
    };
    const takeDefault = (value) => {
        if (!isMap(value))
            return;
        const key = defaultFromEntry(value);
        if (key && !defaultModelKey)
            defaultModelKey = key;
    };
    if (Array.isArray(document)) {
        /**
         * One loader entry, and one level of `insert:` below it.
         *
         * A patch may group entries in an `insert:` block (`- insert: [{id: llm-pi-ai,
         * config: {providers: …}}]`). Only looking at top-level entries found zero
         * providers there and the scan answered "no provider list found" — the old
         * "0 models" symptom on a file that does list them. Recursing **one** level
         * (not blindly inside every nested map) covers the shape the loader writes
         * without turning into a general tree walk.
         */
        const takeEntry = (entry, depth) => {
            takeDefault(entry);
            const config = entry.config;
            if (isMap(config) && 'providers' in config)
                takeProviders(config.providers ?? null);
            if ('providers' in entry)
                takeProviders(entry.providers ?? null);
            if (depth === 0) {
                const insert = entry.insert;
                if (Array.isArray(insert)) {
                    for (const nested of insert)
                        if (isMap(nested))
                            takeEntry(nested, depth + 1);
                }
            }
        };
        for (const entry of document) {
            if (!isMap(entry))
                continue;
            takeEntry(entry, 0);
        }
        return { providers, ...(defaultModelKey ? { defaultModelKey } : {}) };
    }
    if (isMap(document)) {
        takeDefault(document);
        if ('providers' in document)
            takeProviders(document.providers ?? null);
        // A legacy settings document: one section per plugin instance.
        for (const [sectionId, section] of Object.entries(document)) {
            if (sectionId === 'providers')
                continue;
            if (!isMap(section))
                continue;
            takeDefault(section);
            if ('providers' in section)
                takeProviders(section.providers ?? null);
        }
    }
    return { providers, ...(defaultModelKey ? { defaultModelKey } : {}) };
}
/** `agent-default-model: { provider, model }` → `provider/model`. */
function defaultFromEntry(entry) {
    const config = isMap(entry.config) ? entry.config : entry;
    const provider = config.provider;
    const model = config.model;
    if (typeof provider !== 'string' || typeof model !== 'string')
        return undefined;
    if (provider.trim() === '' || model.trim() === '')
        return undefined;
    return `${provider}/${model}`;
}
/**
 * One `providers` value in either of its two YAML spellings:
 * a map keyed by provider id, or a list of objects that carry their own `id`.
 */
function providersFromValue(value) {
    const out = [];
    const entries = Array.isArray(value)
        ? value.map((item) => [undefined, item])
        : isMap(value)
            ? Object.entries(value)
            : [];
    for (const [key, item] of entries) {
        if (!isMap(item))
            continue;
        const id = key ?? asString(item.id) ?? asString(item.provider);
        if (!id)
            continue;
        out.push({
            id,
            name: asString(item.displayName) ?? asString(item.name) ?? id,
            models: modelsFromValue(item.models),
        });
    }
    return out;
}
/** Normalizes the model spellings DSH configs use into the adapter's shape. */
function modelsFromValue(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        if (typeof item === 'string') {
            out.push({ id: item, capabilities: capabilitiesForModalities({ text: true, image: false }) });
            continue;
        }
        if (!isMap(item))
            continue;
        const id = asString(item.id) ?? asString(item.name);
        if (!id)
            continue;
        const modalities = modalitiesOf(item.input);
        const declared = Array.isArray(item.capabilities)
            ? item.capabilities.filter((c) => typeof c === 'string')
            : undefined;
        const price = (field) => typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : undefined;
        out.push({
            id,
            ...(asString(item.name) ? { name: asString(item.name) } : {}),
            ...(typeof item.contextWindow === 'number' ? { contextWindow: item.contextWindow } : {}),
            // DSH's pi-ai route spells the output cap `maxTokens`; the adapter's own
            // field is `maxOutputTokens`. Both are accepted, the explicit one wins.
            ...(typeof item.maxOutputTokens === 'number'
                ? { maxOutputTokens: item.maxOutputTokens }
                : typeof item.maxTokens === 'number'
                    ? { maxOutputTokens: item.maxTokens }
                    : {}),
            ...(price(item.inputPerMTok) !== undefined ? { inputPerMTok: price(item.inputPerMTok) } : {}),
            ...(price(item.outputPerMTok) !== undefined ? { outputPerMTok: price(item.outputPerMTok) } : {}),
            ...(typeof item.supportsTools === 'boolean' ? { supportsTools: item.supportsTools } : {}),
            ...(declared && declared.length > 0
                ? { capabilities: declared }
                : { capabilities: capabilitiesForModalities(modalities) }),
            ...(typeof item.strength === 'number' ? { strength: item.strength } : {}),
        });
    }
    return out;
}
/** `input: [ text, image ]` → which modalities the model accepts. */
function modalitiesOf(value) {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    const names = list.filter((v) => typeof v === 'string').map((v) => v.toLowerCase());
    if (names.length === 0)
        return { text: true, image: false };
    return {
        text: names.some((n) => n === 'text' || n === 'audio' || n === 'document'),
        image: names.some((n) => n === 'image' || n === 'vision'),
    };
}
function isMap(value) {
    return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}
function asString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
//# sourceMappingURL=dsh-profile-config.js.map