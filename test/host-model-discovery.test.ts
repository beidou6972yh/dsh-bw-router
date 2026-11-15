import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRouter,
  modelReport,
  type DshHostContext,
  type DshHttpRequest,
  type DshHttpResponse,
} from '../src/plugin/dsh-shell.js';
import { parseYamlLite } from '../src/adapters/yaml-lite.js';
import { providerConfigsFromDocument } from '../src/adapters/dsh-profile-config.js';
import { discoverHostModels, resolvedLimits } from '../src/adapters/dsh-host-models.js';
import { declaredDocumentPath } from '../src/plugin/dsh-shell.js';

/**
 * 灰狼 DEF-1 回归：**模型来源**。
 *
 * 报告原文要点："它只识别宿主注入的模型清单和三个配置文件，而我们的真实模型
 * 清单在本机配置里；因此扫描不到模型，模型数就是 0"。
 *
 * The tests below are written against the **real host shapes**, not against an
 * adapter-shaped stub:
 *  - a Cordis-like context whose only inject-free read is `ctx.get(name)`
 *    (reading `ctx.sessionController` on a real context throws
 *    `cannot get property … without inject`), so a plugin that probes the wrong
 *    way sees nothing;
 *  - `sessionController.modelCatalog()` exactly as
 *    `@deepseek-ai/dsh-api-session-controller` declares it
 *    (`{ default, groups: [{ id, models }], failures }`);
 *  - `llm.listProviders()` / `llm.listModels(p)` / `llm.resolveModelInfo(p, m)`
 *    exactly as `@deepseek-ai/dsh-llm` declares them;
 *  - a real `profiles/<profile>/cordis.patch.yml` written in DSH's own dialect,
 *    read through the same YAML path the plugin uses on a live install.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A context shaped the way Cordis 4 exposes one: services are reachable only
 * through `get()`, everything else throws.
 */
function cordisHost(
  services: Record<string, unknown>,
  options: Record<string, unknown> = {},
): DshHostContext {
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'get') return (name: string) => services[name];
      if (prop in options) return options[prop];
      throw new Error(`cannot get property "${prop}" without inject`);
    },
  });
  return ctx as unknown as DshHostContext;
}

function hostWithRoute(services: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const routes: { handler: (req: DshHttpRequest, res: DshHttpResponse) => unknown }[] = [];
  const ctx = cordisHost(
    { ...services, webServer: { register: (route: { handler: (typeof routes)[number]['handler'] }) => routes.push({ handler: route.handler }) } },
    options,
  );
  const router = createRouter(ctx);
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const answer = await router.handle({ method: 'GET', path });
    return { status: answer.status, ...answer.body } as Record<string, unknown>;
  };
  return { ctx, router, routes, get };
}

/** The profile patch a live DSH install really carries (trimmed to the routes). */
const REAL_PROFILE_PATCH = `# cordis.patch.yml — 用户 patch 层
- insert:
    - id: mcp-searxng
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: searxng
        transport: stdio
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
          - id: ornith-sysmarshal-v1.3:128k
            name: Ornith SysMarshal v1.3（本地 35B-A3B · 128k）
            contextWindow: 131072
            maxTokens: 8192
            input:
              - text
              - image
          - id: qwen3.8:27b-mlx
            name: Qwen3.8 27B MLX（本地 · 质量优先）
            contextWindow: 131072
            maxTokens: 8192
      freellmapi:
        displayName: FreeLLMAPI 免费池网关
        models:
          - id: auto
            name: FreeLLMAPI Auto（免费池自动路由）
            contextWindow: 131072
            maxTokens: 16384
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: local-ollama
    model: ornith-sysmarshal-v1.3:128k
`;

function writeProfilePatch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'router-profile-'));
  tempDirs.push(dir);
  const file = join(dir, 'profiles', 'web', 'cordis.patch.yml');
  mkdirSync(join(dir, 'profiles', 'web'), { recursive: true });
  writeFileSync(file, REAL_PROFILE_PATCH, 'utf8');
  return file;
}

