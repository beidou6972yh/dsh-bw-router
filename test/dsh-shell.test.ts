import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  apply,
  createRouter,
  guardRequest,
  inject,
  listModels,
  PLUGIN_NAME,
  readJsonBody,
  selectionFrom,
  type DshHostContext,
  type DshHttpRequest,
  type DshHttpResponse,
} from '../src/plugin/dsh-shell.js';
import { ROUTER_PREFIX } from '../src/plugin/endpoints.js';
import { createGlobalDefaultGuard } from '../src/adapters/dsh-model.js';
import { allModels } from './fixtures/models.js';

/**
 * The DSH shell: the only file that knows what a host looks like.
 *
 * These tests use a fake host context and a fake req/res, which is the point:
 * if the shell needed a real Cordis runtime to be exercised, it would be the one
 * part of the plugin nobody could test.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Minimal req/res pair: enough to prove body reading and JSON writing work. */
function fakeExchange(method: string, url: string, body?: unknown) {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const req: DshHttpRequest = {
    method,
    url,
    on(event, cb) {
      (handlers[event] ??= []).push(cb as (arg?: unknown) => void);
    },
  };
  const written: { status?: number; headers?: Record<string, string>; payload?: string } = {};
  const res: DshHttpResponse = {
    writeHead(status, headers) {
      written.status = status;
      written.headers = headers;
    },
    end(payload) {
      written.payload = payload;
    },
  };
  return {
    req,
    res,
    written,
    /** Feeds the body chunks and closes the stream, like a real request. */
    send(): void {
      const text = body === undefined ? '' : JSON.stringify(body);
      for (const cb of handlers.data ?? []) cb({ toString: () => text });
      for (const cb of handlers.end ?? []) cb();
    },
  };
}

/** A request that emits one raw (possibly invalid) chunk, then ends. */
function fakeBody(raw: string): DshHttpRequest {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const req: DshHttpRequest = {
    on(event, cb) {
      (handlers[event] ??= []).push(cb as (arg?: unknown) => void);
    },
  };
  queueMicrotask(() => {
    for (const cb of handlers.data ?? []) cb({ toString: () => raw });
    for (const cb of handlers.end ?? []) cb();
  });
  return req;
}

function fakeHost(overrides: Partial<DshHostContext> = {}) {
  const routes: { kind: string; path: string; handler: (req: DshHttpRequest, res: DshHttpResponse) => unknown }[] = [];
  const effects: (() => void)[] = [];
  let current = 'deepseek/flash';
  const ctx: DshHostContext = {
    webServer: { register: (route) => routes.push(route) },
    effect: (fn) => {
      const teardown = fn();
      if (teardown) effects.push(teardown);
    },
    session: {
      sessionId: 'sess-1',
      readCurrent: () => current,
      selectModel: async (_provider: string, model: string) => {
        current = `${_provider}/${model}`;
      },
    },
    providers: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'flash' }, { id: 'reasoner' }] }],
    // A real DSH host carries the connection-trust service, and this one trusts
    // whatever it is handed (`undefined` = pass). Hosts that lack it, or refuse,
    // are the cases the trust-gate tests state explicitly.
    connection: { requestRejection: () => undefined },
    // No profile files: this fixture states every source it has, so the suite
    // never inherits the developer's (or the CI box's) real DSH install.
    profileCandidates: [],
    ...overrides,
  };
  return { ctx, routes, effects };
}

describe('shell wiring', () => {
  it('declares the plugin name and the webServer injection', () => {
    expect(PLUGIN_NAME).toBe('dsh-bw-router');
    expect(inject).toEqual(['connection', 'webServer']);
  });

  it('registers exactly one prefix route, torn down by effect()', () => {
    const { ctx, routes } = fakeHost();
    apply(ctx);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.kind).toBe('prefix');
    expect(routes[0]!.path).toBe(ROUTER_PREFIX);
  });

  it('still registers when the host offers no effect()', () => {
    const { ctx, routes } = fakeHost({ effect: undefined });
    apply(ctx);
    expect(routes).toHaveLength(1);
  });

  it('does not explode when the host has no web server at all', () => {
    expect(() => apply({})).not.toThrow();
  });

  it('reads a JSON body, and treats garbage as {} instead of throwing', async () => {
    const ok = fakeExchange('POST', '/router/plan', { taskId: 't1' });
    const okBody = readJsonBody(ok.req);
    ok.send();
    await expect(okBody).resolves.toEqual({ taskId: 't1' });

    const empty = fakeExchange('POST', '/router/plan');
    const emptyBody = readJsonBody(empty.req);
    empty.send();
    await expect(emptyBody).resolves.toEqual({});

    const broken = fakeBody('not json at all');
    await expect(readJsonBody(broken)).resolves.toEqual({});
  });
});

