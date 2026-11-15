import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelEntry } from '../core/types.js';
import { discoverFromDshConfig, type DshProviderConfig, type DiscoveryResult } from './dsh-discovery.js';

/**
 * Locates and reads DSH's provider config — **read only**.
 *
 * Everything here takes its paths as input and opens files with `'r'` intent;
 * nothing in this file writes, renames, or re-serialises a config. That is a
 * hard rule of the project (铁律 3: never degrade the host environment), and the
 * test suite asserts it by comparing file mtimes across a full discovery pass.
 */

export interface DshConfigPaths {
  /** Candidate config files, in the order DSH itself would look. */
  candidates: string[];
}

export interface ReadConfigResult {
  /** Config objects parsed from files, as plain data. */
  configs: DshProviderConfig[];
  /** Files actually read, for the wizard's "where did this come from" line. */
  filesRead: string[];
  /** Non-fatal reasons a candidate was skipped. Never throws. */
  skipped: string[];
}

/** Default candidates, relative to `$DSH_HOME` (falling back to `~/.dsh`). */
export function defaultConfigPaths(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')): DshConfigPaths {
  return {
    candidates: [join(home, 'config.json'), join(home, 'providers.json'), join(home, 'models.json')],
  };
}

/**
 * Reads the first config file that parses. Missing files are not errors — a
 * fresh install has none, and the wizard simply shows "no DSH providers found".
 */
export async function readDshConfig(paths: DshConfigPaths): Promise<ReadConfigResult> {
  const configs: DshProviderConfig[] = [];
  const filesRead: string[] = [];
  const skipped: string[] = [];

  for (const file of paths.candidates) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      skipped.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      for (const config of toProviderConfigs(parsed)) configs.push(config);
      filesRead.push(file);
    } catch {
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
export function toProviderConfigs(parsed: unknown): DshProviderConfig[] {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { providers?: unknown }).providers)
      ? ((parsed as { providers: unknown[] }).providers)
      : parsed && typeof parsed === 'object' && 'id' in parsed
        ? [parsed]
        : [];

  const out: DshProviderConfig[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id : typeof raw.name === 'string' ? raw.name : undefined;
    if (!id) continue;
    const models = Array.isArray(raw.models)
      ? raw.models
          .map((m) => {
            if (typeof m === 'string') return { id: m };
            if (!m || typeof m !== 'object') return undefined;
            const rec = m as Record<string, unknown>;
            const modelId = typeof rec.id === 'string' ? rec.id : typeof rec.name === 'string' ? rec.name : undefined;
            return modelId ? { ...rec, id: modelId } as { id: string } : undefined;
          })
          .filter((m): m is { id: string } => Boolean(m))
      : [];
    out.push({
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      models,
    } as DshProviderConfig);
  }
  return out;
}

/** Runtime model list as the host exposes it at run time (already in memory). */
export interface DshRuntimeSnapshot {
  providers: DshProviderConfig[];
  /** Model keys the host reports as currently selectable. */
  availableKeys?: string[];
}

export interface DshDiscoveryAdapterOptions {
  paths?: DshConfigPaths;
  /** Injected by the host at runtime; the adapter never reaches for it itself. */
  runtime?: DshRuntimeSnapshot;
}

export interface DshDiscoveryResult extends DiscoveryResult {
  filesRead: string[];
  skipped: string[];
  runtimeModels: number;
}

/**
 * One read-only discovery pass: config files + runtime list, merged into model
 * entries. Skips (never throws) on anything unreadable, so the wizard can run
 * on a machine where DSH has never been configured.
 */
export async function discoverDshModels(
  options: DshDiscoveryAdapterOptions = {},
): Promise<DshDiscoveryResult> {
  const filesRead: string[] = [];
  const skipped: string[] = [];
  let models: ModelEntry[] = [];
  let providers: string[] = [];

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
    const runtimeModels = fromRuntime.models.map((m) => ({ ...m, source: 'dsh-runtime' as const }));
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
export async function mtimeOf(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}
