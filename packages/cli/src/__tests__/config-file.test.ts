import { describe, expect, it } from 'vitest';
import { hasExperiment, insertExperiment, renderExperiment, setExperimentStatus } from '../config-file';

const base = `import { defineConfig } from '@splithub/core';

export default defineConfig({
  project: 'demo',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: {
    'hero-cta': {
      kind: 'component',
      status: 'running',
      variants: { control: 50, bold: 50 },
      goal: 'signup',
      description: "it's {bold}",
    },
    // a comment with a brace { inside
  },
});
`;

describe('config-file editing', () => {
  it('finds experiments and flips status without touching the rest', () => {
    expect(hasExperiment(base, 'hero-cta')).toBe(true);
    expect(hasExperiment(base, 'hero')).toBe(false);
    const out = setExperimentStatus(base, 'hero-cta', 'paused');
    expect(out).toContain("status: 'paused'");
    expect(out).toContain(`description: "it's {bold}"`);
    expect(out.replace("status: 'paused'", "status: 'running'")).toBe(base);
    expect(() => setExperimentStatus(base, 'nope', 'paused')).toThrow(/no experiment "nope"/);
  });

  it('appends a value experiment at the end with the surrounding indentation', () => {
    const out = insertExperiment(base, {
      key: 'hero-title',
      kind: 'value',
      status: 'draft',
      goal: 'signup',
      variants: [
        { key: 'control', weight: 1, value: 'Ship faster' },
        { key: 'direct', weight: 1, value: "Know what's winning" },
      ],
    });
    expect(out.indexOf("'hero-title'")).toBeGreaterThan(out.indexOf("'hero-cta'"));
    expect(out).toContain(
      [
        "    'hero-title': {",
        "      kind: 'value',",
        "      status: 'draft',",
        '      variants: {',
        "        control: { weight: 1, value: 'Ship faster' },",
        "        direct: { weight: 1, value: 'Know what\\'s winning' },",
        '      },',
        "      goal: 'signup',",
        '    },',
        '  },',
        '});',
      ].join('\n')
    );
    expect(hasExperiment(out, 'hero-title')).toBe(true);
    expect(hasExperiment(out, 'hero-cta')).toBe(true);
  });

  it('adds a missing trailing comma to the previous entry', () => {
    const noComma = base.replace("description: \"it's {bold}\",\n    },", "description: \"it's {bold}\",\n    }");
    const out = insertExperiment(noComma, { key: 'x', kind: 'component', status: 'draft', variants: [{ key: 'control', weight: 1 }, { key: 'b', weight: 1 }] });
    expect(out).toContain('    },\n    // a comment with a brace { inside\n    x: {');
  });

  it('renders redirect and component entries', () => {
    const redirect = renderExperiment({ key: 'landing', kind: 'redirect', status: 'draft', match: '/', variants: [{ key: 'control', weight: 1, to: '/' }, { key: 'v2', weight: 1, to: '/v2' }] });
    expect(redirect).toContain("match: '/'");
    expect(redirect).toContain("v2: { weight: 1, to: '/v2' }");
    const component = renderExperiment({ key: 'x', kind: 'component', status: 'running', variants: [{ key: 'control', weight: 90 }, { key: 'b', weight: 10 }] });
    expect(component).toContain('variants: { control: 90, b: 10 }');
  });

  it('keeps braces balanced', () => {
    const out = insertExperiment(base, { key: 'x', kind: 'component', status: 'draft', variants: [{ key: 'control', weight: 1 }, { key: 'b', weight: 1 }] });
    const code = out.replace(/\/\/[^\n]*/g, '');
    expect((code.match(/\{/g) ?? []).length).toBe((code.match(/\}/g) ?? []).length);
  });
});

describe('targeting flow in the config file', () => {
  it('renders the dashboard graph as JSON and the result still loads', () => {
    const flow = { start: 'c', nodes: { c: { type: 'condition', conditions: [{ field: 'country', op: 'in', value: 'de, at' }], then: 'b', else: 'control' }, b: { type: 'variant', variant: 'b' }, control: { type: 'variant', variant: 'control' } } };
    const out = renderExperiment({ key: 'geo', kind: 'component', status: 'running', variants: [{ key: 'control', weight: 50 }, { key: 'b', weight: 50 }], flow });
    expect(out).toContain('flow: {');
    expect(out).toContain('"field": "country"');
    expect(JSON.parse(out.slice(out.indexOf('flow: ') + 6, out.lastIndexOf(',')))).toEqual(flow);
  });
});
