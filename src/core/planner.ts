import type { CapabilityKind, Stage } from './types.js';

interface StagePreset {
  name: string;
  goal: string;
  capability: CapabilityKind;
  /**
   * A stage's whole output allowance, as a share of the task total. A budget,
   * not a reply size: the guard divides it into single replies (A2).
   */
  outputShare: number;
  optional: boolean;
}

const PRESETS: Record<string, StagePreset> = {
  analyze: {
    name: 'analyze',
    goal: 'Understand the request and pin down what "done" means',
    capability: 'reasoning',
    outputShare: 0.1,
    optional: false,
  },
  design: {
    name: 'design',
    goal: 'Decide the approach before writing anything',
    capability: 'reasoning',
    outputShare: 0.15,
    optional: false,
  },
  implement: {
    name: 'implement',
    goal: 'Produce the actual artifact',
    capability: 'coding',
    outputShare: 0.6,
    optional: false,
  },
  review: {
    name: 'review',
    goal: 'Check the artifact against the goal',
    capability: 'reasoning',
    outputShare: 0.1,
    optional: true,
  },
  write: {
    name: 'write',
    goal: 'Turn the result into something readable',
    capability: 'writing',
    outputShare: 0.3,
    optional: false,
  },
  summarize: {
    name: 'summarize',
    goal: 'Compress findings so context survives the switch',
    capability: 'summarizing',
    outputShare: 0.05,
    optional: true,
  },
  // 出图 is a first-class stage, not an unknown word that falls back to
  // "reasoning": a task that ends in a picture was being planned onto a text
  // model, so the image stage could never be routed (A3).
  image: {
    name: 'image',
    goal: 'Generate the image the task asks for',
    capability: 'image-generation',
    outputShare: 0.1,
    optional: false,
  },
};

/**
 * Task words → stage preset, so a plan can be named the way a user names work.
 *
 * Only aliases that would otherwise be mis-planned live here. An unknown word
 * still falls back to `reasoning`, which is why "出图"/"配图"/"绘图" must be
 * spelled out: the fallback is not wrong, it is merely blind.
 */
const ALIASES: Record<string, string> = {
  分析: 'analyze',
  需求: 'analyze',
  拆解: 'analyze',
  设计: 'design',
  方案: 'design',
  架构: 'design',
  实现: 'implement',
  开发: 'implement',
  编码: 'implement',
  编程: 'implement',
  编码实现: 'implement',
  测试: 'review',
  评审: 'review',
  复核: 'review',
  检查: 'review',
  写: 'write',
  写作: 'write',
  文档: 'write',
  汇报: 'write',
  ppt: 'write',
  演示: 'write',
  总结: 'summarize',
  摘要: 'summarize',
  压缩: 'summarize',
  出图: 'image',
  配图: 'image',
  绘图: 'image',
  作图: 'image',
  生图: 'image',
  画图: 'image',
  图片: 'image',
  插画: 'image',
  海报: 'image',
  image: 'image',
  illustration: 'image',
  picture: 'image',
};

/** Resolves a stage name to a preset key, or undefined when unknown. */
export function resolvePresetKey(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  if (!key) return undefined;
  if (PRESETS[key]) return key;
  return ALIASES[key];
}

export interface PlanInput {
  taskId: string;
  /** Stable id for this plan; the ledger and the plan card share it. */
  planId: string;
  summary: string;
  /** Stage names in execution order; at least one. */
  stageNames: string[];
  /** Total input tokens the whole task is expected to burn. */
  estimatedInputTokens: number;
  /** Total output tokens the whole task is expected to emit. */
  estimatedOutputTokens?: number;
}

/**
 * Builds the ordered stage list. Rule-based on purpose: v1 must be explainable
 * and testable before anything smart goes in.
 */
export function buildStages(input: PlanInput): Stage[] {
  if (input.stageNames.length === 0) {
    throw new Error('buildStages: at least one stage name is required');
  }
  const totalInput = Math.max(0, Math.round(input.estimatedInputTokens));
  const totalOutput =
    input.estimatedOutputTokens ?? Math.round(input.estimatedInputTokens * DEFAULT_OUTPUT_RATIO);

  const resolved = input.stageNames.map((rawName) => {
    const name = rawName.trim().toLowerCase();
    const presetKey = resolvePresetKey(name);
    return {
      preset: presetKey ? PRESETS[presetKey]! : fallbackPreset(name),
      // The card speaks the user's words: a stage the user called "复核" must
      // not turn into the preset key "review" on screen (灰狼 2026-10-26 实测：
      // 四段里只有"复核"显示成 review，因为别名命中了预设)。The preset still
      // owns capability/goal/budget; it no longer owns the visible label.
      displayName: rawName.trim() || name,
    };
  });
  const presets = resolved.map((entry) => entry.preset);
  const shares = closeShares(presets.map((preset) => preset.outputShare));
  const inputs = distributeInputs(totalInput, shares, presets);
  const outputs = distributeOutputs(totalOutput, shares);

  return presets.map((preset, index) => ({
    id: `stage-${index + 1}`,
    name: resolved[index]!.displayName,
    goal: preset.goal,
    capability: preset.capability,
    estimatedInputTokens: inputs[index]!,
    estimatedOutputTokens: outputs[index]!,
    optional: preset.optional,
  }));
}

