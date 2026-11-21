/**
 * 「客户端内可以直接发起计划」的端到端自测（blocker B 证据脚本）。
 *
 * 这不是单元测试，而是**把真的客户端半放进真的加载器契约里跑一遍**：
 *
 *   1. `src/plugin/client-entry.ts` 用 rolldown 打成 CJS，再用仓库自己的
 *      `scripts/client-bundle.mjs` 包成 `window.__ModuleLoader__.load({id, factory})`
 *      —— 浏览器加载器读的就是这个形状（不碰 dist/，不动 `npm run build`）；
 *   2. 在一个假的 `window.__ModuleLoader__` 里执行它，拿到 `{ inject, apply }`；
 *   3. `apply(ctx, { react, fetchImpl })` 注册 dock 组件；
 *   4. 假 fetch 不 mock 业务，它把每个请求原样交给**真的** `src/plugin/endpoints.ts`
 *      的 `dispatch`（同一个路由实现、同一张卡），所以这里看到的状态码/卡片就是
 *      生产环境会给的那份；
 *   5. 模拟用户按下 `[生成计划]`，等宿主回答，打印 dock 里 `router-plan-card`
 *      槽位真正渲染出来的行。
 *
 * 场景：正常计划、空清单（stageNames: []）、宿主失败。
 *
 * 用法：`node scripts/verify-plan-trigger.mjs`（临时产物写在 temp/，被 .gitignore
 * 忽略；退出码非 0 = 有断言没过）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { wrapClientBundle, CLIENT_MODULE_ID } from './client-bundle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP = join(ROOT, 'temp/verify-plan-trigger');
const failures = [];

function check(label, ok, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`;
  console.log(line);
  if (!ok) failures.push(label);
}

/* ----------------------------------------------------------------- 1. 打两个包 */

/**
 * Host 侧入口：把真路由（dispatch）与真宿主（PluginHost）打成一个可 import 的
 * ESM 模块。写进 temp/ 而不是仓库，避免多一个无人引用的源文件。
 */
async function buildHostModule() {
  const entryPath = join(TEMP, 'host-entry.ts');
  const srcEndpoints = relative(TEMP, join(ROOT, 'src/plugin/endpoints.js')).replaceAll('\\', '/');
  const srcIndex = relative(TEMP, join(ROOT, 'src/plugin/index.js')).replaceAll('\\', '/');
  const fixtures = relative(TEMP, join(ROOT, 'test/fixtures/models.js')).replaceAll('\\', '/');
  await writeFile(
    entryPath,
    [
      `export { dispatch, ROUTER_PREFIX } from '${srcEndpoints}';`,
      `export { PluginHost, RouterSession } from '${srcIndex}';`,
      `export { allModels } from '${fixtures}';`,
      '',
    ].join('\n'),
    'utf8',
  );

  const bundle = await rolldown({ input: entryPath, platform: 'node' });
  try {
    const { output } = await bundle.generate({ format: 'esm', sourcemap: false });
    const chunk = output.find((piece) => piece.type === 'chunk');
    if (!chunk) throw new Error('host bundle produced no chunk');
    const outfile = join(TEMP, 'host.mjs');
    await writeFile(outfile, chunk.code, 'utf8');
    return outfile;
  } finally {
    await bundle.close();
  }
}

/** Client 侧入口：源码 → CJS → 加载器工厂包装（与 `npm run build` 同一条路径）。 */
async function buildClientScript() {
  const bundle = await rolldown({
    input: join(ROOT, 'src/plugin/client-entry.ts'),
    platform: 'browser',
    external: ['react', 'react/jsx-runtime'],
  });
  try {
    const { output } = await bundle.generate({ format: 'cjs', exports: 'named', sourcemap: false });
    const chunk = output.find((piece) => piece.type === 'chunk');
    if (!chunk) throw new Error('client bundle produced no chunk');
    const script = wrapClientBundle(CLIENT_MODULE_ID, chunk.code);
    await writeFile(join(TEMP, 'client.js'), script, 'utf8');
    return script;
  } finally {
    await bundle.close();
  }
}

/* --------------------------------------------------------- 2. 极简 React 替身 */

/**
 * 一个够用的 React：`useState` 真的会触发重渲染，`useEffect([], …)` 只在挂载时
 * 跑一次。够用来证明"点一下 → 状态变了 → 卡片重画了"。
 */
