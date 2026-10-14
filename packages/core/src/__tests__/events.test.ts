import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventQueue } from '../events';
import type { EventBatch, SplitHubEvent } from '../types';

const ev = (i: number): SplitHubEvent => ({ id: `g_${i}`, type: 'goal', goal: 'signup', vid: 'v', sid: 's', ts: i });

describe('EventQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries with backoff, then drops after maxAttempts', async () => {
    let calls = 0;
    const q = new EventQueue({ project: 'p', sdk: 't', maxAttempts: 3, transport: { send: () => { calls++; throw new Error('offline'); } } });
    q.push(ev(1));
    await q.flush();
    expect(calls).toBe(1);
    expect(q.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); // first backoff ≤ 1 s
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(2000); // second ≤ 2 s
    expect(calls).toBe(3);
    expect(q.size).toBe(0);
    q.destroy();
  });

  it('does not retry a refusal, retries 429', async () => {
    const status = { value: 403 };
    const q = new EventQueue({ project: 'p', sdk: 't', transport: { send: () => { throw Object.assign(new Error('no'), { status: status.value }); } } });
    q.push(ev(1));
    await q.flush();
    expect(q.size).toBe(0);
    status.value = 429;
    q.push(ev(2));
    await q.flush();
    expect(q.size).toBe(1);
    q.destroy();
  });

  it('keeps at most maxQueue events, the newest', async () => {
    const sent: EventBatch[] = [];
    const q = new EventQueue({ project: 'p', sdk: 't', maxQueue: 5, maxBatch: 100, transport: { send: (b) => void sent.push(b) } });
    for (let i = 0; i < 8; i++) q.push(ev(i));
    expect(q.size).toBe(5);
    await q.flush();
    expect(sent[0]!.events.map((e) => e.ts)).toEqual([3, 4, 5, 6, 7]);
    q.destroy();
  });
});
