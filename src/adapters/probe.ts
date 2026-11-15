import type { CapabilityEntry } from '../core/types.js';

export interface ProbeTarget {
  /** Key used in logs and UI, e.g. `ollama`. */
  name: string;
  url: string;
}

/** Default local endpoints the wizard offers to check. */
export const DEFAULT_TARGETS: ProbeTarget[] = [
  { name: 'ollama', url: 'http://localhost:11434' },
  { name: 'lm-studio', url: 'http://localhost:1234' },
  { name: 'llama-cpp', url: 'http://localhost:8082' },
  { name: 'litellm', url: 'http://localhost:4000' },
  { name: 'vllm', url: 'http://localhost:8000' },
];

export interface ProbeResult {
  name: string;
  url: string;
  reachable: boolean;
  latencyMs: number;
  detail: string;
}

export interface ProbeOptions {
  /** Per-target timeout. Must stay small; the wizard blocks on this. */
  timeoutMs?: number;
  /** Injected fetch, so tests never touch the network. */
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** Minimal abort-signal shape, so this file needs no DOM/Node type libs. */
export interface AbortSignalLike {
  readonly aborted: boolean;
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignalLike },
) => Promise<{ ok: boolean; status: number }>;

interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}

type RuntimeGlobals = {
  fetch?: FetchLike;
  AbortController?: new () => AbortControllerLike;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

const runtime = globalThis as unknown as RuntimeGlobals;

export const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Probes one endpoint. Never throws: a dead port and a timeout both come back
 * as `reachable: false` with a reason, because the wizard must keep going.
 */
export async function probeEndpoint(
  target: ProbeTarget,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? runtime.fetch;
  const started = now();

  if (!fetchImpl) {
    return {
      name: target.name,
      url: target.url,
      reachable: false,
      latencyMs: 0,
      detail: 'no fetch implementation available',
    };
  }

  const AbortCtor = runtime.AbortController;
  if (!AbortCtor) {
    return {
      name: target.name,
      url: target.url,
      reachable: false,
      latencyMs: 0,
      detail: 'no AbortController available',
    };
  }
  const controller = new AbortCtor();
  const timer = runtime.setTimeout?.(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.url, { signal: controller.signal });
    return {
      name: target.name,
      url: target.url,
      reachable: response.ok,
      latencyMs: now() - started,
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: target.name,
      url: target.url,
      reachable: false,
      latencyMs: now() - started,
      detail: controller.signal.aborted ? `timeout after ${timeoutMs}ms` : message,
    };
  } finally {
    runtime.clearTimeout?.(timer);
  }
}

/** Probes every target concurrently; results keep input order. */
export async function probeAll(
  targets: ProbeTarget[] = DEFAULT_TARGETS,
  options: ProbeOptions = {},
): Promise<ProbeResult[]> {
  return Promise.all(targets.map((t) => probeEndpoint(t, options)));
}

/** Applies probe results to registry entries by provider name. */
export function applyProbeResults(
  entries: CapabilityEntry[],
  results: ProbeResult[],
): CapabilityEntry[] {
  const reachable = new Map(results.map((r) => [r.name, r.reachable]));
  return entries.map((entry) => {
    const hit = reachable.get(entry.model.provider);
    return hit === undefined ? entry : { ...entry, available: hit };
  });
}
