/**
 * Builds the browser half: `dist/client/client.js`.
 *
 * Run by `npm run build` after `tsc`. Kept as a script (not part of the test
 * suite) for the same reason the TypeScript build is: building is a gate.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildClientBundle } from './client-bundle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const result = await buildClientBundle({
  // The compiled entry, so the browser bundle and the typechecked source can
  // never disagree about what `apply` does.
  entry: join(ROOT, 'dist/plugin/client-entry.js'),
  outfile: join(ROOT, 'dist/client/client.js'),
});

console.log(`client bundle: ${result.outfile} (${result.bytes} bytes, wrapped=${result.wrapped})`);
