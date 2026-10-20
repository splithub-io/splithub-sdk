// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createClient } from '../client';
import { defineConfig, newPropertyId, pickProperty } from '../config';
import { applyRemoteOverrides } from '../remote';
import type { EventBatch, PageEvent } from '../types';

const config = defineConfig({
  project: 'p',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: {},
  properties: { site: { goals: ['signup'] }, old: { status: 'paused' } },
});

describe('analytics properties', () => {
  it('normalizes properties and rejects unknown goals', () => {
    expect(config.properties).toEqual([
      { key: 'site', status: 'running', description: null, goals: ['signup'] },
      { key: 'old', status: 'paused', description: null, goals: [] },
    ]);
    expect(() => defineConfig({ project: 'p', storage: { mode: 'cloud' }, experiments: {}, properties: { x: { goals: ['nope'] } } })).toThrow(/not declared/);
    expect(() => defineConfig({ project: 'p', storage: { mode: 'cloud' }, experiments: {}, properties: { 'Bad Key': {} } })).toThrow(/invalid/);
    expect(pickProperty(config)).toBeNull();
    expect(pickProperty(config, 'old')?.key).toBe('old');
    expect(newPropertyId()).toMatch(/^sh-[a-z2-9]{6}$/);
  });

  it('applies live status and dashboard properties from the overrides', () => {
    const live = applyRemoteOverrides(config, { version: 2, experiments: {}, properties: { site: { status: 'paused' } }, addedProperties: [{ key: 'blog', status: 'running', description: null, goals: [] }, { key: 'site', status: 'running', description: null, goals: [] }] });
    expect(live.properties?.map((p) => `${p.key}:${p.status}:${p.origin ?? 'config'}`)).toEqual(['site:paused:config', 'old:paused:config', 'blog:running:dashboard']);
    expect(pickProperty(live, 'blog')?.status).toBe('running');
  });

  it('reports client-side navigations as pageviews once', async () => {
    const sent: EventBatch[] = [];
    const client = createClient(config, { property: 'site', transport: { send: (b) => void sent.push(b) } });
    client.pageview();
    history.pushState({}, '', '/pricing?plan=pro');
    history.replaceState({}, '', '/pricing?plan=team');
    await new Promise((r) => setTimeout(r, 5));
    history.pushState({}, '', '/docs');
    await new Promise((r) => setTimeout(r, 5));
    await client.flush();
    const pages = sent.flatMap((b) => b.events).filter((e): e is PageEvent => e.type === 'page');
    expect(pages.map((p) => p.url)).toEqual(['/', '/pricing?plan=team', '/docs']);
    expect(pages.every((p) => p.prop === 'site')).toBe(true);
    client.destroy();
    history.pushState({}, '', '/after');
    await new Promise((r) => setTimeout(r, 5));
    await client.flush();
    expect(sent.flatMap((b) => b.events).filter((e) => e.type === 'page')).toHaveLength(3);
  });

  it('sends no analytics without a property id', async () => {
    const sent: EventBatch[] = [];
    const client = createClient(config, { transport: { send: (b) => void sent.push(b) } });
    client.pageview('/x');
    client.track('Clicked');
    await client.flush();
    // The goal row still goes out for experiments; nothing for analytics.
    expect(sent.flatMap((b) => b.events).map((e) => e.type)).toEqual(['goal']);
  });
});
