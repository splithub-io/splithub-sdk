import { defineConfig } from '@splithub/core';
import { describe, expect, it } from 'vitest';
import { configTemplate } from '../templates';

describe('cloud endpoint in the generated config', () => {
  it('reads the endpoint from the variable the bundler inlines', () => {
    expect(configTemplate('shop', 'cloud', 'pk_1', { framework: 'next' })).toContain('endpoint: process.env.NEXT_PUBLIC_SPLITHUB_ENDPOINT');
    expect(configTemplate('shop', 'cloud', undefined, { framework: 'vite' })).toContain("key: import.meta.env?.VITE_SPLITHUB_KEY ?? '', endpoint: import.meta.env?.VITE_SPLITHUB_ENDPOINT");
    expect(configTemplate('shop', 'cloud', 'pk_1', { app: true })).toContain('endpoint: process.env.EXPO_PUBLIC_SPLITHUB_ENDPOINT');
  });

  it('an unset variable means SplitHub Cloud', () => {
    const config = defineConfig({ project: 'p', storage: { mode: 'cloud', key: 'pk_1', endpoint: undefined }, experiments: {} });
    expect(config.storage).toEqual({ mode: 'cloud', key: 'pk_1' });
    expect(defineConfig({ project: 'p', storage: { mode: 'cloud', key: 'pk_1', endpoint: '' }, experiments: {} }).storage).toEqual({ mode: 'cloud', key: 'pk_1' });
    expect(defineConfig({ project: 'p', storage: { mode: 'cloud', key: 'pk_1', endpoint: 'stats.shop.example' }, experiments: {} }).storage).toMatchObject({ endpoint: 'https://stats.shop.example/v1/events' });
  });
});
