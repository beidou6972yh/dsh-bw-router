import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UNCERTAINTY,
  estimateStage,
  formatEstimate,
  savingsRatio,
  sumEstimates,
} from '../src/core/budget.js';
import { bigBrain, coder, makeModel } from './fixtures/models.js';

const unpriced = makeModel({
  provider: 'cloud',
  name: 'mystery',
  pricing: { inputPerMTok: null, outputPerMTok: null },
});

describe('estimateStage', () => {
  it('computes cost, baseline cost and savings', () => {
    const estimate = estimateStage({
      model: coder,
      baseline: bigBrain,
      inputTokens: 100_000,
      outputTokens: 50_000,
    });
    expect(estimate.cost).toBe(0);
    expect(estimate.baselineCost).toBeCloseTo(0.2 + 0.4, 6);
    expect(estimate.savings).toBeCloseTo(0.6, 6);
    expect(estimate.uncertainty).toBe(DEFAULT_UNCERTAINTY);
  });

  it('reports negative savings when the picked model is pricier', () => {
    const estimate = estimateStage({
      model: bigBrain,
      baseline: coder,
      inputTokens: 10_000,
      outputTokens: 10_000,
    });
    expect(estimate.savings).toBeLessThan(0);
  });

  it('allows an explicit uncertainty for calibrated profiles', () => {
    const estimate = estimateStage({
      model: coder,
      baseline: bigBrain,
      inputTokens: 1,
      outputTokens: 1,
      uncertainty: 0.1,
    });
    expect(estimate.uncertainty).toBe(0.1);
  });
});

describe('estimateStage with unknown pricing', () => {
  it('reports null cost instead of a free model', () => {
    const estimate = estimateStage({
      model: unpriced,
      baseline: bigBrain,
      inputTokens: 10_000,
      outputTokens: 10_000,
    });
    expect(estimate.cost).toBeNull();
    expect(estimate.savings).toBeNull();
    expect(estimate.baselineCost).toBeGreaterThan(0);
    expect(estimate.unknownPricing).toEqual(['cloud/mystery']);
  });

  it('never renders an unknown price as "$0.0000 ... save 100%"', () => {
    const line = formatEstimate(
      estimateStage({ model: unpriced, baseline: bigBrain, inputTokens: 10, outputTokens: 10 }),
    );
    expect(line).toContain('price unknown');
    expect(line).not.toContain('save');
    expect(line).not.toContain('$0.0000');
  });

  it('an unpriced baseline makes savings unknown, not maximal', () => {
    const estimate = estimateStage({
      model: bigBrain,
      baseline: unpriced,
      inputTokens: 10,
      outputTokens: 10,
    });
    expect(estimate.savings).toBeNull();
    expect(savingsRatio(estimate)).toBeNull();
  });
});

describe('sumEstimates', () => {
  it('savings of the whole equals the sum of the parts', () => {
    const a = estimateStage({ model: coder, baseline: bigBrain, inputTokens: 1000, outputTokens: 1000 });
    const b = estimateStage({ model: bigBrain, baseline: bigBrain, inputTokens: 1000, outputTokens: 1000 });
    const total = sumEstimates([a, b]);
    expect(total.savings).toBeCloseTo(a.savings! + b.savings!, 6);
    expect(total.cost).toBeCloseTo(a.cost! + b.cost!, 6);
    expect(total.inputTokens).toBe(2000);
  });

  it('combines independent bands in quadrature instead of taking the widest', () => {
    const parts = Array.from({ length: 4 }, () =>
      estimateStage({ model: coder, baseline: bigBrain, inputTokens: 1, outputTokens: 1, uncertainty: 0.2 }),
    );
    // sqrt(4 × 0.2²) = 0.4 — not 0.2.
    expect(sumEstimates(parts).uncertainty).toBeCloseTo(0.4, 6);
  });

  it('never claims a narrower band than its widest part', () => {
    const parts = [
      estimateStage({ model: coder, baseline: bigBrain, inputTokens: 1, outputTokens: 1, uncertainty: 0.5 }),
      estimateStage({ model: coder, baseline: bigBrain, inputTokens: 1, outputTokens: 1, uncertainty: 0.1 }),
    ];
    expect(sumEstimates(parts).uncertainty).toBeGreaterThanOrEqual(0.5);
  });

  it('an unknown part makes the whole unknown', () => {
    const priced = estimateStage({ model: coder, baseline: bigBrain, inputTokens: 1000, outputTokens: 1000 });
    const unknown = estimateStage({ model: unpriced, baseline: bigBrain, inputTokens: 1000, outputTokens: 1000 });
    const total = sumEstimates([priced, unknown]);
    expect(total.cost).toBeNull();
    expect(total.savings).toBeNull();
    expect(total.unknownPricing).toEqual(['cloud/mystery']);
  });

  it('an empty list totals to "unknown", not "$0.00" (N-3)', () => {
    const total = sumEstimates([]);
    // Nothing to add up is not the same as costing nothing: a $0 total on a
    // card with no models reads as "free", which is the one thing this project
    // never says about an unpriced run.
    expect(total.cost).toBeNull();
    expect(total.savings).toBeNull();
    expect(total.priceUnknownReason).toBe('no-model');
    expect(total.uncertainty).toBe(0);
    expect(formatEstimate(total)).toContain('no model assigned yet');
  });
});

describe('savingsRatio / formatEstimate', () => {
  it('ratio is zero when the baseline cost is zero', () => {
    const estimate = estimateStage({ model: bigBrain, baseline: coder, inputTokens: 10, outputTokens: 10 });
    expect(savingsRatio(estimate)).toBe(0);
  });

  it('states the ± band in the user-facing sentence', () => {
    const estimate = estimateStage({ model: coder, baseline: bigBrain, inputTokens: 1000, outputTokens: 1000 });
    const line = formatEstimate(estimate);
    expect(line).toContain('±35%');
    expect(line).toContain('save 100%');
  });
});
