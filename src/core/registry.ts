import type {
  CapabilityEntry,
  CapabilityKind,
  CapabilitySource,
  ModelEntry,
} from './types.js';
import { availableAnd, modelKey, pricingKnown } from './types.js';

/** One model seen by more than one source: kept as one entry, provenance merged. */
export interface MergeReport {
  /** Entries created from scratch. */
  added: string[];
  /** Entries that existed already and got their data refreshed. */
  updated: string[];
  /** Keys where two sources disagreed on something user-visible. */
  conflicts: { key: string; field: string; kept: string; dropped: string }[];
}

/** Source precedence: explicit beats discovered, discovered beats probed guesses. */
export const SOURCE_PRECEDENCE: CapabilitySource[] = [
  'manual-import',
  'dsh-config',
  'dsh-runtime',
  'local-endpoint',
];

function rank(source: CapabilitySource): number {
  const index = SOURCE_PRECEDENCE.indexOf(source);
  return index < 0 ? SOURCE_PRECEDENCE.length : index;
}

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
export class Registry {
  private readonly entries = new Map<string, CapabilityEntry>();

  register(input: RegisterInput): CapabilityEntry[] {
    const available = new Set(input.availableKeys ?? []);
    const known = input.availableKeys !== undefined;
    const added: CapabilityEntry[] = [];

    for (const model of input.models) {
      const key = modelKey(model.provider, model.model);
      const previous = this.entries.get(key);
      const entry: CapabilityEntry = {
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

  get(key: string): CapabilityEntry | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  all(): CapabilityEntry[] {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }

  remove(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Entries that can do `capability`, strongest first. */
  byCapability(capability: CapabilityKind): CapabilityEntry[] {
    return this.all()
      .filter((e) => e.model.capabilities.includes(capability))
      .sort((a, b) => b.model.strength - a.model.strength);
  }

  /** Groups the list by provider — what the install wizard shows. */
  byProvider(): Map<string, CapabilityEntry[]> {
    const out = new Map<string, CapabilityEntry[]>();
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
  cheapestFor(capabilities: CapabilityKind[]): CapabilityEntry | undefined {
    return this.all()
      .filter((e) => e.available)
      .filter((e) => capabilities.every((c) => e.model.capabilities.includes(c)))
      .filter((e) => pricingKnown(e.model.pricing))
      .sort(
        (a, b) =>
          a.model.pricing.outputPerMTok! - b.model.pricing.outputPerMTok! ||
          a.model.pricing.inputPerMTok! - b.model.pricing.inputPerMTok!,
      )[0];
  }

  /** Marks availability after a probe. Unknown keys are ignored, not created. */
  markAvailability(key: string, available: boolean, note?: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.available = available;
    if (note) entry.notes.push(note);
  }

  clear(): void {
    this.entries.clear();
  }
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
export function pickBaseline(
  entries: CapabilityEntry[],
  usage: Record<string, number> = {},
): BaselinePick {
  let best: string | undefined;
  let bestCount = 0;
  for (const entry of entries) {
    const count = usage[entry.key] ?? 0;
    if (count > bestCount) {
      best = entry.key;
      bestCount = count;
    }
  }
  if (best) return { key: best, isGuess: false };

  const priced = entries.filter((e) => e.available && pricingKnown(e.model.pricing));
  const fallback = [...priced].sort(
    (a, b) =>
      b.model.pricing.outputPerMTok! - a.model.pricing.outputPerMTok! ||
      a.key.localeCompare(b.key),
  )[0]?.key;
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
export function buildCapabilityList(
  batches: { source: CapabilitySource; models: ModelEntry[] }[],
  options: { availableKeys?: string[] } = {},
): { registry: Registry; report: MergeReport } {
  const registry = new Registry();
  const report: MergeReport = { added: [], updated: [], conflicts: [] };
  const seenSources = new Map<string, CapabilitySource>();

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

      const previous = seenSources.get(key)!;
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
          kept: `${winner.pricing.outputPerMTok ?? 'unknown'} (${winner.source})`,
          dropped: `${loser.pricing.outputPerMTok ?? 'unknown'} (${loser.source})`,
        });
      }

      const merged: ModelEntry = {
        ...winner,
        // Capabilities are additive: a probed endpoint rarely knows them, DSH may.
        capabilities: [
          ...new Set([...winner.capabilities, ...loser.capabilities]),
        ] as CapabilityKind[],
      };
      registry.register({ models: [merged], availableKeys: options.availableKeys });
      seenSources.set(key, winner.source);
      report.updated.push(key);
    }
  }

  return { registry, report };
}
