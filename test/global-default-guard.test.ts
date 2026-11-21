import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DshModelAdapter,
  createGlobalDefaultGuard,
  splitModelKey,
} from '../src/adapters/dsh-model.js';
import { PluginHost } from '../src/plugin/index.js';
import { allModels } from './fixtures/models.js';
import { createRouter, observeGlobalDefault, type DshHostContext } from '../src/plugin/dsh-shell.js';
import { ROUTER_PREFIX } from '../src/plugin/endpoints.js';

/**
 * F2 / B4: the platform writes the global default back on every session switch
 * (K-003). The plugin cannot reach into the platform, so it does the only
 * honest thing available: it *sees* it, says it out loud, and books it.
 *
 * The assertions here run against **real files on disk**: md5 and mtime are
 * taken before and after a full plugin switch, so "nothing was written" is a
 * measured fact, not a mocked promise.
 */

let home: string;
let defaultPath: string;
let patchPath: string;
let sessionPath: string;

const DEFAULT_YML = 'agent-default-model: deepseek/flash\nmodel: deepseek/flash\n';
const PATCH_YML = 'agent-default-model: deepseek/flash\n';

async function md5(file: string): Promise<string> {
  return createHash('md5').update(await readFile(file, 'utf8')).digest('hex');
}

async function fingerprint(file: string): Promise<{ md5: string; mtimeMs: number }> {
  const info = await stat(file);
  return { md5: await md5(file), mtimeMs: info.mtimeMs };
}

async function writeDefaults(modelKey: string): Promise<void> {
  await writeFile(defaultPath, `agent-default-model: ${modelKey}\nmodel: ${modelKey}\n`, 'utf8');
  await writeFile(patchPath, `agent-default-model: ${modelKey}\n`, 'utf8');
}

/** Reads the global default the way a user's settings file would tell us. */
async function readGlobalDefault(): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(defaultPath, 'utf8');
  } catch {
    return undefined; // a missing settings file is "unknown", not a crash
  }
  const match = /^agent-default-model:\s*(\S+)\s*$/m.exec(text);
  return match?.[1];
}

interface PlatformOptions {
  /** Simulates DSH: `selectModel` also rewrites the global default (fire-and-forget). */
  wroteBack?: boolean;
  /** Simulates a platform that acks and ignores the switch. */
  deaf?: boolean;
  fail?: boolean;
}

function dshPlatform(options: PlatformOptions = {}) {
  let session = 'deepseek/flash';
  /** Mirrors the default file into the guard's cell, like a real host watches it. */
  let mirror: ((value: string) => void) | undefined;
  return {
    observe: (fn: (value: string) => void) => {
      mirror = fn;
    },
    selectModel: async (_session: string, provider: string, model: string) => {
      const key = `${provider}/${model}`;
      if (options.fail) throw new Error('platform said no');
      if (!options.deaf) session = key;
      if (options.wroteBack) {
        await writeDefaults(key);
        mirror?.(key);
      }
    },
    readCurrent: () => session,
    sessionNow: () => session,
  };
}

/** Last reading of the real default file; the guard stays synchronous. */
let cachedGlobalDefault: string | undefined;

/**
 * Wires the adapter exactly like a host would.
 *
 * The guard's reader is a live cell (`cachedGlobalDefault`) that the fake
 * platform updates through `observe`, i.e. exactly what DSH does to the file.
 * `prime()` fills the cell from the real file first, so the baseline the test
 * arms with is the byte that is actually on disk.
 */
function hostWith(platform: ReturnType<typeof dshPlatform>) {
  const adapter = new DshModelAdapter(
    { selectModel: platform.selectModel, readCurrent: platform.readCurrent },
    'session-1',
    createGlobalDefaultGuard(() => cachedGlobalDefault),
  );
  const host = new PluginHost(adapter);
  host.registerModels(allModels, allModels.map((m) => `${m.provider}/${m.model}`));
  /**
   * Arms the watch, like a host does right before a switch.
   *
   * The guard's reader is re-evaluated at every read, so the *cell* has to stay
   * live: `setDefault` mirrors the disk, and `prime()` takes one real reading.
   * A test that only armed a stale cache would prove nothing about the file.
   */
  const setDefault = (value: string | undefined) => {
    cachedGlobalDefault = value;
  };
  const prime = async () => {
    cachedGlobalDefault = await readGlobalDefault();
    adapter.primeGlobalDefault();
  };
  platform.observe(setDefault);
  return { host, adapter, prime };
}