describe('HTTP glue', () => {
  it('answers a plan request with JSON and a no-store header', async () => {
    const { ctx, routes } = fakeHost();
    apply(ctx);
    const exchange = fakeExchange('POST', `${ROUTER_PREFIX}/plan`, {
      taskId: 't1',
      summary: 'ship',
      stageNames: ['implement'],
      estimatedInputTokens: 5_000,
    });
    const pending = routes[0]!.handler(exchange.req, exchange.res) as Promise<void>;
    exchange.send();
    await pending;
    expect(exchange.written.status).toBe(200);
    expect(exchange.written.headers?.['content-type']).toContain('application/json');
    expect(exchange.written.headers?.['cache-control']).toBe('no-store');
    expect(JSON.parse(exchange.written.payload!).ok).toBe(true);
  });

  it('serves state over GET without a body', async () => {
    const { ctx, routes } = fakeHost();
    apply(ctx);
    const exchange = fakeExchange('GET', `${ROUTER_PREFIX}/state`);
    await (routes[0]!.handler(exchange.req, exchange.res) as Promise<void>);
    const body = JSON.parse(exchange.written.payload!) as { state: { active: boolean } };
    expect(exchange.written.status).toBe(200);
    expect(body.state.active).toBe(false);
  });
});

/**
 * The connection-trust gate the market asks for: routes a plugin registers on
 * `webServer` get no Host/Origin check from DSH, so the plugin has to ask the
 * `connection` service itself. These tests drive the *registered handler*, not
 * the helper, so "refused" is proven end to end: no body read, no route work.
 */
describe('connection trust gate', () => {
  /** A request that records whether the handler ever attached body listeners. */
  function listened(method: string, url: string) {
    const events: string[] = [];
    const req: DshHttpRequest = {
      method,
      url,
      on(event) {
        events.push(event);
      },
    };
    return { req, events };
  }

  /** A response that keeps what the handler wrote. */
  function captureRes() {
    const written: { status?: number; headers?: Record<string, string>; payload?: string } = {};
    const res: DshHttpResponse = {
      writeHead(status, headers) {
        written.status = status;
        written.headers = headers;
      },
      end(payload) {
        written.payload = payload;
      },
    };
    return { res, written };
  }

  /** Runs one GET /router/state through the route the host received. */
  async function callState(overrides: Partial<DshHostContext> = {}) {
    const { ctx, routes } = fakeHost(overrides);
    apply(ctx);
    const { req, events } = listened('GET', `${ROUTER_PREFIX}/state`);
    const { res, written } = captureRes();
    await (routes[0]!.handler(req, res) as Promise<void>);
    return { written, events };
  }

  it('answers 403 and runs nothing when the host refuses the request', async () => {
    const { written, events } = await callState({ connection: { requestRejection: () => 403 } });
    expect(written.status).toBe(403);
    expect(written.payload).toBe('');
    expect(events).toEqual([]); // no body listener was ever attached
  });

  it('passes through the host status, 401 included', async () => {
    const { written } = await callState({ connection: { requestRejection: () => 401 } });
    expect(written.status).toBe(401);
    expect(written.payload).toBe('');
  });

  it('runs the route when the host explicitly returns undefined', async () => {
    const { written, events } = await callState({ connection: { requestRejection: () => undefined } });
    expect(written.status).toBe(200);
    expect((JSON.parse(written.payload!) as { ok: boolean }).ok).toBe(true);
    expect(events).toEqual([]); // GET, so still no body read
  });

  it('fails closed when the host offers no connection service at all', async () => {
    const { written } = await callState({ connection: undefined });
    expect(written.status).toBe(403);
    expect(written.payload).toBe('');
  });

  it('fails closed when the service has no requestRejection method', async () => {
    const { written } = await callState({ connection: {} });
    expect(written.status).toBe(403);
  });

  it('fails closed when requestRejection throws', async () => {
    const { written } = await callState({
      connection: {
        requestRejection: () => {
          throw new Error('host exploded');
        },
      },
    });
    expect(written.status).toBe(403);
  });

  it('fails closed on a non-numeric verdict, null included', async () => {
    for (const verdict of ['yes', true, null, {}] as unknown[]) {
      const { written } = await callState({ connection: { requestRejection: () => verdict } });
      expect(written.status).toBe(403);
      expect(written.payload).toBe('');
    }
  });

  it('reads the service through get() when the host exposes one', async () => {
    const { written } = await callState({
      get: (name: string) => (name === 'connection' ? { requestRejection: () => 403 } : undefined),
    });
    expect(written.status).toBe(403);
  });

  it('reports its verdict to the caller as a boolean', () => {
    const { ctx } = fakeHost({ connection: { requestRejection: () => undefined } });
    const { res } = captureRes();
    const { req } = listened('GET', `${ROUTER_PREFIX}/state`);
    expect(guardRequest(ctx, req, res)).toBe(false);
    const refusing = captureRes();
    expect(guardRequest(fakeHost({ connection: { requestRejection: () => 403 } }).ctx, req, refusing.res)).toBe(true);
    expect(refusing.written.status).toBe(403);
  });
});

