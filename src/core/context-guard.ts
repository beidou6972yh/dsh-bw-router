import type { ContextAction } from './types.js';

/**
 * F5 — context protection before a model switch.
 *
 * The rule the project is built on: switching models must not lose the thread
 * (原则 3), and it must never lose it **silently**. So this module answers one
 * question with four possible answers, and the caller has to act on the answer
 * it got instead of truncating the conversation to make it fit:
 *
 *  - `direct`   — hold on, nothing is cut;
 *  - `summary`  — travel with the stage-summary chain only (details stay in the
 *                 session, but the new model's prompt starts from the chain);
 *  - `compress` — the context is too big: compress first, then go;
 *  - `refuse`   — even after compressing it does not fit: **do not switch**, and
 *                 offer the user three ways out.
 *
 * Nothing here compresses anything. DSH already ships compaction
 * (`compaction-basic`, `/compact`, `summarizationProvider/Model`); this file
 * owns the *timing*, the *shape* of the handover, the *checks* on it, the
 * *notice* the user sees, and the *booking* of what the compression cost. Writing
 * a second compressor would be a second engine to keep honest, for no gain
 * (派工单 §二 A.7).
 */

/**
 * The three thresholds, as fractions of the target model's context window.
 *
 * Defaults follow 决策记录 D-006. They are fractions of the **window**, not of
 * the usable/headroom window, because that is how the decision was written down
 * ("C ≤ W×50%"); the guard's own headroom is applied on top when the switch is
 * finally asked, so this file can only make the switch *more* conservative,
 * never less.
 *
 * `refuseShare` (16%) is the floor compression must reach: compress to
 * `≤ refuseShare×W` and the switch is comfortable; fail to get under it and the
 * switch is refused rather than attempted.
 */
export interface ContextThresholds {
  /** C ≤ W×directShare → switch as is. */
  directShare: number;
  /** C ≤ W×summaryShare → switch with the summary chain only. */
  summaryShare: number;
  /** Compression must reach ≤ W×refuseShare; otherwise refuse. */
  refuseShare: number;
}

export const DEFAULT_CONTEXT_THRESHOLDS: ContextThresholds = Object.freeze({
  directShare: 0.5,
  summaryShare: 0.7,
  refuseShare: 0.16,
});

/**
 * Reads the thresholds from a plain config object, clamping instead of trusting.
 *
 * A config file is user input. `directShare: 2` must not turn the protection
 * into "always fine", and a `refuseShare` above `directShare` would make the
 * compression target unreachable by construction — both are corrected here, and
 * the caller is told (via the returned `adjusted` list) that it happened, because
 * silently rewriting a user's setting is the same class of bug as silently
 * truncating their context.
 */
export function readThresholds(
  config: Partial<Record<keyof ContextThresholds, unknown>> | undefined,
  fallback: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS,
): { thresholds: ContextThresholds; adjusted: string[] } {
  const adjusted: string[] = [];
  const pick = (key: keyof ContextThresholds): number => {
    const raw = config?.[key];
    if (raw === undefined) return fallback[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw >= 1) {
      adjusted.push(`${key}: ${String(raw)} is not a fraction in (0,1), kept ${fallback[key]}`);
      return fallback[key];
    }
    return raw;
  };
  let refuseShare = pick('refuseShare');
  let directShare = pick('directShare');
  let summaryShare = pick('summaryShare');
  if (summaryShare < directShare) {
    adjusted.push(
      `summaryShare ${summaryShare} < directShare ${directShare}: swapped so the summary band cannot be empty`,
    );
    [directShare, summaryShare] = [summaryShare, directShare];
  }
  // The three bands only make sense ordered: compressing must land *below* the
  // comfortable line. A config that inverts that would let a "compressed" context
  // still be too big — a silent hole in the protection — so it is repaired here.
  if (refuseShare > directShare) {
    adjusted.push(
      `refuseShare ${refuseShare} > directShare ${directShare}: raised directShare so compressed stays comfortable`,
    );
    directShare = refuseShare;
  }
  if (summaryShare < directShare) {
    adjusted.push(`summaryShare ${summaryShare} < directShare ${directShare}: raised to keep the bands ordered`);
    summaryShare = directShare;
  }
  return { thresholds: { directShare, summaryShare, refuseShare }, adjusted };
}

