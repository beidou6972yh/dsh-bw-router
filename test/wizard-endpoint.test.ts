import { describe, expect, it } from 'vitest';
import { buildWizardView, confirmWizard, PluginHost } from '../src/plugin/index.js';
import { dispatch, ROUTER_PREFIX, type RouterDeps } from '../src/plugin/endpoints.js';
import { RouterSession } from '../src/plugin/index.js';
import { buildWizardDraft } from '../src/core/wizard-draft.js';
import { collectUsage } from '../src/core/usage-stats.js';
import type { DshModelSelection } from '../src/adapters/dsh-model.js';
import { allModels, bigBrain, cheapFast, makeModel } from './fixtures/models.js';

/**
 * P1: the wizard, minimal version — "能看能确认".
 *
 * The rule this file protects: **viewing changes nothing, and confirming changes
 * only memory**. The host never writes DSH settings, so an install that is
 * previewed and abandoned leaves the user's environment exactly as it was.
 */

function harness(models = allModels) {
  const selection: DshModelSelection & { writes: number } = {
    writes: 0,
    current: () => 'deepseek/flash',
    select: async () => {
      selection.writes += 1;
    },
  };
  const host = new PluginHost(selection);
  host.registerModels(models, models.map((m) => `${m.provider}/${m.model}`));
  const deps: RouterDeps = { host, session: new RouterSession(host) };
  return { host, deps, selection };
}

const NOW = '2026-10-22T12:00:00.000Z';
const log = (
  rows: [string, string, number][],
): { at: string; provider: string; model: string }[] =>
  rows.flatMap(([provider, model, count]) =>
    Array.from({ length: count }, () => ({ at: NOW, provider, model })),
  );

describe('GET /router/wizard', () => {
  it('lists what was found, grouped by provider, with a guessed baseline', async () => {
    const { deps } = harness();
    const res = await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/wizard` }, deps);
    expect(res.status).toBe(200);
    const wizard = res.body.wizard as {
      totalModels: number;
      stages: { provider: string; count: number; reachable: boolean }[];
      baselineBasis: string;
      ready: boolean;
      questions: { kind: string }[];
    };
    expect(wizard.totalModels).toBe(4);
    expect(wizard.stages.map((s) => s.provider).sort()).toEqual(['cloud', 'deepseek', 'local']);
    expect(wizard.stages.every((s) => s.reachable)).toBe(true);
    expect(wizard.baselineBasis).toBe('price-fallback');
    expect(wizard.ready).toBe(true);
    expect(wizard.questions.some((q) => q.kind === 'confirm-baseline')).toBe(true);
  });

  it('uses real usage when it exists, and stops asking', async () => {
    const { host, deps } = harness([bigBrain, cheapFast]);
    const usage = collectUsage(log([['deepseek', 'flash', 20]]), { now: NOW });
    const draft = host.wizardDraft();
    const view = buildWizardView(buildWizardDraft({ entries: host.registry.all(), usage }));
    expect(view.baselineBasis).toBe('usage');
    expect(view.baselineKey).toBe('deepseek/flash');
    expect(view.questions.some((q) => q.kind === 'confirm-baseline')).toBe(false);
    // The draft itself is still available for a caller that wants the details.
    expect(draft.totalModels).toBe(2);
    expect((await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/wizard` }, deps)).status).toBe(200);
  });

  it('says "nothing found" without crashing on an empty machine', async () => {
    const { deps } = harness([]);
    const res = await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/wizard` }, deps);
    const wizard = res.body.wizard as { totalModels: number; ready: boolean; questions: { kind: string }[] };
    expect(wizard.totalModels).toBe(0);
    expect(wizard.ready).toBe(false);
    expect(wizard.questions.map((q) => q.kind)).toEqual(['missing-models']);
  });

  it('shows unpriced models as a question, not a failure', async () => {
    const { deps } = harness([
      bigBrain,
      makeModel({ provider: 'cloud', name: 'mystery', capabilities: ['coding'], pricing: { inputPerMTok: null, outputPerMTok: null } }),
    ]);
    const res = await dispatch({ method: 'GET', path: `${ROUTER_PREFIX}/wizard` }, deps);
    const wizard = res.body.wizard as { questions: { kind: string; keys: string[] }[] };
    const question = wizard.questions.find((q) => q.kind === 'price-unknown')!;
    expect(question.keys).toEqual(['cloud/mystery']);
  });
});

describe('POST /router/wizard/confirm', () => {
  it('records the confirmed baseline and plans with it afterwards', async () => {
    const { host, deps } = harness();
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/wizard/confirm`, body: { baselineKey: 'deepseek/flash' } },
      deps,
    );
    expect(res.status).toBe(200);
    const confirmation = res.body.confirmation as { baselineKey: string; totalModels: number; confirmedAt: string };
    expect(confirmation.baselineKey).toBe('deepseek/flash');
    expect(confirmation.totalModels).toBe(4);
    expect(Number.isNaN(Date.parse(confirmation.confirmedAt))).toBe(false);

    const planned = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/plan`, body: { taskId: 't1', stageNames: ['implement'], estimatedInputTokens: 5_000 } },
      deps,
    );
    const plan = planned.body.plan as { baselineModelKey: string; baselineIsGuess: boolean };
    // The user answered the question, so it is no longer described as a guess.
    expect(plan.baselineModelKey).toBe('deepseek/flash');
    expect(plan.baselineIsGuess).toBe(false);
    expect(host.baselineFor()).toBe('deepseek/flash');
  });

  it('refuses a baseline that is not in the model list', async () => {
    const { deps } = harness();
    const res = await dispatch(
      { method: 'POST', path: `${ROUTER_PREFIX}/wizard/confirm`, body: { baselineKey: 'ghost/none' } },
      deps,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown-model');
  });

  it('refuses to confirm an empty machine, and points at the wizard', async () => {
    const { deps } = harness([]);
    const res = await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/wizard/confirm`, body: {} }, deps);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no-models');
    expect(res.body.needsWizard).toBe(true);
  });

  it('writes nothing to the platform: no select, no settings', async () => {
    const { deps, selection } = harness();
    await dispatch({ method: 'POST', path: `${ROUTER_PREFIX}/wizard/confirm`, body: {} }, deps);
    expect(selection.writes).toBe(0);
  });
});

describe('confirmWizard (in-process)', () => {
  it('keeps the draft basis when the user accepts the guess', () => {
    const { host } = harness([bigBrain, cheapFast]);
    const draft = host.wizardDraft();
    const { confirmation } = confirmWizard(host, draft);
    expect(confirmation.basis).toBe('price-fallback');
    // pickBaseline's fallback is the priciest *available* model: conservative by
    // design, so "省了多少" is measured against the most expensive habit we can
    // imagine rather than a flattering cheap one.
    expect(confirmation.baselineKey).toBe('deepseek/reasoner');
  });

  it('records basis "usage" when the user overrides the guess', () => {
    const { host } = harness([bigBrain, cheapFast]);
    const draft = host.wizardDraft();
    const override = host.registry.all().find((e) => e.key !== draft.baselineKey)!.key;
    const { confirmation } = confirmWizard(host, draft, override);
    expect(confirmation.basis).toBe('usage');
    expect(confirmation.baselineKey).toBe(override);
  });

  it('leaves a ledger line so the run can answer "who picked this baseline"', () => {
    const { host } = harness([bigBrain, cheapFast]);
    confirmWizard(host, host.wizardDraft());
    const entry = host.ledger.all().at(-1)!;
    expect(entry.detail).toContain('wizard confirmed');
  });
});
