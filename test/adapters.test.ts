import { describe, expect, it } from 'vitest';
import { discoverFromDshConfig, strengthFromCapabilities } from '../src/adapters/dsh-discovery.js';
import { DshModelAdapter, splitModelKey } from '../src/adapters/dsh-model.js';
import {
  DEFAULT_TARGETS,
  applyProbeResults,
  probeAll,
  probeEndpoint,
  type FetchLike,
} from '../src/adapters/probe.js';
import type { CapabilityEntry } from '../src/core/types.js';

describe('dsh-discovery', () => {
  it('builds entries from three providers and keeps provenance', () => {
    const { models, providers } = discoverFromDshConfig([
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: [
          { id: 'chat', contextWindow: 64_000, inputPerMTok: 0.5, outputPerMTok: 2 },
          { id: 'reasoner', capabilities: ['reasoning', 'coding'] },
        ],
      },
      { id: 'local', name: 'Local', models: [{ id: 'qwen' }] },
      { id: 'cloud', name: 'Cloud', models: [] },
    ]);
    expect(providers).toEqual(['deepseek', 'local']);
    expect(models).toHaveLength(3);
    expect(models.every((m) => m.source === 'dsh-config')).toBe(true);
    expect(models[0]!.limits.contextWindow).toBe(64_000);
    expect(models[1]!.limits.contextWindow).toBe(32_000);
  });

  it('marks image models as image-capable', () => {
    const { models } = discoverFromDshConfig([
      { id: 'x', name: 'X', models: [{ id: 'imager', capabilities: ['vision'] }] },
    ]);
    expect(models[0]!.limits.supportsImages).toBe(true);
  });

  it('does not mutate the config it was handed', () => {
    const config = [{ id: 'a', name: 'A', models: [{ id: 'm' }] }];
    const snapshot = JSON.stringify(config);
    discoverFromDshConfig(config);
    expect(JSON.stringify(config)).toBe(snapshot);
  });

  it('does not reward breadth: a two-label model is not stronger than a specialist (B-10)', () => {
    // The old formula was 0.6 + 0.05×labels, so `coding+writing` beat `coding`
    // and "strength" secretly meant "number of tags". It never may again.
    expect(strengthFromCapabilities(['coding', 'writing'])).toBeLessThanOrEqual(
      strengthFromCapabilities(['coding']),
    );
  });

  it('takes a stated strength from the config over any heuristic (B-10)', () => {
    const { models } = discoverFromDshConfig([
      { id: 'p', name: 'P', models: [{ id: 'strong', capabilities: ['coding'], strength: 0.9 }] },
      { id: 'p', name: 'P', models: [{ id: 'taggy', capabilities: ['coding', 'writing', 'vision'] }] },
    ]);
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId['p/strong']!.strength).toBe(0.9);
    expect(byId['p/strong']!.strength).toBeGreaterThan(byId['p/taggy']!.strength);
  });

  it('leaves tool support unknown when the config does not say (C-4)', () => {
    const { models } = discoverFromDshConfig([
      { id: 'p', name: 'P', models: [{ id: 'm' }, { id: 'n', supportsTools: false }] },
    ]);
    expect(models[0]!.limits.supportsTools).toBeNull();
    expect(models[1]!.limits.supportsTools).toBe(false);
  });
});

describe('dsh-model adapter', () => {
  it('splits model keys into provider and model', () => {
    expect(splitModelKey('deepseek/reasoner')).toEqual({
      provider: 'deepseek',
      model: 'reasoner',
    });
    expect(splitModelKey('openrouter/meta/llama-3')).toEqual({
      provider: 'openrouter',
      model: 'meta/llama-3',
    });
  });

  it('rejects malformed keys', () => {
    expect(() => splitModelKey('nope')).toThrow(/malformed/);
    expect(() => splitModelKey('/x')).toThrow(/malformed/);
    expect(() => splitModelKey('x/')).toThrow(/malformed/);
  });

  it('delegates the switch to the host callback for this session only', async () => {
    const calls: string[][] = [];
    const adapter = new DshModelAdapter(
      {
        selectModel: async (sessionId, provider, model) => {
          calls.push([sessionId, provider, model]);
        },
        readCurrent: () => 'deepseek/flash',
      },
      'sess-1',
    );
    await adapter.select('sess-1', 'local/qwen-coder');
    expect(calls).toEqual([['sess-1', 'local', 'qwen-coder']]);
    expect(adapter.current()).toBe('deepseek/flash');
  });
});

