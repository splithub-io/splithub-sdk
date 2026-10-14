import { describe, expect, it } from 'vitest';
import { defineConfig } from '@splithub/core';
import { renderExperiment } from '../config-file';

describe('multivariate in splithub.config.ts', () => {
  it('writes factors, not the derived variants, and the file loads back into the same combinations', () => {
    const block = renderExperiment({
      key: 'hero',
      kind: 'mvt',
      status: 'draft',
      goal: 'signup',
      variants: [],
      factors: { headline: { old: 'Old headline', new: "New one, isn't it" }, button: { blue: '#2563eb', green: '#16a34a' } },
    });
    expect(block).toContain("kind: 'mvt'");
    expect(block).toContain("headline: { old: 'Old headline', new: 'New one, isn\\'t it' }");
    expect(block).not.toContain('variants');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factors = new Function(`return ({ ${block} }).hero.factors`)() as Record<string, Record<string, string>>;
    const config = defineConfig({ project: 'x', storage: { mode: 'cloud', key: 'pk_x' }, goals: { signup: { type: 'event' } }, experiments: { hero: { kind: 'mvt', status: 'draft', goal: 'signup', factors } } });
    expect(config.experiments[0]!.variants.map((v) => v.key)).toEqual(['old-blue', 'old-green', 'new-blue', 'new-green']);
  });
});
