import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Machine-enforced architecture rules. This test is the only thing keeping the
 * kernel portable, so it reads the real files instead of trusting convention,
 * and it is checked against an escape-case matrix: every shape that used to slip
 * through (`await import(...)`, bare side-effect imports, `node:fs/promises`,
 * global `fetch`/`process`, `../adapters/*`) must be rejected.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CORE = join(ROOT, 'src/core');
/**
 * Where the escape matrix writes its probe file.
 *
 * M-8: it used to write into `src/core/`, so a probe that imports
 * `@org/cordis` existed *inside the build root* — `tsc` then failed
 * with TS2307 for as long as the file lived, and `npm test` (which ran a build)
 * went red for reasons that had nothing to do with the code under test. The
 * probe now lives outside `src/`, so a concurrent build can never see it, and
 * `tsconfig.build.json` excludes the directory anyway (belt and braces: the
 * build must be hermetic even if a probe is left behind by a killed run).
 */
const PROBE_DIR = join(ROOT, 'test/.probe');
const PROBE_FILE = join(PROBE_DIR, '__escape_probe.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Masks comments and string/template literal *contents* with fill characters.
 *
 * Two things it must do, and the old version failed the first:
 *  - prose cannot trip the rules: `'no fetch implementation available'` inside a
 *    normal UI string is not a call to `fetch` (false positive, fixed here);
 *  - code cannot hide in a string: the fills are newlines and spaces, never
 *    letters, so a match still lands on the right line and cannot be assembled
 *    out of quoted fragments (`'fe' + 'tch('` reads as `'  ' + '    ('`).
 * Specifier contents are kept, because they are what the import rules inspect.
 */
export function maskCommentsAndStrings(source: string, options: { keepSpecifiers?: boolean } = {}): string {
  const keepSpecifiers = options.keepSpecifiers ?? true;
  let out = '';
  let i = 0;
  type Mode = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  let content = '';

  const fill = (text: string, keep: boolean): string =>
    keep ? text : text.replace(/[^\n]/g, ' ');

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line-comment'; i += 2; continue; }
      if (c === '/' && next === '*') { mode = 'block-comment'; i += 2; continue; }
      if (c === "'") { mode = 'single'; out += "'"; content = ''; i++; continue; }
      if (c === '"') { mode = 'double'; out += '"'; content = ''; i++; continue; }
      if (c === '`') { mode = 'template'; out += '`'; content = ''; i++; continue; }
      out += c;
      i++;
      continue;
    }
    if (mode === 'line-comment') {
      if (c === '\n') { mode = 'code'; out += c; }
      i++;
      continue;
    }
    if (mode === 'block-comment') {
      // Keep the newlines so line numbers in reports still match the file.
      if (c === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n';
      i++;
      continue;
    }
    const closer = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
    if (c === '\\') { content += source.slice(i, i + 2); i += 2; continue; }
    if (c === closer) {
      out += fill(content, keepSpecifiers) + c;
      content = '';
      mode = 'code';
      i++;
      continue;
    }
    content += c;
    i++;
  }
  if (mode !== 'code') out += fill(content, keepSpecifiers);
  return out;
}

/** Back-compat name used by older notes: masked code with specifiers kept. */
export const stripCommentsAndStrings = (source: string): string =>
  maskCommentsAndStrings(source, { keepSpecifiers: false });

/** Every module specifier the file mentions, whatever the import form. */
export function importSpecifiers(source: string): string[] {
  // Specifiers are kept on purpose: blanking them would blank the evidence.
  const code = maskCommentsAndStrings(source, { keepSpecifiers: true });
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // import x from '...' / export ... from '...'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // await import('...')
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('...')
    /\bimport\s+['"]([^'"]+)['"]/g, // bare side-effect import '...'
  ];
  for (const re of patterns) {
    for (const match of code.matchAll(re)) specs.push(match[1]!);
  }
  return specs;
}

/** Shapes that assemble an import/computed reference a regex will never read. */
const OPAQUE_LOADER = /\bimport\s*\(\s*[^'"\s)]/;
const IDENTIFIER_ARGUMENT = /\b(import|require)\s*\(\s*[A-Za-z_$][\w$]*\s*[),]/;

/** Node builtins the kernel may never touch, including their subpaths. */
const NODE_BUILTIN = /^(node:)?(fs|net|http|https|http2|dns|tls|os|stream|module|worker_threads|child_process|cluster|dgram|v8|vm|inspector|readline|repl|tty|zlib|perf_hooks|crypto)(\/|$)/;
const PLATFORM_IMPORT = /^(@deepseek-ai\/|ds-h|@?dsh[-\/])/;
/** Platform/network globals need no import, so they are matched in code. */
const FORBIDDEN_GLOBAL =
  /\b(fetch|XMLHttpRequest|WebSocket|process|globalThis|Buffer|__dirname|__filename|Deno|Bun)\b/;
const HARDCODED_IP = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
/**
 * Private/LAN IPv4 ranges (RFC 1918 + link-local).
 *
 * Loopback is deliberately **not** internal topology: a local fixture pointing
 * at `http://127.0.0.1:11434/v1` is the recommended replacement for a LAN
 * address, so a rule that also reds on it would forbid the fix.
 */
const INTERNAL_IP = /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/;
const SECRET_LIKE = /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,})/;

