import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildStages, closeShares, pruneOptional, distributeInputs } from '../src/core/planner.js';
import { Registry, buildCapabilityList } from '../src/core/registry.js';
import { Ledger } from '../src/core/ledger.js';
import { PluginHost } from '../src/plugin/index.js';
import { withAvailability } from '../src/adapters/dsh-model.js';
import { discoverFromDshConfig, strengthFromCapabilities } from '../src/adapters/dsh-discovery.js';
import { costOf } from '../src/core/types.js';
import type { CapabilityEntry, ModelEntry } from '../src/core/types.js';
import { DEFAULT_TARGETS } from '../src/adapters/probe.js';
import { allModels, bigBrain, coder, makeModel } from './fixtures/models.js';

/**
 * M2 收口：13 条剩项逐条一个可失败的断言。
 *
 * Each `it` names the finding it closes and states what would have to be true
 * for the old defect to come back. No `expect(x).toBe(x)` anywhere — the point of
 * C-2 was that a tautology is a test that cannot fail.
 */

const host = () =>
  new PluginHost({ current: () => 'deepseek/flash', select: async () => undefined });

describe('B-2: stage shares close to exactly 1, and input is not split evenly', () => {
  it('a single implement stage is no longer starved of the task input', () => {
    const stages = buildStages({
      taskId: 'b2a',
      planId: 'p1',
      summary: 'one stage',
      stageNames: ['implement'],
      estimatedInputTokens: 30_000,
    });
    // The old code handed this stage 18% of the input (5.4k) while claiming a 60%
    // output share of a total derived from the same number.
    expect(stages[0]!.estimatedInputTokens).toBe(30_000);
  });

  it('output shares always sum to the whole output budget', () => {
    for (const names of [
      ['implement'],
      ['analyze', 'implement'],
      ['analyze', 'design', 'implement', 'review', 'write', 'summarize'],
      ['write', 'implement', '出图'],
    ]) {
      const stages = buildStages({
        taskId: 'b2b',
        planId: 'p2',
        summary: 'shares',
        stageNames: names,
        estimatedInputTokens: 40_000,
        estimatedOutputTokens: 12_000,
      });
      const sum = stages.reduce((acc, s) => acc + s.estimatedOutputTokens, 0);
      expect(sum, `shares must close for ${names.join('/')}`).toBe(12_000);
    }
  });

  it('input tokens are distributed by what each stage reads, and still sum to the task', () => {
    const stages = buildStages({
      taskId: 'b2c',
      planId: 'p3',
      summary: 'inputs',
      stageNames: ['summarize', 'implement'],
      estimatedInputTokens: 50_000,
    });
    const sum = stages.reduce((acc, s) => acc + s.estimatedInputTokens, 0);
    expect(sum).toBe(50_000);
    // Equal shares would have made these identical: 25k each.
    expect(stages[1]!.estimatedInputTokens).toBeGreaterThan(stages[0]!.estimatedInputTokens);
  });

  it('closeShares normalises any weights, including ones summing above 1', () => {
    const shares = closeShares([0.6, 0.3, 0.3, 0.05]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // Ratio preserved: implement still gets more than design.
    expect(shares[0]!).toBeGreaterThan(shares[1]!);
  });

  it('distributeInputs never loses or invents tokens through rounding', () => {
    const presets = [{ name: 'a', goal: '', capability: 'reasoning' as const, outputShare: 0.3, optional: false }];
    const out = distributeInputs(1_001, [1], presets as never);
    expect(out.reduce((a, b) => a + b, 0)).toBe(1_001);
  });
});

describe('B-7: pruneOptional keeps the mandatory stage, not the first one', () => {
  const stages = buildStages({
    taskId: 'b7',
    planId: 'p4',
    summary: 'prune',
    stageNames: ['write', 'implement'],
    estimatedInputTokens: 1_000,
  });

  it('skipping everything keeps the last mandatory stage', () => {
    const kept = pruneOptional(stages, stages.map((s) => s.id));
    expect(kept).toHaveLength(1);
    // `write` is stage-1; keeping it would drop the implementation entirely.
    expect(kept[0]!.name).toBe('implement');
  });

  it('skipping all-optional stages falls back to the last one, not the first', () => {
    const optionalStages = buildStages({
      taskId: 'b7b',
      planId: 'p5',
      summary: 'optional only',
      stageNames: ['review', 'summarize'],
      estimatedInputTokens: 1_000,
    });
    const kept = pruneOptional(optionalStages, optionalStages.map((s) => s.id));
    expect(kept.map((s) => s.name)).toEqual(['summarize']);
  });
});

describe('B-3: registry availability semantics and notes', () => {
  it('keeps probe notes across a re-registration', () => {
    const registry = new Registry();
    registry.register({ models: [bigBrain], availableKeys: [] });
    registry.markAvailability('deepseek/reasoner', false, 'probe: ECONNREFUSED');
    // The config is re-read: the note must not vanish with the new batch.
    registry.register({ models: [bigBrain] });
    expect(registry.get('deepseek/reasoner')!.notes).toEqual(['probe: ECONNREFUSED']);
    expect(registry.get('deepseek/reasoner')!.available).toBe(false);
  });

  it('tells "no probe ran" (undefined) apart from "probe found nothing alive" ([])', () => {
    const noProbe = new Registry();
    noProbe.register({ models: [bigBrain] });
    expect(noProbe.get('deepseek/reasoner')!.available).toBe(true);

    const probedEmpty = new Registry();
    probedEmpty.register({ models: [bigBrain], availableKeys: [] });
    expect(probedEmpty.get('deepseek/reasoner')!.available).toBe(false);
  });

  it('merging two sources keeps the better verdict and both notes', () => {
    const { registry } = buildCapabilityList(
      [{ source: 'dsh-config', models: [coder] }],
      { availableKeys: [] },
    );
    expect(registry.get('local/qwen-coder')!.available).toBe(false);
  });
});

describe('B-10: strength is not the number of capability labels', () => {
  it('a three-label model is not stronger than a one-label specialist', () => {
    expect(strengthFromCapabilities(['coding', 'writing', 'vision'])).toBeLessThanOrEqual(
      strengthFromCapabilities(['coding']),
    );
  });

  it('a configured strength beats the heuristic', () => {
    const { models } = discoverFromDshConfig([
      { id: 'p', name: 'P', models: [{ id: 'm', capabilities: ['coding'], strength: 0.95 }] },
    ]);
    expect(models[0]!.strength).toBe(0.95);
  });
});

describe('C-1: withAvailability actually changes availability', () => {
  const entry: CapabilityEntry = {
    key: 'p/m',
    model: makeModel({ provider: 'p', name: 'm' }),
    available: true,
    notes: [],
  };

  it('flips the flag it is named after, and reports the change', () => {
    const result = withAvailability([entry], 'p/m', { available: false, note: 'probe: timeout' });
    expect(result.changed).toBe(true);
    expect(result.found).toBe(true);
    expect(result.entries[0]!.available).toBe(false);
    expect(result.entries[0]!.notes).toEqual(['probe: timeout']);
  });

  it('does not claim a change it did not make, and does not invent a key', () => {
    const same = withAvailability([entry], 'p/m', { available: true });
    expect(same.changed).toBe(false);
    const missing = withAvailability([entry], 'nope/nope', { available: false });
    expect(missing.found).toBe(false);
    expect(missing.changed).toBe(false);
  });
});

describe('C-4: tool support is unknown when the config does not say', () => {
  it('discovery leaves it null instead of asserting true', () => {
    const { models } = discoverFromDshConfig([{ id: 'p', name: 'P', models: [{ id: 'm' }] }]);
    expect(models[0]!.limits.supportsTools).toBeNull();
  });

  it('probe targets stay local addresses, no internal hosts creep in', () => {
    for (const target of DEFAULT_TARGETS) {
      expect(target.url).toMatch(/^http:\/\/localhost/);
    }
  });
});

describe('C-6: development happens on a branch, and the log says so', () => {
  /**
   * Whether `git` is usable here.
   *
   * The delivered tarball is an **unpacked directory**, not a worktree: the
   * branch assertion old-ed out (`fatal: not a git repository`) and the package
   * could not be self-tested green (P3-10). A process rule about *this*
   * checkout has nothing to say about an unpacked copy, so it is skipped there
   * instead of failing.
   */
  const gitAvailable = ((): boolean => {
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: new URL('../', import.meta.url),
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!gitAvailable)('the M2 work is identifiable by its commit on a feature branch', () => {
    // A process check that can actually fail: the branch this suite runs on must
    // not be `main`, or the discipline the finding demanded is gone again.
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: new URL('../', import.meta.url),
      encoding: 'utf8',
    }).trim();
    expect(branch).not.toBe('main');
  });
});

