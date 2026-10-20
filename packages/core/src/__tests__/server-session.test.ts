import { describe, expect, it } from 'vitest';
import { createClient } from '../client';
import { defineConfig } from '../config';
import type { EventBatch } from '../types';

const config = defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/api/splithub' }, experiments: {}, properties: { site: {} } });

describe('server-side sessions', () => {
  it('gives each visitor a session of their own when none is passed', async () => {
    const sent: EventBatch[] = [];
    const transport = { send: (b: EventBatch) => void sent.push(b) };
    const a = createClient(config, { visitorId: 'v_a', property: 'site', transport });
    const b = createClient(config, { visitorId: 'v_b', property: 'site', transport });
    expect(a.sessionId).toMatch(/^srv_/);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(createClient(config, { visitorId: 'v_a', transport }).sessionId).toBe(a.sessionId);
    expect(createClient(config, { visitorId: 'v_a', sessionId: 'mine', transport }).sessionId).toBe('mine');
    a.track('Signed In');
    await a.flush();
    expect(sent.flatMap((x) => x.events).map((e) => e.sid)).toEqual([a.sessionId]);
  });
});