function createReact() {
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children });
  let current = null;

  const react = {
    createElement: h,
    useState(initial) {
      const inst = current;
      const index = inst.index++;
      if (index >= inst.hooks.length) inst.hooks[index] = initial;
      return [
        inst.hooks[index],
        (next) => {
          inst.hooks[index] = typeof next === 'function' ? next(inst.hooks[index]) : next;
          schedule(inst);
        },
      ];
    },
    useEffect(effect) {
      current.effects.push(effect);
    },
  };

  function schedule(inst) {
    if (inst.pending) return;
    inst.pending = true;
    queueMicrotask(() => {
      inst.pending = false;
      renderNow(inst, false);
    });
  }

  function renderNow(inst, runEffects) {
    const previous = current;
    current = inst;
    inst.index = 0;
    try {
      inst.tree = inst.Component(inst.props);
    } finally {
      current = previous;
    }
    if (runEffects) {
      const effects = inst.effects.splice(0);
      for (const effect of effects) effect();
    }
    return inst.tree;
  }

  function mount(Component, props) {
    const inst = { Component, props, hooks: [], effects: [], index: 0, tree: null, pending: false };
    renderNow(inst, true);
    return inst;
  }

  return { react, mount };
}

/** Every string drawn under a node, in render order (the dock's lines). */
function textsOf(node) {
  const out = [];
  const walk = (value) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') walk(value.children);
  };
  walk(node);
  return out;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/* ------------------------------------------------------- 3. 一次"页面加载" */

/**
 * 模拟浏览器启动一次：执行加载器脚本 → 拿模块 → apply(ctx) → 返回挂载工具。
 *
 * @param script - 包装好的客户端脚本。
 * @param fetchImpl - 宿主侧的假 fetch（这里会桥到真的 dispatch）。
 */
function bootPage(script, fetchImpl) {
  const loaded = { id: undefined, module: undefined };
  const fakeWindow = {
    __ModuleLoader__: {
      load({ id, factory }) {
        loaded.id = id;
        loaded.module = factory((name) => {
          if (name === 'react') return reactRuntime;
          throw new Error(`module table has no "${name}"`);
        });
      },
    },
  };

  const { react, mount } = createReact();
  const reactRuntime = react;
  // eslint-disable-next-line no-new-func -- the loader serves a classic script
  new Function('window', script)(fakeWindow);

  const registered = [];
  const ctx = {
    slots: {
      inject(name, callback) {
        callback();
        return () => {};
      },
      register(spec, component) {
        registered.push({ spec, component });
        return () => {};
      },
    },
  };
  loaded.module.apply(ctx, { react, fetchImpl });

  const components = new Map(registered.map((entry) => [entry.spec.id, entry.component]));
  return { id: loaded.id, module: loaded.module, registered, components, mount };
}

/** A fetch that forwards every request to the **real** endpoint router. */
function hostBridge(deps, log) {
  return async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const method = init.method ?? 'GET';
    const answer = await deps.dispatch({ method, path: url, ...(body === undefined ? {} : { body }) }, deps);
    log.push({ method, path: url, status: answer.status, body });
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
}

/* ------------------------------------------------------------------ 4. 跑场景 */

