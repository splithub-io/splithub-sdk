// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../client';
import { defineConfig } from '../config';
import { readRemoteCache, writeRemoteCache, type RemoteOverrides } from '../remote';
import type { EventBatch, ExperimentStatus } from '../types';

// In the cloud, a first visit has no cached overrides: the client waits for them
// before deciding, so the dashboard's status counts from the first page.

const cloudConfig = (status: ExperimentStatus) =>
  defineConfig({
    project: 'p',
    storage: { mode: 'cloud', key: 'pk_live_x' },
    goals: { signup: { type: 'event' } },
    experiments: { hero: { kind: 'value', status, variants: { control: { weight: 0, value: 'a' }, b: { weight: 1, value: 'b' } }, goal: 'signup' } },
  });

function memoryTransport() {
  const batches: EventBatch[] = [];
  return { batches, send: (b: EventBatch) => void batches.push(b) };
}

/** A fetch that answers with `body` when the test says so. */
function stubOverrides() {
  let answer!: (body: RemoteOverrides) => void;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        answer = (body) => resolve(new Response(JSON.stringify(body), { status: 200 }));
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, answer: (body: RemoteOverrides) => answer(body) };
}

const overrides = (status: ExperimentStatus): RemoteOverrides => ({ version: 2, experiments: { hero: { status } } });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('first visit in cloud mode', () => {
  it('serves control while waiting, then follows a test started in the dashboard', async () => {
    const { answer } = stubOverrides();
    const t = memoryTransport();
    const client = createClient(cloudConfig('draft'), { visitorId: 'v_1', sessionId: 's_1', transport: t });
    const notified = vi.fn();
    client.subscribe(notified);

    expect(client.pending).toBe(true);
    expect(client.assignment('hero').reason).toBe('pending');
    expect(client.value('hero')).toBe('a');
    client.track('signup');

    answer(overrides('running'));
    await client.ready;

    expect(client.pending).toBe(false);
    expect(notified).toHaveBeenCalledTimes(1);
    expect(client.value('hero')).toBe('b');
    expect(readRemoteCache('pk_live_x')?.overrides.version).toBe(2);
    await client.flush();
    const events = t.batches.flatMap((b) => b.events);
    expect(events.map((e) => e.type)).toEqual(['exposure', 'goal']);
    // The goal keeps the time it happened, after the exposure, so it converts.
    expect(events[0]!.ts).toBeLessThanOrEqual(events[1]!.ts);
  });

  it('never shows variants of a test paused in the dashboard', async () => {
    const { answer } = stubOverrides();
    const t = memoryTransport();
    const client = createClient(cloudConfig('running'), { visitorId: 'v_1', sessionId: 's_1', transport: t });
    expect(client.value('hero')).toBe('a');
    client.track('signup');

    answer(overrides('paused'));
    await client.ready;

    expect(client.value('hero')).toBe('a');
    await client.flush();
    expect(t.batches.flatMap((b) => b.events)).toHaveLength(0);
  });

  it('follows the file when the overrides are late, and keeps them for the next page', async () => {
    const { answer } = stubOverrides();
    const t = memoryTransport();
    const client = createClient(cloudConfig('running'), { visitorId: 'v_1', sessionId: 's_1', transport: t, remote: { waitMs: 10 } });
    expect(client.value('hero')).toBe('a');
    await client.ready;
    expect(client.value('hero')).toBe('b');

    // Arriving now changes nothing on this page.
    answer(overrides('paused'));
    await vi.waitFor(() => expect(readRemoteCache('pk_live_x')).not.toBeNull());
    expect(client.value('hero')).toBe('b');
    await client.flush();
    expect(t.batches.flatMap((b) => b.events).map((e) => e.type)).toEqual(['exposure']);
  });

  it('follows the file when the overrides fail', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const client = createClient(cloudConfig('running'), { visitorId: 'v_1', transport: memoryTransport() });
    await client.ready;
    expect(client.pending).toBe(false);
    expect(client.value('hero')).toBe('b');
  });

  it('decides at once from the cache on later pages', () => {
    const { fetchMock } = stubOverrides();
    writeRemoteCache('pk_live_x', overrides('paused'));
    const client = createClient(cloudConfig('running'), { visitorId: 'v_1', transport: memoryTransport() });
    expect(client.pending).toBe(false);
    expect(client.value('hero')).toBe('a');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not wait when the server already decided (overrides: null) or waitMs is 0', () => {
    stubOverrides();
    expect(createClient(cloudConfig('running'), { visitorId: 'v_1', transport: memoryTransport(), remote: { overrides: null } }).pending).toBe(false);
    localStorage.clear();
    expect(createClient(cloudConfig('running'), { visitorId: 'v_1', transport: memoryTransport(), remote: { waitMs: 0 } }).pending).toBe(false);
  });
});

describe('first visit with holdout and bots', () => {
  it('sends the holdout marker with the exposure once the client decides', async () => {
    const { answer } = stubOverrides();
    const t = memoryTransport();
    const config = defineConfig({
      project: 'p',
      storage: { mode: 'cloud', key: 'pk_live_x' },
      holdout: { percent: 50 },
      experiments: { hero: { kind: 'value', status: 'draft', variants: { control: { weight: 0, value: 'a' }, b: { weight: 1, value: 'b' } } } },
    });
    const client = createClient(config, { visitorId: 'v_1', sessionId: 's_1', transport: t });
    client.exposure('hero');
    answer(overrides('running'));
    await client.ready;
    await client.flush();
    const exps = t.batches.flatMap((b) => b.events).map((e) => (e as { exp?: string }).exp);
    expect(exps).toContain('__holdout');
  });

  it('sends nothing for a bot, even after the overrides arrive', async () => {
    const { answer } = stubOverrides();
    const t = memoryTransport();
    const client = createClient(cloudConfig('draft'), { visitorId: 'v_1', sessionId: 's_1', transport: t, context: { device: 'bot' } });
    client.exposure('hero');
    client.track('signup');
    answer(overrides('running'));
    await client.ready;
    await client.flush();
    expect(client.assignment('hero').reason).toBe('bot');
    expect(t.batches.flatMap((b) => b.events)).toEqual([]);
  });
});
