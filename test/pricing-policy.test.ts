import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRouter, type DshHostContext } from '../src/plugin/dsh-shell.js';
import { ROUTER_PREFIX } from '../src/plugin/endpoints.js';
import { UNPRICED_HOST_NOTICE, UNPRICED_OPT_IN_NOTICE, parsePricingPolicy, resolvePricing } from '../src/core/pricing.js';
import { PluginHost } from '../src/plugin/index.js';

/**
 * 铁律 5, honest-degradation form — the real-host hard block.
 *
 * Measured on this machine's real profile (`profiles/web/cordis.patch.yml`) and
 * on 灰狼's host: provider config states **no** `inputPerMTok`/`outputPerMTok`
 * (real billing lives in LiteLLM), so `guardSwitch`'s old default
 * `requireKnownPricing ?? true` refused every stage:
 *
 *   POST /router/plan        → 200, 3 rows, every row guard `price-unknown`
 *   POST /router/plan/confirm → **400 plan-blocked**
 *       "stage-1 … has no price configured, so the run cannot be costed"
 *
 * i.e. on a real host no plan could ever start. The fix is not "delete the law";
 * it is: when the catalog prices **nothing**, allow the run and say out loud
 * that the estimate is unavailable and the tokens are still booked. When the
 * catalog prices **some** models, 铁律 5 stays strict unless the request opts in
 * with `allowUnknownPricing: true`.
 *
 * These tests are shaped like the real host, not like injected objects:
 *  - the model list comes from a real `cordis.patch.yml` written in DSH's own
 *    dialect and read through `profileCandidates`;
 *  - the context is a Cordis-like proxy: `get(name)` for services, **every**
 *    uninjected property throws;
 *  - the calls go through `createRouter(...).handle`, i.e. the HTTP seam.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A live profile patch with **no** price fields anywhere (the real machine). */
const UNPRICED_PATCH = `# cordis.patch.yml — user patch layer (trimmed to the routes)
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      local-ollama:
        displayName: 本地 Ollama（局域网）
        apiKeyEnv: LOCAL_OLLAMA_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1
        models:
          - id: wide-local
            name: 本地宽窗模型（128k）
            contextWindow: 131072
            maxTokens: 8192
          - id: second-local
            name: 本地次选模型（128k）
            contextWindow: 131072
            maxTokens: 8192
      freellmapi:
        displayName: 免费池网关
        apiKeyEnv: FREELLMAPI_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:3001/v1
        models:
          - id: auto
            name: 免费池 Auto
            contextWindow: 131072
            maxTokens: 16384
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: local-ollama
    model: wide-local
`;

/**
 * A **mixed** catalog: one priced model and one unpriced coder.
 *
 * Stage 2 of `analyze/implement/write` needs `coding`, which only the unpriced
 * model declares — so the plan has exactly one unpriced row and the default
 * stance must keep 铁律 5 there.
 */
const MIXED_PATCH = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      acme:
        displayName: Acme
        api: openai-completions
        baseURL: http://127.0.0.1:9999/v1
        models:
          - id: priced-basic
            name: Priced Basic
            contextWindow: 131072
            maxTokens: 8192
            inputPerMTok: 1
            outputPerMTok: 4
            capabilities:
              - reasoning
              - writing
          - id: unpriced-coder
            name: Unpriced Coder
            contextWindow: 131072
            maxTokens: 8192
            capabilities:
              - coding