async function main() {
  await mkdir(TEMP, { recursive: true });
  const hostModulePath = await buildHostModule();
  const script = await buildClientScript();
  const hostModule = await import(pathToFileURL(hostModulePath).href);
  const { dispatch, PluginHost, RouterSession, allModels, ROUTER_PREFIX } = hostModule;

  const host = new PluginHost({ current: () => 'deepseek/flash', select: async () => undefined });
  host.registerModels(allModels, allModels.map((model) => `${model.provider}/${model.model}`));
  const session = new RouterSession(host);
  const deps = { host, session, dispatch };

  console.log(`== 加载器契约 ==`);
  const requests = [];
  const page = bootPage(script, hostBridge(deps, requests));
  check('loader registered the module under its package id', page.id === CLIENT_MODULE_ID, page.id);
  check('module exports inject = ["slots"]', JSON.stringify(page.module.inject) === '["slots"]');
  check('module exports apply()', typeof page.module.apply === 'function');
  const ids = page.registered.map((entry) => entry.spec.id);
  const orders = page.registered.map((entry) => entry.spec.order);
  console.log(`   dock 注册: ${ids.map((id, i) => `${id}@${orders[i]}`).join(', ')}`);
  check(
    'dock entries: trigger@59, card@60, bar@61',
    JSON.stringify(ids) === JSON.stringify(['router-plan-trigger', 'router-plan-card', 'router-status-bar']) &&
      JSON.stringify(orders) === JSON.stringify([59, 60, 61]),
  );

  /* --- 场景 1: 正常计划 --------------------------------------------------- */
  const card = page.mount(page.components.get('router-plan-card'));
  const trigger = page.mount(page.components.get('router-plan-trigger'), {
    stageNames: ['analyze', 'implement', 'write'],
  });
  await settle();

  console.log(`\n== 场景 1: 按下 [生成计划] ==`);
  console.log(`   按钮文本: ${JSON.stringify(textsOf(trigger.tree))}`);
  check('the trigger renders a [生成计划] button', textsOf(trigger.tree).includes('[生成计划]'));
  check('no card is drawn before the click', textsOf(card.tree).length === 0);

  trigger.tree.props.onClick();
  await settle();

  for (const entry of requests) {
    console.log(`   HTTP ${entry.method} ${entry.path} -> ${entry.status}`);
  }
  const post = requests.filter((entry) => entry.path === `${ROUTER_PREFIX}/plan`);
  check('clicking sent exactly one POST /router/plan', post.length === 1);
  check('the POST carried a client-generated taskId', /^ui-\d+$/.test(post[0]?.body?.taskId ?? ''), post[0]?.body?.taskId);
  const lines = textsOf(card.tree);
  console.log(`   router-plan-card 槽位渲染出 ${lines.length} 行:`);
  for (const line of lines) console.log(`     ${line}`);
  const text = lines.join('\n');
  check('the plan card rendered the host card', lines[0]?.includes('执行计划（可改）') === true);
  check('model + money rows are on screen', lines.some((l) => l.includes('▾')) && text.includes('$'));
  check('the card offers 确认开工', text.includes('确认开工'));
  check(
    'the card slot did not fetch its own copy (only the mount-time GET /card + the POST)',
    requests.filter((entry) => entry.path.startsWith(`${ROUTER_PREFIX}/card`)).length === 1 &&
      requests.length === post.length + 1,
  );

  /* --- 场景 2: 空清单 ----------------------------------------------------- */
  const emptyTrigger = page.mount(page.components.get('router-plan-trigger'), { stageNames: [] });
  console.log(`\n== 场景 2: 空清单（stageNames: []）==`);
  emptyTrigger.tree.props.onClick();
  await settle();
  const emptyAnswer = requests.filter((entry) => entry.path === `${ROUTER_PREFIX}/plan`).at(-1);
  check('empty stage list answers 200, not 500', emptyAnswer?.status === 200, String(emptyAnswer?.status));
  const emptyLines = textsOf(card.tree);
  console.log(`   router-plan-card 槽位渲染出 ${emptyLines.length} 行:`);
  for (const line of emptyLines) console.log(`     ${line}`);
  const emptyText = emptyLines.join('\n');
  check('the dock prints the empty-list sentence', emptyText.includes('空清单：未提供阶段'));
  check('an empty plan offers no 确认开工', !emptyText.includes('确认开工'));

  /* --- 场景 3: 宿主失败 --------------------------------------------------- */
  const failingPage = bootPage(script, async (url) => {
    // The card's mount-time GET behaves like a real host with no plan (404 →
    // `idle` → draw nothing); only POST /router/plan fails, which is the path
    // under test here.
    if (url.startsWith('/router/card')) {
      return { ok: false, status: 404, json: async () => ({ ok: false, code: 'no-plan', error: 'no plan yet' }) };
    }
    return { ok: false, status: 500, json: async () => ({ ok: false, code: 'internal', error: 'the host said no' }) };
  });
  const failingCard = failingPage.mount(failingPage.components.get('router-plan-card'));
  const failingTrigger = failingPage.mount(failingPage.components.get('router-plan-trigger'), { stageNames: ['implement'] });
  await settle();
  console.log(`\n== 场景 3: 宿主 500 ==`);
  check('no plan yet means no card (the 404 → idle rule)', textsOf(failingCard.tree).length === 0);
  failingTrigger.tree.props.onClick();
  await settle();
  const failingLines = textsOf(failingCard.tree);
  console.log(`   router-plan-card 槽位渲染出 ${failingLines.length} 行:`);
  for (const line of failingLines) console.log(`     ${line}`);
  check(
    'a failure reaches the dock as 加载失败：<宿主原因>',
    failingLines.length === 1 && failingLines[0] === '加载失败：the host said no',
    JSON.stringify(failingLines),
  );

  console.log(`\n== 结论 ==`);
  if (failures.length === 0) {
    console.log('全部断言通过：客户端内可以直接生成计划。');
    return;
  }
  console.log(`未通过 ${failures.length} 条：\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
}

await main();
