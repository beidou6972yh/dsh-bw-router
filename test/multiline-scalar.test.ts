import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRouter, type DshHostContext } from '../src/plugin/dsh-shell.js';
import { parseYamlLite, YamlLiteError, type YamlValue } from '../src/adapters/yaml-lite.js';
import {
  providerConfigsFromDocument,
  readProfileConfigFiles,
} from '../src/adapters/dsh-profile-config.js';

/**
 * 对侧（灰狼）发布 blocker：**多行纯量让整份 profile 配置报废**。
 *
 * 2026-11-15 03:5x 实测原文：「`/router/models` 报 `sources.config=0`，`skipped`
 * 首条是 `profiles/web/cordis.patch.yml: unexpected indentation (line 732)`——
 * 该行是 xerj MCP 的 `- ApiKey` 后换行续写（合法 YAML 多行纯量），插件的
 * yaml-lite 不认，整份配置被跳过。运行时仍拿到 52 个模型，能跑，但读不到配置
 * 里的价格/窗口。」
 *
 * YAML 让一个 plain scalar 折行续写：**比它所属条目更深缩进的下一行属于同一个
 * 值**，按空格折叠。DSH 自己写出的 patch 就用了这种写法（MCP `args` 里一个
 * `- ApiKey`，密钥写在下一行），而 yaml-lite 只认单行标量，于是整份文件
 * `throw` → 文件级跳过 → provider / 价格 / contextWindow 全部读不到。
 *
 * 本文件锁住三件事：
 *  1. 折行纯量能解析，值按 YAML 语义用空格折叠（不是被截断、也不是被吞掉）；
 *  2. 同一份含折行纯量的 profile，`config>0`：provider、价格、窗口都可读；
 *  3. 真正写坏的缩进仍然**大声报错**——容错不等于把坏配置当散文读。
 *
 * 密钥一律写成占位符：本仓库不得出现真实凭据（全局红线）。
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The shape 灰狼's live profile carries: an MCP entry whose `args` list has a
 * value wrapped onto the next line (`- ApiKey` / `        <key>`), followed by
 * the real route block that states prices and windows.
 */
const STRESS_PROFILE = `# cordis.patch.yml — 对侧 0.2.1-rc.2 web profile（截取 line-732 形状 + llm 路由）
- insert:
    - id: mcp-xerj
      name: '@org/dsh-mcp-client'
      config:
        serverName: xerj
        transport: stdio
        command: npx
        args:
          - -y
          - xerj-mcp
          - ApiKey
            sk-<redacted-key>
- id: llm-pi-ai
  name: "@org/dsh-llm-pi-ai"
  config:
    providers:
      freellmapi:
        displayName: FreeLLMAPI 免费池网关
        models:
          - id: auto
            name: FreeLLMAPI Auto
            contextWindow: 200000
            inputPerMTok: 0
            outputPerMTok: 0
      provider_a:
        displayName: 供应商A账号
        models:
          - id: model_a1
            name: DeepSeek Flash
            contextWindow: 1048576
            maxTokens: 65536
            inputPerMTok: 0.28
            outputPerMTok: 0.42
`;

function writeProfile(text = STRESS_PROFILE): string {
  const dir = mkdtempSync(join(tmpdir(), 'router-multiline-'));
  tempDirs.push(dir);
  const file = join(dir, 'cordis.patch.yml');
  writeFileSync(file, text, 'utf8');
  return file;
}

/** A Cordis-4-shaped context: services only through `get()`, options passthrough. */
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

async function getModels(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = cordisHost({}, options);
  const router = createRouter(ctx);
  const answer = await router.handle({ method: 'GET', path: '/router/models' });
  return { status: answer.status, ...answer.body } as Record<string, unknown>;
}

const asMap = (value: YamlValue | undefined): Record<string, YamlValue> =>
  (value ?? {}) as Record<string, YamlValue>;

