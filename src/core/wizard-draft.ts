import type { CapabilityEntry, CapabilitySource } from './types.js';
import { pickBaseline, type MergeReport } from './registry.js';
import { pricingKnown } from './types.js';
import { describeUsage, inferBaseline, usageCounts, type UsageSummary } from './usage-stats.js';

/**
 * Everything the install wizard needs to show, as plain data.
 *
 * This module deliberately has no UI: it returns what to ask, what to show, and
 * what it guessed — the plugin shell renders it. That keeps the guesswork
 * testable without a browser.
 */

/** Below this share the "most-used" model is not really the user's habit. */
export const DOMINANT_SHARE = 0.6;

export type WizardQuestionKind =
  | 'confirm-baseline'
  | 'confirm-endpoint'
  | 'missing-models'
  | 'price-unknown';

export interface WizardQuestion {
  kind: WizardQuestionKind;
  /** Short headline, user-facing. */
  title: string;
  /** Optional detail; never contains prompt text or keys. */
  detail: string;
  /** Model keys this question is about, when applicable. */
  keys: string[];
}

export interface WizardProviderGroup {
  provider: string;
  count: number;
  sources: CapabilitySource[];
  /** True when every model in the group came back reachable. */
  reachable: boolean;
  keys: string[];
}

export interface WizardDraft {
  /** Model groups, ordered by size then name — the wizard's main list. */
  groups: WizardProviderGroup[];
  /** Guessed baseline (most-used model). Undefined means "ask the user". */
  baselineKey?: string;
  /** Why that baseline: 'usage' beats 'price-fallback'. */
  baselineBasis: 'usage' | 'price-fallback' | 'none';
  /** Usage summary the guess came from, safe to show (counts only). */
  usage: { totalCalls: number; topKey?: string; topShare: number; line: string };
  /** Things the user must confirm before the wizard finishes. */
  questions: WizardQuestion[];
  /** Merge conflicts worth surfacing once, not per model. */
  conflicts: MergeReport['conflicts'];
  /** Sources that contributed at all. */
  sources: CapabilitySource[];
  totalModels: number;
}

export interface WizardDraftInput {
  entries: CapabilityEntry[];
  usage?: UsageSummary;
  mergeReport?: MergeReport;
  /** Endpoints the probe found dead. Their models are hidden but not deleted. */
  deadEndpoints?: string[];
}

/** Builds the draft. Pure; no fs, no network, no UI. */
export function buildWizardDraft(input: WizardDraftInput): WizardDraft {
  const entries = input.entries;
  const usage = input.usage;
  const questions: WizardQuestion[] = [];

  const groups = groupByProvider(entries);

  const inferred = usage ? inferBaseline(usage, entries) : undefined;
  let baselineKey: string | undefined;
  let baselineBasis: WizardDraft['baselineBasis'] = 'none';

  if (inferred) {
    baselineKey = inferred.key;
    baselineBasis = 'usage';
    // A dominant model needs no confirmation; a 50/50 split does.
    if (inferred.share < DOMINANT_SHARE) {
      questions.push({
        kind: 'confirm-baseline',
        title: `默认拿 ${inferred.key} 当省钱基线？`,
        detail: `它只占 ${Math.round(inferred.share * 100)}%，你可能常换模型。`,
        keys: [inferred.key],
      });
    }
  } else {
    const fallback = pickBaseline(entries, usage ? usageCounts(usage) : {}).key;
    if (fallback) {
      baselineKey = fallback;
      baselineBasis = 'price-fallback';
      questions.push({
        kind: 'confirm-baseline',
        title: `没有调用记录，先按最贵的 ${fallback} 估算省多少？`,
        detail: '这只是猜的（不是你的真实习惯）；跑几次后会自动换成你真正常用的模型。',
        keys: [fallback],
      });
    }
  }

  if (entries.length === 0) {
    questions.push({
      kind: 'missing-models',
      title: '一个模型都没扫到',
      detail: '检查 DSH provider 配置，或手动导入模型清单。',
      keys: [],
    });
  }

  const unknownPrice = entries.filter(
    (e) => !pricingKnown(e.model.pricing),
  );
  if (unknownPrice.length > 0) {
    questions.push({
      kind: 'price-unknown',
      title: `${unknownPrice.length} 个模型没有价格`,
      detail: '没有价格就算不出省多少；可以补价目，或先只做能力路由。',
      keys: unknownPrice.map((e) => e.key),
    });
  }

  for (const dead of input.deadEndpoints ?? []) {
    questions.push({
      kind: 'confirm-endpoint',
      title: `本地端点 ${dead} 没响应`,
      detail: '跳过它的模型。如果是没启动，起来后重新扫描即可。',
      keys: [],
    });
  }

  return {
    groups,
    ...(baselineKey ? { baselineKey } : {}),
    baselineBasis,
    usage: {
      totalCalls: usage?.totalCalls ?? 0,
      ...(usage?.topKey ? { topKey: usage.topKey } : {}),
      topShare: usage?.topShare ?? 0,
      line: usage ? describeUsage(usage) : '没有会话记录，无法推断常用模型',
    },
    questions,
    conflicts: input.mergeReport?.conflicts ?? [],
    sources: [...new Set(entries.map((e) => e.model.source))].sort(),
    totalModels: entries.length,
  };
}

/** Groups entries by provider for the wizard list. */
export function groupByProvider(entries: CapabilityEntry[]): WizardProviderGroup[] {
  const map = new Map<string, CapabilityEntry[]>();
  for (const entry of entries) {
    const list = map.get(entry.model.provider) ?? [];
    list.push(entry);
    map.set(entry.model.provider, list);
  }
  return [...map.entries()]
    .map(([provider, list]) => ({
      provider,
      count: list.length,
      sources: [...new Set(list.map((e) => e.model.source))].sort(),
      reachable: list.some((e) => e.available),
      keys: list.map((e) => e.key).sort(),
    }))
    .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));
}

/** True when nothing needs confirming — the wizard can close on its own. */
export function isReady(draft: WizardDraft): boolean {
  return draft.totalModels > 0 && draft.baselineBasis !== 'none' && draft.questions.length === 0;
}
