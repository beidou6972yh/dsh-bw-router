import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverDshModels, type DshConfigPaths } from '../src/adapters/dsh-config.js';
import { discoverFromDshConfig } from '../src/adapters/dsh-discovery.js';
import { estimateStage } from '../src/core/budget.js';
import { guardSwitch } from '../src/core/guard.js';
import { buildCapabilityList } from '../src/core/registry.js';
import { PluginHost } from '../src/plugin/index.js';

/**
 * F1 / B3 end to end.
 *
 * The core learned "unknown price is not zero" in M0-1FIX, but the only
 * producer of `ModelEntry` — the DSH discovery adapter — kept writing `0` and a
 * fake 32k window. The new gates were therefore unreachable on real data: every
 * test built `pricing: null` by hand and none went through discovery.
 *
 * These tests start at a config file on disk and never hand-build a model.
 */

const CONFIG = {
  providers: [
    {
      id: 'cloud',
      name: 'Cloud',
      models: [
        // Priced model: config states everything.
        {
          id: 'known',
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          inputPerMTok: 2,
          outputPerMTok: 8,
          capabilities: ['coding'],
        },
        // The defect: a real provider entry with no price and no window.
        { id: 'mystery', capabilities: ['coding'] },
        // A local model: zero is a real, stated price.
        {
          id: 'local-free',
          contextWindow: 32_000,
          maxOutputTokens: 4_096,
          inputPerMTok: 0,
          outputPerMTok: 0,
          capabilities: ['coding'],
        },
      ],
    },
  ],
};

let home: string;
let paths: DshConfigPaths;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-router-f1-'));
  await writeFile(join(home, 'config.json'), JSON.stringify(CONFIG, null, 2), 'utf8');
  paths = { candidates: [join(home, 'config.json')] };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function entryFor(key: string) {
  const discovered = await discoverDshModels({ paths });
  const model = discovered.models.find((m) => m.id === key)!;
  return model;
}

describe('F1: discovery emits unknown, not zero (adapters -> core)', () => {
  it('a provider entry with no price becomes null, not 0', async () => {
    const mystery = await entryFor('cloud/mystery');
    expect(mystery.pricing).toEqual({ inputPerMTok: null, outputPerMTok: null });
  });

  it('an explicitly priced model keeps its price', async () => {
    const known = await entryFor('cloud/known');
    expect(known.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 8 });
    expect(known.limitsGuessed).toBeUndefined();
  });

  it('an explicitly free model stays free — zero is a real price', async () => {
    const free = await entryFor('cloud/local-free');
    expect(free.pricing).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
  });

  it('a model with no window is flagged limitsGuessed instead of silently 32k', async () => {
    const mystery = await entryFor('cloud/mystery');
    expect(mystery.limitsGuessed).toBe(true);
    expect(mystery.limits.contextWindow).toBe(32_000); // placeholder, but labelled
  });

  it('a half-known model (window but no max output) is flagged too', () => {
    const { models } = discoverFromDshConfig([
      { id: 'p', name: 'P', models: [{ id: 'm', contextWindow: 64_000, inputPerMTok: 1, outputPerMTok: 1 }] },
    ]);
    expect(models[0]!.limitsGuessed).toBe(true);
    expect(models[0]!.pricing).toEqual({ inputPerMTok: 1, outputPerMTok: 1 });
  });

  it('rejects nonsense numbers instead of trusting them', () => {
    const { models } = discoverFromDshConfig([
      {
        id: 'p',
        name: 'P',
        models: [
          {
            id: 'm',
            contextWindow: 0,
            maxOutputTokens: -1,
            inputPerMTok: Number.NaN,
            outputPerMTok: -5,
          },
        ],
      },
    ]);
    expect(models[0]!.limitsGuessed).toBe(true);
    expect(models[0]!.pricing).toEqual({ inputPerMTok: null, outputPerMTok: null });
  });
});

describe('F1: the core gates now fire on real discovery output', () => {
  it('an unpriced discovered model is refused by the switch guard', async () => {
    const model = await entryFor('cloud/mystery');
    const verdict = guardSwitch({
      target: model,
      contextTokens: 1_000,
      expectedOutputTokens: 500,
      requiredCapabilities: ['coding'],
    });
    // Window is unconfirmed too; either way it must not say yes.
    expect(verdict.allowed).toBe(false);
    expect(['price-unknown', 'limits-unconfirmed']).toContain(verdict.code);
  });

  it('a priced, windowed discovered model passes the same guard', async () => {
    const model = await entryFor('cloud/known');
    const verdict = guardSwitch({
      target: model,
      contextTokens: 1_000,
      expectedOutputTokens: 500,
      requiredCapabilities: ['coding'],
    });
    expect(verdict).toMatchObject({ code: 'ok', allowed: true });
  });

  it('the price gate alone fires when only the price is missing', () => {
    const { models } = discoverFromDshConfig([
      { id: 'p', name: 'P', models: [{ id: 'm', contextWindow: 128_000, maxOutputTokens: 8_192 }] },
    ]);
    expect(models[0]!.limitsGuessed).toBeUndefined();
    expect(guardSwitch({ target: models[0]!, contextTokens: 10, expectedOutputTokens: 10 }).code).toBe(
      'price-unknown',
    );
  });

  it('plan money says "price unknown", never "save 100%"', async () => {
    const discovered = await discoverDshModels({ paths });
    const host = new PluginHost({ current: () => 'cloud/known', select: async () => undefined });
    host.registerFromSources([{ source: 'dsh-config', models: discovered.models }]);

    const plan = host.plan({
      taskId: 'f1',
      summary: 'cost a real config',
      stageNames: ['implement'],
      estimatedInputTokens: 10_000,
      usage: { 'cloud/mystery': 99 },
    });
    const { line, total } = host.planTotals(plan);
    expect(line).toContain('price unknown');
    expect(line).not.toContain('save 100%');
    // The priced stages still add up; the plan flags which model it could not price.
    expect(total.unknownPricing).toContain('cloud/mystery');
    expect(total.unknownPricing).not.toContain('cloud/known');
    expect(plan.stages.every((s) => s.estimate.cost !== null)).toBe(true);
  });

  it('a free model is still allowed to claim a full saving (it really is free)', async () => {
    const discovered = await discoverDshModels({ paths });
    const free = discovered.models.find((m) => m.id === 'cloud/local-free')!;
    const known = discovered.models.find((m) => m.id === 'cloud/known')!;
    const estimate = estimateStage({ model: free, baseline: known, inputTokens: 1_000, outputTokens: 1_000 });
    expect(estimate.cost).toBe(0);
    expect(estimate.savings).toBe(0.01);
    expect(estimate.unknownPricing).toBeUndefined();
  });

  it('the registry keeps the unknown price through the merge', async () => {
    const discovered = await discoverDshModels({ paths });
    const { registry } = buildCapabilityList([{ source: 'dsh-config', models: discovered.models }]);
    expect(registry.get('cloud/mystery')!.model.pricing.outputPerMTok).toBeNull();
  });
});
