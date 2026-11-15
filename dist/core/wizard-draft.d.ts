import type { CapabilityEntry, CapabilitySource } from './types.js';
import { type MergeReport } from './registry.js';
import { type UsageSummary } from './usage-stats.js';
/**
 * Everything the install wizard needs to show, as plain data.
 *
 * This module deliberately has no UI: it returns what to ask, what to show, and
 * what it guessed — the plugin shell renders it. That keeps the guesswork
 * testable without a browser.
 */
/** Below this share the "most-used" model is not really the user's habit. */
export declare const DOMINANT_SHARE = 0.6;
export type WizardQuestionKind = 'confirm-baseline' | 'confirm-endpoint' | 'missing-models' | 'price-unknown';
export interface WizardQuestion {
    kind: WizardQuestionKind;
    /** Short headline, user-facing. */
    title: string;
    /** Optional detail; never contains prompt text or keys. */
    detail: string;
    /** Model keys this question is about, when applicable. */
    keys: string[];
}
export interface WizardProviderGroup {
    provider: string;
    count: number;
    sources: CapabilitySource[];
    /** True when every model in the group came back reachable. */
    reachable: boolean;
    keys: string[];
}
export interface WizardDraft {
    /** Model groups, ordered by size then name — the wizard's main list. */
    groups: WizardProviderGroup[];
    /** Guessed baseline (most-used model). Undefined means "ask the user". */
    baselineKey?: string;
    /** Why that baseline: 'usage' beats 'price-fallback'. */
    baselineBasis: 'usage' | 'price-fallback' | 'none';
    /** Usage summary the guess came from, safe to show (counts only). */
    usage: {
        totalCalls: number;
        topKey?: string;
        topShare: number;
        line: string;
    };
    /** Things the user must confirm before the wizard finishes. */
    questions: WizardQuestion[];
    /** Merge conflicts worth surfacing once, not per model. */
    conflicts: MergeReport['conflicts'];
    /** Sources that contributed at all. */
    sources: CapabilitySource[];
    totalModels: number;
}
export interface WizardDraftInput {
    entries: CapabilityEntry[];
    usage?: UsageSummary;
    mergeReport?: MergeReport;
    /** Endpoints the probe found dead. Their models are hidden but not deleted. */
    deadEndpoints?: string[];
}
/** Builds the draft. Pure; no fs, no network, no UI. */
export declare function buildWizardDraft(input: WizardDraftInput): WizardDraft;
/** Groups entries by provider for the wizard list. */
export declare function groupByProvider(entries: CapabilityEntry[]): WizardProviderGroup[];
/** True when nothing needs confirming — the wizard can close on its own. */
export declare function isReady(draft: WizardDraft): boolean;
//# sourceMappingURL=wizard-draft.d.ts.map