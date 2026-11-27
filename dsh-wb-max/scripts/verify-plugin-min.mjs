#!/usr/bin/env node
/**
 * verify-plugin-min.mjs — 插件最小回归三条（随包可自跑，1.0.3.15 三方核查 .14 验收项）
 * 用法：node scripts/verify-plugin-min.mjs
 * 退出码 0 = 三条全过。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const idx = readFileSync(path.join(here, '..', 'dist', 'plugin', 'index.js'), 'utf8');
let pass = 0, total = 3;
function ok(cond, name) { if (cond) { pass++; console.log('  OK  ' + name); } else { console.log('  FAIL ' + name); process.exitCode = 1; } }
// 1) 不内置部署路径/凭据文件名
ok(!/\/opt\/|config\/(wb-)?gateway\.local\.json|数据\//.test(idx), '1 无内置部署路径/凭据文件名');
// 2) 缺鉴权 fail-loud（503），不静默发无鉴权请求
ok(/status:\s*503/.test(idx) && /gatewayKey\(\)/.test(idx), '2 缺鉴权明确 503');
// 3) annotations 仅显式配置时读取
ok(/WB_ANNOTATIONS_FILE/.test(idx) && /if \(file\)/.test(idx), '3 annotations 仅显式配置读取');
console.log(`最小回归 ${pass}/${total}`);
