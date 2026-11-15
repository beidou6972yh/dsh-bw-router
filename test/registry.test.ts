import { describe, expect, it } from 'vitest';
import { pickBaseline, Registry } from '../src/core/registry.js';
import { allModels, bigBrain, coder, makeModel } from './fixtures/models.js';

describe('Registry', () => {
  const build = () => {
    const registry = new Registry();
    registry.register({ models: allModels });
    return registry;
  };

  it('holds 4 providers and 5 models after a second source is registered', () => {
    // C-2: the name said "3 providers / 5 models" while the fixture is four
    // models over three providers, plus one added here = 4 / 5. The assertion was
    // right and the title was wrong, which is how a suite teaches the wrong fact.
    const registry = build(); // deepseek, local, cloud (4 models)
    expect(registry.byProvider().size).toBe(3);
    expect(registry.size()).toBe(4);
    registry.register({
      models: [
        {
          ...bigBrain,
          id: 'third/alpha',
          provider: 'third',
          model: 'alpha',
          capabilities: ['reasoning'],
        },
      ],
    });
    expect(registry.byProvider().size).toBe(4);
    expect(registry.size()).toBe(5);
  });

  it('filters by capability, strongest first', () => {
    const registry = build();
    const coding = registry.byCapability('coding');
    expect(coding.map((e) => e.key)).toEqual(['deepseek/reasoner', 'local/qwen-coder']);
    expect(coding[0]!.model.strength).toBeGreaterThan(coding[1]!.model.strength);
  });

  it('cheapestFor returns the local zero-cost coder for coding only', () => {
    const registry = build();
    expect(registry.cheapestFor(['coding'])?.key).toBe('local/qwen-coder');
  });

  it('cheapestFor returns undefined when nothing covers every capability', () => {
    const registry = build();
    expect(registry.cheapestFor(['coding', 'image-generation'])).toBeUndefined();
  });

  it('re-registering a key replaces the entry instead of duplicating', () => {
    const registry = new Registry();
    registry.register({ models: [coder] });
    registry.register({ models: [{ ...coder, pricing: { inputPerMTok: 1, outputPerMTok: 1 } }] });
    expect(registry.size()).toBe(1);
    expect(registry.get('local/qwen-coder')!.model.pricing.outputPerMTok).toBe(1);
  });

  it('markAvailability ignores unknown keys and keeps notes', () => {
    const registry = build();
    registry.markAvailability('nope/nothing', false, 'should not appear');
    expect(registry.size()).toBe(4);
    registry.markAvailability('local/qwen-coder', false, 'port closed');
    const entry = registry.get('local/qwen-coder')!;
    expect(entry.available).toBe(false);
    expect(entry.notes).toContain('port closed');
  });

  it('availableKeys marks everything else unavailable', () => {
    const registry = new Registry();
    registry.register({ models: allModels, availableKeys: ['deepseek/reasoner'] });
    expect(registry.get('deepseek/reasoner')!.available).toBe(true);
    expect(registry.all().filter((e) => !e.available)).toHaveLength(3);
  });
});

describe('pickBaseline', () => {
  const registry = (() => {
    const r = new Registry();
    r.register({ models: allModels });
    return r;
  })();

  it('prefers the most-used model and says it is not a guess', () => {
    expect(
      pickBaseline(registry.all(), { 'deepseek/flash': 40, 'deepseek/reasoner': 5 }),
    ).toEqual({ key: 'deepseek/flash', isGuess: false });
  });

  it('falls back to the priciest available model, flagged as a guess', () => {
    expect(pickBaseline(registry.all(), {})).toEqual({
      key: 'cloud/diffusion-xl',
      isGuess: true,
    });
  });

  it('never guesses an unpriced model as baseline', () => {
    const r = new Registry();
    r.register({
      models: [
        makeModel({ provider: 'cloud', name: 'mystery', pricing: { inputPerMTok: null, outputPerMTok: null } }),
      ],
    });
    expect(pickBaseline(r.all(), {})).toEqual({ key: undefined, isGuess: false });
  });

  it('returns no key only when the registry is empty', () => {
    expect(pickBaseline([], {})).toEqual({ key: undefined, isGuess: false });
  });
});
