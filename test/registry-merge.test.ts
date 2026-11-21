import { describe, expect, it } from 'vitest';
import { Registry, buildCapabilityList, pickBaseline, SOURCE_PRECEDENCE } from '../src/core/registry.js';
import { allModels, bigBrain, coder, makeModel } from './fixtures/models.js';

/**
 * M1-1: the capability list is built from several sources. These tests fix the
 * merge semantics — one entry per provider/model, provenance never dropped,
 * disagreements reported instead of swallowed.
 */
describe('capability list from multiple sources', () => {
  it('merges 3 providers into one list with provenance per entry', () => {
    const { registry, report } = buildCapabilityList([
      { source: 'dsh-config', models: [bigBrain, makeModel({ provider: 'deepseek', name: 'flash' })] },
      { source: 'local-endpoint', models: [coder] },
      { source: 'dsh-runtime', models: [makeModel({ provider: 'cloud', name: 'diffusion-xl' })] },
    ]);

    expect(registry.size()).toBe(4);
    const providers = [...registry.byProvider().keys()].sort();
    expect(providers).toEqual(['cloud', 'deepseek', 'local']);
    expect(registry.get('deepseek/reasoner')!.model.source).toBe('dsh-config');
    expect(registry.get('local/qwen-coder')!.model.source).toBe('local-endpoint');
    expect(registry.get('cloud/diffusion-xl')!.model.source).toBe('dsh-runtime');
    expect(report.added).toHaveLength(4);
    expect(report.updated).toEqual([]);
  });

  it('keeps one entry when two sources report the same model', () => {
    const probed = { ...coder, source: 'local-endpoint' as const, pricing: { inputPerMTok: 0, outputPerMTok: 0 } };
    const { registry, report } = buildCapabilityList([
      { source: 'dsh-config', models: [probed] },
      { source: 'dsh-runtime', models: [{ ...probed, limits: { ...probed.limits, contextWindow: 16_000 } }] },
    ]);
    expect(registry.size()).toBe(1);
    expect(report.updated).toEqual(['local/qwen-coder']);
  });

  it('prefers the more explicit source and reports the disagreement', () => {
    const fromDsh = makeModel({ provider: 'p', name: 'm', limits: { contextWindow: 128_000, maxOutputTokens: 8_192, supportsTools: true, supportsImages: false } });
    const probed = makeModel({
      provider: 'p',
      name: 'm',
      limits: { contextWindow: 8_000, maxOutputTokens: 8_192, supportsTools: true, supportsImages: false },
      pricing: { inputPerMTok: 1, outputPerMTok: 99 },
    });
    const { registry, report } = buildCapabilityList([
      { source: 'local-endpoint', models: [probed] },
      { source: 'manual-import', models: [fromDsh] },
    ]);

    expect(registry.get('p/m')!.model.limits.contextWindow).toBe(128_000);
    expect(registry.get('p/m')!.model.source).toBe('manual-import');
    const fields = report.conflicts.map((c) => c.field).sort();
    expect(fields).toEqual(['contextWindow', 'outputPerMTok']);
    expect(report.conflicts[0]!.kept).toContain('manual-import');
    expect(report.conflicts[0]!.dropped).toContain('local-endpoint');
  });

  it('unions capabilities instead of letting the weaker source win', () => {
    const { registry } = buildCapabilityList([
      { source: 'dsh-config', models: [makeModel({ provider: 'p', name: 'm', capabilities: ['coding'] })] },
      { source: 'local-endpoint', models: [makeModel({ provider: 'p', name: 'm', capabilities: ['vision'] })] },
    ]);
    expect(registry.get('p/m')!.model.capabilities.sort()).toEqual(['coding', 'vision']);
  });

  it('declares a precedence order that puts explicit sources first', () => {
    expect(SOURCE_PRECEDENCE[0]).toBe('manual-import');
    expect(SOURCE_PRECEDENCE.indexOf('dsh-config')).toBeLessThan(
      SOURCE_PRECEDENCE.indexOf('local-endpoint'),
    );
  });

  it('applies availability across merged sources in one pass', () => {
    const { registry } = buildCapabilityList(
      [
        { source: 'dsh-config', models: [bigBrain, coder] },
      ],
      { availableKeys: ['deepseek/reasoner'] },
    );
    expect(registry.get('deepseek/reasoner')!.available).toBe(true);
    expect(registry.get('local/qwen-coder')!.available).toBe(false);
  });

  it('groups by capability across providers, strongest first', () => {
    const registry = new Registry();
    registry.register({ models: allModels });
    expect(registry.byCapability('coding').map((e) => e.key)).toEqual([
      'deepseek/reasoner',
      'local/qwen-coder',
    ]);
  });

  it('picks the baseline from usage when usage exists', () => {
    const registry = new Registry();
    registry.register({ models: allModels });
    const picked = pickBaseline(registry.all(), { 'local/qwen-coder': 12, 'deepseek/reasoner': 3 });
    expect(picked).toEqual({ key: 'local/qwen-coder', isGuess: false });
  });
});
