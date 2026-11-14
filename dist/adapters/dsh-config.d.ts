import { type DshProviderConfig, type DiscoveryResult } from './dsh-discovery.js';
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
export declare function defaultConfigPaths(home?: string): DshConfigPaths;
/**
 * Reads the first config file that parses. Missing files are not errors — a
 * fresh install has none, and the wizard simply shows "no DSH providers found".
 */
export declare function readDshConfig(paths: DshConfigPaths): Promise<ReadConfigResult>;
/**
 * Accepts either `{ providers: [...] }`, a bare array, or a single provider
 * object. DSH config shapes have moved around; being liberal here keeps the
 * adapter from breaking on a schema bump.
 */
export declare function toProviderConfigs(parsed: unknown): DshProviderConfig[];
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
export declare function discoverDshModels(options?: DshDiscoveryAdapterOptions): Promise<DshDiscoveryResult>;
/** mtime of a path, or undefined when it does not exist. Used by read-only tests. */
export declare function mtimeOf(file: string): Promise<number | undefined>;
//# sourceMappingURL=dsh-config.d.ts.map