describe('DEF-1: the model list comes from the host, not from three JSON files', () => {
  it('reads the session controller catalog + llm exact metadata through ctx.get()', async () => {
    const { get } = hostWithRoute({
      sessionController: {
        // Real 0.2.1-rc.2 shape: the controller has `selectModel`/`modelCatalog`
        // and **no** `sessionId` property (that field never existed on it).
        async modelCatalog() {
          return {
            default: { provider: 'deepseek-official', model: 'deepseek-flash' },
            routableProviders: ['deepseek-official', 'local-ollama'],
            groups: [
              {
                id: 'deepseek-official',
                name: 'DeepSeek',
                models: [
                  { id: 'deepseek-flash', name: 'DeepSeek Flash' },
                  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
                ],
              },
              {
                id: 'local-ollama',
                name: '本地 Ollama',
                models: [{ id: 'ornith-sysmarshal-v1.3:128k', name: 'Ornith' }],
              },
            ],
            failures: [],
          };
        },
      },
      llm: {
        listProviders: () => [
          { id: 'deepseek-official', name: 'DeepSeek' },
          { id: 'local-ollama', name: '本地 Ollama' },
        ],
        async listModels(provider: string) {
          return provider === 'deepseek-official'
            ? [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }]
            : [{ id: 'ornith-sysmarshal-v1.3:128k', name: 'Ornith' }];
        },
        // Real `LlmResolvedModelInfo` shape: `context.contextWindow` +
        // `defaultMaxTokens` (never a top-level `contextWindow`).
        async resolveModelInfo(provider: string, model: string) {
          return provider === 'local-ollama'
            ? { context: { contextWindow: 131_072 }, defaultMaxTokens: 8_192 }
            : { context: { contextWindow: 1_048_576 }, defaultMaxTokens: 65_536 };
        },
      },
    }, { profileCandidates: [] });

    const answer = await get('/router/models');
    expect(answer.status).toBe(200);
    // 扫到 N 个模型 — the number the defect report asked for.
    expect(answer.count).toBe(3);
    const models = answer.models as { key: string; contextWindow: number | null; limitsGuessed: boolean }[];
    expect(models.map((m) => m.key).sort()).toEqual([
      'deepseek-official/deepseek-flash',
      'deepseek-official/deepseek-v4-pro',
      'local-ollama/ornith-sysmarshal-v1.3:128k',
    ]);
    // The window is a real number because `resolveModelInfo` answered it.
    const local = models.find((m) => m.key.startsWith('local-ollama/'))!;
    expect(local.contextWindow).toBe(131_072);
    expect(local.limitsGuessed).toBe(false);
    // The host's own default route is reported, not invented.
    expect(answer.defaultModelKey).toBe('deepseek-official/deepseek-flash');
    expect(answer.sources).toEqual({ runtime: 3, config: 0 });
  });

  it('falls back to the live profile patch YAML and reports where it read', async () => {
    const file = writeProfilePatch();
    const { get } = hostWithRoute({}, { profileCandidates: [file] });

    const answer = await get('/router/models');
    expect(answer.status).toBe(200);
    expect(answer.count).toBe(3);
    expect(answer.filesRead).toEqual([file]);
    const models = answer.models as { key: string; contextWindow: number | null; capabilities: string[] }[];
    const ornith = models.find((m) => m.key === 'local-ollama/ornith-sysmarshal-v1.3:128k')!;
    expect(ornith.contextWindow).toBe(131_072);
    // `input: [text, image]` is where vision comes from; a text route gets the
    // text capabilities (otherwise every coding/writing stage stays unassigned).
    expect(ornith.capabilities).toEqual(expect.arrayContaining(['reasoning', 'coding', 'writing', 'vision']));
    const auto = models.find((m) => m.key === 'freellmapi/auto')!;
    expect(auto.capabilities).not.toContain('vision');
    expect(auto.capabilities).toEqual(expect.arrayContaining(['coding', 'writing', 'summarizing']));
  });

  it('a broken profile file is "no models from that file", never a failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'router-broken-'));
    tempDirs.push(dir);
    const file = join(dir, 'cordis.patch.yml');
    // 修正版5 contract change: anchors/aliases are now tolerated inline (see
    // test/anchors.test.ts). File-level refusal is kept for genuinely malformed
    // YAML (unterminated flow), so "broken file ≠ hard failure" still holds.
    writeFileSync(file, '- id: llm-pi-ai\n  config:\n    providers: [ unclosed\n', 'utf8');
    const { get } = hostWithRoute({}, { profileCandidates: [file] });

    const answer = await get('/router/models');
    expect(answer.status).toBe(200);
    expect(answer.count).toBe(0);
    expect(answer.filesRead).toEqual([]);
    expect((answer.skipped as string[]).join('\n')).toMatch(/cordis\.patch\.yml/);
  });

  it('a `!!js` loader expression elsewhere in the file does not hide the models', async () => {
    // The tester's live profile carries `!!js` values in unrelated entries (the
    // loader evaluates them; a reader must not). One tag must not turn the whole
    // file into "no models".
    const dir = mkdtempSync(join(tmpdir(), 'router-js-tag-'));
    tempDirs.push(dir);
    const file = join(dir, 'cordis.patch.yml');
    writeFileSync(
      file,
      [
        '- insert:',
        '    - id: mcp-searxng',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '- id: connection',
        '  config:',
        '    trustedHosts: !!js ctx.webStartup.trustedHosts',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      llama-local:',
        '        displayName: llama 本地',
        '        models:',
        '          - id: fast-9b',
        '            name: 【图】fast-9b',
        '            input: [ text, image ]',
        '            contextWindow: 98304',
        '            maxTokens: 8192',
      ].join('\n'),
      'utf8',
    );
    const { get } = hostWithRoute({}, { profileCandidates: [file] });
    const answer = await get('/router/models');
    expect(answer.count).toBe(1);
    expect((answer.models as { key: string }[])[0]!.key).toBe('llama-local/fast-9b');
  });

  it('merges config prices/windows with the runtime catalog instead of overwriting them', () => {
    // Same key from both sources: the file states a window and a price, the
    // catalog only knows the name. The merged entry must keep both numbers —
    // otherwise the guard refuses a model the config clearly describes.
    const discovery = discoverHostModels({
      catalog: { groups: [{ id: 'acme', models: [{ id: 'wide' }] }] },
      config: [
        {
          id: 'acme',
          name: 'Acme',
          models: [
            {
              id: 'wide',
              contextWindow: 200_000,
              maxOutputTokens: 8_192,
              inputPerMTok: 1,
              outputPerMTok: 4,
              capabilities: ['reasoning'],
            },
          ],
        },
      ],
    });
    expect(discovery.models).toHaveLength(1);
    const model = discovery.models[0]!;
    expect(model.limits.contextWindow).toBe(200_000);
    expect(model.limitsGuessed).toBeUndefined();
    expect(model.pricing.inputPerMTok).toBe(1);
    expect(model.source).toBe('dsh-runtime');
  });

  it('the YAML reader understands the dialect DSH writes, including flow lists and comments', () => {
    const parsed = parseYamlLite(
      [
        '# a comment line',
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      p:',
        '        displayName: "A: b"  # trailing comment',
        '        models:',
        '          - id: m1',
        '            input: [ text, image ]',
        '            contextWindow: 131072',
      ].join('\n'),
    );
    const { providers, defaultModelKey } = providerConfigsFromDocument(parsed);
    expect(defaultModelKey).toBeUndefined();
    expect(providers).toHaveLength(1);
    expect(providers[0]!.id).toBe('p');
    expect(providers[0]!.name).toBe('A: b');
    expect(providers[0]!.models[0]).toMatchObject({
      id: 'm1',
      contextWindow: 131_072,
      capabilities: expect.arrayContaining(['vision']),
    });
  });

  it('reads only the active profile when the host names it (siblings are not this process)', async () => {
    // A machine keeps several profiles side by side; `SettingsForms.documentPath()`
    // is the one authoritative pointer to the config this process runs.
    const dir = mkdtempSync(join(tmpdir(), 'router-multi-'));
    tempDirs.push(dir);
    const active = join(dir, 'profiles', 'web', 'cordis.patch.yml');
    const sibling = join(dir, 'profiles', 'headless', 'cordis.patch.yml');
    mkdirSync(join(dir, 'profiles', 'web'), { recursive: true });
    mkdirSync(join(dir, 'profiles', 'headless'), { recursive: true });
    writeFileSync(active, REAL_PROFILE_PATCH, 'utf8');
    writeFileSync(
      sibling,
      ['- id: llm-pi-ai', '  config:', '    providers:', '      ghost:', '        models:', '          - id: gone'].join('\n'),
      'utf8',
    );

    // The real shape is a **getter** (`get documentPath(): string`); a method
    // stub is what hid the `is not a function` failure from this suite.
    const { get } = hostWithRoute({
      settings: {
        get documentPath(): string {
          return active;
        },
      },
    });
    const answer = await get('/router/models');
    expect(answer.count).toBe(3);
    expect(answer.filesRead).toEqual([active]);
    const keys = (answer.models as { key: string }[]).map((model) => model.key);
    expect(keys.some((key) => key.startsWith('ghost/'))).toBe(false);
  });

  it('the report is also reachable without HTTP, so a host can log the count', async () => {
    const file = writeProfilePatch();
    const report = await modelReport(cordisHost({}, { profileCandidates: [file] }))();
    expect(report.count).toBe(3);
    expect(report.providers.sort()).toEqual(['freellmapi', 'local-ollama']);
    expect(report.defaultModelKey).toBe('local-ollama/ornith-sysmarshal-v1.3:128k');
  });
});

