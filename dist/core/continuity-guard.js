/**
 * continuity-guard.js — 换挡连续性守门（融合契约 v1.0 §四；插件侧实现）
 *
 * 只做判定，不读配置、不连上游、不持密钥、不抛错。
 * 灰度：默认 record（只判定、不拦，返回 wouldBlock=true）；DSH_ROUTER_CONTINUITY_MODE=enforce 才真拦。
 */
const sessions = new Map();
const CHECK_FIELDS = ['goal', 'done', 'next', 'why', 'ctx'];
const DEFAULT_MIN_RATIO = (() => {
  const v = Number(process.env.DSH_ROUTER_CONTINUITY_MIN_RATIO);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.8;
})();
const ENFORCE = () => String(process.env.DSH_ROUTER_CONTINUITY_MODE || 'record').toLowerCase() === 'enforce';

function missingOf(input) {
  const check = input && input.check ? input.check : {};
  return CHECK_FIELDS.filter((k) => !check[k] || String(check[k]).trim() === '');
}

export function continuityVerdict(sessionId, contextTokens, input = {}) {
  const missing = missingOf(input);
  const minRatio = Number.isFinite(input.minRatio) ? input.minRatio : DEFAULT_MIN_RATIO;
  const verdict = (code, message, ratio) => {
    if (!ENFORCE()) {
      return { allowed: true, code: 'record:' + code, wouldBlock: true, message, ratio, missing };
    }
    return { allowed: false, code, message, ratio, missing };
  };

  if (!sessionId) {
    return { allowed: true, code: 'no-session', message: '', ratio: 1, missing };
  }
  const prev = sessions.get(sessionId);
  if (!prev) {
    return { allowed: true, code: 'no-baseline', message: '', ratio: 1, missing };
  }
  if (input.goalHash && prev.goalHash && input.goalHash !== prev.goalHash) {
    return verdict('goal-drift', '换挡被拦：会话目标变了（目标指纹不一致），请保持原档继续，确认目标后再换。', null);
  }
  if (input.ctxId && prev.ctxId && input.ctxId !== prev.ctxId) {
    return verdict('ctx-changed', '换挡被拦：上下文整段标识变了（疑似重开或摘要顶替），请保持原档继续。', null);
  }
  const before = Number(prev.contextTokens) || 0;
  const now = Number(contextTokens) || 0;
  const ratio = before > 0 ? now / before : 1;
  if (before > 0 && ratio < minRatio) {
    return verdict('context-drop',
      `换挡被拦：上下文从 ${before} 掉到 ${now}（${Math.round(ratio * 100)}%，低于 ${Math.round(minRatio * 100)}%），疑似重开或摘要顶替。`,
      ratio);
  }
  return { allowed: true, code: 'ok', message: '', ratio, missing };
}

export function noteContinuity(sessionId, contextTokens, modelKey, input = {}) {
  if (!sessionId) return;
  sessions.set(sessionId, {
    contextTokens: Number(contextTokens) || 0,
    modelKey: modelKey || null,
    goalHash: input.goalHash || null,
    ctxId: input.ctxId || null,
    at: Date.now(),
  });
}

/** 测试用：清空基线。 */
export function resetContinuity() {
  sessions.clear();
}
