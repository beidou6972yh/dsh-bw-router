import { describe, expect, it } from 'vitest';
import { buildWizardDraft, groupByProvider, isReady } from '../src/core/wizard-draft.js';
import { Registry, buildCapabilityList } from '../src/core/registry.js';
import { collectUsage, type SessionCallRecord } from '../src/core/usage-stats.js';
import { PluginHost } from '../src/plugin/index.js';
import { allModels, bigBrain, cheapFast, coder, makeModel } from './fixtures/models.js';

const NOW = '2026-10-22T12:00:00.000Z';

function log(entries: [string, string, number][]): SessionCallRecord[] {
  return entries.flatMap(([provider, model, count]) =>
    Array.from({ length: count }, (_, i) => ({
      at: new Date(Date.parse(NOW) - 3_600_000 * (i + 1)).toISOString(),
      provider,
      model,
    })),
  );
}

describe('wizard draft (data only)', () => {
  it('groups 3 providers and summarizes sources', () => {
    const { registry } = buildCapabilityList([
      { source: 'dsh-config', models: [bigBrain, cheapFast] },
      { source: 'local-endpoint', models: [coder] },
      { source: 'dsh-runtime', models: [allModels[3]!] },
    ]);
    const draft = buildWizardDraft({ entries: registry.all() });

    expect(draft.totalModels).toBe(4);
    expect(draft.groups.map((g) => g.provider)).toEqual(['deepseek', 'cloud', 'local']);
    expect(draft.groups[0]!.count).toBe(2);
    expect(draft.sources).toEqual(['dsh-config', 'dsh-runtime', 'local-endpoint']);
  });

  it('uses usage to guess the baseline and stays quiet when it is dominant', () => {
    const registry = new Registry();
    registry.register({ models: allModels });
    const usage = collectUsage(log([['deepseek', 'reasoner', 18], ['local', 'qwen-coder', 2]]), { now: NOW });

    const draft = buildWizardDraft({ entries: registry.all(), usage });
    expect(draft.baselineKey).toBe('deepseek/reasoner');
    expect(draft.baselineBasis).toBe('usage');
    expect(draft.questions.some((q) => q.kind === 'confirm-baseline')).toBe(false);
    expect(draft.usage.totalCalls).toBe(20);
  });

  it('asks when usage is split across models', () => {
    const registry = new Registry();
    registry.register({ models: allModels });
    const usage = collectUsage(log([['deepseek', 'reasoner', 5], ['local', 'qwen-coder', 5]]), { now: NOW });

    const draft = buildWizardDraft({ entries: registry.all(), usage });
    expect(draft.questions.some((q) => q.kind === 'confirm-baseline')).toBe(true);
  });

  it('falls back to the priciest model and says so when there is no history', () => {
    const registry = new Registry();
    registry.register({ models: allModels });
    const draft = buildWizardDraft({ entries: registry.all() });

    expect(draft.baselineBasis).toBe('price-fallback');
    expect(draft.baselineKey).toBe('cloud/diffusion-xl');
    expect(draft.usage.line).toContain('没有会话记录');
    expect(draft.questions.some((q) => q.kind === 'confirm-baseline')).toBe(true);
  });

  it('flags unpriced models and dead endpoints as questions, not failures', () => {
    const registry = new Registry();
    registry.register({
      models: [
        ...allModels,
        makeModel({
          provider: 'cloud',
          name: 'mystery',
          pricing: { inputPerMTok: null, outputPerMTok: null },
        }),
      ],
    });
    const draft = buildWizardDraft({
      entries: registry.all(),
      deadEndpoints: ['ollama'],
    });
    expect(draft.questions.some((q) => q.kind === 'price-unknown')).toBe(true);
    expect(draft.questions.find((q) => q.kind === 'confirm-endpoint')!.title).toContain('ollama');
  });

  it('asks for models when nothing was discovered', () => {
    const draft = buildWizardDraft({ entries: [] });
    expect(draft.totalModels).toBe(0);
    expect(draft.baselineKey).toBeUndefined();
    expect(draft.baselineBasis).toBe('none');
    expect(draft.questions.map((q) => q.kind)).toEqual(['missing-models']);
    expect(isReady(draft)).toBe(false);
  });

  it('is ready when models exist and no question is pending', () => {
    const registry = new Registry();
    // Priced models only: unpriced ones legitimately raise a price question.
    registry.register({ models: [bigBrain, cheapFast] });
    const usage = collectUsage(log([['deepseek', 'reasoner', 20]]), { now: NOW });
    const draft = buildWizardDraft({ entries: registry.all(), usage });
    expect(isReady(draft)).toBe(true);
  });

  it('surfaces merge conflicts once, not per model', () => {
    const { registry, report } = buildCapabilityList([
      { source: 'dsh-config', models: [bigBrain] },
      {
        source: 'local-endpoint',
        models: [{ ...bigBrain, limits: { ...bigBrain.limits, contextWindow: 1_000 } }],
      },
    ]);
    const draft = buildWizardDraft({ entries: registry.all(), mergeReport: report });
    expect(draft.conflicts).toHaveLength(1);
    expect(draft.conflicts[0]!.field).toBe('contextWindow');
  });

  it('groupByProvider marks reachability per provider', () => {
    const { registry } = buildCapabilityList(
      [{ source: 'dsh-config', models: [bigBrain, coder] }],
      { availableKeys: ['local/qwen-coder'] },
    );
    const groups = groupByProvider(registry.all());
    expect(groups.find((g) => g.provider === 'local')!.reachable).toBe(true);
    expect(groups.find((g) => g.provider === 'deepseek')!.reachable).toBe(false);
  });
});

describe('PluginHost wiring for M1-1', () => {
  const host = () =>
    new PluginHost({
      current: () => 'deepseek/flash',
      select: async () => undefined,
    });

  it('registers several sources at once and reports conflicts', () => {
    const h = host();
    const { entries, conflicts } = h.registerFromSources([
      { source: 'dsh-config', models: [bigBrain, cheapFast] },
      { source: 'local-endpoint', models: [coder] },
    ]);
    expect(entries).toHaveLength(3);
    expect(conflicts).toBe(0);
    expect(h.registry.size()).toBe(3);
  });

  it('builds a wizard draft from the registry plus a log', () => {
    const h = host();
    h.registerFromSources([{ source: 'dsh-config', models: allModels }]);
    const draft = h.wizardDraft({ logs: log([['local', 'qwen-coder', 9]]), days: 30 });
    expect(draft.baselineKey).toBe('local/qwen-coder');
    expect(draft.totalModels).toBe(4);
  });

  it('feeds usage counts straight into plan() without re-parsing', () => {
    const h = host();
    h.registerFromSources([{ source: 'dsh-config', models: allModels }]);
    const counts = h.usageCountsFrom(log([['deepseek', 'flash', 4]]));
    const plan = h.plan({
      taskId: 't1',
      summary: 'ship it',
      stageNames: ['analyze', 'implement'],
      estimatedInputTokens: 2_000,
      usage: counts,
    });
    expect(plan.baselineModelKey).toBe('deepseek/flash');
    expect(plan.stages).toHaveLength(2);
  });
});
