import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USAGE_DAYS,
  collectUsage,
  describeUsage,
  inferBaseline,
  toCallRecord,
  usageCounts,
  type SessionCallRecord,
} from '../src/core/usage-stats.js';
import { Registry } from '../src/core/registry.js';
import { allModels } from './fixtures/models.js';

const NOW = '2026-10-22T12:00:00.000Z';

/** Builds a log with `calls` entries for one model, `daysAgo` back. */
function calls(provider: string, model: string, count: number, daysAgo = 1): SessionCallRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    at: new Date(Date.parse(NOW) - daysAgo * 86_400_000 - i * 1000).toISOString(),
    provider,
    model,
  }));
}

describe('usage stats: most-used model', () => {
  it('ranks by call count and reports share', () => {
    const summary = collectUsage(
      [...calls('deepseek', 'reasoner', 6), ...calls('local', 'qwen-coder', 3), ...calls('deepseek', 'flash', 1)],
      { now: NOW },
    );

    expect(summary.totalCalls).toBe(10);
    expect(summary.rows.map((r) => r.key)).toEqual([
      'deepseek/reasoner',
      'local/qwen-coder',
      'deepseek/flash',
    ]);
    expect(summary.rows[0]!.calls).toBe(6);
    expect(summary.rows[0]!.share).toBeCloseTo(0.6, 5);
    expect(summary.rows[2]!.share).toBeCloseTo(0.1, 5);
    expect(summary.topKey).toBe('deepseek/reasoner');
    expect(summary.topShare).toBeCloseTo(0.6, 5);
  });

  it('breaks ties by key so output is stable', () => {
    const summary = collectUsage(
      [...calls('b', 'm', 2), ...calls('a', 'm', 2)],
      { now: NOW },
    );
    expect(summary.rows.map((r) => r.key)).toEqual(['a/m', 'b/m']);
  });

  it('drops records outside the window and counts them', () => {
    const summary = collectUsage(
      [...calls('deepseek', 'reasoner', 4, 2), ...calls('deepseek', 'reasoner', 9, 45)],
      { now: NOW, days: 7 },
    );
    expect(summary.totalCalls).toBe(4);
    expect(summary.skipped).toBe(9);
    expect(summary.windowDays).toBe(7);
  });

  it('ignores unparseable timestamps instead of guessing', () => {
    const summary = collectUsage(
      [{ at: 'not-a-date', provider: 'x', model: 'y' }, ...calls('x', 'y', 1)],
      { now: NOW },
    );
    expect(summary.totalCalls).toBe(1);
  });

  it('handles an empty log without throwing', () => {
    const summary = collectUsage([], { now: NOW });
    expect(summary.totalCalls).toBe(0);
    expect(summary.rows).toEqual([]);
    expect(summary.topKey).toBeUndefined();
    expect(summary.windowDays).toBe(DEFAULT_USAGE_DAYS);
  });

  it('returns a usage map the baseline picker accepts', () => {
    const summary = collectUsage([...calls('deepseek', 'reasoner', 2), ...calls('local', 'qwen-coder', 5)], { now: NOW });
    expect(usageCounts(summary)).toEqual({ 'local/qwen-coder': 5, 'deepseek/reasoner': 2 });
  });
});

describe('usage stats: privacy boundary', () => {
  it('projection keeps only at/provider/model', () => {
    const projected = toCallRecord({
      at: NOW,
      provider: 'p',
      model: 'm',
      // @ts-expect-error extra fields must not survive the projection
      content: 'user secret prompt',
    });
    expect(Object.keys(projected).sort()).toEqual(['at', 'model', 'provider']);
    expect(JSON.stringify(projected)).not.toContain('secret');
  });
});

describe('usage stats: baseline inference', () => {
  const registry = new Registry();
  registry.register({ models: allModels });

  it('infers the top model when the registry knows it', () => {
    const summary = collectUsage([...calls('local', 'qwen-coder', 7), ...calls('deepseek', 'reasoner', 1)], { now: NOW });
    const inferred = inferBaseline(summary, registry.all());
    expect(inferred?.key).toBe('local/qwen-coder');
    expect(inferred?.share).toBeCloseTo(7 / 8, 5);
  });

  it('returns undefined when usage points only at unknown models', () => {
    const summary = collectUsage(calls('ghost', 'model', 3), { now: NOW });
    expect(inferBaseline(summary, registry.all())).toBeUndefined();
  });

  it('describes usage in one short line', () => {
    const summary = collectUsage([...calls('deepseek', 'reasoner', 3), ...calls('local', 'qwen-coder', 1)], { now: NOW });
    const line = describeUsage(summary);
    expect(line).toContain('4 次调用');
    expect(line).toContain('deepseek/reasoner 75%');
  });
});