function planAndApprove(host: PluginHost) {
  return host.approvePlan(
    host.plan({ taskId: 'f2', summary: 'switch', stageNames: ['implement'], estimatedInputTokens: 1_000 }),
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-router-f2-'));
  defaultPath = join(home, 'agent-default-model.yml');
  patchPath = join(home, 'cordis.patch.yml');
  sessionPath = join(home, 'session-model.yml');
  await writeDefaults('deepseek/flash');
  await writeFile(sessionPath, 'agent-default-model: deepseek/flash\n', 'utf8');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('F2: a platform write-back is detected, reported and booked', () => {
  it('books the write-back and warns the user, instead of switching silently', async () => {
    const platform = dshPlatform({ wroteBack: true });
    const { host, prime } = hostWith(platform);
    const plan = planAndApprove(host);
    await prime();

    const before = await fingerprint(defaultPath);
    const result = await host.switchForStage('stage-1', 'local/qwen-coder', 1_000, 1_000, ['coding'], plan.planId);
    const after = await fingerprint(defaultPath);

    expect(result).toMatchObject({ switched: true, globalDefaultWrittenBack: true });
    expect(result.message).toMatch(/global default model changed/);
    expect(result.message).toMatch(/deepseek\/flash/);
    expect(result.message).toMatch(/local\/qwen-coder/);

    expect(host.ledger.totals().globalDefaultWriteBacks).toBe(1);
    const event = host.ledger.all().find((e) => e.type === 'global-default-writeback')!;
    expect(event.planId).toBe(plan.planId);
    expect(event.detail).toContain('local/qwen-coder');

    // Real files: the defaults did move, and we can prove it byte for byte.
    expect(after.md5).not.toBe(before.md5);
    expect(await readFile(defaultPath, 'utf8')).toContain('local/qwen-coder');
  });

  it('leaves the global default file byte-identical and mtime-identical when the platform behaves', async () => {
    const platform = dshPlatform({ wroteBack: false });
    const { host, prime } = hostWith(platform);
    const plan = planAndApprove(host);
    await prime();

    const defaultBefore = await fingerprint(defaultPath);
    const patchBefore = await fingerprint(patchPath);

    const result = await host.switchForStage('stage-1', 'local/qwen-coder', 1_000, 1_000, ['coding'], plan.planId);

    expect(result.switched).toBe(true);
    expect(result.globalDefaultWrittenBack).toBeUndefined();
    expect(host.ledger.totals().globalDefaultWriteBacks).toBe(0);

    const defaultAfter = await fingerprint(defaultPath);
    const patchAfter = await fingerprint(patchPath);
    expect(defaultAfter.md5).toBe(defaultBefore.md5);
    expect(defaultAfter.mtimeMs).toBe(defaultBefore.mtimeMs);
    expect(patchAfter.md5).toBe(patchBefore.md5);
    expect(patchAfter.mtimeMs).toBe(patchBefore.mtimeMs);
  });

  it('says nothing about write-backs it could not observe', async () => {
    // No guard wired: we are blind, and blind must never read as "all clear".
    const platform = dshPlatform({ wroteBack: true });
    const host = new PluginHost({
      current: platform.readCurrent,
      select: async (_s, key) => {
        const parts = splitModelKey(key);
        await platform.selectModel('session-1', parts.provider, parts.model);
      },
    });
    host.registerModels(allModels, allModels.map((m) => `${m.provider}/${m.model}`));
    const plan = planAndApprove(host);

    const result = await host.switchForStage('stage-1', 'local/qwen-coder', 1_000, 1_000, ['coding'], plan.planId);
    expect(result.switched).toBe(true);
    expect(result.globalDefaultWrittenBack).toBeUndefined();
    expect(host.ledger.totals().globalDefaultWriteBacks).toBe(0);
  });
});

describe('F2: the watcher itself', () => {
  it('reports a change only when it happens during the switch', () => {
    let value = 'a/one';
    const guard = createGlobalDefaultGuard(() => value);
    expect(guard.snapshot()).toBe('a/one');
    expect(guard.compare()).toEqual({ wroteBackGlobalDefault: false });
    value = 'b/two';
    expect(guard.compare()).toEqual({ wroteBackGlobalDefault: true, from: 'a/one', to: 'b/two' });
    // Second call sees no further movement.
    expect(guard.compare()).toEqual({ wroteBackGlobalDefault: false });
  });

  it('does not blame the switch for a default that moved before it started', () => {
    let value = 'a/one';
    const guard = createGlobalDefaultGuard(() => value);
    value = 'c/three'; // moved by some other actor, before the switch
    expect(guard.arm()).toBe('c/three'); // host re-reads right before switching
    expect(guard.compare().wroteBackGlobalDefault).toBe(false);
    value = 'd/four'; // this one IS the switch
    expect(guard.compare()).toEqual({ wroteBackGlobalDefault: true, from: 'c/three', to: 'd/four' });
  });

  it('claims nothing when the default cannot be read', () => {
    const guard = createGlobalDefaultGuard(() => undefined);
    expect(guard.snapshot()).toBeUndefined();
    expect(guard.arm()).toBeUndefined();
    expect(guard.compare()).toEqual({ wroteBackGlobalDefault: false });
  });

  it('reads the real file through the adapter seam', async () => {
    const platform = dshPlatform({ wroteBack: false });
    const { adapter, prime } = hostWith(platform);
    await prime();
    expect(adapter.globalDefault()).toBe('deepseek/flash');

    await writeDefaults('local/qwen-coder');
    await prime();
    expect(adapter.globalDefault()).toBe('local/qwen-coder');

    await rm(defaultPath, { force: true });
    cachedGlobalDefault = await readGlobalDefault();
    expect(adapter.primeGlobalDefault()).toBeUndefined();
  });

  it('surfaces a refused switch without inventing a write-back', async () => {
    const platform = dshPlatform({ fail: true });
    const adapter = new DshModelAdapter(
      { selectModel: platform.selectModel, readCurrent: platform.readCurrent },
      'session-1',
      createGlobalDefaultGuard(() => 'deepseek/flash'),
    );
    const outcome = await adapter.selectGuarded('local/qwen-coder');
    expect(outcome.wroteBackGlobalDefault).toBe(false);
    expect(outcome.error).toMatch(/platform said no/);
    expect(platform.sessionNow()).toBe('deepseek/flash');
  });
});

describe('F2: a switch that never happened cannot hide a write-back', () => {
  it('reports both facts when the platform ignores the switch but moves the default', async () => {
    const platform = dshPlatform({ deaf: true, wroteBack: true });
    const { host, prime } = hostWith(platform);
    const plan = planAndApprove(host);
    await prime();

    const result = await host.switchForStage('stage-1', 'local/qwen-coder', 1_000, 1_000, ['coding'], plan.planId);

    expect(result.switched).toBe(false);
    expect(result.message).toMatch(/still runs deepseek\/flash/);
    expect(result.message).toMatch(/global default model changed/);
    expect(result.globalDefaultWrittenBack).toBe(true);
    expect(host.ledger.totals().unverified).toBe(1);
    expect(host.ledger.totals().globalDefaultWriteBacks).toBe(1);
  });
});

/**
 * P1-1：全局默认的**读源**必须是 `ctx.agentDefaultModel.currentSelection()`。
 *
 * 宿主在 `selectModel` 内部调用 `agentDefaultModel.saveSelection()`（"选一次
 * 会话=改全局默认"），而插件找的是宿主根本没有的 `readGlobalDefault`，所以
 * 真机上 `globalDefaultWriteBacks` 恒 0 —— K-003 又变成静默。
 *
 * 这里用真服务的形状（`currentSelection()` 同步返回 `{provider, model}`）跑
 * plan → confirm → switch，并断言"读不到"时响应明确写 `globalDefaultObserved:false`。
 */
const PRICED_PROVIDERS = [
  {
    id: 'acme',
    name: 'Acme',
    models: [
      {
        id: 'wide',
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
        inputPerMTok: 5,
        outputPerMTok: 20,
        capabilities: ['reasoning', 'coding', 'writing', 'summarizing'],
      },
      {
        id: 'narrow',
        contextWindow: 131_072,
        maxOutputTokens: 8_192,
        inputPerMTok: 0.5,
        outputPerMTok: 2,
        capabilities: ['reasoning', 'coding', 'writing', 'summarizing'],
      },
    ],
  },
];

function routerContext(services: Record<string, unknown>): DshHostContext {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'get') return (name: string) => services[name];
      if (prop === 'providers') return PRICED_PROVIDERS;
      if (prop === 'profileCandidates') return [];
      throw new Error(`cannot get property "${prop}" without inject`);
    },
  }) as unknown as DshHostContext;
}

