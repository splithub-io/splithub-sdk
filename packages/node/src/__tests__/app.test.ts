import { defineConfig, type EventBatch, type SplitHubEvent } from '@splithub/core';
import { describe, expect, it } from 'vitest';
import { appDimensions } from '../app';
import { storedEventFromRow } from '../analytics';
import { createSplitHubHandler } from '../handler';
import { createMemoryStore } from '../store';
import { sanitizeApp, validateBatch } from '../validate';

const config = defineConfig({
  project: 'demo',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: { hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 }, goal: 'signup' } },
  properties: { app: {} },
});

const now = Date.now();
const events: SplitHubEvent[] = [
  { type: 'exposure', id: 'evt_app_0001', vid: 'v1', sid: 's1', ts: now, exp: 'hero', var: 'bold' },
  { type: 'page', id: 'evt_app_0002', prop: 'app', vid: 'v1', sid: 's1', ts: now, url: '/settings', title: 'Settings' },
  { type: 'event', id: 'evt_app_0003', prop: 'app', name: 'signup', vid: 'v1', sid: 's1', ts: now + 1 },
];

function post(body: EventBatch) {
  const store = createMemoryStore();
  const handler = createSplitHubHandler({ config, store });
  return handler(new Request('http://x/api/splithub', { method: 'POST', body: JSON.stringify(body) })).then((res) => ({ res, store }));
}

describe('apps', () => {
  it('sanitizes the app block and keeps it on the validation result', () => {
    expect(sanitizeApp({ platform: 'ios', id: ' Com.Acme.Shop ', version: '2.4.1', device: 'tablet', model: 'x'.repeat(100) })).toEqual({ platform: 'ios', id: 'com.acme.shop', version: '2.4.1', device: 'tablet', model: 'x'.repeat(64) });
    expect(sanitizeApp({ platform: 'web' })).toBeUndefined();
    expect(sanitizeApp({ platform: 'android', device: 'watch' })).toEqual({ platform: 'android' });
    const r = validateBatch({ project: 'demo', sdk: 'ios/1.0.0', events, app: { platform: 'android', version: '3.0' } }, 'demo', now);
    expect(r).toMatchObject({ ok: true, app: { platform: 'android', version: '3.0' } });
    expect(validateBatch({ project: 'demo', events }, 'demo', now)).not.toHaveProperty('app');
  });

  it('maps the app block like the cloud: device, OS, browser App, app id as host', () => {
    expect(appDimensions(undefined)).toEqual({ platform: 'web', app_version: null });
    expect(appDimensions({ platform: 'ios', id: 'com.acme.shop', version: '2.4.1' })).toEqual({ platform: 'ios', app_version: '2.4.1', device: 'mobile', os: 'iOS', browser: 'App', host: 'com.acme.shop' });
    expect(appDimensions({ platform: 'macos', device: 'desktop' })).toMatchObject({ os: 'macOS', device: 'desktop', host: null, app_version: null });
    expect(appDimensions({ platform: 'windows' }).os).toBe('Windows');
    expect(appDimensions({ platform: 'linux' }).os).toBe('Linux');
    expect(appDimensions({ platform: 'android' }).os).toBe('Android');
  });

  it('stores every row of an app batch with its platform and version, derived goals included', async () => {
    const { res, store } = await post({ project: 'demo', sdk: 'react-native/1.0.0', events, app: { platform: 'ios', id: 'com.acme.shop', version: '2.4.1', device: 'tablet' } });
    expect(res.status).toBe(202);
    // exposure, page, event and the goal derived from the event
    expect(store.events.map((e) => e.type).sort()).toEqual(['event', 'exposure', 'goal', 'page']);
    for (const e of store.events) expect(e).toMatchObject({ platform: 'ios', app_version: '2.4.1', device: 'tablet', os: 'iOS', browser: 'App', host: 'com.acme.shop' });
    expect(await store.variantCounts('hero', 'signup')).toEqual([expect.objectContaining({ variant: 'bold', exposures: 1, conversions: 1 })]);
  });

  it('marks website batches as web and leaves their user-agent fields alone', async () => {
    const { store } = await post({ project: 'demo', sdk: 'js/1.0.0', events });
    for (const e of store.events) {
      expect(e).toMatchObject({ platform: 'web', app_version: null });
      expect(e.browser).toBeUndefined();
      expect(e.os).toBeUndefined();
    }
  });

  it('reads the app columns back from SQL rows, and keeps the old shape without them', () => {
    const row = { id: 'a', type: 'page', experiment: 'app', variant: null, goal: null, visitor_id: 'v', session_id: 's', ts: 1, url: '/', props: null, received_at: 1 };
    expect(storedEventFromRow({ ...row, platform: 'android', app_version: '3.0' })).toMatchObject({ platform: 'android', app_version: '3.0' });
    expect(storedEventFromRow(row)).not.toHaveProperty('platform');
  });
});