/**
 * 阻断 B-1 回归 + A/B：`settings.documentPath` 是真 **getter**，不是方法。
 *
 * The M2 build typed it `documentPath?: () => string` and called
 * `settings?.documentPath?.()`. On a real host that is
 * `TypeError: settings.documentPath is not a function`, the pointer is dropped,
 * and the scan reads every sibling profile (which is how a deleted provider came
 * back into the advertised list).
 */
describe('B-1: documentPath is a getter on the real host, and all three shapes are read', () => {
  it('reads a real getter, a legacy function, and a plain string; the getter path is what runs live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'router-getter-'));
    tempDirs.push(dir);
    const active = join(dir, 'profiles', 'web', 'cordis.patch.yml');
    mkdirSync(join(dir, 'profiles', 'web'), { recursive: true });
    writeFileSync(active, REAL_PROFILE_PATCH, 'utf8');

    // The real host shape.
    const live = { get documentPath(): string { return active; } };
    expect(declaredDocumentPath(live.documentPath)).toBe(active);

    // The M0/embedded shapes still work.
    expect(declaredDocumentPath(() => active)).toBe(active);
    expect(declaredDocumentPath(active)).toBe(active);
    expect(declaredDocumentPath(undefined)).toBeUndefined();

    // End to end through the shell: the active file is the only profile read.
    const { get } = hostWithRoute({
      settings: {
        get documentPath(): string {
          return active;
        },
      },
    });
    const answer = await get('/router/models');
    expect(answer.filesRead).toEqual([active]);
    expect(answer.count).toBe(3);
  });

  it('A/B: the old "call it as a function" read throws on the same getter', () => {
    const active = '/tmp/profiles/web/cordis.patch.yml';
    const settings = { get documentPath(): string { return active; } };
    // The old implementation, verbatim: `settings?.documentPath?.()`.
    const legacyRead = () =>
      (settings as unknown as { documentPath?: () => string }).documentPath?.();
    expect(legacyRead).toThrow(/not a function/);
    // The real implementation never throws and returns the pointer.
    expect(declaredDocumentPath(settings.documentPath)).toBe(active);
    // If `declaredDocumentPath` regresses to "only accept a function", this
    // assertion goes red: the value below is a string.
    expect(typeof settings.documentPath).toBe('string');
  });
});

