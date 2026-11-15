import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultConfigPaths,
  discoverDshModels,
  mtimeOf,
  readDshConfig,
  toProviderConfigs,
  type DshConfigPaths,
} from '../src/adapters/dsh-config.js';
import { probeAll } from '../src/adapters/probe.js';
import { buildCapabilityList } from '../src/core/registry.js';
import { collectUsage } from '../src/core/usage-stats.js';
import { buildWizardDraft } from '../src/core/wizard-draft.js';

/**
 * M1-1 hard requirement: the whole discovery path is READ ONLY.
 *
 * These tests build a fake DSH home on disk, run every read path against it,
 * and assert the bytes and mtimes are untouched. Node paths come from
 * `fileURLToPath` on purpose — this repo lives under a directory with non-ASCII
 * characters, and `new URL(...).pathname` percent-encodes it.
 */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const CONFIG = {
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'reasoner', contextWindow: 128_000, inputPerMTok: 2, outputPerMTok: 8, capabilities: ['reasoning', 'coding'] },
        { id: 'flash', contextWindow: 64_000, inputPerMTok: 0.1, outputPerMTok: 0.3, capabilities: ['cheap-bulk'] },
      ],
    },
    { id: 'local', name: 'Local', models: [{ id: 'qwen-coder', contextWindow: 32_000, capabilities: ['coding'] }] },
  ],
};

let home: string;
let paths: DshConfigPaths;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-router-ro-'));
  const file = join(home, 'config.json');
  await writeFile(file, JSON.stringify(CONFIG, null, 2), 'utf8');
  paths = { candidates: [file] };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('DSH config adapter (read only)', () => {
  it('resolves repo paths without percent-encoding', () => {
    expect(REPO_ROOT).not.toContain('%');
    expect(REPO_ROOT.startsWith('/')).toBe(true);
  });

  it('reads 3 providers worth of config from disk', async () => {
    const result = await readDshConfig(paths);
    expect(result.configs).toHaveLength(2);
    expect(result.filesRead).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it('skips missing files silently and reports why', async () => {
    const result = await readDshConfig({ candidates: [join(home, 'nope.json'), paths.candidates[0]!] });
    expect(result.configs).toHaveLength(2);
    expect(result.skipped[0]).toContain('nope.json');
  });

  it('skips malformed JSON without throwing', async () => {
    const bad = join(home, 'bad.json');
    await writeFile(bad, '{ not json', 'utf8');
    const result = await readDshConfig({ candidates: [bad] });
    expect(result.configs).toEqual([]);
    expect(result.skipped[0]).toContain('not valid JSON');
  });

  it('discovery leaves the config file byte-identical (mtime unchanged)', async () => {
    const file = paths.candidates[0]!;
    const before = await stat(file);
    const bytesBefore = await readFile(file, 'utf8');

    await discoverDshModels({ paths });
    await discoverDshModels({ paths });

    const after = await stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(file, 'utf8')).toBe(bytesBefore);
  });

  it('the whole wizard data path touches nothing on disk', async () => {
    const file = paths.candidates[0]!;
    const statBefore = await stat(file);
    const bytesBefore = await readFile(file, 'utf8');

    const discovered = await discoverDshModels({ paths });
    const { registry } = buildCapabilityList([
      { source: 'dsh-config', models: discovered.models },
    ]);
    const usage = collectUsage([
      { at: '2026-10-21T10:00:00.000Z', provider: 'deepseek', model: 'reasoner' },
      { at: '2026-10-21T10:01:00.000Z', provider: 'local', model: 'qwen-coder' },
    ]);
    const draft = buildWizardDraft({ entries: registry.all(), usage });

    expect(draft.totalModels).toBe(3);
    const statAfter = await stat(file);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    expect(await readFile(file, 'utf8')).toBe(bytesBefore);
  });

  it('returns undefined mtime for a path that does not exist', async () => {
    expect(await mtimeOf(join(home, 'ghost.json'))).toBeUndefined();
  });

  it('defaults to $DSH_HOME when it is set', () => {
    const defaults = defaultConfigPaths('/tmp/dsh-home');
    expect(defaults.candidates.every((p) => p.startsWith('/tmp/dsh-home'))).toBe(true);
    expect(defaults.candidates).toHaveLength(3);
  });
});

describe('config shape tolerance', () => {
  it('accepts a bare array, a providers object, and a single provider', () => {
    expect(toProviderConfigs(CONFIG.providers)).toHaveLength(2);
    expect(toProviderConfigs(CONFIG)).toHaveLength(2);
    expect(toProviderConfigs({ id: 'solo', models: ['m1', 'm2'] })).toEqual([
      { id: 'solo', name: 'solo', models: [{ id: 'm1' }, { id: 'm2' }] },
    ]);
  });

  it('drops providers with no id and leaves empty model lists alone', () => {
    expect(toProviderConfigs([{ name: 42 }, { id: 'ok', models: [] }])).toEqual([
      { id: 'ok', name: 'ok', models: [] },
    ]);
  });

  it('merges runtime models alongside config models', async () => {
    const result = await discoverDshModels({
      paths,
      runtime: {
        providers: [{ id: 'cloud', name: 'Cloud', models: [{ id: 'diffusion-xl' }] }],
      },
    });
    expect(result.providers).toEqual(['deepseek', 'local', 'cloud']);
    expect(result.models).toHaveLength(4);
    expect(result.runtimeModels).toBe(1);
    expect(result.models.find((m) => m.provider === 'cloud')!.source).toBe('dsh-runtime');
  });
});

describe('probe keeps failures silent', () => {
  it('probes five default endpoints within the timeout budget and never throws', async () => {
    const dead = async () => {
      throw new Error('ECONNREFUSED');
    };
    const started = Date.now();
    const results = await probeAll(undefined, { fetchImpl: dead, timeoutMs: 2000 });
    expect(results).toHaveLength(5);
    expect(results.every((r) => !r.reachable)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a hanging endpoint is reported as a timeout, not an exception', async () => {
    const hanging = (_url: string, init?: { signal?: { aborted: boolean } }) =>
      new Promise<{ ok: boolean; status: number }>((_res, rej) => {
        init?.signal && setTimeout(() => rej(new Error('aborted')), 5);
      });
    const [result] = await probeAll([{ name: 'ollama', url: 'http://localhost:11434' }], {
      fetchImpl: hanging,
      timeoutMs: 1,
    });
    expect(result!.reachable).toBe(false);
    expect(result!.detail).toMatch(/timeout|aborted/);
  });
});
