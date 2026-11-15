import { describe, expect, it } from 'vitest';
import { buildStages, pruneOptional } from '../src/core/planner.js';

describe('buildStages', () => {
  it('turns stage names into ordered, id-ed stages', () => {
    const stages = buildStages({
      taskId: 't1',
  planId: 'plan-test',
      summary: 'build a thing',
      stageNames: ['analyze', 'implement', 'review'],
      estimatedInputTokens: 30_000,
    });
    expect(stages.map((s) => s.id)).toEqual(['stage-1', 'stage-2', 'stage-3']);
    expect(stages.map((s) => s.capability)).toEqual(['reasoning', 'coding', 'reasoning']);
  });

  it('splits input tokens across stages and never drops below 1', () => {
    const stages = buildStages({
      taskId: 't1',
      planId: 'plan-test',
      summary: 'x',
      stageNames: ['analyze', 'implement'],
      estimatedInputTokens: 3,
    });
    expect(stages.every((s) => s.estimatedInputTokens >= 1)).toBe(true);
  });

  it('marks review/summarize optional, implement mandatory', () => {
    const stages = buildStages({
      taskId: 't1',
      planId: 'plan-test',
      summary: 'x',
      stageNames: ['implement', 'review', 'summarize'],
      estimatedInputTokens: 10_000,
    });
    const byName = Object.fromEntries(stages.map((s) => [s.name, s.optional]));
    expect(byName.implement).toBe(false);
    expect(byName.review).toBe(true);
    expect(byName.summarize).toBe(true);
  });

  it('gives unknown stage names a sane fallback preset', () => {
    const [stage] = buildStages({
      taskId: 't1',
      planId: 'plan-test',
      summary: 'x',
      stageNames: ['weird-thing'],
      estimatedInputTokens: 1_000,
    });
    expect(stage!.name).toBe('weird-thing');
    expect(stage!.capability).toBe('reasoning');
    expect(stage!.goal).toContain('weird-thing');
  });

  it('keeps the label the user wrote when it maps to a preset alias', () => {
    // 灰狼 2026-10-26 真机实测：四段里"复核"在卡片上显示成 review，其他段正常。
    // 段名归用户，预设只决定能力/预算；别名命中不等于改名。
    const stages = buildStages({
      taskId: 't1',
      planId: 'plan-test',
      summary: 'x',
      stageNames: ['读取文件', '总结', '复核'],
      estimatedInputTokens: 10_000,
    });
    expect(stages.map((s) => s.name)).toEqual(['读取文件', '总结', '复核']);
    expect(stages.map((s) => s.capability)).toEqual(['reasoning', 'summarizing', 'reasoning']);
  });

  it('rejects an empty stage list', () => {
    expect(() =>
      buildStages({ taskId: 't1',
  planId: 'plan-test', summary: 'x', stageNames: [], estimatedInputTokens: 1 }),
    ).toThrow(/at least one stage/);
  });
});

describe('pruneOptional', () => {
  const stages = buildStages({
    taskId: 't1',
  planId: 'plan-test',
    summary: 'x',
    stageNames: ['analyze', 'implement', 'review'],
    estimatedInputTokens: 30_000,
  });

  it('drops skipped stages', () => {
    expect(pruneOptional(stages, ['stage-3']).map((s) => s.id)).toEqual(['stage-1', 'stage-2']);
  });

  it('never returns an empty plan', () => {
    expect(pruneOptional(stages, ['stage-1', 'stage-2', 'stage-3'])).toHaveLength(1);
  });
});

describe('plan shape', () => {
  it('spreads a multi-stage plan over different models when it can', async () => {
    const { PluginHost } = await import('../src/plugin/index.js');
    const { allModels } = await import('./fixtures/models.js');
    const host = new PluginHost({ current: () => 'deepseek/flash', select: async () => {} });
    host.registerModels(allModels, allModels.map((m) => `${m.provider}/${m.model}`));
    const plan = host.plan({
      taskId: 't1',
      summary: 'x',
      stageNames: ['analyze', 'implement'],
      estimatedInputTokens: 20_000,
    });
    expect(new Set(plan.stages.map((s) => s.modelKey)).size).toBe(2);
  });
});
