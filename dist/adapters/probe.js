/** Default local endpoints the wizard offers to check. */
export const DEFAULT_TARGETS = [
    { name: 'ollama', url: 'http://localhost:11434' },
    { name: 'lm-studio', url: 'http://localhost:1234' },
    { name: 'llama-cpp', url: 'http://localhost:8082' },
    { name: 'litellm', url: 'http://localhost:4000' },
    { name: 'vllm', url: 'http://localhost:8000' },
];
const runtime = globalThis;
export const DEFAULT_TIMEOUT_MS = 2000;
/**
 * Probes one endpoint. Never throws: a dead port and a timeout both come back
 * as `reachable: false` with a reason, because the wizard must keep going.
 */
export async function probeEndpoint(target, options = {}) {
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
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            name: target.name,
            url: target.url,
            reachable: false,
            latencyMs: now() - started,
            detail: controller.signal.aborted ? `timeout after ${timeoutMs}ms` : message,
        };
    }
    finally {
        runtime.clearTimeout?.(timer);
    }
}
/** Probes every target concurrently; results keep input order. */
export async function probeAll(targets = DEFAULT_TARGETS, options = {}) {
    return Promise.all(targets.map((t) => probeEndpoint(t, options)));
}
/** Applies probe results to registry entries by provider name. */
export function applyProbeResults(entries, results) {
    const reachable = new Map(results.map((r) => [r.name, r.reachable]));
    return entries.map((entry) => {
        const hit = reachable.get(entry.model.provider);
        return hit === undefined ? entry : { ...entry, available: hit };
    });
}
//# sourceMappingURL=probe.js.map