/**
 * 阻断 B-2 回归 + A/B：`resolveModelInfo` 返回 `context.contextWindow` /
 * `defaultMaxTokens`，不是顶层 `contextWindow` / `maxOutputTokens`。
 */
describe('B-2: the resolved-model limits come from the real fields', () => {
  const realAnswer = {
    provider: 'local-ollama',
    id: 'ornith',
    name: 'Ornith',
    context: { contextWindow: 131_072 },
    defaultMaxTokens: 8_192,
  };

  it('reads context.contextWindow and defaultMaxTokens', () => {
    expect(resolvedLimits(realAnswer)).toEqual({
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
    });
    // And the merged entry is not flagged as guessed.
    const discovery = discoverHostModels({
      providers: [{ id: 'local-ollama', name: 'Ollama' }],
      modelsByProvider: { 'local-ollama': [{ id: 'ornith' }] },
      resolved: { 'local-ollama/ornith': realAnswer },
    });
    const model = discovery.models[0]!;
    expect(model.limits.contextWindow).toBe(131_072);
    expect(model.limits.maxOutputTokens).toBe(8_192);
    expect(model.limitsGuessed).toBeUndefined();
  });

  it('A/B: the old top-level read gets undefined from the real answer', () => {
    // The old implementation read exactly this:
    const legacy = {
      contextWindow: (realAnswer as { contextWindow?: number }).contextWindow,
      maxOutputTokens: (realAnswer as { maxOutputTokens?: number }).maxOutputTokens,
    };
    expect(legacy).toEqual({ contextWindow: undefined, maxOutputTokens: undefined });
    const read = resolvedLimits(realAnswer);
    expect(read.contextWindow).toBe(131_072);
    // If `resolvedLimits` ever goes back to the top-level names, `read` becomes
    // `{contextWindow: undefined}` and both assertions above go red.
    expect(read.contextWindow).not.toBe(legacy.contextWindow);
  });

  it('still reads the shallow shape a legacy host may hand over', () => {
    expect(resolvedLimits({ contextWindow: 64_000, maxOutputTokens: 4_096 })).toEqual({
      contextWindow: 64_000,
      maxOutputTokens: 4_096,
    });
    // The real field wins when both are present.
    expect(
      resolvedLimits({
        context: { contextWindow: 131_072 },
        defaultMaxTokens: 8_192,
        contextWindow: 1_000,
        maxOutputTokens: 1_000,
      }),
    ).toEqual({ contextWindow: 131_072, maxOutputTokens: 8_192 });
  });
});

