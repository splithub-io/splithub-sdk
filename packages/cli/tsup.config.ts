import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  sourcemap: true,
  clean: true,
  target: 'node18',
  platform: 'node',
  banner: { js: '#!/usr/bin/env node' },
  external: ['@splithub/node', '@splithub/core', '@clack/prompts', 'jiti', 'typescript'],
});
