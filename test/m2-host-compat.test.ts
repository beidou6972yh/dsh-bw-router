import { describe, expect, it } from 'vitest';
import {
  apply,
  createRouter,
  resolveHostSession,
  selectionFrom,
  type DshHostContext,
  type DshHttpRequest,
  type DshHttpResponse,
} from '../src/plugin/dsh-shell.js';

/**
 * Host-compatibility surface of the shell (M2 试装缺陷回归).
 *
 * The M2 试装 crashed on activation with
 *   `cannot get property "session" without inject`
 * because `selectionFrom` read `ctx.session` eagerly and the host under test
 * (DSH 0.2.1-rc.2) does not register a service by that name — and because Cordis
 * throws on the first unreachable access. These tests pin the fixes:
 *
 *  1. activation never throws for a host with no (or an unreachable) session
 *     service — the shell degrades to "not observable";
 *  2. the service is probed per call, under the names real hosts use
 *     (`session`, `sessionController`, `sessions`);
 *  3. the host's selection call shape is detected, not assumed: the 0.2.x
 *     request-object form and the positional forms all work;
 *  4. a host that cannot report the current model falls back to the last switch
 *     this plugin made, instead of reporting `''` forever.
 */

function fakeRouteSink() {
  const routes: { path: string }[] = [];
  return { routes };
}

/** A host whose session service is unreachable, the way Cordis reports it. */
function hostWithThrowingService(name: string): DshHostContext {
  const sink = fakeRouteSink();
  const ctx = {
    webServer: { register: (route: { path: string }) => sink.routes.push(route) },
    effect: (fn: () => void) => fn(),
  } as unknown as DshHostContext;
  Object.defineProperty(ctx, name, {
    configurable: true,
    get() {
      throw new Error(`cannot get property "${name}" without inject`);
    },
  });
  return ctx;
}

describe('activation survives a host that has no session service', () => {
  it('apply() registers the route instead of throwing', () => {
    const ctx = hostWithThrowingService('session');
    expect(() => apply(ctx)).not.toThrow();
    expect((ctx as unknown as { webServer: { register: unknown } }).webServer).toBeDefined();
  });

  it('a plain host with only webServer still activates', async () => {
    const routes: { path: string }[] = [];
    const ctx: DshHostContext = {
      webServer: { register: (route) => routes.push(route) },
      effect: (fn) => fn(),
    };
    apply(ctx);
    expect(routes).toHaveLength(1);
    expect(selectionFrom(ctx).current()).toBe('');
  });
});

describe('service probing', () => {
  it('finds the DSH 0.2.x controller service and detects its request-object call', async () => {
    const calls: Record<string, unknown>[] = [];
    const ctx = {
      sessionController: {
        sessionId: 'sess-42',
        // Arity 1: the request-object form DSH 0.2.1-rc.2 exposes.
        selectModel: async (request: Record<string, unknown>) => {
          calls.push(request);
          return { provider: request.provider, model: request.model };
        },
      },
    } as unknown as DshHostContext;
    const selection = selectionFrom(ctx);
    // '' = the caller states no session; the host-named one is used (and never
    // the literal 'current' the M2 build sent).
    await selection.select('', 'deepseek/reasoner');
    expect(calls).toEqual([{ sessionId: 'sess-42', provider: 'deepseek', model: 'reasoner' }]);
    // No readCurrent on this host: the last switch is the best available answer.
    expect(selection.current()).toBe('deepseek/reasoner');
  });

  it('supports the positional (sessionId, provider, model) form', async () => {
    const calls: unknown[][] = [];
    const ctx = {
      session: {
        sessionId: 'sess-7',
        // Three named parameters — the positional variant arity detection sees.
        selectModel: async (sessionId: string, provider: string, model: string) => {
          calls.push([sessionId, provider, model]);
        },
      },
    } as unknown as DshHostContext;
    await selectionFrom(ctx).select('', 'deepseek/flash');
    expect(calls).toEqual([['sess-7', 'deepseek', 'flash']]);
  });

  it('prefers what the host reports over the last switch it made', async () => {
    let reported = 'deepseek/flash';
    const ctx = {
      sessions: {
        readCurrent: () => reported,
        selectModel: async () => {
          reported = 'deepseek/reasoner';
        },
      },
    } as unknown as DshHostContext;
    const selection = selectionFrom(ctx);
    expect(selection.current()).toBe('deepseek/flash');
    await selection.select('s', 'deepseek/reasoner');
    expect(selection.current()).toBe('deepseek/reasoner');
  });

  it('reports no session surface when the host only carries an unrelated store', () => {
    const ctx = { sessions: { get: () => undefined, list: () => [] } } as unknown as DshHostContext;
    expect(resolveHostSession(ctx)).toBeUndefined();
  });

  it('still refuses a switch when the host offers no selectModel', async () => {
    const ctx = { session: { readCurrent: () => 'deepseek/flash' } } as unknown as DshHostContext;
    await expect(selectionFrom(ctx).select('sess', 'deepseek/reasoner')).rejects.toThrow(/no selectModel/);
  });
});

