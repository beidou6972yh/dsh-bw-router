import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_THRESHOLDS,
  compactionNotice,
  decideContext,
  emptyHandover,
  handoverComplete,
  readThresholds,
  renderHandover,
  validateHandover,
  type StageHandover,
} from '../src/core/context-guard.js';

/**
 * F5 — context protection before a model switch.
 *
 * Four branches, three thresholds, one structured handover, three checks, one
 * notice. The four tests at the top are the acceptance criteria (判据 2); the
 * rest pin the rules that make those branches trustworthy.
 */

const W = 100_000;
const full: StageHandover = {
  goal: '把 M2 的上下文保护做完',
  done: ['实现了三分支判定', '压缩产物落成五要素交接'],
  artifacts: ['src/core/context-guard.ts', 'test/m2-context-guard.test.ts'],
  keyFacts: ['阈值 70/50/16', '压完仍 >70% 就拒绝硬切'],
  open: ['压缩模型选择策略待管理员定'],
};

describe('F5 判据 2: the four branches, one test each', () => {
  it('C ≤ 50% of the window switches directly and says nothing was cut', () => {
    const decision = decideContext({ contextTokens: 40_000, windowTokens: W });
    expect(decision.action).toBe('direct');
    expect(decision.carry).toBe('full');
    expect(decision.carriedTokens).toBe(40_000);
    expect(decision.message).toMatch(/nothing cut/);
  });

  it('50% < C ≤ 70% switches with the summary chain only', () => {
    const decision = decideContext({ contextTokens: 60_000, windowTokens: W });
    expect(decision.action).toBe('summary');
    expect(decision.carry).toBe('summary-chain');
    expect(decision.message).toMatch(/summary chain/);
    // The full transcript stays behind: the carried ceiling is the chain, not 60k.
    expect(decision.share).toBeCloseTo(0.6, 6);
  });

  it('C > 70% asks for compression down to ≤ 16%, and does not switch yet', () => {
    const decision = decideContext({ contextTokens: 85_000, windowTokens: W });
    expect(decision.action).toBe('compress');
    expect(decision.targetTokens).toBe(16_000);
    expect(decision.carry).toBe('summary-chain');
    expect(decision.message).toMatch(/compressed to/);
  });

  it('still over 70% after compressing refuses the switch and offers three options', () => {
    const decision = decideContext({
      contextTokens: 90_000,
      windowTokens: W,
      tokensAfterCompaction: 72_000,
    });
    expect(decision.action).toBe('refuse');
    expect(decision.carry).toBe('none');
    expect(decision.carriedTokens).toBe(0);
    expect(decision.options?.map((o) => o.kind)).toEqual(['bigger-window', 'stay', 'split']);
    expect(decision.message).toMatch(/refusing to switch instead of truncating/);
  });

  it('a compression that reached the target turns the refusal into a compress-and-go', () => {
    const decision = decideContext({
      contextTokens: 90_000,
      windowTokens: W,
      tokensAfterCompaction: 14_000,
    });
    expect(decision.action).toBe('compress');
    expect(decision.carriedTokens).toBe(14_000);
    expect(decision.message).toMatch(/can still be reopened/);
  });
});

describe('F5 判据 2: thresholds are configurable, not hardcoded in the decision', () => {
  it('ships the D-006 defaults: 50 / 70 / 16', () => {
    expect(DEFAULT_CONTEXT_THRESHOLDS).toEqual({ directShare: 0.5, summaryShare: 0.7, refuseShare: 0.16 });
  });

  it('a different set of thresholds changes the branch for the same context', () => {
    const strict = readThresholds({ directShare: 0.2, summaryShare: 0.3, refuseShare: 0.1 }).thresholds;
    expect(decideContext({ contextTokens: 40_000, windowTokens: W }).action).toBe('direct');
    expect(decideContext({ contextTokens: 40_000, windowTokens: W, thresholds: strict }).action).toBe('compress');
  });

  it('clamps a nonsense config and reports that it did', () => {
    const { thresholds, adjusted } = readThresholds({ directShare: 2, summaryShare: 0.05, refuseShare: 0.1 });
    // 2 is not a fraction, so the default 0.5 is kept instead of trusting it.
    expect(adjusted.join(' ')).toMatch(/directShare/);
    expect(adjusted.join(' ')).toMatch(/swapped|refuseShare/);
    expect(thresholds.summaryShare).toBeGreaterThanOrEqual(thresholds.directShare);
    expect(thresholds.directShare).toBeGreaterThanOrEqual(thresholds.refuseShare);
  });
});

describe('F5 判据 3: the handover is structured, and the three checks are real', () => {
  it('accepts a handover with all five fields, including a real artifact path', () => {
    expect(validateHandover(full)).toEqual([]);
    expect(handoverComplete(full)).toBe(true);
  });

  it('flags each of the three load-bearing fields when it is missing', () => {
    const problems = validateHandover({
      ...emptyHandover(),
      goal: 'goal',
      done: ['something finished'],
    });
    expect(problems.map((p) => p.field)).toEqual(['artifacts', 'keyFacts', 'open']);
  });

  it('flags an artifact list that names no file path', () => {
    const problems = validateHandover({
      ...full,
      artifacts: ['改了核心模块', '优化了性能'],
    });
    expect(problems.map((p) => `${p.field}:${p.kind}`)).toEqual(['artifacts:no-artifact-path']);
  });

  it('renders the five sections in a fixed order, even when they are empty', () => {
    const text = renderHandover(emptyHandover());
    expect(text.indexOf('## 任务目标')).toBeLessThan(text.indexOf('## 已完成与结论'));
    expect(text.indexOf('## 已完成与结论')).toBeLessThan(text.indexOf('## 产物清单'));
    expect(text).toMatch(/（缺）/);
  });

  it('renders the red list when the checks failed', () => {
    const text = renderHandover(emptyHandover(), validateHandover(emptyHandover()));
    expect(text).toMatch(/校验未过（需重压）/);
    expect(text).toMatch(/⚠ red/);
  });
});

describe('F5 判据 3: a compression is never silent', () => {
  it('says how much was compressed, and that details may be lost', () => {
    const notice = compactionNotice({ tokensBefore: 90_000, tokensAfter: 14_000, problems: [] });
    expect(notice.visible).toBe(true);
    expect(notice.warning).toBe(false);
    expect(notice.text).toContain('90k');
    expect(notice.text).toContain('14k');
    expect(notice.text).toMatch(/原文可回溯/);
  });

  it('warns instead of pretending when the handover is short a field', () => {
    const notice = compactionNotice({
      tokensBefore: 90_000,
      tokensAfter: 70_000,
      problems: validateHandover({ ...full, artifacts: [] }),
    });
    expect(notice.warning).toBe(true);
    expect(notice.text).toMatch(/建议重压/);
    expect(notice.problems.map((p) => p.field)).toEqual(['artifacts']);
  });

  it('does not promise a transcript it cannot reopen', () => {
    const notice = compactionNotice({
      tokensBefore: 90_000,
      tokensAfter: 14_000,
      problems: [],
      reopenable: false,
    });
    expect(notice.text).toMatch(/原文不可回看/);
  });
});
