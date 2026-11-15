import { describe, expect, it } from 'vitest';
import { decideModel } from '../src/core/decider.js';
import { Registry } from '../src/core/registry.js';
import type { Stage } from '../src/core/types.js';
import { allModels, painter } from './fixtures/models.js';

const stage = (over: Partial<Stage> = {}): Stage => ({
  id: 'stage-1',
  name: 'implement',
  goal: 'write the code',
  capability: 'coding',
  estimatedInputTokens: 10_000,
  estimatedOutputTokens: 4_000,
  optional: false,
  ...over,
});

const registry = (() => {
  const r = new Registry();
  r.register({ models: allModels });
  return r;
})();

describe('decideModel', () => {
  it('picks the coding model for a coding stage', () => {
    const decision = decideModel(stage(), registry.all());
    expect(decision.modelKey).toBe('deepseek/reasoner');
    expect(decision.reason).toContain('coding');
  });

  it('picks the image model for an image-generation stage', () => {
    const decision = decideModel(stage({ capability: 'image-generation' }), registry.all());
    expect(decision.modelKey).toBe('cloud/diffusion-xl');
  });

  it('prefers the cheap model for a summarizing stage', () => {
    const decision = decideModel(stage({ capability: 'summarizing' }), registry.all());
    expect(decision.modelKey).toBe('deepseek/flash');
  });

  it('honours a pinned model for the capability', () => {
    const decision = decideModel(stage(), registry.all(), {
      pinned: { coding: 'local/qwen-coder' },
    });
    expect(decision.modelKey).toBe('local/qwen-coder');
    expect(decision.reason).toMatch(/pinned/);
  });

  it('ignores an unavailable model', () => {
    const entries = registry.all().map((e) =>
      e.key === 'deepseek/reasoner' ? { ...e, available: false } : e,
    );
    const decision = decideModel(stage(), entries);
    expect(decision.modelKey).toBe('local/qwen-coder');
  });

  it('ignores excluded models', () => {
    const decision = decideModel(stage(), registry.all(), { exclude: ['deepseek/reasoner'] });
    expect(decision.modelKey).toBe('local/qwen-coder');
  });

  it('throws when nothing can serve the capability', () => {
    expect(() =>
      decideModel(stage({ capability: 'vision' }), registry.all(), {
        exclude: ['cloud/diffusion-xl'],
      }),
    ).toThrow(/no available model/);
  });

  it('explains the window usage in the reason string', () => {
    const decision = decideModel(stage({ capability: 'image-generation' }), [painter].map((m) => ({
      key: `${m.provider}/${m.model}`,
      model: m,
      available: true,
      notes: [],
    })));
    expect(decision.reason).toContain('k of');
  });
});

describe('decideModel stage spreading', () => {
  it('avoids reusing a model already settled by a sibling stage', () => {
    const first = decideModel(stage(), registry.all());
    const second = decideModel(stage({ id: 'stage-2' }), registry.all(), {
      settle: [first.modelKey],
    });
    expect(first.modelKey).toBe('deepseek/reasoner');
    expect(second.modelKey).toBe('local/qwen-coder');
  });

  it('demotes a model that barely swallows the stage', () => {
    const tight = stage({ capability: 'coding', estimatedInputTokens: 30_000, estimatedOutputTokens: 4_000 });
    expect(decideModel(tight, registry.all()).modelKey).toBe('deepseek/reasoner');
  });
});

describe('pinned models still pass the gates (A-7)', () => {
  it('does not pick a pinned model that failed the health probe', () => {
    const entries = registry.all().map((e) =>
      e.key === 'local/qwen-coder' ? { ...e, available: false } : e,
    );
    const decision = decideModel(stage(), entries, { pinned: { coding: 'local/qwen-coder' } });
    expect(decision.modelKey).toBe('deepseek/reasoner');
    expect(decision.basis).toBe('pinned-overridden');
    expect(decision.reason).toContain('pinned');
    expect(decision.reason).toContain('unavailable');
  });

  it('does not pick a pinned model that is explicitly excluded', () => {
    const decision = decideModel(stage(), registry.all(), {
      pinned: { coding: 'local/qwen-coder' },
      exclude: ['local/qwen-coder'],
    });
    expect(decision.modelKey).toBe('deepseek/reasoner');
    expect(decision.reason).toContain('excluded');
  });

  it('does not pick a pinned model lacking the stage capability', () => {
    const decision = decideModel(stage(), registry.all(), {
      pinned: { coding: 'cloud/diffusion-xl' },
    });
    expect(decision.modelKey).toBe('deepseek/reasoner');
    expect(decision.reason).toContain('does not do coding');
  });

  it('a usable pin still wins outright', () => {
    const decision = decideModel(stage(), registry.all(), {
      pinned: { coding: 'deepseek/reasoner' },
    });
    expect(decision.modelKey).toBe('deepseek/reasoner');
    expect(decision.basis).toBe('pinned');
  });

  it('flags a pinned model that cannot comfortably hold the stage', () => {
    const tight = stage({ estimatedInputTokens: 30_000, estimatedOutputTokens: 4_000 });
    const decision = decideModel(tight, registry.all(), {
      pinned: { coding: 'local/qwen-coder' },
    });
    expect(decision.modelKey).toBe('local/qwen-coder');
    expect(decision.overflow).toBe(true);
    expect(decision.reason).toContain('TIGHT');
  });

  it('signals an overflowing winner instead of calling it a good fit', () => {
    const huge = stage({ estimatedInputTokens: 200_000, estimatedOutputTokens: 10_000 });
    const decision = decideModel(huge, registry.all());
    expect(decision.overflow).toBe(true);
    expect(decision.reason).toContain('TIGHT');
  });

  it('breaks ties deterministically instead of by array order', () => {
    const a = { ...painter, pricing: { inputPerMTok: 5, outputPerMTok: 5 } };
    const twin = { ...painter, model: 'diffusion-xl-b', id: 'cloud/diffusion-xl-b', label: 'B' };
    const entries = [
      { key: 'cloud/diffusion-xl', model: a, available: true, notes: [] },
      { key: 'cloud/diffusion-xl-b', model: twin, available: true, notes: [] },
    ];
    const forward = decideModel(stage({ capability: 'image-generation' }), entries).modelKey;
    const backward = decideModel(stage({ capability: 'image-generation' }), [...entries].reverse()).modelKey;
    expect(forward).toBe(backward);
    expect(forward).toBe('cloud/diffusion-xl');
  });
});
