import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({ entryPoints: [resolve(process.argv[2], 'server.mjs')], outfile: resolve(process.argv[2], 'server.bundle.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24', minify: false });
