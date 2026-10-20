import { describe, expect, it } from 'vitest';
import { validateBatch } from '../validate';

const NOW = Date.UTC(2026, 9, 20);
const exposure = (extra: Record<string, unknown>) => ({ id: `e_${Math.random().toString(36).slice(2, 12)}`, type: 'exposure', exp: 'hero', var: 'bold', vid: 'v1', sid: 's1', ts: NOW, ...extra });

describe('validateBatch: exposure referrer', () => {
  it('keeps the referrer an exposure carries in props, empty string included (direct)', () => {
    const r = validateBatch({ project: 'demo', events: [exposure({ ref: 'https://www.google.com' }), exposure({ ref: '' }), exposure({})] }, 'demo', NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.events.map((e) => e.props)).toEqual([{ ref: 'https://www.google.com' }, { ref: '' }, null]);
  });

  it('is lenient: a long referrer is cut to 300 characters, anything else is ignored', () => {
    const r = validateBatch({ project: 'demo', events: [exposure({ ref: `https://x.com/${'a'.repeat(400)}` }), exposure({ ref: 42 }), exposure({ ref: null })] }, 'demo', NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.dropped).toBe(0);
    expect(String(r.events[0]!.props?.ref)).toHaveLength(300);
    expect(r.events[1]!.props).toBeNull();
    expect(r.events[2]!.props).toBeNull();
  });
});
