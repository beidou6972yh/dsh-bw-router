import type { CapabilityEntry } from '../core/types.js';

/**
 * Adapter boundary for DSH's session-level model selection.
 *
 * The kernel never calls this directly: `PluginHost` owns an instance. Keeping
 * it an interface means the adapter can be swapped without touching `core/`.
 */
export interface DshModelSelection {
  /** Current model key for this session, e.g. `deepseek/deepseek-chat`. */
  /**
   * Current model key for a session, e.g. `deepseek/deepseek-chat`.
   *
   * The optional id is the session the caller is acting on; omitting it asks
   * the adapter for the session it resolved for this host (never a literal).
   */
  current(sessionId?: string): string;
  /**
   * Switches the model for THIS session only.
   * MUST NOT touch the user's global default model.
   */
  select(sessionId: string, modelKey: string): Promise<void>;
  /** Model key of the user's global default, or undefined when not observable. */
  globalDefault?(): string | undefined;
  /**
   * Whether the last global-default reading produced a value at all.
   *
   * `false` is the honest "未能观测" state: a watcher that cannot read the cell
   * must not let its silence be read as "nothing happened" (K-003).
   */
  globalDefaultObservable?(): boolean;
  /**
   * Takes a fresh reading of the global default and makes it the baseline for
   * the next comparison. Hosts call it at the start of a run and before each
   * switch: without it the watch compares against a stale reading, and a
   * settings edit between two switches gets reported as if the switch did it.
   */
  primeGlobalDefault?(): string | undefined;
  /**
   * Runs a switch and reports whether the global default moved because of it.
   *
   * `sessionId` is the session the request named; a caller that omits it gets
   * the adapter's own resolution (`current()`), which is never the literal
   * `'current'` any more.
   */
  selectGuarded?(
    modelKey: string,
    sessionId?: string,
  ): Promise<{ wroteBackGlobalDefault: boolean; from?: string; to?: string }>;
}

export interface SelectModelDeps {
  /** Injected by the plugin host; never imported by core. */
  selectModel: (sessionId: string, provider: string, model: string) => Promise<void>;
  readCurrent: (sessionId: string) => string;
}

/**
 * Thin wrapper over the host callbacks.
 *
 * It cannot stop DSH from writing the global default back (that happens inside
 * the platform), so it does the thing that is actually possible: it watches.
 * Every `select` snapshots the global default before and after, and a change is
 * reported in the switch result — never swallowed. Silent write-back was K-003,
 * and silence is what made it dangerous.
 */
export class DshModelAdapter implements DshModelSelection {
  /**
   * @param guard optional global-default watcher; see `createGlobalDefaultGuard`.
   *   Passed separately so the kernel stays ignorant of where defaults live.
   */
  constructor(
    private readonly deps: SelectModelDeps,
    private readonly sessionId: string | (() => string),
    private readonly guard?: GlobalDefaultGuard,
  ) {}

  /**
   * This session's id.
   *
   * A function is accepted because some hosts only learn the id after their
   * session service comes up; a resolved call keeps the adapter from freezing
   * `'current'` at activation time.
   */
  private get id(): string {
    return typeof this.sessionId === 'function' ? this.sessionId() : this.sessionId;
  }

  current(sessionId?: string): string {
    return this.deps.readCurrent(sessionId || this.id);
  }

  /** Model key of the user's global default, or undefined when not observable. */
  globalDefault(): string | undefined {
    return this.guard?.snapshot();
  }

  /** Whether the last reading actually produced a value (false = 未能观测). */
  globalDefaultObservable(): boolean {
    return this.guard?.observable?.() ?? false;
  }

  /**
   * Re-reads the global default and arms the watch at "now".
   *
   * Callers do this right before a switch: the default may have been edited in
   * settings since the plugin started, and a stale baseline would report that
   * edit as if the switch caused it.
   */
  primeGlobalDefault(): string | undefined {
    return this.guard?.arm();
  }