/**
 * P2-4 回归：providers 嵌在 `insert:` 块里时也要被发现。
 */
describe('P2-4: providers inside an insert block are found', () => {
  it('recurses one level into entry.insert[]', () => {
    const parsed = parseYamlLite(
      [
        '- insert:',
        '    - id: llm-pi-ai',
        '      name: "@deepseek-ai/dsh-llm-pi-ai"',
        '      config:',
        '        providers:',
        '          nested-local:',
        '            displayName: 嵌套本地',
        '            models:',
        '              - id: m1',
        '                contextWindow: 65536',
        '    - id: agent-default-model',
        '      config:',
        '        provider: nested-local',
        '        model: m1',
      ].join('\n'),
    );
    const { providers, defaultModelKey } = providerConfigsFromDocument(parsed);
    expect(providers.map((provider) => provider.id)).toEqual(['nested-local']);
    expect(providers[0]!.models[0]).toMatchObject({ id: 'm1', contextWindow: 65_536 });
    expect(defaultModelKey).toBe('nested-local/m1');
  });

  it('does not mistake a top-level entry for a nested one', () => {
    const parsed = parseYamlLite(
      ['- id: llm-pi-ai', '  config:', '    providers:', '      top:', '        models:', '          - id: m2'].join('\n'),
    );
    const { providers } = providerConfigsFromDocument(parsed);
    expect(providers.map((provider) => provider.id)).toEqual(['top']);
  });
});
