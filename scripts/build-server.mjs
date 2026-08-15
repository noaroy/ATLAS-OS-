import { build } from 'esbuild';
import { rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'dist/server/atlas.mjs');

/**
 * Bundles the server into a single ESM file.
 *
 * Bundling keeps deployment simple: one artifact plus the native SQLite
 * binding, no workspace resolution on the VPS, and a fast cold start.
 */
rmSync(resolve(root, 'dist/server'), { recursive: true, force: true });
mkdirSync(resolve(root, 'dist/server'), { recursive: true });

await build({
  entryPoints: [resolve(root, 'packages/server/src/main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false, // readable stack traces matter more than bytes on a server
  // better-sqlite3 ships a native binding that cannot be bundled.
  external: ['better-sqlite3'],
  banner: {
    // Some dependencies still expect CommonJS globals under ESM.
    js: [
      "import { createRequire as __atlasCreateRequire } from 'node:module';",
      "import { fileURLToPath as __atlasFileURLToPath } from 'node:url';",
      "import { dirname as __atlasDirname } from 'node:path';",
      'const require = __atlasCreateRequire(import.meta.url);',
      'const __filename = __atlasFileURLToPath(import.meta.url);',
      'const __dirname = __atlasDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});

console.log(`\nBuilt ${outfile}`);
console.log('Run with: node dist/server/atlas.mjs');