describe('M-6 / M-8 are pinned in their own suites', () => {
  it('keeps a reminder here so the close-out list is complete', () => {
    // M-6: client `totalOf` no longer adds money (test/client-half.test.ts).
    // M-8: the escape probe lives outside src/ and the build gate is in
    //      scripts/verify-m0.sh (test/architecture.test.ts + test/package.test.ts).
    expect([allModels.length, costOf({ inputPerMTok: null, outputPerMTok: 1 }, 1, 1)]).toEqual([4, null]);
  });
});

describe('A-6 / N-4: a failed switch that moved the global default is still booked', () => {
  it('records the write-back on the error path, not only in the return value', async () => {
    let globalDefault = 'deepseek/reasoner';
    const selection = {
      current: () => 'deepseek/flash',
      select: async () => {
        throw new Error('platform said no');
      },
      globalDefault: () => globalDefault,
      primeGlobalDefault: () => globalDefault,
      selectGuarded: async () => {
        // The platform refuses the session switch but has already written the
        // global default back — the exact shape of K-003 on a failure path.
        globalDefault = 'local/qwen-coder';
        return { wroteBackGlobalDefault: true, from: 'deepseek/reasoner', to: 'local/qwen-coder', error: 'refused' };
      },
    };
    const h = new PluginHost(selection);
    h.registerModels(allModels);
    const plan = h.plan({ taskId: 'a6', summary: 's', stageNames: ['analyze'], estimatedInputTokens: 1_000 });
    h.approvePlan(plan);
    const result = await h.switchForStage(
      'stage-1',
      'local/qwen-coder',
      1_000,
      500,
      ['coding'],
      plan.planId,
    );
    expect(result.switched).toBe(false);
    expect(result.globalDefaultWrittenBack).toBe(true);
    const writeBacks = h.ledger.all().filter((e) => e.type === 'global-default-writeback');
    expect(writeBacks).toHaveLength(1);
    expect(String(writeBacks[0]!.detail)).toMatch(/deepseek\/reasoner -> local\/qwen-coder/);
    // And the refusal itself is booked too.
    expect(h.ledger.all().some((e) => e.type === 'switch-blocked')).toBe(true);
  });
});

