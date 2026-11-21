/**
 * 发布前验**产物**：`dist/client/client.js` 里到底有没有那个按钮。
 *
 * `npm run verify:plan-trigger` 验的是**源码**（rolldown 现打现跑）；本脚本验的是
 * `npm run build` 之后的**真产物**——发布出去的就是这一份。两件事必须分开验：
 * 源码对了但忘了重建 dist（或者 `build:client` 没把新导出带上），装到用户机器上
 * 仍然是没有按钮的旧包。
 *
 * 做法：读 dist/client/client.js → 假 `window.__ModuleLoader__` → 真 `factory()` →
 * `apply()` 注册进假 slot 服务 → 点 `[生成计划]` → 请求交给 dist 里**真的**
 * `dispatch` 路由实现 → 客户端渲染函数打印计划卡行。
 *
 * 三场景：正常计划 / 空清单（stageNames: []）/ 宿主失败。退出码非 0 = 有断言没过。
 *
 * 用法：`npm run build && npm run verify:dist-client`
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const bundle = readFileSync('dist/client/client.js', 'utf8');

const { PluginHost, RouterSession } = await import(pathToFileURL('dist/plugin/index.js').href);
const { dispatch } = await import(pathToFileURL('dist/plugin/endpoints.js').href);

/* ---------- 真宿主（dist 产物里的 PluginHost / RouterSession） ---------- */
const model = (provider, name, extra = {}) => ({
  id: `${provider}/${name}`,
  provider,
  model: name,
  label: `${provider} ${name}`,
  capabilities: ['reasoning', 'coding', 'writing'],
  limits: { contextWindow: 128_000, maxOutputTokens: 8_192, supportsTools: true, supportsImages: false },
  pricing: { inputPerMTok: 1, outputPerMTok: 2 },
  strength: 0.7,
  source: 'dsh-config',
  ...extra,
});
const models = [
  model('deepseek', 'flash'),
  model('deepseek', 'reasoner', { strength: 0.9 }),
  model('qwen', 'coder', { capabilities: ['coding'], pricing: { inputPerMTok: 0, outputPerMTok: 0 } }),
];
const selection = {
  current: () => 'deepseek/flash',
  select: async () => {},
  globalDefault: () => 'deepseek/flash',
  primeGlobalDefault: () => 'deepseek/flash',
};
const host = new PluginHost(selection);
host.registerModels(models, models.map((m) => m.id));
const session = new RouterSession(host);
const deps = { host, session, dispatch };

/** 浏览器外壳：假 React、假 slot 服务、假 fetch 桥（请求原样交给真 dispatch）。 */
function makeShell() {
  const nodes = [];
  const react = {
    createElement(type, props, ...children) {
      const node = { type, props: props ?? {}, children };
      nodes.push(node);
      return node;
    },
    useState(initial) {
      return [initial, () => {}];
    },
    useEffect() {},
  };
  const registered = [];
  const ctx = {
    slots: {
      inject: (_name, cb) => cb(),
      register: (spec, component) => {
        registered.push({ spec, component });
        return () => {};
      },
    },
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ path: url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = await dispatch(
      { method: init?.method ?? 'GET', path: url, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) }) },
      deps,
    );
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
  return { react, nodes, ctx, registered, calls, fetchImpl };
}

const textOf = (node) => node.children.flatMap((c) => (typeof c === 'string' ? [c] : textOf(c)));

const sandbox = { window: { __ModuleLoader__: { load: (entry) => (sandbox.loaded = entry) } } };
const requireStub = (name) => {
  if (name === 'react') return sandbox.react;
  throw new Error(`unexpected require(${name})`);
};
new Function('window', 'require', 'console', 'fetch', bundle)(sandbox.window, requireStub, console, globalThis.fetch);

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(label);
};

/* ---------- 场景 1：正常计划 ---------- */
let shell = makeShell();
sandbox.react = shell.react;
const module = sandbox.loaded.factory(requireStub);
module.apply(shell.ctx, { react: shell.react, fetchImpl: shell.fetchImpl });
check('loader id = package name', sandbox.loaded.id === pkg.name, sandbox.loaded.id);
check(
  'dock 注册 trigger@59 + card@60 + bar@61',
  shell.registered.map((e) => `${e.spec.id}@${e.spec.order}`).join(',') ===
    'router-plan-trigger@59,router-plan-card@60,router-status-bar@61',
  JSON.stringify(shell.registered.map((e) => e.spec.id)),
);

const trigger = shell.registered.find((e) => e.spec.id === 'router-plan-trigger').component;
const button = trigger();
check('按钮是 <button> 且文案 [生成计划]', button.type === 'button' && textOf(button).includes('[生成计划]'));

button.props.onClick();
await new Promise((r) => setTimeout(r, 50));
const view = module.latestPlanView();
const lines = module.planCardView(view) ?? [];
check('点击真的发了 POST /router/plan', shell.calls.filter((c) => c.method === 'POST' && c.path === '/router/plan').length === 1);
check('taskId 由客户端生成 ui-<ts>', /^ui-\d+$/.test(shell.calls.find((c) => c.method === 'POST').body.taskId));
check('拿回 ready 的计划卡', view?.state === 'ready', `state=${view?.state}`);
check('卡里有模型行与费用', lines.some((l) => l.includes('▾')) && lines.some((l) => l.includes('$')));
console.log('   —— 场景1 计划卡渲染 ——');
for (const line of lines) console.log('     ' + line);

/* ---------- 场景 2：空清单 ---------- */
shell = makeShell();
sandbox.react = shell.react;
const module2 = sandbox.loaded.factory(requireStub);
module2.apply(shell.ctx, { react: shell.react, fetchImpl: shell.fetchImpl });
const trigger2 = shell.registered.find((e) => e.spec.id === 'router-plan-trigger').component;
trigger2({ stageNames: [] }).props.onClick();
await new Promise((r) => setTimeout(r, 50));
const view2 = module2.latestPlanView();
const lines2 = module2.planCardView(view2) ?? [];
check('空清单：状态码不是 500（响应 ok）', view2?.state === 'ready', `state=${view2?.state}`);
check('空清单：卡里印出提示且不给确认开工', lines2.some((l) => l.includes('空清单：未提供阶段')) && !lines2.some((l) => l.includes('确认开工')));
console.log('   —— 场景2 空清单渲染 ——');
for (const line of lines2) console.log('     ' + line);

/* ---------- 场景 3：宿主失败 ---------- */
shell = makeShell();
sandbox.react = shell.react;
const module3 = sandbox.loaded.factory(requireStub);
module3.apply(shell.ctx, {
  react: shell.react,
  fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }),
});
const trigger3 = shell.registered.find((e) => e.spec.id === 'router-plan-trigger').component;
trigger3().props.onClick();
await new Promise((r) => setTimeout(r, 50));
const lines3 = module3.planCardView(module3.latestPlanView()) ?? [];
check('失败显示宿主原因而非空壳', lines3.join('\n').includes('加载失败：boom'), JSON.stringify(lines3));

console.log('\nVERDICT:', failures.length === 0 ? '全部通过 ✅' : `失败 ${failures.length} 条 ❌`);
process.exitCode = failures.length === 0 ? 0 : 1;
