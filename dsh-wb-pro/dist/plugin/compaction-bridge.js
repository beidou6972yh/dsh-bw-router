/** The lifecycle state a fallback agent must be in (`Agent.status`). */
const RUNNING = 'running';
/**
 * Builds the `RouterDeps.compact` hook from the host's own compaction service.
 *
 * @returns `undefined` when the host offers no compaction — the caller then
 *   falls back to the legacy `ctx.compact`, and failing that the switch keeps
 *   its safe refusal instead of pretending the context shrank.
 */
export function createHostCompaction(probe) {
    const engine = probe.engine;
    if (!engine)
        return undefined;
    const compressOne = engine.compactIfNeeded?.bind(engine) ?? engine.compactNow?.bind(engine);
    if (!compressOne)
        return undefined;
    return async ({ tokensBefore, targetModelKey, sessionId }) => {
        // The request's session (when it named one) wins over the probe thunk: the
        // thunk is "the last session resolved", which a concurrent request could
        // have changed between the resolve and this await.
        const agent = resolveAgent(sessionId === undefined ? probe : { ...probe, sessionId });
        if (!agent) {
            throw new Error('宿主有压缩服务，但找不到承载本次会话的 agent（ctx.agents.get(sessionId)/currentInitiator ' +
                '都没有答，agents.list() 里也没有唯一的 running 会话）：拒绝在未确认压缩对象的情况下切换');
        }
        const session = agent.session;
        if (!session) {
            throw new Error('宿主的 agent 没有会话对象，无法压缩：拒绝切换而不是截断');
        }
        // `pressure` is the automatic policy trigger. `context-overflow` is reserved
        // for a provider-confirmed overflow; the router's own 80% band is pressure.
        const signal = new AbortController().signal;
        const result = engine.compactIfNeeded
            ? await engine.compactIfNeeded(agent, 'pressure', signal)
            : await engine.compactNow(agent, signal);
        if (!result) {
            throw new Error('宿主的压缩服务判定没有可安全压缩的范围（compactIfNeeded → null）：' +
                '上下文无法再缩小，按约定拒绝切换而不是截断');
        }
        const tokensAfter = measureAfter(probe, session);
        const facts = summaryFacts(session, result);
        const modelKey = facts?.modelKey ??
            (agent.options?.provider && agent.options.model
                ? `${agent.options.provider}/${agent.options.model}`
                : (targetModelKey ?? 'host-compaction'));
        return {
            tokensAfter,
            inputTokens: facts?.inputTokens ?? 0,
            outputTokens: facts?.outputTokens ?? 0,
            modelKey,
            // The host reports tokens, not money: the kernel books the tokens with no
            // price rather than inventing one ("never ¥0 as a claim").
            cost: null,
            // Compaction replaces a span with a durable summary node inside the same
            // session, so the transcript stays reopenable from the log.
            reopenable: true,
        };
    };
}
/**
 * Finds the agent that owns the session being routed.
 *
 * Order matters and is honest about why:
 *  1. the session this request resolved (`sessionId` thunk → `agents.get(id)`);
 *     an HTTP handler has no initiating agent, so a request-supplied id is the
 *     only reliable way in on a real host;
 *  2. the agent initiating the current operation (`currentInitiator()`), which
 *     is what a plugin acting inside a turn should use;
 *  3. the only **running** agent, when there is exactly one — a single-agent
 *     host names nothing because there is nothing to name;
 *  4. otherwise nothing: guessing between several sessions would compress the
 *     wrong conversation, which is worse than refusing.
 */
export function resolveAgent(probe) {
    const agents = probe.agents;
    if (!agents)
        return undefined;
    const sessionId = typeof probe.sessionId === 'function' ? probe.sessionId() : probe.sessionId;
    if (sessionId && agents.get) {
        const found = agents.get(sessionId);
        if (found)
            return found;
    }
    const initiator = agents.currentInitiator?.();
    if (initiator)
        return initiator;
    const live = agents.list?.() ?? [];
    // `running` **and** exactly one: two live sessions mean there is no honest way
    // to pick one, and compressing a different conversation is worse than saying
    // "cannot locate the agent" (the caller then refuses the switch).
    const running = live.filter((agent) => Boolean(agent) && typeof agent === 'object' && agent.status === RUNNING);
    if (running.length === 1)
        return running[0];
    return undefined;
}
/**
 * The context size after compaction, from the host's own token meter.
 *
 * A meter is required rather than optional: the only other arithmetic available
 * here (`tokensBefore − shadowedTokenCount`) *omits the summary's own tokens*, so
 * it would report a smaller context than the provider will actually receive.
 * That is exactly the "silently pretend it fits" failure this project refuses —
 * so a host without a meter gets a refusal, not a guess. (`compaction-basic`
 * itself injects the token meter, so a host with compaction has one.)
 */
function measureAfter(probe, session) {
    const meter = probe.tokenMeter;
    if (!meter) {
        throw new Error('宿主没有 token 计量服务：无法确认压缩后的上下文大小，拒绝切换');
    }
    const measurement = meter.measure(session);
    const total = measurement?.totalTokens;
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) {
        throw new Error('宿主的 token 计量没有返回可用数值：无法确认压缩结果，拒绝切换');
    }
    return total;
}
/**
 * Reads the provider-reported usage of the compaction call.
 *
 * `CompactionResult` carries the summary's seq, and the host's durable
 * `compaction/summary` event right there carries `usage`, `provider` and
 * `model`. Reading it back is how the router books the **real** cost of
 * compressing instead of estimating it.
 */
function summaryFacts(session, result) {
    const event = session.eventAt?.(result.summarySeq);
    if (!event || event.type !== 'compaction/summary')
        return undefined;
    const data = event.data;
    if (!data || typeof data !== 'object')
        return undefined;
    const record = data;
    const usage = record.usage;
    const usageRecord = usage && typeof usage === 'object' ? usage : undefined;
    const input = usageRecord?.inputTokens;
    const output = usageRecord?.outputTokens;
    const provider = typeof record.provider === 'string' ? record.provider : undefined;
    const model = typeof record.model === 'string' ? record.model : undefined;
    return {
        inputTokens: typeof input === 'number' && Number.isFinite(input) ? input : 0,
        outputTokens: typeof output === 'number' && Number.isFinite(output) ? output : 0,
        ...(provider && model ? { modelKey: `${provider}/${model}` } : {}),
    };
}
//# sourceMappingURL=compaction-bridge.js.map