/** Default output:input ratio for a task nobody sized. */
export const DEFAULT_OUTPUT_RATIO = 0.3;

/**
 * Makes the stage output shares sum to exactly 1 (B-2).
 *
 * The presets are per-stage intuition ("implement is most of the work"), so they
 * were never meant to add up — `implement` alone is 0.6 and a task with six
 * stages summed to more than 1. The result was a plan that promised 82% of the
 * task's output to no stage at all: a single `implement` stage was budgeted 18%
 * of the task's *input*, while claiming a 60% share of an output total that was
 * itself derived from that input. The two halves of the same sentence disagreed.
 *
 * Normalising keeps the ratio between stages (which is the meaningful part) and
 * makes the total exact. Largest-remainder rounding, so the last stage does not
 * absorb everyone else's rounding error.
 */
export function closeShares(shares: number[]): number[] {
  if (shares.length === 0) return [];
  const clean = shares.map((share) => (Number.isFinite(share) && share > 0 ? share : 0));
  const sum = clean.reduce((acc, share) => acc + share, 0);
  const exact = sum > 0 ? clean.map((share) => share / sum) : clean.map(() => 1 / clean.length);
  // Work in per-mille integers: sum is exactly 1000, so no float drift can make
  // the shares of six stages add up to 1.002.
  const millis = exact.map((share) => Math.floor(share * 1000));
  let rest = 1000 - millis.reduce((acc, value) => acc + value, 0);
  const order = exact
    .map((share, index) => ({ index, frac: share * 1000 - Math.floor(share * 1000) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  let i = 0;
  while (rest > 0 && order.length > 0) {
    millis[order[i % order.length]!.index]! += 1;
    rest -= 1;
    i += 1;
  }
  return millis.map((value) => value / 1000);
}

/**
 * Splits the task's input tokens across stages by what each stage reads (B-2).
 *
 * Equal shares said an `analyze` stage reads as much as an `implement` stage,
 * which produced "one implement stage on 18k input" while the plan claimed 30k —
 * a 40% understatement on the stage that costs the most. Reading weight is the
 * stage's *input* appetite: everything that must reason over the task reads all
 * of it, a summarising step reads what came before.
 */
export function distributeInputs(totalInput: number, shares: number[], presets: StagePreset[]): number[] {
  const weights = presets.map((preset, index) => inputWeight(preset, shares[index] ?? 0));
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  if (sum <= 0) return weights.map(() => Math.max(0, Math.round(totalInput / weights.length)));
  const raw = weights.map((weight) => (totalInput * weight) / sum);
  return fixRounding(raw, totalInput);
}

/** How much of the task a stage has to read to do its job. */
function inputWeight(preset: StagePreset, outputShare: number): number {
  if (preset.name === 'summarize') return 0.6;
  if (preset.name === 'review') return 0.8;
  // Reasoning and production stages read the task; a stage that emits more is
  // also a stage that will be handed more context by its predecessors.
  return 1 + outputShare * 0.5;
}

export function distributeOutputs(totalOutput: number, shares: number[]): number[] {
  const raw = shares.map((share) => totalOutput * share);
  return fixRounding(raw, totalOutput).map((value) => Math.max(1, value));
}

/** Rounds to integers whose sum is exactly `total` (largest remainder). */
function fixRounding(values: number[], total: number): number[] {
  const floors = values.map((value) => Math.floor(value));
  let rest = Math.round(total - floors.reduce((acc, value) => acc + value, 0));
  const order = values
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  const out = [...floors];
  let i = 0;
  while (rest > 0 && order.length > 0) {
    out[order[i % order.length]!.index] = (out[order[i % order.length]!.index] ?? 0) + 1;
    rest -= 1;
    i += 1;
  }
  // A negative `rest` (values summed above the total by rounding) takes from the
  // smallest fractional parts, never below 0.
  while (rest < 0 && order.length > 0) {
    const target = order[order.length - 1 - (i % order.length)]!.index;
    if ((out[target] ?? 0) > 0) {
      out[target] = out[target]! - 1;
      rest += 1;
    }
    i += 1;
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fallbackPreset(name: string): StagePreset {
  return {
    name: name || 'stage',
    goal: `Do the "${name}" part of the task`,
    capability: 'reasoning',
    outputShare: 0.2,
    optional: false,
  };
}

/**
 * Drops optional stages the user unselected, and never leaves nothing behind.
 *
 * B-7: when every stage was skipped this used to return `stages.slice(0, 1)` —
 * the **first** stage — while the comment promised "never drops the last one".
 * On a `write → implement` task that meant keeping `write` and losing
 * `implement`: the plan silently became "plan the work" with no work in it.
 *
 * The mandatory stage is the one the task exists for, and in a task order that is
 * the **last** mandatory stage (later stages consume earlier ones). Only when
 * every stage is optional does position decide, and then the last one is still the
 * better answer than the first: it is the one whose output the user can use.
 */
export function pruneOptional(stages: Stage[], skippedIds: string[]): Stage[] {
  const skipped = new Set(skippedIds);
  const kept = stages.filter((s) => !skipped.has(s.id));
  if (kept.length > 0) return kept;
  for (let i = stages.length - 1; i >= 0; i -= 1) {
    if (!stages[i]!.optional) return [stages[i]!];
  }
  return stages.length > 0 ? [stages[stages.length - 1]!] : [];
}
