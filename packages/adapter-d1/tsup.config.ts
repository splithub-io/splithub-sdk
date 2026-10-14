import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', testing: 'src/testing.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['node:sqlite', '@splithub/node', '@splithub/core'],
});
