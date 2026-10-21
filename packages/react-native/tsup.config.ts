import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  define: { __SDK_VERSION__: JSON.stringify(version) },
  // Metro reads the CommonJS build: its literal require() calls inside try/catch are how
  // Metro handles the optional modules (storage, Expo info, Expo Router, React Navigation) that an app may not have.
  external: [
    'react',
    'react/jsx-runtime',
    'react-native',
    '@splithub/core',
    '@splithub/react',
    '@react-native-async-storage/async-storage',
    'react-native-mmkv',
    'expo-application',
    'expo-constants',
    'expo-device',
    'expo-router',
    '@react-navigation/native',
  ],
});