describe('多行纯量：YAML 的折行续写不再让整份配置报废（灰狼 line 732）', () => {
  it('parses a plain scalar wrapped onto the next line, folding it with a space', () => {
    const document = parseYamlLite(STRESS_PROFILE);

    // The whole document parses — that is the defect: it used to throw
    // `unexpected indentation (line <continuation line>)`.
    expect(Array.isArray(document)).toBe(true);
    const insert = asMap((document as YamlValue[])[0])['insert'] as YamlValue[];
    const xerj = asMap(insert[0]);
    const args = asMap(xerj['config'])['args'] as YamlValue[];
    expect(args).toEqual(['-y', 'xerj-mcp', 'ApiKey sk-<redacted-key>']);
  });

  it('config>0: the same profile yields providers, prices and windows', async () => {
    const document = parseYamlLite(STRESS_PROFILE);
    const found = providerConfigsFromDocument(document);
    expect(found.providers.map((provider) => provider.id)).toEqual(['freellmapi', 'provider_a']);

    const flash = found.providers[1]!.models[0]!;
    // Price and window are the two fields the defect report says are unreadable.
    expect(flash.inputPerMTok).toBe(0.28);
    expect(flash.outputPerMTok).toBe(0.42);
    expect(flash.contextWindow).toBe(1_048_576);
  });

  it('readProfileConfigFiles reads the file instead of skipping it', async () => {
    const file = writeProfile();
    const scanned = await readProfileConfigFiles([file]);

    expect(scanned.skipped).toEqual([]);
    expect(scanned.filesRead).toEqual([file]);
    expect(scanned.providers).toHaveLength(2);
    const models = scanned.providers.flatMap((provider) => provider.models);
    expect(models.map((model) => model.id)).toEqual(['auto', 'model_a1']);
    expect(models[1]!.inputPerMTok).toBe(0.28);
  });

  it('/router/models reports sources.config > 0 and readable prices (the acceptance criterion)', async () => {
    const file = writeProfile();
    const answer = await getModels({ profileCandidates: [file] });

    expect(answer.status).toBe(200);
    expect(answer.skipped).toEqual([]);
    const sources = answer.sources as { runtime: number; config: number };
    expect(sources.config).toBeGreaterThan(0);
    expect(sources.config).toBe(2);
    const models = answer.models as { key: string; priceKnown: boolean; contextWindow: number | null }[];
    const flash = models.find((model) => model.key === 'provider_a/model_a1')!;
    expect(flash.priceKnown).toBe(true);
    expect(flash.contextWindow).toBe(1_048_576);
  });

  it('folds a wrapped mapping value too (`key: first` + deeper `second`)', () => {
    const document = parseYamlLite(
      ['summary: 第一行', '  第二行', 'other: 值'].join('\n'),
    ) as Record<string, YamlValue>;
    expect(document['summary']).toBe('第一行 第二行');
    expect(document['other']).toBe('值');
  });

  it('folds a value written entirely under its key (`key:` then text lines)', () => {
    // The same plain-scalar rule, the other spelling: the value starts on the
    // line *below* its key. `profiles/headless/cordis.patch.yml` is the real
    // file that exposed this path — it is a bare `[]`, which used to be
    // rejected as `expected "key: value" in "[]"`.
    const document = parseYamlLite(
      ['description:', '  第一行', '  第二行', 'tags: []'].join('\n'),
    ) as Record<string, YamlValue>;
    expect(document['description']).toBe('第一行 第二行');
    expect(document['tags']).toEqual([]);
    expect(parseYamlLite('[]\n')).toEqual([]);
  });

  it('folds a wrapped value inside a `- key: value` item', () => {
    const document = parseYamlLite(['- name: 复核', '    说明第二行', '- name: 收尾'].join('\n'));
    const items = document as Record<string, YamlValue>[];
    expect(items[0]!['name']).toBe('复核 说明第二行');
    expect(items[1]!['name']).toBe('收尾');
  });

  it('keeps the block scalars it already supported (`|` literal, `>` folded)', () => {
    const document = parseYamlLite(
      ['literal: |', '  第一行', '  第二行', 'folded: >', '  甲', '  乙'].join('\n'),
    ) as Record<string, YamlValue>;
    expect(document['literal']).toBe('第一行\n第二行');
    expect(document['folded']).toBe('甲 乙');
  });

  it('tolerates an explicit block-scalar indicator (`|2`, `>-2`)', () => {
    const document = parseYamlLite(
      ['a: |2', '    保留缩进', 'b: >-2', '    折叠', '    成一行'].join('\n'),
    ) as Record<string, YamlValue>;
    expect(document['a']).toBe('保留缩进');
    expect(document['b']).toBe('折叠 成一行');
  });

  it('still fails loudly on genuinely broken indentation — tolerance is not prose', () => {
    // A deeper line that *is* a `key: value` pair is an indentation error in
    // YAML, not a continuation: reading it as text would silently invent a value.
    expect(() => parseYamlLite(['a: 1', '  b: 2'].join('\n'))).toThrow(YamlLiteError);
    expect(() => parseYamlLite(['a: 1', '  b: 2'].join('\n'))).toThrow(/unexpected indentation/);
    // A deeper sequence item under a scalar is equally invalid.
    expect(() => parseYamlLite(['- a', '  - b'].join('\n'))).toThrow(/unexpected indentation/);
  });

  it('a file that cannot be read says why, and says what is lost (no silent 0)', async () => {
    // Unterminated flow: outside the supported subset, so the file is skipped —
    // but the reason must name the consequence, not just the line.
    const file = writeProfile('- id: llm-pi-ai\n  config:\n    providers: [ unclosed\n');
    const scanned = await readProfileConfigFiles([file]);
    expect(scanned.providers).toEqual([]);
    expect(scanned.skipped.join('\n')).toMatch(/cordis\.patch\.yml/);
    expect(scanned.skipped.join('\n')).toMatch(/unexpected indentation|unterminated/i);
    // 明确降级：失败句子必须说清代价，不能只留一个行号让人当"没配置"。
    expect(scanned.skipped.join('\n')).toMatch(/本次不生效/);
    expect(scanned.skipped.join('\n')).toMatch(/不等于没配置/);
  });
});