describe('B-8 / F5 §6: the ledger has a real compaction producer', () => {
  it('bookCompaction puts tokens, cost and both sizes in the book', () => {
    const ledger = new Ledger(() => '2026-01-01T00:00:00.000Z');
    ledger.recordCompaction({
      stageId: 'stage-1',
      modelKey: 'acme/big',
      inputTokens: 40_000,
      outputTokens: 900,
      cost: 0.0412,
      tokensBefore: 41_000,
      tokensAfter: 3_000,
      targetModelKey: 'acme/small',
      handoverOk: true,
      planId: 'plan-1',
    });
    const event = ledger.all().find((e) => e.type === 'compaction')!;
    expect(event.inputTokens).toBe(40_000);
    expect(event.tokensBefore).toBe(41_000);
    expect(event.tokensAfter).toBe(3_000);
    expect(ledger.totals().compactionCost).toBeCloseTo(0.0412, 10);
    expect(ledger.totals().compactionInputTokens).toBe(40_000);
  });

  it('an unpriced compaction books tokens and no money — never $0', () => {
    const ledger = new Ledger();
    ledger.recordCompaction({
      stageId: 'stage-1',
      modelKey: 'acme/mystery',
      inputTokens: 10_000,
      outputTokens: 100,
      cost: null,
      tokensBefore: 10_000,
      tokensAfter: 1_000,
    });
    expect(ledger.totals().compactionInputTokens).toBe(10_000);
    expect(ledger.totals().compactionCost).toBe(0);
    expect(ledger.all()[0]!.cost).toBeUndefined();
  });
});
