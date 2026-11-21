import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverFromDshConfig } from './dsh-discovery.js';
/** Default candidates, relative to `$DSH_HOME` (falling back to `~/.dsh`). */
export function defaultConfigPaths(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
    return {
        candidates: [join(home, 'config.json'), join(home, 'providers.json'), join(home, 'models.json')],
    };
}
/**
 * Reads the first config file that parses. Missing files are not errors — a
 * fresh install has none, and the wizard simply shows "no DSH providers found".
 */
export async function readDshConfig(paths) {
    const configs = [];
    const filesRead = [];
    const skipped = [];
    for (const file of paths.candidates) {
        let text;
        try {
            text = await readFile(file, 'utf8');
        }
        catch (error) {
            skipped.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        try {
            const parsed = JSON.parse(text);
            for (const config of toProviderConfigs(parsed))
                configs.push(config);
            filesRead.push(file);
        }
        catch {
            skipped.push(`${file}: not valid JSON`);
        }
    }
    return { configs, filesRead, skipped };
}
/**
 * Accepts either `{ providers: [...] }`, a bare array, or a single provider
 * object. DSH config shapes have moved around; being liberal here keeps the
 * adapter from breaking on a schema bump.
 */
export function toProviderConfigs(parsed) {
    const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray(parsed.providers)
            ? (parsed.providers)
            : parsed && typeof parsed === 'object' && 'id' in parsed
                ? [parsed]
                : [];
    const out = [];
    for (const item of list) {
        if (!item || typeof item !== 'object')
            continue;
        const raw = item;
        const id = typeof raw.id === 'string' ? raw.id : typeof raw.name === 'string' ? raw.name : undefined;
        if (!id)
            continue;
        const models = Array.isArray(raw.models)
            ? raw.models
                .map((m) => {
                if (typeof m === 'string')
                    return { id: m };
                if (!m || typeof m !== 'object')
                    return undefined;
                const rec = m;
                const modelId = typeof rec.id === 'string' ? rec.id : typeof rec.name === 'string' ? rec.name : undefined;
                return modelId ? { ...rec, id: modelId } : undefined;
            })
                .filter((m) => Boolean(m))
            : [];
        out.push({
            id,
            name: typeof raw.name === 'string' ? raw.name : id,
            models,
        });
    }
    return out;
}
/**
 * One read-only discovery pass: config files + runtime list, merged into model
 * entries. Skips (never throws) on anything unreadable, so the wizard can run
 * on a machine where DSH has never been configured.
 */
export async function discoverDshModels(options = {}) {
    const filesRead = [];
    const skipped = [];
    let models = [];
    let providers = [];
    if (options.paths) {
        const fromDisk = await readDshConfig(options.paths);
        filesRead.push(...fromDisk.filesRead);
        skipped.push(...fromDisk.skipped);
        const discovered = discoverFromDshConfig(fromDisk.configs);
        models.push(...discovered.models);
        providers.push(...discovered.providers);
    }
    const runtime = options.runtime;
    if (runtime?.providers?.length) {
        const fromRuntime = discoverFromDshConfig(runtime.providers);
        const runtimeModels = fromRuntime.models.map((m) => ({ ...m, source: 'dsh-runtime' }));
        models = [...models, ...runtimeModels];
        providers = [...new Set([...providers, ...fromRuntime.providers])];
    }
    return {
        models,
        providers,
        filesRead,
        skipped,
        runtimeModels: runtime?.providers?.reduce((n, p) => n + p.models.length, 0) ?? 0,
    };
}
/** mtime of a path, or undefined when it does not exist. Used by read-only tests. */
export async function mtimeOf(file) {
    try {
        return (await stat(file)).mtimeMs;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=dsh-config.js.map