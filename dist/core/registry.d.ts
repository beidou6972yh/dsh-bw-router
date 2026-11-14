import type { CapabilityEntry, CapabilityKind, CapabilitySource, ModelEntry } from './types.js';
/** One model seen by more than one source: kept as one entry, provenance merged. */
export interface MergeReport {
    /** Entries created from scratch. */
    added: string[];
    /** Entries that existed already and got their data refreshed. */
    updated: string[];
    /** Keys where two sources disagreed on something user-visible. */
    conflicts: {
        key: string;
        field: string;
        kept: string;
        dropped: string;
    }[];
}
/** Source precedence: explicit beats discovered, discovered beats probed guesses. */
export declare const SOURCE_PRECEDENCE: CapabilitySource[];
export interface RegisterInput {
    /** Model entries as discovered by adapters. */
    models: ModelEntry[];
    /**
     * Keys that answered a health probe this run.
     *
     * B-3: the two cases are now told apart everywhere, not just in the comment.
     * `undefined` = **no probe ran**, so nothing is claimed (a known-dead entry
     * stays dead, a never-probed entry stays optimistic — a fresh install with no
     * probe must not look like "every model is down"). `[]` = **a probe ran and
     * every key failed**, which is a real verdict and marks the batch unavailable.
     * The M0-1 report caught the old code treating `[]` as unknown in prose while
     * acting on it as "all dead".
     */
    availableKeys?: string[];
    /** Where the batch came from, recorded on each entry. */
    source?: CapabilitySource;
}
/**
 * The capability list. Adapters feed it, the planner/decider/guard read it.
 *
 * Kept deliberately dumb: no probing, no persistence, no platform calls.
 * Re-registering a key replaces the entry (last writer wins) so a live
 * discovery pass can refresh stale prices.
 */
export declare class Registry {
    private readonly entries;
    register(input: RegisterInput): CapabilityEntry[];
    get(key: string): CapabilityEntry | undefined;
    has(key: string): boolean;
    all(): CapabilityEntry[];
    size(): number;
    remove(key: string): boolean;
    /** Entries that can do `capability`, strongest first. */
    byCapability(capability: CapabilityKind): CapabilityEntry[];
    /** Groups the list by provider — what the install wizard shows. */
    byProvider(): Map<string, CapabilityEntry[]>;
    /**
     * Cheapest available entry that still has every requested capability.
     * Models whose price is unknown are never "cheap": they are left out.
     */
    cheapestFor(capabilities: CapabilityKind[]): CapabilityEntry | undefined;
    /** Marks availability after a probe. Unknown keys are ignored, not created. */
    markAvailability(key: string, available: boolean, note?: string): void;
    clear(): void;
}
export interface BaselinePick {
    key: string | undefined;
    /** True when the key came from price ordering, not from the user's habits. */
    isGuess: boolean;
}
/**
 * Picks the model a user runs most of the time = the savings baseline.
 *
 * With no usage data we guess, and we say so: the guess never pretends to be
 * the user's habit, and models with unknown prices are not candidates.
 */
export declare function pickBaseline(entries: CapabilityEntry[], usage?: Record<string, number>): BaselinePick;
/**
 * Merges several batches into one capability list.
 *
 * Each batch carries its own source. The same provider/model discovered twice
 * stays ONE entry: higher-precedence source wins field by field, and every
 * disagreement is reported instead of silently dropped. That is what makes
 * "the wizard found 3 providers, here they are" honest.
 */
export declare function buildCapabilityList(batches: {
    source: CapabilitySource;
    models: ModelEntry[];
}[], options?: {
    availableKeys?: string[];
}): {
    registry: Registry;
    report: MergeReport;
};
//# sourceMappingURL=registry.d.ts.map