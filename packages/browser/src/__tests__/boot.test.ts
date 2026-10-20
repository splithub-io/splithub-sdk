// @vitest-environment jsdom
import { createClient, resetAnalyticsClaims, type RemoteOverrides, type SplitHubConfig, type SplitHubEvent } from '@splithub/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../index';

const property = { key: 'sh-abc123', status: 'running' as const, description: null, goals: [] };

/** Overrides answered when the test says so; event batches collected. */
function stubCloud() {
  const sent: SplitHubEvent[] = [];
  let answer!: (body: RemoteOverrides) => void;
  const overrides = new Promise<RemoteOverrides>((r) => (answer = r));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/overrides/')) return new Response(JSON.stringify(await overrides));
      sent.push(...(JSON.parse(String(init?.body)) as { events: SplitHubEvent[] }).events);
      return new Response('{}', { status: 202 });
    })
  );
  return { sent, answer };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  delete window.splithub;
  delete window.splithubq;
  document.head.innerHTML = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  // sh.js clients of earlier tests stay alive and would keep the property claimed.
  resetAnalyticsClaims();
});

describe('sh.js analytics', () => {
  it('keeps the landing page when the overrides come after the redirect decision', async () => {
    const cloud = stubCloud();
    const done = boot({ key: 'pk_live_x', endpoint: 'https://go.test/v1/events', property: 'sh-abc123', redirects: true, noHold: true, holdMs: 150 });
    await done;
    await window.splithub!.client.flush();
    expect(cloud.sent).toEqual([]);

    cloud.answer({ version: 1, experiments: {}, addedProperties: [property] });
    await vi.waitFor(async () => {
      await window.splithub!.client.flush();
      expect(cloud.sent.map((e) => e.type)).toEqual(['page']);
    });
  });

  it('identifies from the queue and sends no automatic events', async () => {
    const cloud = stubCloud();
    cloud.answer({ version: 1, experiments: {}, addedProperties: [property] });
    const meta = document.createElement('meta');
    meta.name = 'splithub-404';
    document.head.appendChild(meta);
    window.splithubq = [['identify', 'user_9', { plan: 'pro' }]];
    await boot({ key: 'pk_live_x', endpoint: 'https://go.test/v1/events', property: 'sh-abc123' });
    await window.splithub!.client.flush();
    expect(cloud.sent.map((e) => (e.type === 'event' ? `event:${e.name}` : e.type))).toEqual(['page', 'identify']);
    expect(cloud.sent.find((e) => e.type === 'identify')).toMatchObject({ uid: 'user_9', traits: { plan: 'pro' } });
  });

  it('tracks queued events with the one call, track()', async () => {
    const cloud = stubCloud();
    cloud.answer({ version: 1, experiments: {}, addedProperties: [property] });
    window.splithubq = [['track', 'Video Played', { id: 3 }]];
    await boot({ key: 'pk_live_x', endpoint: 'https://go.test/v1/events', property: 'sh-abc123' });
    await window.splithub!.client.flush();
    expect(cloud.sent.find((e) => e.type === 'event')).toMatchObject({ name: 'Video Played', props: { id: 3 } });
    expect('event' in window.splithub!).toBe(false);
  });
});

describe('sh.js next to the SDK', () => {
  const sdkConfig = (): SplitHubConfig => ({ project: 'app', storage: { mode: 'cloud', key: 'pk_live_x', endpoint: 'https://go.test/v1/events' }, visitorKey: 'sh_vid', runDraftsInDev: false, goals: [], experiments: [], properties: [property], __splithub: 2 });

  it('leaves pageviews to the SDK that collects the property first; its track() still sends one event', async () => {
    const cloud = stubCloud();
    cloud.answer({ version: 1, experiments: {}, addedProperties: [property] });
    const sdk = createClient(sdkConfig(), { property: 'sh-abc123', remote: { disabled: true, overrides: { version: 1, experiments: {}, addedProperties: [property] } } });
    sdk.pageview();
    await sdk.flush();
    await boot({ key: 'pk_live_x', endpoint: 'https://go.test/v1/events', property: 'sh-abc123' });
    window.splithub!.track('signup');
    await window.splithub!.client.flush();
    expect(cloud.sent.map((e) => e.type)).toEqual(['page', 'event']);
    expect(window.splithub!.client.visitorId).toBe(sdk.visitorId);
    sdk.destroy();
  });

  it('keeps the SDK from sending a second pageview when sh.js collects first', async () => {
    const cloud = stubCloud();
    cloud.answer({ version: 1, experiments: {}, addedProperties: [property] });
    await boot({ key: 'pk_live_x', endpoint: 'https://go.test/v1/events', property: 'sh-abc123' });
    await window.splithub!.client.flush();
    const sdk = createClient(sdkConfig(), { property: 'sh-abc123', remote: { disabled: true, overrides: { version: 1, experiments: {}, addedProperties: [property] } } });
    sdk.pageview();
    sdk.track('signup');
    await sdk.flush();
    expect(cloud.sent.map((e) => e.type)).toEqual(['page', 'event']);
    sdk.destroy();
  });
});
