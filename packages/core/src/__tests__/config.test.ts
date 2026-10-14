import { describe, expect, it } from 'vitest';
import { defineConfig } from '../config';

describe('defineConfig', () => {
  it('normalizes weights and defaults', () => {
    const c = defineConfig({
      project: 'p',
      storage: { mode: 'cloud', key: 'pk_x' },
      experiments: {
        hero: { kind: 'component', status: 'running', variants: { control: 1, b: 3 } },
        title: {
          kind: 'value',
          status: 'draft',
          variants: { control: { weight: 1, value: 'A' }, b: { weight: 1, value: 'B' } },
        },
      },
    });
    const hero = c.experiments[0]!;
    expect(hero.variants.map((v) => v.weight)).toEqual([0.25, 0.75]);
    expect(hero.traffic).toBe(1);
    expect(hero.seed).toBe('hero');
    expect(c.experiments[1]!.variants[1]!.value).toBe('B');
    expect(c.visitorKey).toBe('sh_vid');
    expect(c.runDraftsInDev).toBe(false);
  });

  it('rejects bad input', () => {
    expect(() =>
      defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/x' }, experiments: { 'Bad Key': { kind: 'component', status: 'running', variants: { a: 1, b: 1 } } } })
    ).toThrow(/invalid/);
    expect(() =>
      defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/x' }, experiments: { one: { kind: 'component', status: 'running', variants: { a: 1 } } } })
    ).toThrow(/at least 2/);
    expect(() =>
      defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/x' }, experiments: { e: { kind: 'component', status: 'running', goal: 'missing', variants: { a: 1, b: 1 } } } })
    ).toThrow(/goal "missing"/);
  });
});
