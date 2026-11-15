/**
 * A/B 复现脚本：多行纯量（plain scalar 折行）→ config=0（灰狼 2026-11-15 line 732）
 *
 * 用法（`adapters` 目录 = 某个构建产物里的 adapters/，含 yaml-lite.js + dsh-profile-config.js）：
 *   # 修复前：基线提交 1ff55a3 的构建产物（dist/adapters）
 *   node scripts/repro-yaml-multiline.mjs /tmp/before-dist/adapters
 *   # 修复后：当前源码编译出的 adapters
 *   npm run build && node scripts/repro-yaml-multiline.mjs dist/adapters
 *
 * 装置：造一份与对侧 0.2.1-rc.2 web profile 同形的 `cordis.patch.yml`：
 *   - xerj MCP 的 args 里 `- ApiKey` 后换行续写密钥（合法 YAML 多行纯量）；
 *   - 后面是 llm-pi-ai 的 provider 段，写清 contextWindow / maxTokens / 单价。
 * 填充注释行使续写行正好落在**第 732 行**，与对侧报的报错行号一字不差。
 * 然后走插件真实的读取层 readProfileConfigFiles，打印 config / skipped / 价格。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const adapters = process.argv[2];
if (!adapters) {
  console.error('usage: node temp/repro-yaml-multiline.mjs <adapters-dir>');
  process.exit(2);
}

const { readProfileConfigFiles } = await import(pathToFileURL(join(adapters, 'dsh-profile-config.js')).href);

/** 续写行必须落在 732：先数固定部分的偏移，再补注释。 */
const body = [
  '- insert:',
  '    - id: mcp-xerj',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: xerj',
  '        transport: stdio',
  '        command: npx',
  '        args:',
  '          - -y',
  '          - xerj-mcp',
  '          - ApiKey', // ← 732 行是它的续写行（下一行）
  '            sk-<redacted-key>',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      freellmapi:',
  '        displayName: FreeLLMAPI 免费池网关',
  '        models:',
  '          - id: auto',
  '            name: FreeLLMAPI Auto',
  '            contextWindow: 200000',
  '            maxTokens: 16384',
  '            inputPerMTok: 0',
  '            outputPerMTok: 0',
  '      deepseek-account:',
  '        displayName: DeepSeek 官方账号',
  '        models:',
  '          - id: deepseek-flash',
  '            name: DeepSeek Flash',
  '            contextWindow: 1048576',
  '            maxTokens: 65536',
  '            inputPerMTok: 0.28',
  '            outputPerMTok: 0.42',
];

// 续写行 = 补丁行（顶部注释）+ body 里的第 12 行；令其等于 732。
const header = '# cordis.patch.yml — 复现装置（填充注释使续写行落在 732）';
const pad = 732 - 12 - 1;
const lines = [header, ...Array.from({ length: pad }, (_, i) => `# filler ${i + 1}`), ...body];
const dir = mkdtempSync(join(tmpdir(), 'repro-732-'));
const file = join(dir, 'cordis.patch.yml');
writeFileSync(file, lines.join('\n') + '\n', 'utf8');

const scanned = await readProfileConfigFiles([file]);
const models = scanned.providers.flatMap((p) => p.models.map((m) => ({ key: `${p.id}/${m.id}`, ...m })));

console.log('adapters      :', adapters);
console.log('file          :', file);
console.log('续写行号      :', lines.findIndex((l) => l.includes('sk-<redacted-key>')) + 1);
console.log('filesRead     :', scanned.filesRead.length);
console.log('config(providers):', scanned.providers.length);
console.log('config(models)   :', models.length);
console.log('providers     :', JSON.stringify(scanned.providers.map((p) => p.id)));
console.log('models        :', JSON.stringify(models.map((m) => ({
  key: m.key,
  contextWindow: m.contextWindow ?? null,
  maxTokens: m.maxOutputTokens ?? null,
  inputPerMTok: m.inputPerMTok ?? null,
  outputPerMTok: m.outputPerMTok ?? null,
}))));
console.log('skipped       :', JSON.stringify(scanned.skipped));
console.log('VERDICT       :', scanned.providers.length > 0 ? 'config>0 ✅' : 'config=0 ❌');
