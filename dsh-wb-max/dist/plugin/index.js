// dsh-wb-max host half: proxy gateway plan/annotation/models + DSH session switch.
import { readFileSync } from 'node:fs';

export const inject = ['webServer'];
const GATEWAY_BASE = (process.env.WB_GATEWAY_BASE || 'http://127.0.0.1:18790').replace(/\/+$/, '');
const KEY_FILE = process.env.WB_GATEWAY_KEY_FILE || (process.env.DSH_HOME ? process.env.DSH_HOME + '/config/gateway.local.json' : '');

function gatewayKey() {
  const env = (process.env.WB_GATEWAY_API_KEY || '').trim();
  if (env) return env;
  try {
    const doc = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
    return String(doc.token || doc.api_key || '').trim();
  } catch { return ''; }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c.toString(); if (raw.length > 2 * 1024 * 1024) raw = raw.slice(0, 2 * 1024 * 1024); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}
async function proxy(path, method, body, extraHeaders) {
  const key = gatewayKey();
  const headers = { accept: 'application/json', ...(extraHeaders || {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const resp = await fetch(`${GATEWAY_BASE}${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 500) }; }
  return { status: resp.status, data };
}

function serviceOf(ctx, name) {
  let get;
  try { get = ctx?.get; } catch { get = undefined; }
  if (typeof get === 'function') {
    try { const v = get.call(ctx, name); if (v !== null && v !== undefined) return v; } catch {}
  }
  try { const v = ctx?.[name]; return v === null || v === undefined ? undefined : v; } catch { return undefined; }
}
function sessionService(ctx) {
  for (const name of ['sessionController', 'session', 'sessions']) {
    const service = serviceOf(ctx, name);
    if (service && (typeof service.selectModel === 'function' || typeof service.setModel === 'function')) return { name, service };
  }
  return undefined;
}
function sessionDebug(ctx) {
  const out = {};
  for (const name of ['sessionController', 'session', 'sessions']) {
    const service = serviceOf(ctx, name);
    out[name] = service ? {
      selectModel: typeof service.selectModel === 'function' ? service.selectModel.length : null,
      setModel: typeof service.setModel === 'function' ? service.setModel.length : null,
    } : null;
  }
  return out;
}
function callSelect(select, sessionId, provider, model) {
  const arity = select.length;
  if (arity >= 3) return select(sessionId, provider, model);
  if (arity === 2) return select(provider, model);
  return select({ sessionId, provider, model });
}
async function doSwitch(ctx, body) {
  const sessionId = String(body?.sessionId || '').trim();
  let modelKey = String(body?.modelKey || '').trim();
  if (modelKey.startsWith('wb-gateway/')) modelKey = modelKey.slice('wb-gateway/'.length);
  const dshDirect = /^(provider_i|provider_h)\//.test(modelKey);
  const provider = dshDirect ? modelKey.split('/')[0] : 'wb-gateway';
  const model = dshDirect ? modelKey.split('/').slice(1).join('/') : modelKey;
  if (!sessionId) return { status: 400, data: { ok: false, error: 'sessionId required' } };
  if (!modelKey) return { status: 400, data: { ok: false, error: 'modelKey required' } };
  const found = sessionService(ctx);
  const service = found?.service;
  const select = service?.selectModel || service?.setModel;
  if (!select) return { status: 501, data: { ok: false, error: 'host offers no selectModel', debug: sessionDebug(ctx) } };
  try {
    await callSelect(select.bind(service), sessionId, provider, model);
    return { status: 200, data: { ok: true, sessionId, provider, model, service: found.name } };
  } catch (error) {
    return { status: 502, data: { ok: false, error: String(error?.message || error), service: found.name, arity: select.length } };
  }
}

export function apply(ctx) {
  const register = () => {
    ctx.webServer?.register({
      kind: 'prefix',
      path: '/wb-max',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const path = url.pathname.replace(/^\/wb-max/, '') || '/';
        const method = (req.method || 'GET').toUpperCase();
        try {
          if (method === 'GET' && path === '/debug') { return json(res, 200, { ok: true, services: sessionDebug(ctx) }); }
          if (method === 'GET' && path === '/health') {
            const r = await proxy('/health', 'GET');
            return json(res, r.status, { ok: r.status === 200, gateway: r.data, base: GATEWAY_BASE });
          }
          if (method === 'GET' && path === '/logs') {
            const planId = String(url.searchParams.get('planId') || '').trim();
            const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100) || 100));
            const r = await proxy(`/router/ledger?limit=${limit}`, 'GET');
            let annotations = [];
            try {
              const file = process.env.WB_ANNOTATIONS_FILE || (process.env.DSH_HOME ? process.env.DSH_HOME + '/annotations.jsonl' : '');
              annotations = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).filter((row) => !planId || row.plan_id === planId).slice(-limit);
            } catch {}
            return json(res, 200, { ok: true, planId, filter: planId ? 'plan_id + 最近网关请求' : '最近网关请求', ledger: r.data?.data || r.data || [], annotations });
          }
          if (method === 'GET' && path === '/models') {
            const r = await proxy('/v1/models', 'GET');
            if (r.status !== 200) return json(res, r.status, r.data);
            const data = (r.data?.data || []).map((m) => ({
              key: `wb-gateway/${m.id}`,
              model: m.id,
              label: m.id,
              context_window: m.context_window ?? null,
              max_output_tokens: m.max_output_tokens ?? null,
              vision: m.vision ?? null,
              capabilities: m.capabilities ?? null,
            }));
            return json(res, 200, { ok: true, count: data.length, models: data });
          }
          if (method === 'POST' && path === '/plan') {
            const body = await readBody(req);
            // 推荐策略模式透传（2026-11-17）：mode → 请求头 X-DSH-Route-Mode
            const mode = String(body?.mode || '').trim().toLowerCase();
            // [2026-11-20 用户令] 决策模型开关：面板选择经 body.decider 透传为 X-WB-Decider（off|shadow|active）
            const dec = String(body?.decider || '').trim().toLowerCase();
            const hdr = {};
            if (mode) hdr['X-DSH-Route-Mode'] = mode;
            if (['off', 'shadow', 'active'].includes(dec)) hdr['X-WB-Decider'] = dec;
            // [2026-11-21 1.0.3.2 · T3/B3] 自动化档位：L2/L3 双写（body.automation_level + 同名请求头，
            // 二者强制一致）；L1 一律不带任何档位字段/头 ⇒ 与 1.0.3.1 的 plan 请求逐字节一致。
            // body 本身仍整体透传（网关未升级时旧逻辑不变）；只有 L2/L3 才规范化该字段。
            const AUTO_LEVELS = new Set(['L2', 'L3']);
            const bodyLevel = String(body?.automation_level || '').trim().toUpperCase();
            const headerLevel = String(req.headers?.['x-wb-automation-level'] || '').trim().toUpperCase();
            const autoLevel = AUTO_LEVELS.has(headerLevel) ? headerLevel : (AUTO_LEVELS.has(bodyLevel) ? bodyLevel : '');
            let outBody = body;
            if (autoLevel) {
              hdr['X-WB-Automation-Level'] = autoLevel;
              if (!body || body.automation_level !== autoLevel) outBody = { ...(body || {}), automation_level: autoLevel };
            }
            const r = await proxy('/v1/route/plan', 'POST', outBody,
              Object.keys(hdr).length ? hdr : undefined);
            return json(res, r.status, r.data);
          }
          if (method === 'POST' && path === '/annotation') {
            const body = await readBody(req);
            const r = await proxy('/v1/route/annotation', 'POST', body);
            return json(res, r.status, r.data);
          }
          if (method === 'POST' && path === '/switch') {
            const body = await readBody(req);
            const r = await doSwitch(ctx, body);
            return json(res, r.status, r.data);
          }
          return json(res, 404, { ok: false, error: `unknown /wb-max${path}` });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message || error) });
        }
      },
    });
  };
  const effect = ctx?.effect;
  if (typeof effect === 'function') effect(() => register()); else register();
}
