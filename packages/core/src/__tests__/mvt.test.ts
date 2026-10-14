import { describe, expect, it } from 'vitest';
import { ConfigError, defineConfig, mvtVariants } from '../index';

describe('multivariate experiments', () => {
  it('turns factors into every combination, first levels first, equal weights', () => {
    const { variants, factors } = mvtVariants('hero', { headline: { old: 'Old', new: 'New' }, button: { blue: '#00f', green: '#0f0', red: '#f00' } });
    expect(factors).toEqual([{ key: 'headline', levels: ['old', 'new'] }, { key: 'button', levels: ['blue', 'green', 'red'] }]);
    expect(variants.map((v) => v.key)).toEqual(['old-blue', 'old-green', 'old-red', 'new-blue', 'new-green', 'new-red']);
    expect(variants[0]).toEqual({ key: 'old-blue', weight: 1 / 6, value: { headline: 'Old', button: '#00f' }, levels: { headline: 'old', button: 'blue' } });
    expect(variants.reduce((s, v) => s + v.weight, 0)).toBeCloseTo(1);
  });

  it('is a normal experiment to the SDK: useValue gets the combination', () => {
    const config = defineConfig({
      project: 'demo',
      storage: { mode: 'cloud', key: 'pk_x' },
      goals: { signup: { type: 'event' } },
      experiments: { hero: { kind: 'mvt', status: 'running', goal: 'signup', factors: { headline: { old: 'Old', new: 'New' }, button: { blue: 'b', green: 'g' } } } },
    });
    const exp = config.experiments[0]!;
    expect(exp.kind).toBe('mvt');
    expect(exp.factors).toEqual([{ key: 'headline', levels: ['old', 'new'] }, { key: 'button', levels: ['blue', 'green'] }]);
    expect(exp.variants).toHaveLength(4);
    expect(exp.variants[3]!.value).toEqual({ headline: 'New', button: 'g' });
  });

  it('refuses what cannot be read: one level, too many combinations, bad keys', () => {
    expect(() => mvtVariants('x', { a: { only: 1 } })).toThrow(ConfigError);
    expect(() => mvtVariants('x', {})).toThrow(ConfigError);
    expect(() => mvtVariants('x', { a: { 'Bad Key': 1, b: 2 } })).toThrow(ConfigError);
    const five = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    expect(() => mvtVariants('x', { f1: five, f2: { a: 1, b: 2 } })).toThrow(/at most 4 levels/);
    const four = { a: 1, b: 2, c: 3, d: 4 };
    expect(() => mvtVariants('x', { f1: four, f2: four, f3: { a: 1, b: 2 } })).toThrow(/combinations/);
  });
});
