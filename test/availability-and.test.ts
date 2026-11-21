import { describe, expect, it } from 'vitest';
import { Registry, buildCapabilityList } from '../src/core/registry.js';
import { availableAnd } from '../src/core/types.js';
import { PluginHost } from '../src/plugin/index.js';
import { allModels, bigBrain, coder } from './fixtures/models.js';

/**
 * F4: availability is an AND, never a reset.
 *
 * M0-1FIX's `registerFromSources` computed "big/brain is dead" and then dropped
 * the signal on the way into the registry, so the plugin believed everything was
 * alive (N-1). A merge must never revive an endpoint a probe buried.
 */

const host = () =>
  new PluginHost({ current: () => 'deepseek/flash', select: async () => undefined });

describe('F4: availableAnd is an AND where unknown is not true', () => {
  it('is only true when both sides say yes', () => {
    expect(availableAnd(true, true)).toBe(true);
    expect(availableAnd(true, false)).toBe(false);
    expect(availableAnd(false, true)).toBe(false);
    expect(availableAnd(false, false)).toBe(false);
  });

  it('treats an unknown side as "not confirmed"', () => {
    expect(availableAnd(undefined, true)).toBe(false);
    expect(availableAnd(true, undefined)).toBe(false);
    expect(availableAnd(undefined, undefined)).toBe(false);
  });
});

describe('F4: a probe verdict survives the merge into the plugin', () => {
  it('keeps a model the probe marked dead dead', () => {
    const h = host();
    const { entries } = h.registerFromSources(
      [{ source: 'dsh-config', models: [bigBrain, coder] }],
      ['local/qwen-coder'],
    );
    // Order follows the source batch; what matters is the verdict per key.
    const verdicts = Object.fromEntries(entries.map((e) => [e.key, e.available]));
    expect(verdicts).toEqual({ 'deepseek/reasoner': false, 'local/qwen-coder': true });
    expect(h.registry.get('deepseek/reasoner')!.available).toBe(false);
  });

  it('an entry the merge itself judged dead stays dead even with no key list', () => {
    const h = host();
    h.registerFromSources([{ source: 'dsh-config', models: [bigBrain] }], []);
    expect(h.registry.get('deepseek/reasoner')!.available).toBe(false);
  });

  it('a later merge without an availability signal cannot revive a dead endpoint', () => {
    const h = host();
    h.registerFromSources([{ source: 'dsh-config', models: [bigBrain] }], []);
    expect(h.registry.get('deepseek/reasoner')!.available).toBe(false);

    // The re-registration that used to wash the verdict away (N-1).
    h.registerFromSources([{ source: 'dsh-runtime', models: [bigBrain] }]);
    expect(h.registry.get('deepseek/reasoner')!.available).toBe(false);
  });

  it('a merge with a good key list can restore a model that really came back', () => {
    const h = host();
    h.registerFromSources([{ source: 'dsh-config', models: [bigBrain] }], []);
    expect(h.registry.get('deepseek/reasoner')!.available).toBe(false);

    h.registerFromSources([{ source: 'dsh-config', models: [bigBrain] }], ['deepseek/reasoner']);
    expect(h.registry.get('deepseek/reasoner')!.available).toBe(true);
  });

  it('registry.register with no availableKeys leaves a known-dead entry dead', () => {
    const registry = new Registry();
    registry.register({ models: [bigBrain], availableKeys: [] });
    expect(registry.get('deepseek/reasoner')!.available).toBe(false);
    registry.register({ models: [bigBrain] });
    expect(registry.get('deepseek/reasoner')!.available).toBe(false);
  });

  it('a first registration with no signal is optimistic, like a fresh install', () => {
    const registry = new Registry();
    registry.register({ models: [bigBrain] });
    expect(registry.get('deepseek/reasoner')!.available).toBe(true);
  });

  it('buildCapabilityList keeps the per-entry verdict', () => {
    const { registry } = buildCapabilityList(
      [{ source: 'dsh-config', models: [bigBrain, coder] }],
      { availableKeys: ['local/qwen-coder'] },
    );
    expect(registry.get('deepseek/reasoner')!.available).toBe(false);
    expect(registry.get('local/qwen-coder')!.available).toBe(true);
  });

  it('planning never routes a stage onto a dead model after a merge', () => {
    const h = host();
    // Only one model survives the probe; the baseline statistic still points at
    // a dead model, and the plan must not care.
    h.registerFromSources([{ source: 'dsh-config', models: allModels }], ['local/qwen-coder']);
    expect(h.registry.all().filter((e) => e.available).map((e) => e.key)).toEqual(['local/qwen-coder']);

    const plan = h.plan({
      taskId: 'f4',
      summary: 'route with one live model',
      stageNames: ['implement'],
      estimatedInputTokens: 2_000,
    });
    expect(plan.stages[0]!.modelKey).toBe('local/qwen-coder');
  });

  it('notes and availability both survive the trip', () => {
    const h = host();
    h.registerFromSources(
      [{ source: 'dsh-config', models: [{ ...bigBrain, source: 'dsh-config' }] }],
      [],
    );
    const entry = h.registry.get('deepseek/reasoner')!;
    expect(entry.available).toBe(false);
    expect(entry.model.capabilities).toContain('coding');
  });
});
