import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A-1 regression: the package must be loadable. `npm test` and `npm run build`
 * were both green while `dist/index.js` did not exist, so this asserts the
 * declared entry points against the real files.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  main: string;
  types: string;
  exports: Record<string, string | Record<string, string>>;
};

/**
 * One `exports` entry, normalised.
 *
 * `exports["./package.json"]` is a bare string (the host's `locatePkgJson()`
 * `createRequire` fallback path needs it), every othersubpath is a conditions
 * object. Reading both shapes through one accessor keeps the assertions about
 * the *contract*, not about which of the two legal forms was used.
 */
function entry(name: string): Record<string, string> {
  const value = pkg.exports[name];
  if (value === undefined) return {};
  return typeof value === 'string' ? { default: value } : value;
}

describe('package entry points exist in source', () => {
  it('src/index.ts is the declared source of the public surface', () => {
    expect(existsSync(join(ROOT, 'src/index.ts'))).toBe(true);
  });

  it('main/types/exports all point at dist/index.*', () => {
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
    expect(entry('.').import).toBe('./dist/index.js');
    expect(entry('.').types).toBe('./dist/index.d.ts');
  });

  it('exposes the client half and the DSH shell as separate entries', () => {
    // The UI and the host shell each pull in a different audience: keeping them
    // separate is what lets a browser bundle import the client without dragging
    // the adapter layer (node:fs) along.
    expect(entry('./dsh').import).toBe('./dist/plugin/dsh-shell.js');
    // The formatting layer stays importable from Node (tests, CLI); the *loaded*
    // client half is the browser bundle below.
    expect(entry('./client-format').import).toBe('./dist/plugin/client.js');
  });

  it('points ./client at the browser bundle, with a string default the loader can resolve', () => {
    // `@deepseek-ai/dsh-client-modules` resolves `exports["./client"]` and only
    // accepts "a string or an object with a string default". The old shape
    // (`{ types, import }`) made the loader skip the plugin entirely — 灰狼 DEF-3.
    const raw: unknown = pkg.exports['./client'];
    // The loader's own rule, asserted as written: a string, or an object whose
    // `default` is a string. Nothing else is accepted, so nothing else is stored.
    const allowed = typeof raw === 'string' ? raw : (raw as { default?: unknown } | null)?.default;
    expect(typeof allowed).toBe('string');
    const target = typeof allowed === 'string' ? allowed : '';
    expect(typeof target).toBe('string');
    expect(target).toBe('./dist/client/client.js');
    expect(existsSync(join(ROOT, 'scripts/client-bundle.mjs'))).toBe(true);
  });

  it('declares the client half the way the host manifest reads it', () => {
    // `DshClientManifest` has exactly these fields (platform/inject/immediately/
    // external); there is no `slots` field, so the old `dsh.client.slots` block
    // was inert data that described registrations nothing performed. The slot
    // ids/orders now live where they are executed: `SLOT_REGISTRATIONS` in
    // src/plugin/client-entry.ts (asserted in test/client-slot-registration).
    const client = (pkg as unknown as { dsh?: { client?: Record<string, unknown> } }).dsh?.client;
    expect(client?.platform).toBe('web');
    expect(client?.slots).toBeUndefined();
    expect(client?.inject).toEqual(['@deepseek-ai/dsh-client-ui-conversation']);
    expect(typeof client?.immediately).toBe('boolean');
  });

  it('every declared build artifact is produced by the entry src files', () => {
    // M-8: this used to run `npm run build` (rm -rf dist + tsc) *inside* the unit
    // suite, with `stdio:'ignore'`, so `npm test` stopped being hermetic and a
    // concurrent probe file turned the whole suite red with the tsc error
    // swallowed. Building is a gate, not a unit test: `scripts/verify-m0.sh`
    // step [7]/[8] builds and imports the real artifacts and prints tsc's output.
    // What is checked here is the mapping those artifacts come from — pure file
    // reading, no side effects, safe to run in parallel.
    const entrySources: Record<string, string> = {
      './dist/index.js': 'src/index.ts',
      './dist/plugin/client.js': 'src/plugin/client.ts',
      './dist/client/client.js': 'src/plugin/client-entry.ts',
      './dist/plugin/dsh-shell.js': 'src/plugin/dsh-shell.ts',
    };
    for (const [artifact, source] of Object.entries(entrySources)) {
      const rel = source.replace(/^src\//, '').replace(/\.ts$/, '.js');
      expect(entry('./' + (source.split('/')[1] ?? 'index'))).toBeDefined();
      expect(existsSync(join(ROOT, source)), `${source} missing for ${artifact}`).toBe(true);
      expect(rel.length).toBeGreaterThan(0);
    }
  });
});

describe('./package.json is resolvable by the host', () => {
  it('declares the self-referencing subpath exactly as the file it is', () => {
    // `locatePkgJson()` falls back to `createRequire(...)('dsh-bw-router/package.json')`
    // when the normal path fails. Without this subpath, `require.resolve` answers
    // ERR_PACKAGE_PATH_NOT_EXPORTED and the host cannot find the manifest.
    expect(pkg.exports['./package.json']).toBe('./package.json');
    expect(existsSync(join(ROOT, 'package.json'))).toBe(true);
  });

  it('really resolves through require() — the fallback path, not a guess', () => {
    const require = createRequire(fileURLToPath(new URL('./probe.cjs', import.meta.url)));
    const resolved = require.resolve(`${pkg.name}/package.json`);
    expect(resolved).toBe(join(ROOT, 'package.json'));
    const manifest = require(`${pkg.name}/package.json`) as { name: string; version: string };
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('really resolves through import() as well', async () => {
    const namespace = (await import(`${pkg.name}/package.json`, { with: { type: 'json' } })) as {
      default: { name: string };
    };
    expect(namespace.default.name).toBe(pkg.name);
  });
});