  /**
   * Switches, then reports whether the platform dragged the global default
   * along. A refused `selectModel` is reported with the same shape, so a caller
   * that only passes the method through still sees the truth.
   */
  async selectGuarded(
    modelKey: string,
    sessionId?: string,
  ): Promise<{ wroteBackGlobalDefault: boolean; from?: string; to?: string; error?: string }> {
    const before = this.guard?.snapshot();
    try {
      await this.select(sessionId || this.id, modelKey);
    } catch (error) {
      const moved = this.guard?.compare();
      return {
        wroteBackGlobalDefault: moved?.wroteBackGlobalDefault ?? false,
        ...(moved?.from === undefined ? {} : { from: moved.from }),
        ...(moved?.to === undefined ? {} : { to: moved.to }),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const moved = this.guard?.compare();
    return {
      wroteBackGlobalDefault: moved?.wroteBackGlobalDefault ?? false,
      ...(moved?.from === undefined ? {} : { from: moved.from }),
      ...(moved?.to === undefined ? {} : { to: moved.to }),
    };
  }

  async select(sessionId: string, modelKey: string): Promise<void> {
    const target = sessionId || this.id;
    if (!target) {
      // Never guess: the previous code fell back to the literal `'current'`,
      // which a real DSH host answers with `session/not-found`.
      throw new Error(
        'session-unknown: no session id was stated by the caller and the host named none',
      );
    }
    const { provider, model } = splitModelKey(modelKey);
    await this.deps.selectModel(target, provider, model);
  }
}

/**
 * Observes the user's global default model across a switch.
 *
 * Implemented in the adapter layer because only it knows whether the default
 * lives in a file, a database, or the host's memory. `core/` only ever sees the
 * boolean "it moved".
 */
export interface GlobalDefaultGuard {
  /** Current global default model key, or undefined when it cannot be read. */
  snapshot(): string | undefined;
  /** Takes a fresh reading and makes it the baseline for the next `compare()`. */
  arm(): string | undefined;
  /** Diffs against the last snapshot. */
  compare(): { wroteBackGlobalDefault: boolean; from?: string; to?: string };
  /** Whether the most recent read produced a value (`false` = 未能观测). */
  observable(): boolean;
}

/**
 * Generic guard over any readable cell.
 *
 * Two rules keep it honest:
 *  - unreadable (undefined) is NOT "unchanged": we say nothing and claim
 *    nothing, because a blind watch must never report "all clear";
 *  - only a change observed *during* `compare()` counts. If the default had
 *    already moved before we started watching, that is not this switch's doing,
 *    and blaming it would be as wrong as missing it.
 */
export function createGlobalDefaultGuard(read: () => string | undefined): GlobalDefaultGuard {
  /** Whether the last *actual* read produced a value. */
  let readable = false;
  const readNow = (): string | undefined => {
    const value = safeRead(read);
    readable = value !== undefined;
    return value;
  };
  let baseline = readNow();
  return {
    snapshot: () => baseline,
    observable: () => readable,
    arm: () => {
      baseline = readNow();
      return baseline;
    },
    compare: () => {
      const after = readNow();
      const moved = baseline !== undefined && after !== undefined && baseline !== after;
      const result = moved
        ? { wroteBackGlobalDefault: true, from: baseline, to: after }
        : { wroteBackGlobalDefault: false };
      baseline = after;
      return result;
    },
  };
}

/** Reading the default must never throw: an unreadable cell is simply unknown. */
function safeRead(read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Splits a model key back into the pair the platform expects. */
export function splitModelKey(modelKey: string): { provider: string; model: string } {
  const index = modelKey.indexOf('/');
  if (index <= 0 || index === modelKey.length - 1) {
    throw new Error(`splitModelKey: malformed model key "${modelKey}"`);
  }
  return { provider: modelKey.slice(0, index), model: modelKey.slice(index + 1) };
}

/**
 * Marks one model as usable — adapters own availability, core never guesses.
 *
 * C-1: this used to be `entries.map(e => e.id === key ? {...e} : e)`, which
 * compared an `id` against a registry **key** (two namespaces, so it never
 * matched) and returned a copy whose fields were identical (so it never changed
 * anything). A function named "withAvailability" that cannot affect availability
 * is worse than no function: it lets a caller believe a dead model was revived.
 *
 * It now takes `CapabilityEntry`s (the level where `available` and `notes` live),
 * matches on `key`, and reports whether anything changed — so its caller can tell
 * "marked dead" from "not in this list" without re-reading the array.
 */
export function withAvailability(
  entries: CapabilityEntry[],
  key: string,
  options: { available?: boolean; note?: string } = {},
): { entries: CapabilityEntry[]; changed: boolean; found: boolean } {
  const available = options.available ?? true;
  let changed = false;
  let found = false;
  const next = entries.map((entry) => {
    if (entry.key !== key) return entry;
    found = true;
    if (entry.available === available && options.note === undefined) return entry;
    changed = true;
    return {
      ...entry,
      available,
      notes: options.note === undefined ? [...entry.notes] : [...entry.notes, options.note],
    };
  });
  return { entries: next, changed, found };
}