describe('probe', () => {
  const okFetch: FetchLike = async () => ({ ok: true, status: 200 });
  const deadFetch: FetchLike = async () => {
    throw new Error('ECONNREFUSED');
  };

  it('reports reachable endpoints with latency', async () => {
    let t = 0;
    const result = await probeEndpoint(
      { name: 'ollama', url: 'http://localhost:11434' },
      { fetchImpl: okFetch, now: () => (t += 7) },
    );
    expect(result.reachable).toBe(true);
    expect(result.latencyMs).toBe(7);
    expect(result.detail).toBe('HTTP 200');
  });

  it('never throws on a dead port', async () => {
    const result = await probeEndpoint(DEFAULT_TARGETS[0]!, { fetchImpl: deadFetch });
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('reports timeouts as timeouts', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal && setTimeout(() => reject(new Error('aborted')), 5);
      });
    const result = await probeEndpoint(DEFAULT_TARGETS[1]!, {
      fetchImpl: hanging,
      timeoutMs: 1,
    });
    expect(result.reachable).toBe(false);
  });

  it('probes all targets in order and keeps failures silent', async () => {
    const results = await probeAll(DEFAULT_TARGETS.slice(0, 3), { fetchImpl: deadFetch });
    expect(results.map((r) => r.name)).toEqual(['ollama', 'lm-studio', 'llama-cpp']);
    expect(results.every((r) => !r.reachable)).toBe(true);
  });

  it('reports missing fetch without throwing', async () => {
    const result = await probeEndpoint(DEFAULT_TARGETS[0]!, { fetchImpl: undefined as never });
    expect(result.reachable).toBe(false);
  });

  it('applies probe results to entries by provider', () => {
    const entries: CapabilityEntry[] = [
      { key: 'a/a', model: { id: 'a/a', provider: 'ollama', model: 'a', label: 'a', capabilities: [], limits: { contextWindow: 1, maxOutputTokens: 1, supportsTools: false, supportsImages: false }, pricing: { inputPerMTok: 0, outputPerMTok: 0 }, strength: 1, source: 'local-endpoint' }, available: true, notes: [] },
      { key: 'b/b', model: { id: 'b/b', provider: 'unknown', model: 'b', label: 'b', capabilities: [], limits: { contextWindow: 1, maxOutputTokens: 1, supportsTools: false, supportsImages: false }, pricing: { inputPerMTok: 0, outputPerMTok: 0 }, strength: 1, source: 'local-endpoint' }, available: true, notes: [] },
    ];
    const patched = applyProbeResults(entries, [
      { name: 'ollama', url: '', reachable: false, latencyMs: 1, detail: '' },
    ]);
    expect(patched[0]!.available).toBe(false);
    expect(patched[1]!.available).toBe(true);
  });
});

describe('adapters are read-only by contract', () => {
  it('discovery does not mutate its input config', () => {
    const config = [
      { id: 'p', name: 'P', models: [{ id: 'm', capabilities: ['coding' as const] }] },
    ];
    const before = JSON.parse(JSON.stringify(config));
    discoverFromDshConfig(config);
    expect(config).toEqual(before);
    // C-2: this used to assert `expect(x).toBe(x)` — a tautology that passes even
    // if discovery rewrote the whole config. Assert the deep shape instead.
    expect(config).toEqual([{ id: 'p', name: 'P', models: [{ id: 'm', capabilities: ['coding'] }] }]);
  });

  it('discovery returns fresh objects, so callers cannot corrupt the source', () => {
    const config = [{ id: 'p', name: 'P', models: [{ id: 'm' }] }];
    const { models } = discoverFromDshConfig(config);
    models[0]!.capabilities.push('coding');
    models[0]!.limits.contextWindow = 1;
    expect(config[0]!.models[0]).toEqual({ id: 'm' });
  });
});
