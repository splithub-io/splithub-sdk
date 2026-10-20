import { describe, expect, it } from 'vitest';
import { defineConfig, eventKey, goalKeyFor } from '../config';

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
      defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/x' }, experiments: { e: { kind: 'component', status: 'running', goal: 'no good!', variants: { a: 1, b: 1 } } } })
    ).toThrow(/goal "no good!" is not a valid event name/);
  });

  it('keeps an optional name beside the key', () => {
    const c = defineConfig({
      project: 'p',
      storage: { mode: 'cloud' },
      experiments: {
        hero: { kind: 'component', status: 'running', name: '  Hero headline ', variants: { a: 1, b: 1 } },
        plain: { kind: 'component', status: 'running', variants: { a: 1, b: 1 } },
      },
    });
    expect(c.experiments[0]!.name).toBe('Hero headline');
    expect('name' in c.experiments[1]!).toBe(false);
    expect(() => defineConfig({ project: 'p', storage: { mode: 'cloud' }, experiments: { e: { kind: 'component', status: 'running', name: ' ', variants: { a: 1, b: 1 } } } })).toThrow(/name must be/);
  });
});

describe('any event as an experiment goal', () => {
  const base = { project: 'p', storage: { mode: 'self' as const, endpoint: '/x' } };
  it('adds undeclared goals as event goals keyed by their slug', () => {
    const c = defineConfig({
      ...base,
      goals: { signup: { type: 'event' }, play: { type: 'event', event: 'Play Clicked' } },
      experiments: {
        a: { kind: 'component', status: 'running', variants: { x: 1, y: 1 }, goal: 'Video Played', metrics: { secondary: ['checkout_done', 'Play Clicked'], guardrails: ['signup'] } },
        b: { kind: 'component', status: 'running', variants: { x: 1, y: 1 }, goal: 'video-played' },
      },
    });
    expect(c.experiments.map((e) => e.goal)).toEqual(['video-played', 'video-played']);
    expect(c.experiments[0]!.metrics).toEqual({ secondary: ['checkout_done', 'play'], guardrails: [{ goal: 'signup', worse: 'lower' }] });
    expect(c.goals.map((g) => [g.key, g.type, g.event ?? null])).toEqual([
      ['signup', 'event', null],
      ['play', 'event', 'Play Clicked'],
      ['video-played', 'event', 'Video Played'],
      ['checkout_done', 'event', null],
    ]);
  });

  it('slugs event names', () => {
    expect(eventKey('Video Played')).toBe('video-played');
    expect(eventKey('signup')).toBe('signup');
    expect(eventKey('page:/pricing')).toBe('page-pricing');
    expect(eventKey('  Hello World!  ')).toBe('hello-world');
    expect(eventKey('---')).toBe('');
    expect(goalKeyFor([{ key: 'play', event: 'Play' }], 'Play')).toBe('play');
    expect(goalKeyFor([], '!!!')).toBeNull();
  });
});