`;

function writeProfilePatch(patch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'router-pricing-'));
  tempDirs.push(dir);
  const file = join(dir, 'profiles', 'web', 'cordis.patch.yml');
  mkdirSync(join(dir, 'profiles', 'web'), { recursive: true });
  writeFileSync(file, patch, 'utf8');
  return file;
}

interface RigOptions {
  /** The profile patch the shell scans; defaults to the unpriced (real) one. */
  patch?: string;
  /** `ctx.compact`: the host's own compaction, for the near-window switch. */
  compact?: boolean;
  /** What the compaction reports after running. */
  tokensAfter?: number;
  /** Host/config pricing stance; absent = `auto`. */
  pricingPolicy?: string;
  /** Extra services reachable through `ctx.get(name)`. */
  services?: Record<string, unknown>;
}

/** A context shaped the way Cordis 4 exposes one: `get()` works, the rest throws. */
function rig(options: RigOptions = {}) {
  const file = writeProfilePatch(options.patch ?? UNPRICED_PATCH);
  const order: string[] = [];
  let current = 'local-ollama/wide-local';

  const sessionController = {
    sessionId: 'session-real-shape',
    readCurrent: () => current,
    async selectModel(request: { provider: string; model: string }) {
      order.push('select');
      current = `${request.provider}/${request.model}`;
    },
  };

  const services: Record<string, unknown> = {
    sessionController,
    ...(options.services ?? {}),
  };
  const extras: Record<string, unknown> = {
    // The real scan path: the active profile's patch file, read-only.
    profileCandidates: [file],
  };
  if (options.pricingPolicy !== undefined) extras.pricingPolicy = options.pricingPolicy;
  if (options.compact) {
    extras.compact = async (input: { tokensBefore: number }) => {
      order.push('compact');
      const after = options.tokensAfter ?? Math.max(1, Math.floor(input.tokensBefore * 0.3));
      return {
        tokensAfter: after,
        inputTokens: input.tokensBefore,
        outputTokens: 500,
        modelKey: 'local-ollama/second-local',
        // No price on this host: the compaction books tokens and no money.
        cost: null,
        reopenable: true,
      };
    };
  }

  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'get') return (name: string) => services[name];
      if (prop in extras) return extras[prop];
      throw new Error(`cannot get property "${prop}" without inject`);
    },
  }) as unknown as DshHostContext;

  const router = createRouter(ctx);
  return { router, order, ctx, current: () => current };
}

type Router = ReturnType<typeof rig>['router'];

async function call(
  router: Router,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const answer = await router.handle({ method, path: `${ROUTER_PREFIX}${path}`, ...(body ? { body } : {}) });
  return { status: answer.status, body: answer.body };
}

const PLAN_BODY = {
  taskId: 'pricing-real',
  summary: '真机形状的价格策略',
  stageNames: ['analyze', 'implement', 'write'],
  estimatedInputTokens: 20_000,
};

/** A card row, as the endpoint serializes it. */
interface CardRow {
  stageId: string;
  modelKey: string | null;
  cost: string;
  guard?: { code: string; allowed: boolean };
}

interface CardShape {
  rows: CardRow[];
  footer: string;
  canStart: boolean;
  pricing: {
    policy: string;
    mode: string;
    catalogHasPrices: boolean;
    requireKnownPricing: boolean;
    notice?: string;
  };
  pricingNotice?: string;
}

describe('全表无价（真机常态）：允许 confirm/switch，但明示预估不可用', () => {
  it('plan 与 confirm 都返回 200，卡片/footer 在价格上明示「宿主未配价」', async () => {
    const { router } = rig();

    // The scan really read the profile file, and really found no price.
    const models = await call(router, 'GET', '/models');
    expect(models.status).toBe(200);
    expect(models.body.count).toBe(3);
    const catalog = models.body.pricing as { mode: string; catalogHasPrices: boolean };
    expect(catalog.mode).toBe('host-unpriced');
    expect(catalog.catalogHasPrices).toBe(false);
    expect((models.body.models as { priceKnown: boolean }[]).every((m) => m.priceKnown === false)).toBe(true);

    const planned = await call(router, 'POST', '/plan', PLAN_BODY);
    expect(planned.status).toBe(200);
    const card = planned.body.card as CardShape;
    expect(card.rows).toHaveLength(3);
    // Every row has a model, and the price rule no longer refuses it.
    expect(card.rows.every((row) => row.modelKey !== null)).toBe(true);
    expect(card.rows.map((row) => row.guard?.code)).toEqual(['ok', 'ok', 'ok']);
    expect(card.canStart).toBe(true);
    // The money line is not a number, and it says why in one place only.
    expect(card.footer).toContain('price unknown');
    expect(card.footer).toContain(UNPRICED_HOST_NOTICE);
    expect(card.footer).toContain('未配价');
    expect(card.pricing).toMatchObject({
      policy: 'auto',
      mode: 'host-unpriced',
      catalogHasPrices: false,
      requireKnownPricing: false,
      notice: UNPRICED_HOST_NOTICE,
    });
    expect(card.pricingNotice).toBe(UNPRICED_HOST_NOTICE);
    expect(planned.body.pricing).toMatchObject({ mode: 'host-unpriced' });

    const planId = String(planned.body.planId);
    const confirmed = await call(router, 'POST', '/plan/confirm', { planId });
    // The hard block this whole change is about: it used to be 400 plan-blocked.
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.approvedAt).toEqual(expect.any(String));
    expect(confirmed.body.pricing).toMatchObject({ mode: 'host-unpriced', notice: UNPRICED_HOST_NOTICE });

    const state = (await call(router, 'GET', '/state')).body.state as {
      active: boolean;
      pricing: { mode: string; notice?: string };
      spent: { actualCost: number; unpricedStages: number };
    };
    expect(state.active).toBe(true);
    expect(state.pricing.mode).toBe('host-unpriced');
    expect(state.pricing.notice).toBe(UNPRICED_HOST_NOTICE);
  });

  it('switch 不被价格拦；账本记 token 与 unpricedStages，cost 是 null 不是 0', async () => {
    const { router, order, current } = rig();
    const planned = await call(router, 'POST', '/plan', PLAN_BODY);
    const planId = String(planned.body.planId);
    const card = planned.body.card as CardShape;
    const stage1 = card.rows.find((row) => row.stageId === 'stage-1')!;

    await call(router, 'POST', '/plan/confirm', { planId });
    const switched = await call(router, 'POST', '/switch', {
      planId,
      stageId: 'stage-1',
      contextTokens: 1_000,
      expectedOutputTokens: 500,
    });
    expect(switched.status).toBe(200);
    expect(switched.body.switched).toBe(true);
    expect(switched.body.pricing).toMatchObject({ mode: 'host-unpriced' });
    expect(String(switched.body.message)).not.toContain('no price configured');
    // The session really moved to the planned model.
    expect(current()).toBe(stage1.modelKey);

    // Booking: real tokens, unknown money.
    const finished = await call(router, 'POST', '/stage/finish', {
      planId,
      stageId: 'stage-1',
      inputTokens: 12_345,
      outputTokens: 678,
    });
    expect(finished.status).toBe(200);
    const state = finished.body.state as {
      spent: { actualCost: number; unpricedStages: number };
      stages: { stageId: string; actualCost?: number }[];
      pricing: { notice?: string };
    };
    expect(state.spent.unpricedStages).toBe(1);
    // No invented dollars: the total stays 0 *and* says one stage is unpriced.
    expect(state.spent.actualCost).toBe(0);
    expect(state.pricing.notice).toBe(UNPRICED_HOST_NOTICE);
    // A stage with no price has no `actualCost` field at all — not 0.
    expect(state.stages.find((s) => s.stageId === 'stage-1')!.actualCost).toBeUndefined();

    const entry = router.host.ledger
      .forPlan(planId)
      .find((event) => event.type === 'stage-end' && event.stageId === 'stage-1')!;
    expect(entry.inputTokens).toBe(12_345);
    expect(entry.outputTokens).toBe(678);
    expect('cost' in entry).toBe(false); // never booked as $0
    expect(router.host.stageCost('stage-1', planId)).toBeNull();
    expect(router.host.ledger.totals().actualCost).toBe(0);
    expect(router.host.ledger.totals().unpricedStages).toBe(1);

    const reconcile = await call(router, 'GET', `/reconcile?planId=${planId}`);
    const row = (reconcile.body.reconcile as { rows: { stageId: string; actual: number | null; within: boolean | null }[] })
      .rows.find((r) => r.stageId === 'stage-1')!;
    expect(row.actual).toBeNull();
    expect(row.within).toBeNull();
  });

  it('逼近窗口时仍走「先压缩再切」，价格规则不插队', async () => {
    const { router, order } = rig({ compact: true, tokensAfter: 40_000 });
    const planned = await call(router, 'POST', '/plan', PLAN_BODY);
    const planId = String(planned.body.planId);
    await call(router, 'POST', '/plan/confirm', { planId });

    // 110k of a 131k window = 84%: past the 70% summary band, into `compress`.
    const switched = await call(router, 'POST', '/switch', {
      planId,
      stageId: 'stage-1',
      contextTokens: 110_000,
      expectedOutputTokens: 1_000,
    });
    expect(switched.status).toBe(200);
    expect(switched.body.switched).toBe(true);
    // The compaction ran **before** the select — the DEF-2 order, still intact.
    expect(order).toEqual(['compact', 'select']);
    expect((switched.body.context as { action: string }).action).toBe('compress');
    expect((switched.body.compaction as { text: string }).text).toContain('压缩');
    expect(switched.body.code).toBeUndefined();
    expect(switched.body.pricing).toMatchObject({ mode: 'host-unpriced' });
  });
});

describe('混合目录（部分有价）：默认 price-unknown，显式 opt-in 才放行', () => {
  it('无价模型默认被拒，拒绝码仍是 price-unknown', async () => {
    const { router } = rig({ patch: MIXED_PATCH });
    const planned = await call(router, 'POST', '/plan', PLAN_BODY);
    expect(planned.status).toBe(200);
    const card = planned.body.card as CardShape;
    const unpriced = card.rows.find((row) => row.stageId === 'stage-2')!;
    expect(unpriced.modelKey).toBe('acme/unpriced-coder');
    expect(unpriced.guard).toMatchObject({ code: 'price-unknown', allowed: false });
    // 铁律 5 in force: one model in the catalog states a price, so unpriced is
    // not the norm here and the card must not promise a startable run.
    expect(card.canStart).toBe(false);
    expect(card.pricing).toMatchObject({ mode: 'strict', catalogHasPrices: true, requireKnownPricing: true });
    expect(card.pricing.notice).toBeUndefined();

    const planId = String(planned.body.planId);
    const confirmed = await call(router, 'POST', '/plan/confirm', { planId });
    expect(confirmed.status).toBe(400);
    expect(confirmed.body.code).toBe('plan-blocked');
    expect((confirmed.body.stages as { stageId: string; code: string }[])[0]?.code).toBe('price-unknown');
    expect(String(confirmed.body.error)).toContain('no price configured');
    // And the refusal names the stance: a bare `price-unknown` looks like a bug.
    expect(confirmed.body.pricing).toMatchObject({ mode: 'strict', catalogHasPrices: true });
  });

  it('已开工的计划遇上「后来才有了价格」：switch 仍以 price-unknown 拒绝（码不是文案）', async () => {
    // Real sequence: the host prices nothing, so the plan starts; then a provider
    // with prices is configured. The catalog becomes mixed, 铁律 5 applies again,
    // and the running plan must stop instead of quietly running unpriced.
    const { router } = rig();
    const planned = await call(router, 'POST', '/plan', PLAN_BODY);
    const planId = String(planned.body.planId);
    expect((await call(router, 'POST', '/plan/confirm', { planId })).status).toBe(200);

    router.host.registerModels([
      {
        id: 'acme/known',
        provider: 'acme',
        model: 'known',
        label: 'Known',
        capabilities: ['reasoning', 'coding', 'writing'],
        limits: { contextWindow: 131_072, maxOutputTokens: 8_192, supportsTools: true, supportsImages: false },
        pricing: { inputPerMTok: 1, outputPerMTok: 4 },
        strength: 0.5,
        source: 'dsh-config',
      },
    ]);

    const switched = await call(router, 'POST', '/switch', {
      planId,
      stageId: 'stage-1',
      contextTokens: 1_000,
      expectedOutputTokens: 500,
    });
    expect(switched.status).toBe(409);
    expect(switched.body.switched).toBe(false);
    expect(switched.body.code).toBe('price-unknown');
    expect(String(switched.body.message)).toContain('no price configured');
    expect(switched.body.pricing).toMatchObject({ mode: 'strict', catalogHasPrices: true });

    // Explicit opt-in on the switch itself is the documented way through.
    const allowed = await call(router, 'POST', '/switch', {
      planId,
      stageId: 'stage-1',
      contextTokens: 1_000,
      expectedOutputTokens: 500,
      allowUnknownPricing: true,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.pricing).toMatchObject({ mode: 'opt-in', notice: UNPRICED_OPT_IN_NOTICE });
  });

  it('请求体 allowUnknownPricing:true 时通过，并在响应里带同样的明示', async () => {
    // plan-time opt-in: the card it returns must already be startable, or the
    // caller would be told "cannot start" and then allowed to start.
    const { router } = rig({ patch: MIXED_PATCH });
    const planned = await call(router, 'POST', '/plan', { ...PLAN_BODY, allowUnknownPricing: true });
    expect(planned.status).toBe(200);
    const card = planned.body.card as CardShape;
    expect(card.rows.every((row) => row.guard?.code === 'ok')).toBe(true);
    expect(card.canStart).toBe(true);
    expect(card.pricing).toMatchObject({ mode: 'opt-in', requireKnownPricing: false, notice: UNPRICED_OPT_IN_NOTICE });
    expect(card.footer).toContain(UNPRICED_OPT_IN_NOTICE);

    const planId = String(planned.body.planId);
    const confirmed = await call(router, 'POST', '/plan/confirm', { planId });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.pricing).toMatchObject({ mode: 'opt-in' });

    const switched = await call(router, 'POST', '/switch', {
      planId,
      stageId: 'stage-2',
      contextTokens: 5_000,
      expectedOutputTokens: 500,
    });
    expect(switched.status).toBe(200);
    expect(switched.body.switched).toBe(true);
    expect(switched.body.pricing).toMatchObject({ mode: 'opt-in', notice: UNPRICED_OPT_IN_NOTICE });
  });

  it('confirm / switch 也能各自 opt-in，且只作用于该计划', async () => {
    const { router } = rig({ patch: MIXED_PATCH });
    const planned = await call(router, 'POST', '/plan', PLAN_BODY);
    const planId = String(planned.body.planId);

    // Default confirm still refuses...
    expect((await call(router, 'POST', '/plan/confirm', { planId })).status).toBe(400);
    // ...and confirm with the flag is the way through.
    const confirmed = await call(router, 'POST', '/plan/confirm', { planId, allowUnknownPricing: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.pricing).toMatchObject({ mode: 'opt-in' });
    // The plan's own opt-in is what the next switch reads, so no flag needed.
    const switched = await call(router, 'POST', '/switch', { planId, stageId: 'stage-2' });
    expect(switched.status).toBe(200);

    // A different plan on the same host is not affected: the opt-in is per plan.
    const other = await call(router, 'POST', '/plan', { ...PLAN_BODY, taskId: 'pricing-other' });
    expect(other.body.pricing).toMatchObject({ mode: 'strict' });
    expect((await call(router, 'POST', '/plan/confirm', { planId: String(other.body.planId) })).status).toBe(400);
  });

  it('宿主 pricingPolicy=strict 时，全表无价也仍拒绝（运营方的话优先）', async () => {
    const { router } = rig({ pricingPolicy: 'strict' });
    const planned = await call(router, 'POST', '/plan', PLAN_BODY);
    const card = planned.body.card as CardShape;
    expect(card.pricing).toMatchObject({ policy: 'strict', mode: 'strict', requireKnownPricing: true });
    expect(card.canStart).toBe(false);
    expect((await call(router, 'POST', '/plan/confirm', { planId: String(planned.body.planId) })).status).toBe(400);
  });

  it('宿主 pricingPolicy=allow-unknown 时，混合目录也不拦，并说明是配置放行', async () => {
    const { router } = rig({ patch: MIXED_PATCH, pricingPolicy: 'allow-unknown' });
    const planned = await call(router, 'POST', '/plan', PLAN_BODY);
    const card = planned.body.card as CardShape;
    expect(card.pricing).toMatchObject({ policy: 'allow-unknown', mode: 'policy-allow', requireKnownPricing: false });
    expect(card.pricing.notice).toContain('配置允许无价模型');
    expect(card.canStart).toBe(true);
  });
});

describe('策略解析本身（core，不依赖宿主）', () => {
  it('缺省 auto + 有价 => strict；auto + 全无价 => 放宽', () => {
    expect(resolvePricing({ catalogHasPrices: true })).toMatchObject({ mode: 'strict', requireKnownPricing: true });
    expect(resolvePricing({ catalogHasPrices: false })).toMatchObject({
      mode: 'host-unpriced',
      requireKnownPricing: false,
      notice: UNPRICED_HOST_NOTICE,
    });
  });

  it('opt-in 只在混合目录里改变结论，不能盖过宿主 strict', () => {
    expect(resolvePricing({ catalogHasPrices: true, requestedAllowUnknown: true })).toMatchObject({ mode: 'opt-in' });
    expect(
      resolvePricing({ catalogHasPrices: true, policy: 'strict', requestedAllowUnknown: true }),
    ).toMatchObject({ mode: 'strict', requireKnownPricing: true });
  });

  it('配置里的垃圾值落回 auto，不被当成 strict 或 allow-unknown', () => {
    expect(parsePricingPolicy('STRICT')).toBe('strict');
    expect(parsePricingPolicy('allow_unknown')).toBe('allow-unknown');
    expect(parsePricingPolicy('nonsense')).toBe('auto');
    expect(parsePricingPolicy(undefined)).toBe('auto');
    expect(parsePricingPolicy(42)).toBe('auto');
  });

  it('手工构造的宿主默认 auto：只有模型清单里存在价格时才严格', () => {
    const host = new PluginHost({ current: () => '', select: async () => undefined });
    // Empty catalog: nothing is priced, so the stance is the relaxed one.
    expect(host.pricing).toMatchObject({ policy: 'auto', mode: 'host-unpriced' });
    host.registerModels([
      {
        id: 'acme/known',
        provider: 'acme',
        model: 'known',
        label: 'Known',
        capabilities: ['reasoning'],
        limits: { contextWindow: 100_000, maxOutputTokens: 8_000, supportsTools: true, supportsImages: false },
        pricing: { inputPerMTok: 1, outputPerMTok: 2 },
        strength: 0.5,
        source: 'dsh-config',
      },
    ]);
    expect(host.pricing).toMatchObject({ mode: 'strict', catalogHasPrices: true, requireKnownPricing: true });
    host.setPricingPolicy('allow-unknown');
    expect(host.pricing).toMatchObject({ mode: 'policy-allow', requireKnownPricing: false });
  });
});
