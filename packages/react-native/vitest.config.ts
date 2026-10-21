import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: { 'react-native': fileURLToPath(new URL('./src/__tests__/mocks/react-native.ts', import.meta.url)) },
  },
  test: { environment: 'jsdom' },
});