async function planConfirmSwitch(ctx: DshHostContext) {
  const router = createRouter(ctx);
  const planned = await router.handle({
    method: 'POST',
    path: `${ROUTER_PREFIX}/plan`,
    body: { taskId: 'f2-service', stageNames: ['implement'], estimatedInputTokens: 1_000 },
  });
  expect(planned.status).toBe(200);
  const planId = String(planned.body.planId);
  const stage = (planned.body.plan as { stages: { stageId: string; modelKey: string }[] }).stages[0]!;
  const confirmed = await router.handle({
    method: 'POST',
    path: `${ROUTER_PREFIX}/plan/confirm`,
    body: { planId, sessionId: 'sess-f2' },
  });
  expect(confirmed.status).toBe(200);
  const switched = await router.handle({
    method: 'POST',
    path: `${ROUTER_PREFIX}/switch`,
    body: {
      planId,
      stageId: stage.stageId,
      modelKey: stage.modelKey,
      contextTokens: 1_000,
      expectedOutputTokens: 1_000,
      sessionId: 'sess-f2',
    },
  });
  return { router, switched };
}

describe('P1-1: the global default is read through agentDefaultModel.currentSelection()', () => {
  it('reads the real service shape directly', () => {
    const ctx = routerContext({
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'flash' }) },
    });
    expect(observeGlobalDefault(ctx)).toBe('deepseek/flash');

    // No service, no legacy read → "未能观测", never a fabricated all-clear.
    expect(observeGlobalDefault(routerContext({}))).toBeUndefined();
  });

  it('detects and books the write-back the host performs inside selectModel', async () => {
    let globalDefault = { provider: 'deepseek', model: 'flash' };
    const ctx = routerContext({
      sessionController: {
        async selectModel(request: { provider: string; model: string }) {
          // Exactly what DSH does: switching the session also saves the default.
          globalDefault = { provider: request.provider, model: request.model };
        },
      },
      agentDefaultModel: { currentSelection: () => ({ ...globalDefault }) },
    });

    const { router, switched } = await planConfirmSwitch(ctx);

    expect(switched.status).toBe(200);
    expect(switched.body.switched).toBe(true);
    expect(switched.body.globalDefaultWrittenBack).toBe(true);
    expect(switched.body.globalDefaultObserved).toBe(true);
    expect(router.host.ledger.totals().globalDefaultWriteBacks).toBe(1);
    expect(globalDefault).toEqual({ provider: 'acme', model: 'narrow' });
  });

  it('reports 未能观测 instead of a silent all-clear when the read cannot exist', async () => {
    const ctx = routerContext({
      sessionController: {
        async selectModel() {
          // The host moves its own default, but nothing here can read it.
        },
      },
    });

    const { switched } = await planConfirmSwitch(ctx);

    expect(switched.status).toBe(200);
    expect(switched.body.switched).toBe(true);
    // Not `true` (it did not see one), and not absent (that would read as
    // "nothing happened"); it is explicitly unobserved.
    expect(switched.body.globalDefaultObserved).toBe(false);
    expect(switched.body.globalDefaultWrittenBack).toBeUndefined();
  });
});