/** One of the three ways out when the context still does not fit (F5 §1). */
export interface ContextOption {
  kind: 'bigger-window' | 'stay' | 'split';
  /** User-facing one-liner. Answers "what do I do now". */
  label: string;
}

export interface ContextDecisionInput {
  /** Context size the session is holding, in tokens. */
  contextTokens: number;
  /** Context window of the model we are switching **to**. */
  windowTokens: number;
  thresholds?: ContextThresholds;
  /**
   * What compression actually achieved, in tokens. Present only when the caller
   * already ran a compression pass and is asking "is this enough?".
   */
  tokensAfterCompaction?: number;
  /** Tokens the compressed handover is expected to carry. Defaults to the target. */
  targetTokens?: number;
}

export interface ContextDecision {
  action: ContextAction;
  /** Share of the window the context is using: C / W. */
  share: number;
  /** Tokens the conversation holds now. */
  contextTokens: number;
  /** Tokens the switch may carry after whatever this decision asks for. */
  carriedTokens: number;
  /** Tokens compression must bring the context down to (`refuseShare×W`). */
  targetTokens: number;
  /** User-visible sentence. Never empty: even `direct` says nothing was cut. */
  message: string;
  /**
   * How the next prompt is assembled. `full` = the whole conversation goes;
   * `summary-chain` = only the stage handovers go; `none` = no switch.
   */
  carry: 'full' | 'summary-chain' | 'none';
  /** Set only for `refuse`: the three choices the user gets instead of a cut. */
  options?: ContextOption[];
  /**
   * True when this decision was produced by a dry run (DEF-5): nothing was
   * compressed, nothing was booked, and `predictedCompactionCost` is a forecast.
   */
  dryRun?: boolean;
  /**
   * What compressing **would** cost, in USD; `null` when that price is unknown.
   * Only set on a dry run — a real compression books its real cost in the ledger
   * instead of predicting it here.
   */
  predictedCompactionCost?: number | null;
}

/** Absolute token thresholds for one window, printed in messages and tests. */
export function contextThresholdsFor(
  windowTokens: number,
  thresholds: ContextThresholds = DEFAULT_CONTEXT_THRESHOLDS,
): { direct: number; summary: number; compressTo: number } {
  const floor = (share: number): number => Math.max(1, Math.floor(windowTokens * share));
  return {
    direct: floor(thresholds.directShare),
    summary: floor(thresholds.summaryShare),
    compressTo: floor(thresholds.refuseShare),
  };
}

const fmtK = (tokens: number): string => `${Math.round(tokens / 100) / 10}k`;

/**
 * Decides what to do with the context before switching to a model of `windowTokens`.
 *
 * Pure and total: every input (including a nonsense window) produces a decision,
 * because the alternative is a caller that falls through to "just switch" when a
 * number was missing.
 */
