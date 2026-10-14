import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  external: ['react', 'react/jsx-runtime', '@splithub/core'],
  // Everything here runs in the browser; the directive lets Next.js import it from Server Components.
  banner: { js: '"use client";' },
});
