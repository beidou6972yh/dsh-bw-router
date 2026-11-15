import { describe, expect, it } from 'vitest';
import { decideContext, readThresholds } from '../src/core/context-guard.js';
import { calibratedUncertainty, emptyCalibration, observeStage } from '../src/core/calibration.js';
import { buildStages } from '../src/core/planner.js';
import { PluginHost } from '../src/plugin/index.js';
import { estimateStage } from '../src/core/budget.js';
import { makeModel } from './fixtures/models.js';

/**
 * A/B 反证：M2 的断言真的会因为"实现被改错"而变红。
 *
 * 每条 `it` 都同时跑两次同一段被测逻辑 —— 一次用真实现，一次用**把关键一步改坏**
 * 的等价实现 —— 并断言两者的结论不同。这就是"测试不得自证"的机器版：如果哪天有人
 * 把判据改回旧行为而断言仍绿，这里会先红。
 */

/** The old behaviour of `decideContext`: anything that fits the window goes. */
const legacyDecide = (contextTokens: number, windowTokens: number): string =>
  contextTokens + 1_000 <= windowTokens ? 'direct' : 'compress';

describe('constraint: a 60% context must not be treated as "fits directly"', () => {
  it('real implementation says summary, the old rule says direct', () => {
    const real = decideContext({ contextTokens: 60_000, windowTokens: 100_000 }).action;
    const legacy = legacyDecide(60_000, 100_000);
    expect(real).toBe('summary');
    expect(legacy).toBe('direct');
    // The assertion that matters: the two disagree, so a regression to the old
    // rule cannot pass this file.
    expect(real).not.toBe(legacy);
  });
});

describe('constraint: the band must react to a real miss', () => {
  it('a 4× bill widens the band; a frozen 0.35 could not', () => {
    const model = makeModel({ provider: 'p', name: 'm' });
    const estimate = estimateStage({
      model,
      baseline: model,
      inputTokens: 10_000,
      outputTokens: 1_000,
      uncertainty: 0.35,
    });
    const state = emptyCalibration();
    observeStage(state, {
      stageId: 'stage-1',
      actualInputTokens: 40_000,
      actualOutputTokens: 4_000,
      actualCost: (estimate.cost ?? 0) * 4,
      estimate,
    });
    const calibrated = calibratedUncertainty(state, 0.35);
    expect(calibrated).toBeGreaterThan(0.35);
    // The calibration would fail silently if the samples were never recorded.
    expect(state.tokenSamples.length + state.costSamples.length).toBeGreaterThan(0);
  });
});

describe('constraint: B-2 shares must close, and the old presets did not', () => {
  it('the raw preset weights sum above 1 while the produced stages sum to the budget', () => {
    const rawPresets = [0.1, 0.15, 0.6, 0.1, 0.3, 0.05]; // analyze…summarize
    const rawSum = rawPresets.reduce((a, b) => a + b, 0);
    expect(rawSum).toBeGreaterThan(1);
    const stages = buildStages({
      taskId: 'ab',
      planId: 'p',
      summary: 'ab',
      stageNames: ['analyze', 'design', 'implement', 'review', 'write', 'summarize'],
      estimatedInputTokens: 40_000,
      estimatedOutputTokens: 10_000,
    });
    const produced = stages.reduce((acc, s) => acc + s.estimatedOutputTokens, 0);
    expect(produced).toBe(10_000);
    expect(produced).not.toBe(Math.round(10_000 * rawSum));
  });
});

describe('constraint: no global-default write-back on the failure path means no event', () => {
  it('the event count follows the platform, so it can be zero as well as one', async () => {
    const build = (wroteBack: boolean) => {
      const h = new PluginHost({
        current: () => 'deepseek/flash',
        select: async () => {
          throw new Error('refused');
        },
        globalDefault: () => 'deepseek/reasoner',
        primeGlobalDefault: () => 'deepseek/reasoner',
        selectGuarded: async () =>
          wroteBack
            ? { wroteBackGlobalDefault: true as const, from: 'a', to: 'b', error: 'refused' }
            : { wroteBackGlobalDefault: false as const, error: 'refused' },
      });
      h.registerModels([makeModel({ provider: 'a', name: 'a' }), makeModel({ provider: 'b', name: 'b' })]);
      return h;
    };

    const withWriteBack = build(true);
    const without = build(false);
    for (const h of [withWriteBack, without]) {
      const plan = h.plan({ taskId: 'ab2', summary: 's', stageNames: ['analyze'], estimatedInputTokens: 1_000 });
      h.approvePlan(plan);
      await h.switchForStage('stage-1', 'b/b', 500, 100, [], plan.planId);
    }
    expect(withWriteBack.ledger.all().filter((e) => e.type === 'global-default-writeback')).toHaveLength(1);
    // A blanket "always record it" implementation would make this 2 and fail.
    expect(without.ledger.all().filter((e) => e.type === 'global-default-writeback')).toHaveLength(0);
  });
});

describe('constraint: thresholds are read, not assumed', () => {
  it('a config that lowers the comfortable line changes the branch', () => {
    // 30% is inside the strict summary band but well above the default 50% line,
    // so the two configurations must disagree on it.
    const strict = readThresholds({ directShare: 0.2, summaryShare: 0.25, refuseShare: 0.1 }).thresholds;
    const loose = decideContext({ contextTokens: 40_000, windowTokens: 100_000 }).action;
    const tight = decideContext({ contextTokens: 40_000, windowTokens: 100_000, thresholds: strict }).action;
    expect(loose).toBe('direct');
    expect(tight).toBe('compress');
    expect(loose).not.toBe(tight);
  });
});
