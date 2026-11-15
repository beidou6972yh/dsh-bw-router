import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseYamlLite, type YamlValue } from '../src/adapters/yaml-lite.js';
import { providerConfigsFromDocument } from '../src/adapters/dsh-profile-config.js';

/**
 * 锚点/别名容错回归。
 *
 * 真实 `profiles/<profile>/cordis.patch.yml` 中段有 `retryPolicy: &zzRetryPolicy`
 * 且后文用 `*zzRetryPolicy` 引用；旧 `parseScalar` 对 `&`/`*` 直接 throw，整份
 * 文件被跳过，模型的 config 来源归零。这里用真实形状（顶层数组、llm-pi-ai 条目、
 * 两个 provider、contextWindow/maxTokens、后向引用与前向引用）锁定新行为。
 */

const FIXTURE = readFileSync(new URL('./fixtures/anchors-profile.yml', import.meta.url), 'utf8');

type MapValue = { [key: string]: YamlValue };

function isMap(value: YamlValue | undefined): value is MapValue {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function entry(document: YamlValue, id: string): MapValue {
  if (!Array.isArray(document)) throw new Error('fixture is not a top-level array');
  const found = document.find((item) => isMap(item) && item.id === id);
  if (!isMap(found)) throw new Error(`fixture entry "${id}" not found`);
  return found;
}

describe('YAML anchors and aliases are tolerated, not fatal', () => {
  it('parses the whole profile and still finds both providers and their models', () => {
    const parsed = parseYamlLite(FIXTURE);
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as YamlValue[]).map((item) => (isMap(item) ? item.id : undefined))).toEqual([
      'mcp-searxng',
      'retry-defaults',
      'forward-consumer',
      'llm-pi-ai',
      'retry-consumer',
      'later-policy',
      'agent-default-model',
    ]);

    const { providers, defaultModelKey } = providerConfigsFromDocument(parsed);
    expect(providers.map((provider) => provider.id).sort()).toEqual(['freellmapi', 'local-ollama']);
    expect(defaultModelKey).toBe('local-ollama/ornith-sysmarshal-v1.3:128k');

    const local = providers.find((provider) => provider.id === 'local-ollama')!;
    expect(local.models).toHaveLength(2);
    expect(local.models[0]).toMatchObject({
      id: 'ornith-sysmarshal-v1.3:128k',
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
    });
    expect(local.models[0]!.capabilities).toContain('vision');
    expect(local.models[1]).toMatchObject({
      id: 'qwen3.8:27b-mlx',
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
    });

    const free = providers.find((provider) => provider.id === 'freellmapi')!;
    expect(free.models[0]).toMatchObject({
      id: 'auto',
      contextWindow: 65_536,
      maxOutputTokens: 16_384,
    });
  });

  it('resolves a later *zzRetryPolicy to the block anchored earlier in the same file', () => {
    const parsed = parseYamlLite(FIXTURE);
    const defaults = entry(parsed, 'retry-defaults').config as MapValue;
    const consumer = entry(parsed, 'retry-consumer').config as MapValue;

    expect(defaults.retryPolicy).toEqual({ maxAttempts: 3, backoffMs: 250, jitter: true });
    expect(consumer.retryPolicy).toEqual(defaults.retryPolicy);
  });

  it('turns a forward/undefined alias into null instead of failing the document', () => {
    const parsed = parseYamlLite(FIXTURE);
    const forward = entry(parsed, 'forward-consumer').config as MapValue;

    expect(forward.retryPolicy).toBeNull();
    expect(forward.marker).toBe('kept');
    // The later definition itself is still readable.
    const later = entry(parsed, 'later-policy').config as MapValue;
    expect(later.policy).toEqual({ timeoutMs: 9_000 });
  });

  it('strips anchors on value and key sides and resolves them in blocks, sequences, and flows', () => {
    const parsed = parseYamlLite(
      [
        'root:',
        '  &keyAnchor key: value',
        '  plain: &valueAnchor 42',
        '  again: *valueAnchor',
        '  fromKey: *keyAnchor',
        '  seq:',
        '    - &item one',
        '    - *item',
        '  flow: { a: &flowAnchor 7, b: *flowAnchor }',
        '  missing: *neverDefined',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      root: {
        key: 'value',
        plain: 42,
        again: 42,
        fromKey: 'value',
        seq: ['one', 'one'],
        flow: { a: 7, b: 7 },
        missing: null,
      },
    });
  });

  it('does not throw on degenerate marker forms', () => {
    expect(() => parseYamlLite('a: &\nb: *\n')).not.toThrow();
  });

  it('A/B: the old "throw on &/*" rule would make the fixture unreadable', () => {
    const oldRule = (text: string): void => {
      const value = text.trim();
      if (value.startsWith('&') || value.startsWith('*')) {
        throw new Error(`unsupported YAML feature "${value[0]}"`);
      }
    };

    expect(() => oldRule('&zzRetryPolicy')).toThrow(/unsupported YAML feature/);
    expect(() => oldRule('*zzRetryPolicy')).toThrow(/unsupported YAML feature/);
    expect(() => parseYamlLite(FIXTURE)).not.toThrow();
  });
});
