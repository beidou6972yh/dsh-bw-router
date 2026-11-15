import { describe, expect, it } from 'vitest';
import { clampHeadroom, displayContext, guardSwitch, usableContext } from '../src/core/guard.js';
import { bigBrain, coder, makeModel } from './fixtures/models.js';

const guessed = makeModel({
  provider: 'local',
  name: 'unknown-window',
  limitsGuessed: true,
  limits: { contextWindow: 32_000, maxOutputTokens: 4_096, supportsTools: true, supportsImages: false },
});
const unpriced = makeModel({
  provider: 'cloud',
  name: 'mystery',
  pricing: { inputPerMTok: null, outputPerMTok: null },
});

describe('guardSwitch', () => {
  it('allows a switch that fits comfortably', () => {
    const result = guardSwitch({
      target: bigBrain,
      contextTokens: 10_000,
      expectedOutputTokens: 2_000,
      requiredCapabilities: ['coding'],
    });
    expect(result).toMatchObject({ code: 'ok', allowed: true, message: '' });
  });

  it('blocks instead of truncating when the context does not fit', () => {
    const result = guardSwitch({
      target: coder, // 32k window, 28.8k usable
      contextTokens: 30_000,
      expectedOutputTokens: 4_000,
    });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('context-overflow');
    expect(result.overflowTokens).toBe(5_200);
    expect(result.message).toMatch(/Compress/);
  });

  it('blocks when the target lacks a required capability', () => {
    const result = guardSwitch({
      target: coder,
      contextTokens: 100,
      expectedOutputTokens: 100,
      requiredCapabilities: ['vision'],
    });
    expect(result.code).toBe('missing-capability');
    expect(result.message).toContain('vision');
  });

  it('blocks when the stage needs more output than the model can emit', () => {
    const result = guardSwitch({
      target: coder,
      contextTokens: 100,
      expectedOutputTokens: 5_000,
    });
    expect(result.code).toBe('output-limit-too-small');
  });

  it('respects a custom headroom', () => {
    const strict = guardSwitch({
      target: coder,
      contextTokens: 20_000,
      expectedOutputTokens: 1_000,
      headroom: 0.5,
    });
    expect(strict.code).toBe('context-overflow');
  });
});

describe('usableContext', () => {
  it('subtracts the expected reply from the headroom-adjusted window', () => {
    expect(usableContext(coder, 4_096)).toBe(24_704);
  });

  it('never goes negative', () => {
    expect(usableContext(coder, 999_999)).toBe(0);
  });
});

describe('guard bounds (B-6) and unknown limits (A-5)', () => {
  it('clamps a headroom above 1 instead of widening the gate', () => {
    expect(clampHeadroom(1.5)).toBe(1);
    const result = guardSwitch({
      target: coder, // 32k window; headroom 1.5 used to allow 34k
      contextTokens: 30_000,
      expectedOutputTokens: 4_000,
      headroom: 1.5,
    });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('context-overflow');
  });

  it('clamps a negative or NaN headroom', () => {
    expect(clampHeadroom(-2)).toBe(0.1);
    expect(clampHeadroom(Number.NaN)).toBe(0.9);
    expect(clampHeadroom(undefined)).toBe(0.9);
  });

  it('keeps usableContext on the same headroom as the gate', () => {
    expect(usableContext(coder, 0, 0.5)).toBe(16_000);
    expect(displayContext(coder, 1_000, 0.5)).toBe(15_000);
  });

  it('never authorises a switch onto a guessed context window', () => {
    const result = guardSwitch({ target: guessed, contextTokens: 100, expectedOutputTokens: 100 });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('limits-unconfirmed');
    expect(displayContext(guessed, 100)).toBe(0);
  });

  it('blocks a model whose price is unknown unless explicitly allowed', () => {
    const strict = guardSwitch({ target: unpriced, contextTokens: 100, expectedOutputTokens: 100 });
    expect(strict.code).toBe('price-unknown');
    const loose = guardSwitch({
      target: unpriced,
      contextTokens: 100,
      expectedOutputTokens: 100,
      requireKnownPricing: false,
    });
    expect(loose.allowed).toBe(true);
  });
});
