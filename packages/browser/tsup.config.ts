import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const coreSource = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig([
  // Library build (import { boot } from '@splithub/browser').
  { entry: { index: 'src/index.ts' }, format: ['esm', 'cjs'], dts: true, sourcemap: true, target: 'es2019' },
  // Self-running script served by the cloud as /sh.js. Core is bundled in.
  // LITE drops the development notes (never shown on a deployed site); NODE_ENV folds the dev-only branches.
  {
    entry: { sh: 'src/script.ts' },
    format: ['iife'],
    minify: true,
    target: 'es2019',
    noExternal: ['@splithub/core'],
    outExtension: () => ({ js: '.js' }),
    define: { __SPLITHUB_LITE__: 'true', 'process.env.NODE_ENV': '"production"' },
    // Bundle core from source, so sh.js never picks up a stale core build.
    esbuildOptions(options) {
      options.alias = { '@splithub/core': coreSource };
    },
  },
]);
