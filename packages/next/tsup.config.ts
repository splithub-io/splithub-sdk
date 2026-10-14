import { defineConfig } from 'tsup';

const external = ['next', 'next/server', 'next/headers', 'react', 'react/jsx-runtime', '@splithub/core', '@splithub/react'];

export default defineConfig([
  {
    entry: { index: 'src/index.ts', server: 'src/server.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'es2020',
    external,
  },
  {
    entry: { client: 'src/client.tsx' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'es2020',
    external,
    banner: { js: '"use client";' },
  },
]);