/** Rules run on masked code: comments and strings can neither hide nor trip. */
export function violations(source: string, file = '<sample>'): string[] {
  const code = maskCommentsAndStrings(source, { keepSpecifiers: false });
  const out: string[] = [];

  // A loader whose argument we cannot read is not "clean", it is unproven.
  if (OPAQUE_LOADER.test(code)) out.push(`${file} -> dynamic import with a computed specifier`);
  if (IDENTIFIER_ARGUMENT.test(code)) out.push(`${file} -> import/require called with a variable`);

  for (const spec of importSpecifiers(source)) {
    if (NODE_BUILTIN.test(spec)) out.push(`${file} -> imports node builtin "${spec}"`);
    if (PLATFORM_IMPORT.test(spec)) out.push(`${file} -> imports platform module "${spec}"`);
    if (!spec.startsWith('.')) out.push(`${file} -> bare specifier "${spec}"`);
    // Relative imports must stay inside core: no '..', and ESM wants the .js suffix.
    if (spec.startsWith('.')) {
      if (spec.split('/').includes('..')) out.push(`${file} -> escapes core with "${spec}"`);
      if (!spec.endsWith('.js')) out.push(`${file} -> "${spec}" must end with .js`);
    }
  }

  for (const match of code.matchAll(new RegExp(FORBIDDEN_GLOBAL.source, 'g'))) {
    out.push(`${file} -> uses global "${match[1]}"`);
  }
  return [...new Set(out)];
}

