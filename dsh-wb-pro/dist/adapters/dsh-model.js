/**
 * Thin wrapper over the host callbacks.
 *
 * It cannot stop DSH from writing the global default back (that happens inside
 * the platform), so it does the thing that is actually possible: it watches.
 * Every `select` snapshots the global default before and after, and a change is
 * reported in the switch result — never swallowed. Silent write-back was K-003,
 * and silence is what made it dangerous.
 */
/**
 * Model keys come in two spaces: the registry/plan space (`provider/model`) and the
 * routing space (`wb-gateway/provider/model`). One leading `wb-gateway/` is routing
 * plumbing, not a different model, so comparisons and read-backs use the registry space.
 * @param key - key as the host or a caller reported it.
 * @returns the same model key without a leading `wb-gateway/`.
 */
export function normalizeModelKey(key) {
    const raw = typeof key === 'string' ? key : String(key ?? '');
    return raw.startsWith('wb-gateway/') ? raw.slice('wb-gateway/'.length) : raw;
}
export class DshModelAdapter {
    deps;
    sessionId;
    guard;
    /**
     * @param guard optional global-default watcher; see `createGlobalDefaultGuard`.
     *   Passed separately so the kernel stays ignorant of where defaults live.
     */
    constructor(deps, sessionId, guard) {
        this.deps = deps;
        this.sessionId = sessionId;
        this.guard = guard;
    }
    /**
     * This session's id.
     *
     * A function is accepted because some hosts only learn the id after their
     * session service comes up; a resolved call keeps the adapter from freezing
     * `'current'` at activation time.
     */
    get id() {
        return typeof this.sessionId === 'function' ? this.sessionId() : this.sessionId;
    }
    current(sessionId) {
        // 261118 灰狼：网关候选优先（selectTargets）会让会话实际落在 `wb-gateway/<原生键>`，
        // 而计划/台账用的是原生键 `provider/model` ⇒ 原样比较永远不相等，每次切段都被判
        // 「unverified」（用户遇到的「第 1 段模型切换失败…请再点一次」）。
        // 这里统一读成**注册键空间**：剥掉一层 `wb-gateway/` 前缀。
        // 等价性：`wb-gateway/provider_b/X` 与 `provider_b/X` 是同一个模型，只是走网关
        // （带链内回落与网关记账，正是 C3 想要的）。剥完也是 PlanCard 里 labelOf() 能命中
        // registry 的形态，状态栏显示从「wb-gateway/…」变回模型名。
        return normalizeModelKey(this.deps.readCurrent(sessionId || this.id));
    }
    /** Model key of the user's global default, or undefined when not observable. */
    globalDefault() {
        return this.guard?.snapshot();
    }
    /** Whether the last reading actually produced a value (false = 未能观测). */
    globalDefaultObservable() {
        return this.guard?.observable?.() ?? false;
    }
    /**
     * Re-reads the global default and arms the watch at "now".
     *
     * Callers do this right before a switch: the default may have been edited in
     * settings since the plugin started, and a stale baseline would report that
     * edit as if the switch caused it.
     */
    primeGlobalDefault() {
        return this.guard?.arm();
    }
    /**
     * Switches, then reports whether the platform dragged the global default
     * along. A refused `selectModel` is reported with the same shape, so a caller
     * that only passes the method through still sees the truth.
     */
    async selectGuarded(modelKey, sessionId) {
        const before = this.guard?.snapshot();
        try {
            await this.select(sessionId || this.id, modelKey);
        }
        catch (error) {
            const moved = this.guard?.compare();
            return {
                wroteBackGlobalDefault: moved?.wroteBackGlobalDefault ?? false,
                ...(moved?.from === undefined ? {} : { from: moved.from }),
                ...(moved?.to === undefined ? {} : { to: moved.to }),
                error: error instanceof Error ? error.message : String(error),
            };
        }
        const moved = this.guard?.compare();
        return {
            wroteBackGlobalDefault: moved?.wroteBackGlobalDefault ?? false,
            ...(moved?.from === undefined ? {} : { from: moved.from }),
            ...(moved?.to === undefined ? {} : { to: moved.to }),
        };
    }
    async select(sessionId, modelKey) {
        const target = sessionId || this.id;
        if (!target) {
            // Never guess: the previous code fell back to the literal `'current'`,
            // which a real DSH host answers with `session/not-found`.
            throw new Error('session-unknown: no session id was stated by the caller and the host named none');
        }
        // 261117 Bug B：一个注册候选可能对应多个宿主 (provider, model) 写法，
        // 逐个试、全部失败才报错（有序候选见 selectTargets）。
        const targets = selectTargets(modelKey);
        const attempts = [];
        let lastError;
        for (const candidate of targets) {
            try {
                await this.deps.selectModel(target, candidate.provider, candidate.model);
                return;
            }
            catch (error) {
                lastError = error;
                attempts.push(`${candidate.provider}/${candidate.model}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // 报「全部候选都失败」，并带上每一次的原始失败：只报最后一次会让人以为是
        // 单一 provider 的问题，而这正是本缺陷当初难查的原因。
        const failure = new Error(`selectModel refused every candidate for "${modelKey}" (tried ${attempts.length}): ${attempts.join(' → ')}`);
        failure.cause = lastError;
        throw failure;
    }
}
/**
 * Generic guard over any readable cell.
 *
 * Two rules keep it honest:
 *  - unreadable (undefined) is NOT "unchanged": we say nothing and claim
 *    nothing, because a blind watch must never report "all clear";
 *  - only a change observed *during* `compare()` counts. If the default had
 *    already moved before we started watching, that is not this switch's doing,
 *    and blaming it would be as wrong as missing it.
 */
export function createGlobalDefaultGuard(read) {
    /** Whether the last *actual* read produced a value. */
    let readable = false;
    const readNow = () => {
        const value = safeRead(read);
        readable = value !== undefined;
        return value;
    };
    let baseline = readNow();
    return {
        snapshot: () => baseline,
        observable: () => readable,
        arm: () => {
            baseline = readNow();
            return baseline;
        },
        compare: () => {
            const after = readNow();
            const moved = baseline !== undefined && after !== undefined && baseline !== after;
            const result = moved
                ? { wroteBackGlobalDefault: true, from: baseline, to: after }
                : { wroteBackGlobalDefault: false };
            baseline = after;
            return result;
        },
    };
}
/** Reading the default must never throw: an unreadable cell is simply unknown. */
function safeRead(read) {
    try {
        return read();
    }
    catch {
        return undefined;
    }
}
/** Splits a model key back into the pair the platform expects. */
export function splitModelKey(modelKey) {
    const index = modelKey.indexOf('/');
    if (index <= 0 || index === modelKey.length - 1) {
        throw new Error(`splitModelKey: malformed model key "${modelKey}"`);
    }
    return { provider: modelKey.slice(0, index), model: modelKey.slice(index + 1) };
}
/**
 * Providers that are DSH 直连桥：网关不代理它们，只有原生一种写法。
 * 给它们加网关候选只会多一次注定失败的往返。
 */
const DIRECT_BRIDGE_PROVIDERS = ['provider_i', 'workbuddy'];
/**
 * Ordered (provider, model) candidates for one registry key.
 *
 * 261117 Bug B（用户令「新建对话 Pro/Max 不能用」）：网关注册的候选
 * `provider_a/model_a5` 被拆成原生 provider + model 直接下发，
 * 但原生 llm-deepseek 只声明了 `model_a1` / `model_a2` 等，
 * **没有 `model_a5`** ⇒ 会话 RPC 回 `session/model-unavailable` ⇒
 * `/router/switch` 失败 ⇒ 发送闸门永久关闭。
 *
 * 正确口径：会话持有的是**注册候选键**，先交给网关
 * （`{provider:'wb-gateway', model:<去掉 wb-gateway/ 前缀的完整候选键>}`，
 * 由网关负责链内回落与记账；Lead 实测同候选走网关返回 200），
 * 网关不认再退原生 `head/rest`。
 *
 * 261117 verifier C3：网关候选**无条件**排在首位，不再按 HEAD 白名单发放——
 * 否则 `provider_h/*` 这类未列入白名单的候选只会走原生，绕过网关
 * （无链内回落/记账），正是本次要消灭的 anti-pattern。
 * 原生兜底保持既有语义：无条件追加在网关候选之后，只在网关失败时才用得上。
 * provider_i / workbuddy 是 DSH 直连桥，网关不代理 ⇒ 只有原生一种候选。
 */
export function selectTargets(modelKey) {
    const raw = String(modelKey ?? '');
    const alreadyGateway = raw.startsWith('wb-gateway/');
    const key = alreadyGateway ? raw.slice('wb-gateway/'.length) : raw;
    // splitModelKey 负责校验格式：畸形键和以前一样立刻抛错。
    const { provider, model } = splitModelKey(key);
    if (DIRECT_BRIDGE_PROVIDERS.includes(provider))
        return [{ provider, model }];
    return [
        { provider: 'wb-gateway', model: key },
        { provider, model },
    ];
}
/**
 * Marks one model as usable — adapters own availability, core never guesses.
 *
 * C-1: this used to be `entries.map(e => e.id === key ? {...e} : e)`, which
 * compared an `id` against a registry **key** (two namespaces, so it never
 * matched) and returned a copy whose fields were identical (so it never changed
 * anything). A function named "withAvailability" that cannot affect availability
 * is worse than no function: it lets a caller believe a dead model was revived.
 *
 * It now takes `CapabilityEntry`s (the level where `available` and `notes` live),
 * matches on `key`, and reports whether anything changed — so its caller can tell
 * "marked dead" from "not in this list" without re-reading the array.
 */
export function withAvailability(entries, key, options = {}) {
    const available = options.available ?? true;
    let changed = false;
    let found = false;
    const next = entries.map((entry) => {
        if (entry.key !== key)
            return entry;
        found = true;
        if (entry.available === available && options.note === undefined)
            return entry;
        changed = true;
        return {
            ...entry,
            available,
            notes: options.note === undefined ? [...entry.notes] : [...entry.notes, options.note],
        };
    });
    return { entries: next, changed, found };
}
//# sourceMappingURL=dsh-model.js.map