describe('router still serves with an unreachable session service', () => {
  it('answers GET /router/state without activating a session', async () => {
    const routes: {
      path: string;
      handler: (req: DshHttpRequest, res: DshHttpResponse) => unknown;
    }[] = [];
    const ctx = hostWithThrowingService('session');
    (ctx as unknown as { webServer: { register: (r: (typeof routes)[number]) => number } }).webServer = {
      register: (route) => routes.push(route),
    };
    apply(ctx);
    const res = {
      status: 0,
      body: '',
      writeHead(status: number) {
        this.status = status;
      },
      end(payload: string) {
        this.body = payload;
      },
    };
    const req: DshHttpRequest = {
      method: 'GET',
      url: '/router/state',
      on() {
        /* no body */
      },
    };
    await routes[0]!.handler(req, res);
    expect(res.status).toBe(200);
    expect(() => JSON.parse(res.body)).not.toThrow();
  });
});

/**
 * A real Cordis context is a proxy that throws for every property it cannot
 * resolve — including plain host-side options (`compact`, `contextThresholds`,
 * `providers`, `sessionId`). The M2 试装 second round reported the failure
 * "moving" from `session` to a threshold service, which is exactly this trap:
 * fixing one eager read only exposed the next. Every optional host read must
 * therefore be tolerant, not just the session one.
 */
function cordisLikeContext(services: Record<string, unknown>) {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop === 'string' && prop in services) return services[prop];
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  }) as unknown as DshHostContext;
}

describe('a Cordis-like context that throws for unknown properties', () => {
  const routeSink = () => {
    const routes: { path: string; handler: (req: DshHttpRequest, res: DshHttpResponse) => unknown }[] = [];
    return { routes, webServer: { register: (route: (typeof routes)[number]) => routes.push(route) } };
  };

  it('activates with only webServer provided (no effect, no options, no session)', () => {
    const sink = routeSink();
    const ctx = cordisLikeContext({ webServer: sink.webServer });
    expect(() => apply(ctx)).not.toThrow();
    expect(sink.routes).toHaveLength(1);
  });

  it('builds the router without touching optional options', async () => {
    const ctx = cordisLikeContext({});
    const router = createRouter(ctx);
    // No session service and no options: the router answers, it does not crash.
    const answer = await router.handle({ method: 'GET', path: '/router/state' });
    expect(answer.status).toBe(200);
  });

  it('still finds a provided sessionController and switches through it', async () => {
    const calls: Record<string, unknown>[] = [];
    const ctx = cordisLikeContext({
      sessionController: {
        sessionId: 'sess-9',
        selectModel: async (request: Record<string, unknown>) => {
          calls.push(request);
        },
      },
    });
    const selection = selectionFrom(ctx);
    await selection.select('', 'deepseek/reasoner');
    expect(calls).toEqual([{ sessionId: 'sess-9', provider: 'deepseek', model: 'reasoner' }]);
  });

  it('serves GET /router/state through the registered route', async () => {
    const sink = routeSink();
    apply(cordisLikeContext({ webServer: sink.webServer }));
    const res = {
      status: 0,
      body: '',
      writeHead(status: number) {
        this.status = status;
      },
      end(payload: string) {
        this.body = payload;
      },
    };
    const req: DshHttpRequest = { method: 'GET', url: '/router/state', on() { /* no body */ } };
    await sink.routes[0]!.handler(req, res);
    expect(res.status).toBe(200);
    expect(() => JSON.parse(res.body)).not.toThrow();
  });
});
