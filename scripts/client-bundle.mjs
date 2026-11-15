/**
 * Builds the client half the way the DSH web loader consumes it.
 *
 * The loader does not import an ES module. `@deepseek-ai/dsh-client-modules`
 * serves the file named by `package.json` `exports["./client"]` as a classic
 * script and expects it to *register* a factory:
 *
 *   window.__ModuleLoader__.load({ id: '<package name>', factory(require) { … } })
 *
 * The factory receives the module table's `require` (so `require('react')` is
 * the shell's React, not a bundled copy) and must `return module.exports` after
 * setting `exports.apply` / `exports.inject`. A plain ESM file served there is a
 * syntax error in a classic script, which is exactly why the tester saw the
 * loader skip this plugin: "它的导出写法让加载器直接跳过".
 *
 * Bundling is done with `rolldown` (already present as vitest's bundler) and the
 * output is CJS, then wrapped. Only `react` stays external: everything else in
 * this package is our own code and must be inlined, because the browser module
 * table knows nothing about `dist/` paths.
 */
import { rolldown } from 'rolldown';

/** The package id the loader keys the module table by. */
export const CLIENT_MODULE_ID = 'dsh-bw-router';

/** Modules the host module table provides; never inlined. */
export const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime'];

/**
 * Wraps a CJS bundle body in the loader's registration factory.
 *
 * Pure string work — no bundler involved — so the shape can be asserted by a
 * unit test without building anything (the project treats "build" as a gate,
 * not as part of the test suite).
 *
 * @param id - package name the module table keys on.
 * @param code - CJS body produced by the bundler.
 * @returns the script the browser must execute.
 */
export function wrapClientBundle(id, code) {
  // A source map trailer inside the body would point at the pre-wrap offsets;
  // drop it and let the wrapper own the file's single trailer.
  const body = code.replace(/^\s*\/\/# sourceMappingURL=.*$/gm, '').trimEnd();
  const indented = body
    .split('\n')
    .map((line) => (line.length > 0 ? `      ${line}` : line))
    .join('\n');
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
${indented}
    return module.exports;
  },
});
`;
}

/**
 * Bundles `entry` into the loader's shape.
 *
 * @param options.entry - the client entry source (`src/plugin/client-entry.ts`).
 * @param options.outfile - where to write the script (`dist/client/client.js`).
 * @returns the written path and its size, for the build log.
 */
export async function buildClientBundle({ entry, outfile }) {
  const bundle = await rolldown({
    input: entry,
    platform: 'browser',
    external: CLIENT_EXTERNALS,
  });
  try {
    const { output } = await bundle.generate({ format: 'cjs', exports: 'named', sourcemap: false });
    const chunk = output.find((piece) => piece.type === 'chunk');
    if (!chunk) throw new Error('client bundle produced no chunk');
    const script = wrapClientBundle(CLIENT_MODULE_ID, chunk.code);
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(outfile), { recursive: true });
    await writeFile(outfile, script, 'utf8');
    return { outfile, bytes: Buffer.byteLength(script), wrapped: script.includes('__ModuleLoader__.load') };
  } finally {
    await bundle.close();
  }
}
