import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hasExperiment, insertExperiment, maskSource, removeExperiment, setExperimentStatus, writeConfigChecked } from '../config-file';
import { CliError } from '../errors';

const tricky = `import { defineConfig } from '@splithub/core';
import { shared } from './shared';

/* experiments: { 'fake': { status: 'running' } } in a block comment */
export default defineConfig({
  project: 'demo',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: {
    "hero": {
      kind: 'value',
      status: 'running', // status: 'paused' { in a comment
      variants: {
        control: { weight: 1, value: 'A } brace' },
        b: { weight: 1, value: \`template { \${'x'} }\` },
      },
      description: "quote ' and { brace",
      flow: { start: 'n', nodes: { n: { type: 'variant', variant: 'b', status: 'running' } } },
      match: /^\\/a{1,2}$/.source,
      goal: 'signup',
    },
    other: { kind: 'component', status: 'draft', variants: { control: 1, b: 1 } }
  },
});
`;

function codeOnly(s: string): string {
  const m = maskSource(s);
  return m;
}

describe('config scanner', () => {
  it('ignores braces and quotes inside strings, templates, regexes and comments', () => {
    const masked = codeOnly(tricky);
    expect(masked.length).toBe(tricky.length);
    expect((masked.match(/\{/g) ?? []).length).toBe((masked.match(/\}/g) ?? []).length);
    expect(hasExperiment(tricky, 'hero')).toBe(true);
    expect(hasExperiment(tricky, 'other')).toBe(true);
    expect(hasExperiment(tricky, 'fake')).toBe(false);
  });

  it('changes only the top-level status of the experiment', () => {
    const out = setExperimentStatus(tricky, 'hero', 'paused');
    expect(out).toContain("status: 'paused', // status: 'paused' { in a comment");
    expect(out).toContain("variant: 'b', status: 'running'");
    expect(setExperimentStatus(tricky, 'other', 'running')).toContain("other: { kind: 'component', status: 'running',");
  });

  it('adds a status when the entry has none, after any spread so it wins', () => {
    const src = tricky.replace("other: { kind: 'component', status: 'draft', variants: { control: 1, b: 1 } }", "other: { ...shared, variants: { control: 1, b: 1 } }");
    const out = setExperimentStatus(src, 'other', 'paused');
    expect(out).toMatch(/variants: \{ control: 1, b: 1 \},\n\s+status: 'paused',\n\s+\}/);
  });

  it('appends after an entry with no trailing comma, and into an empty object', () => {
    const out = insertExperiment(tricky, { key: 'new-one', kind: 'component', status: 'draft', variants: [{ key: 'control', weight: 1 }, { key: 'b', weight: 1 }] });
    expect(out).toContain("variants: { control: 1, b: 1 } },\n    'new-one': {");
    const empty = "export default defineConfig({ project: 'x', experiments: {} });\n";
    const added = insertExperiment(empty, { key: 'a', kind: 'component', status: 'draft', variants: [{ key: 'control', weight: 1 }, { key: 'b', weight: 1 }] });
    expect(added).toContain("experiments: {\n  a: {\n    kind: 'component'");
    expect(hasExperiment(added, 'a')).toBe(true);
  });

  it('removes an entry and its lines, nothing else', () => {
    const out = removeExperiment(tricky, 'hero');
    expect(hasExperiment(out, 'hero')).toBe(false);
    expect(hasExperiment(out, 'other')).toBe(true);
    expect(out).toContain("  experiments: {\n    other: {");
    const m = maskSource(out);
    expect((m.match(/\{/g) ?? []).length).toBe((m.match(/\}/g) ?? []).length);
  });

  it('refuses to edit experiments that come from a spread or an imported constant', () => {
    const spread = tricky.replace('  experiments: {\n', '  experiments: {\n    ...shared,\n');
    expect(() => setExperimentStatus(spread, 'from-shared', 'paused')).toThrow(expect.objectContaining({ code: 'CONFIG_UNSAFE' }) as unknown as Error);
    const ref = tricky.replace("other: { kind: 'component', status: 'draft', variants: { control: 1, b: 1 } }", 'other: shared');
    expect(() => setExperimentStatus(ref, 'other', 'paused')).toThrow(/defined elsewhere/);
    const whole = "export default defineConfig({ project: 'x', experiments: shared });\n";
    expect(() => insertExperiment(whole, { key: 'a', kind: 'component', status: 'draft', variants: [] })).toThrow(/not written inline/);
    expect(() => setExperimentStatus(tricky, 'nope', 'paused')).toThrow(expect.objectContaining({ code: 'EXPERIMENT_NOT_FOUND' }) as unknown as Error);
  });

  it('refuses a duplicate id', () => {
    expect(() => insertExperiment(tricky, { key: 'hero', kind: 'component', status: 'draft', variants: [] })).toThrow(CliError);
  });
});

describe('writeConfigChecked', () => {
  const dir = resolve(__dirname, '../../.tmp-unit', `w${Date.now()}`);
  afterAll(() => rmSync(resolve(__dirname, '../../.tmp-unit'), { recursive: true, force: true }));

  it('restores the original file when the change does not load back', async () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'splithub.config.ts');
    const good = "import { defineConfig } from '@splithub/core';\nexport default defineConfig({ project: 'x', storage: { mode: 'self', endpoint: '/api/splithub' }, goals: {}, experiments: {} });\n";
    writeFileSync(file, good);
    await expect(writeConfigChecked(file, good, good.replace('experiments: {}', 'experiments: { broken'), () => null)).rejects.toMatchObject({ code: 'CONFIG_WRITE' });
    expect(readFileSync(file, 'utf8')).toBe(good);
    await expect(writeConfigChecked(file, good, good, () => 'the status did not change')).rejects.toThrow(/the status did not change/);
    expect(readFileSync(file, 'utf8')).toBe(good);
    const ok = await writeConfigChecked(file, good, good.replace("project: 'x'", "project: 'y'"), (c) => (c.project === 'y' ? null : 'no'));
    expect(ok.project).toBe('y');
  });
});
