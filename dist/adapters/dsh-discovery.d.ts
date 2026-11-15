import type { CapabilityKind, ModelEntry, ModelLimits, ModelPricing } from '../core/types.js';
/** Shape of one provider as DSH hands it over. Read-only by contract. */
export interface DshProviderConfig {
    id: string;
    name: string;
    models: {
        id: string;
        name?: string;
        contextWindow?: number;
        maxOutputTokens?: number;
        inputPerMTok?: number;
        outputPerMTok?: number;
        capabilities?: CapabilityKind[];
        /**
         * Whether the model accepts tool definitions. Optional because most configs
         * do not say — and C-4 is precisely the finding that the old code turned
         * "does not say" into a confident `true`.
         */
        supportsTools?: boolean;
        /** Free-text quality hint from the config, when the provider offers one. */
        strength?: number;
    }[];
}
export interface DiscoveryResult {
    models: ModelEntry[];
    /** Providers that yielded at least one model, for the wizard summary. */
    providers: string[];
}
/**
 * Capabilities a provider config's model accepts, inferred from modalities.
 *
 * The real-host defect behind "计划阶段列表是空的" was that a live host's models
 * arrived with the single capability `reasoning` (the old constant), so every
 * `coding` / `writing` / `summarizing` stage came back **unassigned** — a card
 * full of rows with no model, which is also why "换模型也改不了". A text route
 * in a provider config is a general text model: it accepts the text
 * capabilities. That is a statement about what the route accepts, not a claim
 * about quality — quality is `strength`, and the decider's score (not a tag
 * count) is what ranks models.
 *
 * `image-generation` is never inferred: no config field states it, and a text
 * model cannot emit images. Vision needs an explicit image modality.
 */
export declare function capabilitiesForModalities(modalities: {
    text: boolean;
    image: boolean;
}): CapabilityKind[];
/**
 * Turns a DSH provider config snapshot into model entries.
 *
 * Strictly read-only: takes a plain object, returns plain objects, never writes
 * the config it was handed.
 */
export declare function discoverFromDshConfig(configs: DshProviderConfig[]): DiscoveryResult;
/** Placeholders used ONLY when the config says nothing. Flagged as guessed. */
export declare const FALLBACK_CONTEXT_WINDOW = 32000;
export declare const FALLBACK_MAX_OUTPUT_TOKENS = 4096;
/**
 * Limits for one model, and whether we had to invent any of them.
 *
 * A missing window becomes a placeholder, not a fact: `guessed: true` travels
 * into `ModelEntry.limitsGuessed` so `guardSwitch` refuses to promise space it
 * has never seen. Filling in 32k silently was the A-5/B3 defect — it made the
 * unconfirmed-window gate unreachable on real configs.
 */
export declare function limitsFrom(model: DshProviderConfig['models'][number]): {
    limits: ModelLimits;
    guessed: boolean;
};
/**
 * Price for one model. Missing means unknown, never zero: `null` propagates to
 * `costOf`, so the plan card says "price unknown" instead of "save 100%".
 * Zero is a real price (a local model) and only comes from an explicit 0.
 */
export declare function pricingFrom(model: DshProviderConfig['models'][number]): ModelPricing;
/** Midpoint assumed when nobody states a quality figure. Not a ranking. */
export declare const NEUTRAL_STRENGTH = 0.5;
/**
 * A **placeholder**, and now labelled as one (B-10).
 *
 * It used to be `0.6 + 0.05 × capabilityCount`, which made "how good is this
 * model" mean "how many labels does it have": a model tagged `coding + writing`
 * outranked a specialist coder, while the test that covered it was named
 * "ranks specialised models slightly higher". The score was breadth wearing the
 * word "strength", and `decider` used it as its main signal.
 *
 * Three fixes, in order of importance:
 *  1. a specialisation **penalty** replaces the breadth bonus, so a model that
 *     advertises everything it can do for a stage does not win by being unfocused;
 *  2. a stated `strength` in the provider config wins outright — the honest
 *     answer to "how good" comes from data, not from tag counting;
 *  3. otherwise every model gets the same neutral value, which makes the decider
 *     fall through to fit and price (its other, real signals) instead of to a
 *     number this module made up.
 */
export declare function strengthFromCapabilities(capabilities: CapabilityKind[], stated?: number): number;
//# sourceMappingURL=dsh-discovery.d.ts.map