export function decideContext(input: ContextDecisionInput): ContextDecision {
  const thresholds = input.thresholds ?? DEFAULT_CONTEXT_THRESHOLDS;
  const window = Math.max(1, Math.floor(input.windowTokens));
  const contextTokens = Math.max(0, Math.floor(input.contextTokens));
  const limits = contextThresholdsFor(window, thresholds);
  const share = contextTokens / window;

  const base = {
    share,
    contextTokens,
    targetTokens: limits.compressTo,
  } as const;

  // Comfortable: nothing is cut, and the sentence says so instead of staying silent.
  if (contextTokens <= limits.direct) {
    return {
      ...base,
      action: 'direct',
      carriedTokens: contextTokens,
      carry: 'full',
      message: `context ${fmtK(contextTokens)} of ${fmtK(window)} (${pct(share)}) — fits directly, nothing cut`,
    };
  }

  // Middle band: go, but only with the structured handover chain.
  if (contextTokens <= limits.summary) {
    return {
      ...base,
      action: 'summary',
      carriedTokens: contextTokens,
      carry: 'summary-chain',
      message:
        `context ${fmtK(contextTokens)} of ${fmtK(window)} (${pct(share)}) — switching with the ` +
        `stage-summary chain only; the full transcript stays behind in the session`,
    };
  }

  // Compression was already run: is the result good enough?
  const after = input.tokensAfterCompaction;
  if (after !== undefined) {
    const afterTokens = Math.max(0, Math.floor(after));
    if (afterTokens <= limits.direct) {
      return {
        ...base,
        action: 'compress',
        contextTokens: afterTokens,
        carriedTokens: afterTokens,
        carry: 'summary-chain',
        message:
          `context compressed ${fmtK(contextTokens)} → ${fmtK(afterTokens)} ` +
          `(target ≤ ${fmtK(limits.compressTo)}) — details may be lost, the transcript can still be reopened`,
      };
    }
    return {
      ...base,
      action: 'refuse',
      contextTokens: afterTokens,
      carriedTokens: 0,
      carry: 'none',
      message:
        `compression reached ${fmtK(afterTokens)}, still over ${fmtK(limits.direct)} ` +
        `(${pct(afterTokens / window)} of ${fmtK(window)}) — refusing to switch instead of truncating`,
      options: refusalOptions(window, afterTokens),
    };
  }

  // Over the compress band: compress, then ask again with `tokensAfterCompaction`.
  return {
    ...base,
    action: 'compress',
    carriedTokens: contextTokens,
    carry: 'summary-chain',
    message:
      `context ${fmtK(contextTokens)} of ${fmtK(window)} (${pct(share)}) — must be compressed to ` +
      `≤ ${fmtK(limits.compressTo)} before switching; if it cannot get there the switch is refused`,
  };
}