describe('adapter boundary', () => {
  it('reports an unreadable current model as an empty key, not a crash', () => {
    const selection = selectionFrom({});
    expect(selection.current()).toBe('');
    expect(selection.globalDefault?.()).toBeUndefined();
    expect(selection.primeGlobalDefault?.()).toBeUndefined();
  });

  it('watches the global default through the host cell it was given', async () => {
    let cell: string | undefined = 'deepseek/flash';
    const selection = selectionFrom({
      session: {
        // The host names the session it belongs to; without it the adapter now
        // refuses to guess (it used to send the literal 'current').
        sessionId: 'sess-guard',
        readCurrent: () => 'deepseek/flash',
        selectModel: async () => {
          cell = 'deepseek/reasoner'; // the platform drags the default along
        },
        readGlobalDefault: () => cell,
      },
    });
    expect(selection.primeGlobalDefault?.()).toBe('deepseek/flash');
    const result = await selection.selectGuarded?.('deepseek/reasoner');
    expect(result?.wroteBackGlobalDefault).toBe(true);
    expect(result?.from).toBe('deepseek/flash');
    expect(result?.to).toBe('deepseek/reasoner');
  });

  it('refuses to switch when the host offers no selectModel', async () => {
    const selection = selectionFrom({ session: { readCurrent: () => 'deepseek/flash' } });
    await expect(selection.select('sess', 'deepseek/reasoner')).rejects.toThrow(/no selectModel/);
  });

  it('an unprimed edit is blamed on the switch; arming first moves the blame off', () => {
    let cell = 'deepseek/flash';
    const stale = createGlobalDefaultGuard(() => cell);
    cell = 'other/model'; // the user edited settings between two switches
    // Without primeGlobalDefault the watch still holds the old reading, so it
    // reports a write-back that never happened. This is exactly why the host
    // primes at the start of a run — the assertion below is the contrast.
    expect(stale.compare().wroteBackGlobalDefault).toBe(true);

    const fresh = createGlobalDefaultGuard(() => cell);
    expect(fresh.arm()).toBe('other/model');
    expect(fresh.compare().wroteBackGlobalDefault).toBe(false);
  });
});

describe('discovery through the shell', () => {
  it('reads models the host already has in memory', async () => {
    const { ctx } = fakeHost();
    const models = await listModels(ctx).catch(() => []);
    // Discovery with only an in-memory provider list must yield that provider.
    expect(models.map((m) => m.key).sort()).toEqual(['deepseek/flash', 'deepseek/reasoner']);
  });

  it('a broken config file does not take the wizard down', async () => {
    const { ctx } = fakeHost({ providers: [], configPaths: { candidates: [join(ROOT, 'nope.json')] } });
    const router = createRouter(ctx);
    const answer = await router.handle({ method: 'GET', path: `${ROUTER_PREFIX}/wizard` });
    expect(answer.status).toBe(200);
    expect((answer.body.wizard as { totalModels: number }).totalModels).toBe(0);
  });

  it('registers models from the injected source once per plan', async () => {
    const { ctx } = fakeHost();
    const router = createRouter(ctx);
    await router.handle({
      method: 'POST',
      path: `${ROUTER_PREFIX}/plan`,
      body: { taskId: 't1', stageNames: ['implement'], estimatedInputTokens: 1_000 },
    });
    expect(router.host.registry.size()).toBe(2);
  });
});

describe('architecture: the shell is the only host-aware file', () => {
  it('core and endpoints import nothing from adapters', () => {
    const files = ['src/plugin/endpoints.ts'];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      expect(source).not.toMatch(/from '\.\.\/adapters\//);
    }
    expect(existsSync(join(ROOT, 'src/plugin/dsh-shell.ts'))).toBe(true);
  });

  it('the fixtures used above are the same list the rest of the suite uses', () => {
    expect(allModels.length).toBeGreaterThan(0);
  });
});
