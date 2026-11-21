import type { DshProviderConfig } from './dsh-discovery.js';
import { type YamlValue } from './yaml-lite.js';
/**
 * Reads the model list from **DSH's own live configuration**, read-only.
 *
 * Why: the external tester's first defect was "模型数就是 0". The old discovery
 * only looked at three JSON files (`config.json` / `providers.json` /
 * `models.json`) that a modern DSH install does not have — the real provider
 * list lives in the profile patch YAML (`profiles/<profile>/cordis.patch.yml`)
 * and, on older installs, `settings.yaml`. So the plugin scanned nothing and
 * the plan card said "未配置任何模型" on a host with a dozen models configured.
 *
 * This module is the file half of the fix. It is strictly read-only (opens with
 * `'r'`, never writes), and every failure is collected as a `skipped` line —
 * a broken config means "no models from this file", never a crash (项目约定:
 * 坏配置 = 「暂无模型」).
 */
/** Where to look, in the order DSH itself would resolve them. */
export interface ProfileScanOptions {
    /** `$DSH_HOME`; defaults to the process environment, then `~/.dsh`. */
    home?: string;
    /** Active profile name (`$DSH_PROFILE`), when the host knows it. */
    profile?: string;
}
/** What one read-only scan found. */
export interface ProfileConfigResult {
    providers: DshProviderConfig[];
    /** `provider/model` from the host's own `agent-default-model` entry, when stated. */
    defaultModelKey?: string;
    filesRead: string[];
    /** Non-fatal reasons a candidate was skipped. Never throws. */
    skipped: string[];
}
/** The live config files a DSH install may keep its providers in. */
export declare function defaultProfileCandidates(options?: ProfileScanOptions): Promise<string[]>;
/**
 * True for the non-profile fallbacks: the legacy `settings.yaml` and the three
 * JSON files older adapters knew. They are read even when the active profile is
 * known, because a profile patch may legitimately state no providers.
 */
export declare function isLegacyCandidate(file: string): boolean;
/** `web.bak-20260926` / `web-backup` / `web.old` are copies, not profiles. */
export declare function isBackupDirectory(name: string): boolean;
/**
 * Reads every readable candidate and merges what they state.
 *
 * A file that is missing, unreadable, or outside the supported YAML subset is
 * one `skipped` line; it never aborts the scan, so one bad profile cannot hide
 * the models declared by another.
 */
export declare function readProfileConfigFiles(candidates: readonly string[]): Promise<ProfileConfigResult>;
/**
 * Extracts provider routes from one parsed document.
 *
 * Three shapes occur in the wild, and all three are accepted:
 *  - a profile patch: an **array** of loader entries, providers under
 *    `entry.config.providers` (`- id: llm-pi-ai`);
 *  - a legacy `settings.yaml`: a **map** whose `llm-pi-ai.providers` holds them;
 *  - a bare `{ providers: {...} }` or `providers: [...]` document.
 */
export declare function providerConfigsFromDocument(document: YamlValue): {
    providers: DshProviderConfig[];
    defaultModelKey?: string;
};
//# sourceMappingURL=dsh-profile-config.d.ts.map