describe('architecture: src/core stays portable', () => {
  const files = walk(CORE);

  it('has core files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('imports nothing outside core and touches no platform/global API', () => {
    const offenders = files.flatMap((f) => violations(readFileSync(f, 'utf8'), relative(ROOT, f)));
    expect(offenders).toEqual([]);
  });

  it('the internal-address rule fires on a real LAN address and stays quiet on the fix + versions', () => {
    // Built by joining parts so this test file does not itself contain the
    // literal it forbids (the scan above reads raw source, strings included).
    const lan = ['192', '168', '1', '200'].join('.');
    expect(INTERNAL_IP.test(`baseURL: http://${lan}:11434/v1`)).toBe(true);
    expect(INTERNAL_IP.test(`baseURL: http://${['10', '1', '2', '3'].join('.')}/v1`)).toBe(true);
    expect(INTERNAL_IP.test(`baseURL: http://${['172', '20', '0', '5'].join('.')}/v1`)).toBe(true);
    // The recommended replacement must not be flagged, and neither must
    // versions/dates — a rule that reds on those gets switched off.
    expect(INTERNAL_IP.test('baseURL: http://127.0.0.1:11434/v1')).toBe(false);
    expect(INTERNAL_IP.test('DSH 0.2.1-rc.2')).toBe(false);
    expect(INTERNAL_IP.test('2026-10-26 08:48')).toBe(false);
    expect(INTERNAL_IP.test('http://localhost:3080')).toBe(false);
    expect(INTERNAL_IP.test('no address here')).toBe(false);
  });

  it('hardcodes no IP addresses or secret-looking strings', () => {
    const offenders = files.filter((f) => {
      const source = readFileSync(f, 'utf8');
      return HARDCODED_IP.test(source) || SECRET_LIKE.test(source);
    });
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

describe('architecture: no secrets or platform leakage repo-wide', () => {
  const sources = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'test'))];

  it('no secret-like strings anywhere in src/ or test/', () => {
    const offenders = sources.filter((f) => SECRET_LIKE.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('no hardcoded internal IPs anywhere in src/ or test/', () => {
    // The delivery package shipped a LAN baseURL inside a test fixture — an
    // internal address leaving the machine (P1-3). A rule that
    // only watched `src/` could not see it, so the scan covers both trees.
    const offenders = sources.filter((f) => INTERNAL_IP.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

/**
 * Meta-test: the rules above are only worth anything if the sneaky shapes are
 * caught. Each sample below is a real way the M0-1 rules were bypassed.
 */
describe('architecture: the rules catch every known escape (A-2)', () => {
  const escapes: [string, string][] = [
    ['static node import', "import { readFileSync } from 'node:fs';"],
    ['dynamic import', "const { readFileSync } = await import('node:fs');"],
    ['literal dynamic import', "await import(\"node:fs\");"],
    ['bare side-effect import', "import 'node:fs';"],
    ['require call', "const fs = require('fs');"],
    ['subpath builtin fs/promises', "import { readFile } from 'node:fs/promises';"],
    ['http2', "import { connect } from 'node:http2';"],
    ['worker_threads', "import { Worker } from 'node:worker_threads';"],
    ['module', "import { createRequire } from 'node:module';"],
    ['stream', "import { pipeline } from 'stream';"],
    ['global fetch', "const r = await fetch('http://api.example.com');"],
    ['global process', 'const token = process.env.MODEL_ROUTER_TOKEN;'],
    ['global Buffer', 'const raw = Buffer.from(payload);'],
    ['relative escape to adapters', "import { probe } from '../adapters/probe.js';"],
    ['relative escape upward', "import { x } from '../../other.js';"],
    ['platform package', "import type { Plugin } from '@org/cordis';"],
    ['computed import specifier', 'const spec = "node:fs"; const fs = await import(`node:${spec}`);'],
    ['template literal specifier', 'const fs = await import(`node:fs`);'],
    ['variable import argument', "const m = 'node:fs'; const fs = await import(m);"],
    ['require with variable', "const name = 'fs'; const fs = require(name);"],
  ];

  for (const [name, sample] of escapes) {
    it(`rejects ${name}`, () => {
      expect(violations(sample)).not.toEqual([]);
    });
  }

  it('rejects a directory-escaping specifier even when it ends with .js', () => {
    expect(violations("import { guard } from '../core/../adapters/probe.js';")).toEqual(
      ["<sample> -> escapes core with \"../core/../adapters/probe.js\""],
    );
  });

  it('does not fire on comments or plain prose containing the same words', () => {
    const clean = [
      "// we must never import node:fs or call fetch() here",
      '/** no process.env, no await import("node:fs"), no ../adapters */',
      "import { costOf } from './types.js';",
    ].join('\n');
    expect(violations(clean)).toEqual([]);
  });

  it('does not fire on prose or UI copy that merely mentions a forbidden word', () => {
    const copy = [
      "const noNet = 'no fetch implementation available';",
      'const hint = `no process.env here, no fetch(), no Buffer`;',
      "export const NOTE = 'never import node:fs from core';",
    ].join('\n');
    expect(violations(copy)).toEqual([]);
  });

  it('keeps UI copy with a forbidden word out of the real kernel check', () => {
    // `probe.ts` ships exactly this kind of string; the point is the rule, not the file.
    expect(violations("export const detail = 'no fetch implementation available';")).toEqual([]);
  });
});

/**
 * File-level escape matrix (N-2).
 *
 * The string matrix above only proves the pure function works. This one writes
 * each escaping shape into a real file under `src/core/`, runs the **same walk
 * and scan the kernel check uses**, and requires a red verdict for every shape.
 * If the masker, the walker or the patterns ever drift, this goes red before a
 * real import slips through.
 */
describe('architecture: escapes are caught in real files (N-2)', () => {
  const probeFile = PROBE_FILE;

  afterEach(() => {
    rmSync(probeFile, { force: true });
    expect(existsSync(probeFile)).toBe(false);
    rmSync(PROBE_DIR, { recursive: true, force: true });
  });

  const shapes: [string, string][] = [
    ['static node import', "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n"],
    ['dynamic import', "export const load = async () => (await import('node:fs')).readFile;\n"],
    ['bare side-effect import', "import 'node:fs';\nexport const x = 1;\n"],
    ['require', "export const fs = require('fs');\n"],
    ['global fetch', "export const go = () => fetch('http://api.example.com');\n"],
    ['global process', "export const token = () => process.env.TOKEN;\n"],
    ['escape to adapters', "import { probeEndpoint } from '../adapters/probe.js';\nexport const p = probeEndpoint;\n"],
    ['platform import', "import type { Plugin } from '@org/cordis';\nexport type P = Plugin;\n"],
    ['computed import', 'const name = "fs";\nexport const load = async () => import(`node:${name}`);\n'],
    ['variable import', "const name = 'node:fs';\nexport const load = async () => import(name);\n"],
  ];

  for (const [name, body] of shapes) {
    it(`rejects ${name} written into a real core file`, () => {
      mkdirSync(PROBE_DIR, { recursive: true });
      writeFileSync(probeFile, body, 'utf8');
      const offenders = walk(PROBE_DIR)
        .flatMap((f) => violations(readFileSync(f, 'utf8'), relative(ROOT, f)))
        .filter((o) => o.includes('__escape_probe.ts'));
      expect(offenders, `${name} slipped through the file-level scan`).not.toEqual([]);
    });
  }

  it('a file with only prose about forbidden things stays clean', () => {
    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(
      probeFile,
      [
        "/** Never call fetch() here, and never import node:fs. */",
        "export const detail = 'no fetch implementation available';",
        "export const hint = 'the host owns process.env, not the kernel';",
        '',
      ].join('\n'),
      'utf8',
    );
    const offenders = walk(PROBE_DIR).flatMap((f) => violations(readFileSync(f, 'utf8'), relative(ROOT, f)));
    expect(offenders).toEqual([]);
  });

  it('leaves src/ untouched, so a concurrent build cannot see the probe', () => {
    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(probeFile, "import type { Plugin } from '@org/cordis';\n", 'utf8');
    const inCore = walk(CORE).filter((f) => f.includes('__escape_probe'));
    expect(inCore).toEqual([]);
  });
});
