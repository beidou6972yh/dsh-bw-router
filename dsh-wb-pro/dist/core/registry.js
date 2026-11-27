import { availableAnd, modelKey, pricingKnown } from './types.js';
/** Source precedence: explicit beats discovered, discovered beats probed guesses. */
export const SOURCE_PRECEDENCE = [
    'manual-import',
    'dsh-config',
    'dsh-runtime',
    'local-endpoint',
];
function rank(source) {
    const index = SOURCE_PRECEDENCE.indexOf(source);
    return index < 0 ? SOURCE_PRECEDENCE.length : index;
}
/**
 * 单位价（¥/百万 token）的**展示**口径：小数点后 3 位（早期约定）。
 *
 * 未知价不是 0：`null`/`undefined` 一律返回 `'unknown'`，绝不显示成 `0.000`。
 * 只用于给人看的字符串；排序与冲突判定仍用 `outputPerMTok` 的全精度原值。
 */
function unitPriceText(value) {
    return value === null || value === undefined ? 'unknown' : Number(value).toFixed(3);
}
/**
 * The capability list. Adapters feed it, the planner/decider/guard read it.
 *
 * Kept deliberately dumb: no probing, no persistence, no platform calls.
 * Re-registering a key replaces the entry (last writer wins) so a live
 * discovery pass can refresh stale prices.
 */
export class Registry {
    entries = new Map();
    register(input) {
        const available = new Set(input.availableKeys ?? []);
        const known = input.availableKeys !== undefined;
        const added = [];
        for (const model of input.models) {
            const key = modelKey(model.provider, model.model);
            const previous = this.entries.get(key);
            const entry = {
                key,
                model: { ...model, source: input.source ?? model.source },
                // Unknown availability is a soft yes on first sight, but it is ANDed
                // with what we already believed: a known-dead entry stays dead.
                available: known
                    ? available.has(key)
                    : availableAnd(previous?.available ?? true, true),
                // B-3: notes accumulate instead of being wiped. `CapabilityEntry.notes`
                // is where "why was this excluded / when was it last seen" lives, and
                // `notes: []` on every re-registration meant a probe's ECONNREFUSED
                // vanished the moment the config was re-read — the exact moment a reader
                // would go looking for it.
                notes: [...(previous?.notes ?? [])],
            };
            this.entries.set(key, entry);
            added.push(entry);
        }
        return added;
    }
    get(key) {
        return this.entries.get(key);
    }
    has(key) {
        return this.entries.has(key);
    }
    all() {
        return [...this.entries.values()];
    }
    size() {
        return this.entries.size;
    }
    remove(key) {
        return this.entries.delete(key);
    }
    /** Entries that can do `capability`, strongest first. */
    byCapability(capability) {
        return this.all()
            .filter((e) => e.model.capabilities.includes(capability))
            .sort((a, b) => b.model.strength - a.model.strength);
    }
    /** Groups the list by provider — what the install wizard shows. */
    byProvider() {
        const out = new Map();
        for (const entry of this.all()) {
            const list = out.get(entry.model.provider) ?? [];
            list.push(entry);
            out.set(entry.model.provider, list);
        }
        return out;
    }
    /**
     * Cheapest available entry that still has every requested capability.
     * Models whose price is unknown are never "cheap": they are left out.
     */
    cheapestFor(capabilities) {
        return this.all()
            .filter((e) => e.available)
            .filter((e) => capabilities.every((c) => e.model.capabilities.includes(c)))
            .filter((e) => pricingKnown(e.model.pricing))
            .sort((a, b) => a.model.pricing.outputPerMTok - b.model.pricing.outputPerMTok ||
            a.model.pricing.inputPerMTok - b.model.pricing.inputPerMTok)[0];
    }
    /** Marks availability after a probe. Unknown keys are ignored, not created. */
    markAvailability(key, available, note) {
        const entry = this.entries.get(key);
        if (!entry)
            return;
        entry.available = available;
        if (note)
            entry.notes.push(note);
    }
    clear() {
        this.entries.clear();
    }
}
/**
 * Picks the model a user runs most of the time = the savings baseline.
 *
 * With no usage data we guess, and we say so: the guess never pretends to be
 * the user's habit, and models with unknown prices are not candidates.
 */
export function pickBaseline(entries, usage = {}) {
    let best;
    let bestCount = 0;
    for (const entry of entries) {
        const count = usage[entry.key] ?? 0;
        if (count > bestCount) {
            best = entry.key;
            bestCount = count;
        }
    }
    if (best)
        return { key: best, isGuess: false };
    const priced = entries.filter((e) => e.available && pricingKnown(e.model.pricing));
    const fallback = [...priced].sort((a, b) => b.model.pricing.outputPerMTok - a.model.pricing.outputPerMTok ||
        a.key.localeCompare(b.key))[0]?.key;
    return { key: fallback, isGuess: fallback !== undefined };
}
/**
 * Merges several batches into one capability list.
 *
 * Each batch carries its own source. The same provider/model discovered twice
 * stays ONE entry: higher-precedence source wins field by field, and every
 * disagreement is reported instead of silently dropped. That is what makes
 * "the wizard found 3 providers, here they are" honest.
 */
export function buildCapabilityList(batches, options = {}) {
    const registry = new Registry();
    const report = { added: [], updated: [], conflicts: [] };
    const seenSources = new Map();
    const ordered = [...batches].sort((a, b) => rank(b.source) - rank(a.source));
    for (const batch of ordered) {
        for (const model of batch.models) {
            const key = modelKey(model.provider, model.model);
            const existing = registry.get(key);
            const incoming = { ...model, source: batch.source };
            if (!existing) {
                registry.register({ models: [incoming], availableKeys: options.availableKeys });
                report.added.push(key);
                seenSources.set(key, batch.source);
                continue;
            }
            const previous = seenSources.get(key);
            const winner = rank(batch.source) <= rank(previous) ? incoming : existing.model;
            const loser = winner === incoming ? existing.model : incoming;
            // Only the fields a user actually sees are worth flagging.
            if (winner.limits.contextWindow !== loser.limits.contextWindow) {
                report.conflicts.push({
                    key,
                    field: 'contextWindow',
                    kept: `${winner.limits.contextWindow} (${winner.source})`,
                    dropped: `${loser.limits.contextWindow} (${loser.source})`,
                });
            }
            if (winner.pricing.outputPerMTok !== loser.pricing.outputPerMTok) {
                report.conflicts.push({
                    key,
                    field: 'outputPerMTok',
                    kept: `${unitPriceText(winner.pricing.outputPerMTok)} (${winner.source})`,
                    dropped: `${unitPriceText(loser.pricing.outputPerMTok)} (${loser.source})`,
                });
            }
            const merged = {
                ...winner,
                // Capabilities are additive: a probed endpoint rarely knows them, DSH may.
                capabilities: [
                    ...new Set([...winner.capabilities, ...loser.capabilities]),
                ],
            };
            registry.register({ models: [merged], availableKeys: options.availableKeys });
            seenSources.set(key, winner.source);
            report.updated.push(key);
        }
    }
    return { registry, report };
}
//# sourceMappingURL=registry.js.map