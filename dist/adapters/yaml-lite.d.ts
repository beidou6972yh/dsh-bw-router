/**
 * A deliberately small YAML reader for DSH's own config files.
 *
 * Why this exists at all: DSH's real model list lives in YAML
 * (`profiles/<profile>/cordis.patch.yml`, `settings.yaml`), and a plugin that
 * only understands JSON sees **zero models** on a real host — the DEF-1 defect
 * the external tester reported. Adding a full YAML dependency to the plugin was
 * rejected twice over: the kernel must stay dependency-free, and a YAML parser
 * is a large attack surface for one narrow job.
 *
 * So this reads the **block subset DSH actually writes**:
 *   - block mappings (`key: value`, `key:` + nested block);
 *   - block sequences (`- value`, `- key: value`);
 *   - flow sequences/mappings on one line (`[ text, image ]`, `{ a: 1 }`);
 *   - quoted and plain scalars, block scalars (`|`, `>`), comments.
 *
 * Anchors (`&name`) and aliases (`*name`) are tolerated rather than rejected:
 * an anchor marker is stripped and the rest of the line parsed normally, while
 * an alias resolves against anchors seen earlier in the same file. A missing
 * (forward/undefined) alias becomes `null` so one reference can never make the
 * whole profile unreadable. Tags are kept as opaque strings (see below).
 *
 * It deliberately does **not** support multiple documents or complex keys.
 * Those throw a {@link YamlLiteError} — callers treat that as "this file is
 * unreadable", which is the project's standing rule for a bad config
 * (坏配置 = 「暂无模型」, never a crash).
 */
/** What this reader produces: plain JSON-compatible data. */
export type YamlValue = string | number | boolean | null | YamlValue[] | {
    [key: string]: YamlValue;
};
/** A file this reader could not read, with the line that stopped it. */
export declare class YamlLiteError extends Error {
    /** 1-based line number in the original text. */
    readonly line: number;
    constructor(message: string, 
    /** 1-based line number in the original text. */
    line: number);
}
/** Per-document anchor table. Never module-global: aliases cannot leak across files. */
interface ParseContext {
    anchors: Map<string, YamlValue>;
}
/**
 * Removes a trailing `#` comment, respecting quotes and flow brackets.
 *
 * `#` only starts a comment at the start of the content or after whitespace —
 * `a#b` is a scalar in YAML too, and `url: http://x/#frag` must survive.
 */
export declare function stripComment(text: string): string;
/** Splits `key: value` at the first colon outside quotes/brackets. */
export declare function splitKey(text: string): {
    key: string;
    rest: string;
} | undefined;
/** A scalar, a one-line flow collection, or a block-scalar marker. */
export declare function parseScalar(text: string, line: number, context?: ParseContext): YamlValue;
/**
 * Parses one YAML document.
 *
 * @param source - the file text.
 * @returns plain data (objects/arrays/scalars).
 * @throws {YamlLiteError} for anything outside the supported subset — never a
 *   partial guess, because a half-read provider list is worse than no list.
 */
export declare function parseYamlLite(source: string): YamlValue;
export {};
//# sourceMappingURL=yaml-lite.d.ts.map