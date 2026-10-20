// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '../client';
import { defineConfig } from '../config';
import { referrerOrigin } from '../paths';
import type { EventBatch, ExposureEvent } from '../types';

const config = defineConfig({
  project: 'p',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: { hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 }, goal: 'signup' } },
});

const setReferrer = (value: string) => Object.defineProperty(document, 'referrer', { value, configurable: true });

async function exposureOf(): Promise<ExposureEvent> {
  const batches: EventBatch[] = [];
  const client = createClient(config, { visitorId: 'v_1', transport: { send: (b: EventBatch) => void batches.push(b) } });
  client.variant('hero');
  await client.flush();
  return batches.flatMap((b) => b.events).find((e) => e.type === 'exposure') as ExposureEvent;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => setReferrer(''));

describe('referrerOrigin', () => {
  it('keeps the origin only, says direct for no referrer and nothing for the site itself', () => {
    expect(referrerOrigin('https://www.google.com/search?q=secret', 'shop.example.com')).toBe('https://www.google.com');
    expect(referrerOrigin('', 'shop.example.com')).toBe('');
    expect(referrerOrigin(null, 'shop.example.com')).toBe('');
    expect(referrerOrigin('https://shop.example.com/pricing', 'shop.example.com')).toBeUndefined();
    expect(referrerOrigin('https://www.shop.example.com/', 'shop.example.com:443')).toBeUndefined();
    expect(referrerOrigin('not a url', 'shop.example.com')).toBeUndefined();
    expect(referrerOrigin('android-app://com.google.android.gm/', 'shop.example.com')).toBe('android-app://com.google.android.gm');
  });
});

describe('exposures carry where the visit came from', () => {
  it('sends the landing referrer origin, no path or query', async () => {
    setReferrer('https://www.google.com/search?q=private');
    expect((await exposureOf()).ref).toBe('https://www.google.com');
  });

  it('sends an empty ref for a direct visit', async () => {
    expect((await exposureOf()).ref).toBe('');
  });

  it('remembers the session entry: a later page of the same visit still reports it', async () => {
    setReferrer('https://news.example.org/post/1');
    await exposureOf();
    setReferrer(`${location.origin}/previous-page`);
    sessionStorage.removeItem('sh_exposed');
    expect((await exposureOf()).ref).toBe('https://news.example.org');
  });

  it('leaves ref out when the first page seen was reached from the site itself', async () => {
    setReferrer(`${location.origin}/home`);
    expect('ref' in (await exposureOf())).toBe(false);
  });
});