/** The three choices F5 §1 requires instead of a hard cut. */
export function refusalOptions(windowTokens: number, contextTokens: number): ContextOption[] {
  return [
    {
      kind: 'bigger-window',
      label: `switch to a model with a bigger window (this stage needs more than ${fmtK(windowTokens)})`,
    },
    { kind: 'stay', label: 'stay on the current model and finish this stage here' },
    {
      kind: 'split',
      label: `split the task and open a new session for the rest (${fmtK(contextTokens)} carried over)`,
    },
  ];
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * The structured handover a compression must produce (F5 §3).
 *
 * Five fields, because these are the five things a reader (or the next model)
 * cannot reconstruct from a stream of chat turns: what we are doing, what is
 * settled, what exists on disk, what numbers/decisions are load-bearing, and what
 * is still open. A summary missing any of them is a流水账, not a handover.
 */
export interface StageHandover {
  /** 1. Task goal. */
  goal: string;
  /** 2. Done + the conclusion each stage reached. */
  done: string[];
  /** 3. Artifacts with their file paths. */
  artifacts: string[];
  /** 4. Key numbers and decisions that later stages depend on. */
  keyFacts: string[];
  /** 5. Open questions and the next step. */
  open: string[];
}

/** Which of the five fields a check found missing. */
export type HandoverField = keyof StageHandover;

/** A localised, quotable check result — the "标红" the acceptance asks for. */
export interface HandoverProblem {
  field: HandoverField;
  /** `missing` = the field is absent/empty; `no-artifact-path` = paths not named. */
  kind: 'missing' | 'no-artifact-path';
  message: string;
}

export const HANDOVER_LABELS: Record<HandoverField, string> = {
  goal: '任务目标',
  done: '已完成与结论',
  artifacts: '产物清单（文件路径）',
  keyFacts: '关键数字与决定',
  open: '未决问题与下一步',
};

export function emptyHandover(): StageHandover {
  return { goal: '', done: [], artifacts: [], keyFacts: [], open: [] };
}

/** True when a handover has all five fields filled (each with at least one item). */
export function handoverComplete(handover: StageHandover): boolean {
  return validateHandover(handover).length === 0;
}

/**
 * Checks the three things §3/§4 say must survive: the artifact list, the key
 * numbers, and the outstanding work. The other two fields are checked as well —
 * a handover with no goal is not a handover — but the three are what "缺则重压或
 * 标红" is about.
 *
 * A path is not "named" unless it looks like one: "改了核心模块" is exactly the
 * sentence that makes a compressed context useless six turns later.
 */
export function validateHandover(handover: StageHandover): HandoverProblem[] {
  const problems: HandoverProblem[] = [];
  if (!nonEmpty(handover.goal)) {
    problems.push({ field: 'goal', kind: 'missing', message: '交接缺「任务目标」' });
  }
  if (!filled(handover.done)) {
    problems.push({ field: 'done', kind: 'missing', message: '交接缺「已完成与结论」' });
  }
  if (!filled(handover.artifacts)) {
    problems.push({ field: 'artifacts', kind: 'missing', message: '交接缺「产物清单」' });
  } else if (!handover.artifacts.some(looksLikePath)) {
    problems.push({
      field: 'artifacts',
      kind: 'no-artifact-path',
      message: '产物清单里没有任何文件路径（后续阶段无法据此续做）',
    });
  }
  if (!filled(handover.keyFacts)) {
    problems.push({ field: 'keyFacts', kind: 'missing', message: '交接缺「关键数字与决定」' });
  }
  if (!filled(handover.open)) {
    problems.push({ field: 'open', kind: 'missing', message: '交接缺「未决问题与下一步」' });
  }
  return problems;
}

/**
 * Renders the handover as the text that travels with the switch.
 *
 * Fixed order, fixed headings: the next model (and the user reading the notice)
 * gets the same five sections every time, which is what makes "没丢上下文" a
 * property instead of a hope.
 */
export function renderHandover(handover: StageHandover, problems: HandoverProblem[] = []): string {
  const list = (items: string[]): string => (items.length === 0 ? '（无）' : items.map((i) => `- ${i}`).join('\n'));
  const body = [
    `## 任务目标\n${handover.goal || '（缺）'}`,
    `## 已完成与结论\n${list(handover.done)}`,
    `## 产物清单（文件路径）\n${list(handover.artifacts)}`,
    `## 关键数字与决定\n${list(handover.keyFacts)}`,
    `## 未决问题与下一步\n${list(handover.open)}`,
  ].join('\n\n');
  if (problems.length === 0) return body;
  const red = problems.map((p) => `- ⚠ red: ${p.message}`).join('\n');
  return `${body}\n\n## 校验未过（需重压）\n${red}`;
}

/**
 * What the user is told after a compression (F5 §5).
 *
 * "Allowed to fail" is not allowed: a compression the user never heard about is
 * an amnesia with a clean UI. This returns the sentence **and** whether it is a
 * warning (validation failed), so the caller cannot render a red compression as
 * a normal one.
 */
export interface CompactionNotice {
  visible: true;
  warning: boolean;
  text: string;
  problems: HandoverProblem[];
}

export function compactionNotice(input: {
  tokensBefore: number;
  tokensAfter: number;
  problems: HandoverProblem[];
  /** Whether the original transcript is still reachable in the session. */
  reopenable?: boolean;
}): CompactionNotice {
  const before = fmtK(input.tokensBefore);
  const after = fmtK(input.tokensAfter);
  const reopen =
    input.reopenable === false
      ? '原文不可回看'
      : '细节可能丢失；原文可回溯';
  const base = `已把 ${before} 上下文压缩为 ${after} 交接摘要，${reopen}`;
  if (input.problems.length === 0) {
    return { visible: true, warning: false, text: base, problems: [] };
  }
  const missing = input.problems.map((p) => HANDOVER_LABELS[p.field]).join('、');
  return {
    visible: true,
    warning: true,
    text: `${base}。⚠ 交接校验未过：缺 ${missing}，建议重压`,
    problems: input.problems,
  };
}

/** The compaction call, as it was measured. Real numbers only — never an estimate. */
export interface CompactionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Which model did the compressing (the big one, or the user's choice). */
  modelKey: string;
  /** Model that will receive the handover. */
  targetModelKey: string;
}

function nonEmpty(text: string): boolean {
  return text.trim().length > 0;
}

function filled(items: string[]): boolean {
  return items.some((item) => item.trim().length > 0);
}

/** `src/core/card.ts`, `/tmp/out.md`, `docs/a/b.md` — a named file, not a vague noun. */
function looksLikePath(text: string): boolean {
  return /(^|[\s`'"(])([\w.-]+\/)+[\w.-]+|(^|[\s`'"(])[\w-]+\.(ts|js|tsx|jsx|json|md|yml|yaml|sh|py|txt|csv|png|svg|docx)\b/.test(
    text,
  );
}
