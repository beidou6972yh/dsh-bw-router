#!/usr/bin/env node
// Minimal MCP stdio server for WB router. No dependencies.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.WB_GATEWAY_URL || 'http://127.0.0.1:18790').replace(/\/+$/, '');
const KEY_FILE = process.env.WB_GATEWAY_KEY_FILE || join(homedir(), '.wb-router', 'wb-remote.json');
// ── Q3-7（2026-11-18）：凭据契约闭合 ─────────────────────────────────────
// 优先级：WB_GATEWAY_API_KEY(env) > WB_GATEWAY_KEY_FILE(文件，{"token":"…"})
// 两者都没有时：health/capabilities 仍可访问（网关 AUTH_EXEMPT_PATHS），
// 其余接口直接给可操作错误，而不是静默 401（外部机器最常见就是"没文件"）。
const KEY_EXEMPT_PATHS = new Set(['/health', '/v1/route/capabilities']);
function keyInfo() {
  const env = (process.env.WB_GATEWAY_API_KEY || '').trim();
  if (env) return { token: env, source: 'env' };
  try {
    const token = String(JSON.parse(readFileSync(KEY_FILE, 'utf8')).token || '').trim();
    if (token) return { token, source: `file:${KEY_FILE}` };
  } catch { /* 文件缺失/坏 JSON ⇒ 明确报错，不猜 */ }
  return { token: '', source: 'none' };
}
async function api(path, method = 'GET', body) {
  const headers = { accept: 'application/json' };
  const ki = keyInfo();
  if (ki.token) headers.authorization = `Bearer ${ki.token}`;
  // 1.0.3.5：不在客户端预检 key —— 网关默认不鉴权时 plan/execute 无需 key；
  // 只有网关真的返回 401（启用了 ROUTER_API_KEY）才提示怎么配。
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 500) }; }
  // 401 时把"凭据来源"带出来，便于判断是 env/file 哪一路失效（不含 token 本身）
  if (r.status === 401 && data && typeof data === 'object') {
    data.credential = { source: ki.source, provided: Boolean(ki.token) };
    data.hint = '网关已启用鉴权：请设置 WB_GATEWAY_API_KEY，或提供可读的 WB_GATEWAY_KEY_FILE'
      + `（默认 ${KEY_FILE}，形如 {"token":"…"}，权限 600）。网关未启用鉴权时无需任何 key。`;
  }
  return { status: r.status, ok: r.ok, data };
}
const TOOLS = [
  {
    name: 'wb_route_plan',
    description: '向 WB 模型路由决策器生成分段计划。无副作用；返回 plan_id/stages/估算，执行前必须让用户确认。',
    inputSchema: { type: 'object', properties: {
      task: { type: 'string', description: '用户任务' },
      context: { type: 'string', description: '紧凑上下文/约束（可选）' },
      strategy: { type: 'string', enum: ['auto', 'cost', 'capability', 'function'], description: '默认 auto' },
      function: { type: 'string', description: 'strategy=function 时必填，如 coding/vision/long_context' },
      max_stages: { type: 'number', description: '1-6，默认 3' },
      stage_models: { type: 'object', description: '会话钉选：按段 id 指定模型，如 {"s1":"<upstream>/<model>"}；也接受数字键 "1"/"2"/"3"。非法/未注册模型自动跳过，不阻断计划。' }
    }, required: ['task'] }
  },
  {
    name: 'wb_route_execute',
    description: '按已确认的计划执行一个阶段：调网关 chat，并把 plan/stage/model/usage 回写 annotation。必须 confirmed=true。',
    inputSchema: { type: 'object', properties: {
      plan_id: { type: 'string' },
      stage_id: { type: 'string' },
      model: { type: 'string', description: '该阶段模型 key（计划里的 model.key；显式 upstream/model）' },
      messages: { type: 'array', description: 'OpenAI messages；与 prompt 二选一' },
      prompt: { type: 'string', description: '单条 user 消息；与 messages 二选一' },
      confirmed: { type: 'boolean', description: '必须显式 true' },
      strategy: { type: 'string' },
      capability: { type: 'string' },
      function: { type: 'string' },
      temperature: { type: 'number' },
      max_tokens: { type: 'number' }
    }, required: ['plan_id', 'stage_id', 'model', 'confirmed'] }
  },
  {
    name: 'wb_route_health',
    description: '检查 WB 网关健康。',
    inputSchema: { type: 'object', properties: {} }
  }
];
async function callTool(name, args = {}) {
  if (name === 'wb_route_health') {
    const r = await api('/health');
    return { content: [{ type: 'text', text: JSON.stringify({ status: r.status, ok: r.status === 200, gateway: r.data }) }] };
  }
  if (name === 'wb_route_plan') {
    const task = String(args.task || '').trim();
    if (!task) throw new Error('task 不能为空');
    const body = { task, strategy: args.strategy || 'auto' };
    if (args.context) body.context = String(args.context);
    if (args.function) body.function = String(args.function);
    body.constraints = { max_stages: Number(args.max_stages || 3) };
    // 2026-11-24 会话钉选：请求级覆写三路模型，不写盘、不影响其他会话。
    if (args.stage_models && typeof args.stage_models === 'object' && !Array.isArray(args.stage_models)) {
      body.stage_models = args.stage_models;
    }
    const r = await api('/v1/route/plan', 'POST', body);
    if (!r.ok) throw new Error(`plan HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 500)}`);
    return { content: [{ type: 'text', text: JSON.stringify({ ...r.data, confirm_required: true,
      next: '把计划给用户看；用户明确确认后，再调用 wb_route_execute（confirmed=true），逐段执行。' }) }] };
  }
  if (name === 'wb_route_execute') {
    if (args.confirmed !== true) throw new Error('用户未确认：wb_route_execute 必须 confirmed=true');
    const model = String(args.model || '').trim();
    const planId = String(args.plan_id || '').trim();
    const stageId = String(args.stage_id || '').trim();
    if (!model || !planId || !stageId) throw new Error('plan_id/stage_id/model 必填');
    let messages = args.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) throw new Error('需要 messages 或 prompt');
      messages = [{ role: 'user', content: prompt }];
    }
    const body = { model, messages, stream: false };
    if (typeof args.temperature === 'number') body.temperature = args.temperature;
    if (typeof args.max_tokens === 'number') body.max_tokens = args.max_tokens;
    const r = await api('/v1/chat/completions', 'POST', body);
    if (!r.ok) throw new Error(`execute HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 500)}`);
    const msg = r.data?.choices?.[0]?.message || {};
    const text = String(msg.content || msg.reasoning_content || '');
    const usage = r.data?.usage || {};
    // ── Q1-2 遗留（2026-11-18 夜）：annotation 被网关拒绝时给出**可操作提示** ──
    // 背景：网关 1.0.2 起严格校验 plan/stage/model/principal；模型调用已成功时不让标注失败
    // 连累用户拿不到答案，所以这里不 throw，而是把拒绝原因、code 与下一步提示一起回给调用方。
    let ann = { status: 0, ok: false, data: {} };
    try {
      ann = await api('/v1/route/annotation', 'POST', {
        plan_id: planId, stage_id: stageId, model_key: model, confirmed: true, outcome: 'ok',
        strategy: args.strategy || undefined, capability: args.capability || undefined,
        function: args.function || undefined, usage
      });
    } catch (e) {
      ann = { status: 0, ok: false, data: { code: 'annotation_unreachable', error: String(e && e.message || e) } };
    }
    const annCode = ann?.data?.code;
    const annWarning = ann.ok ? null : {
      code: annCode || `http_${ann.status}`,
      message: ann?.data?.error || `annotation HTTP ${ann.status}`,
      hint: annCode === 'plan_unknown'
        ? '计划已失效（网关重启会清空内存中的 plan 状态）：请重新调用 wb_route_plan 生成新计划后再执行；本次的模型输出仍然有效。'
        : annCode === 'plan_principal_mismatch'
          ? '该计划属于另一个 API key：请用生成计划的同一 key 执行。'
          : annCode === 'stage_unknown'
            ? 'stage_id 不在该计划里：请先用 plan 返回的 stages[].stage_id。'
            : annCode === 'model_mismatch'
              ? '本次模型与计划该阶段不符：若要降级请按计划模型重试，或重新 plan 选对模型。'
              : '标注未写入（不影响本次结果）；把上面的 code 报给灰狼排查。',
    };
    const payload = { ok: true, model, content: text, usage,
      annotation: { status: ann.status, ok: ann.ok, learned: ann.data?.learned || null },
      // Q3-11：把「预估 vs 实付」差额行带到执行回执里（网关 annotation 计算）
      estimate_delta: ann.data?.estimate_delta || null };
    if (annWarning) payload.annotation_warning = annWarning;
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }
  throw new Error(`unknown tool: ${name}`);
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
rl.on('line', async (line) => {
  const raw = line.trim(); if (!raw) return;
  let req; try { req = JSON.parse(raw); } catch { return; }
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'wb-max-mcp', version: '0.1.0' } } });
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      return;
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const name = params?.name; const args = params?.arguments || {};
      const result = await callTool(name, args);
      send({ jsonrpc: '2.0', id, result });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(error?.message || error) } });
  }
});
