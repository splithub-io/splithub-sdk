import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { shipSource } from '../codemod';
import { unifiedDiff } from '../diff';

const run = (file: string, src: string, keep: string, value?: unknown) => shipSource(ts, file, src, { id: 'hero', keep, value, hasValue: value !== undefined });

describe('ship codemod', () => {
  it('unwraps the kept <Variant> of <Experiment> and drops the others and the imports', () => {
    const src = `import { Experiment, Variant, useTrack } from '@splithub/react';

export function Page() {
  const track = useTrack();
  return (
    <main>
      <Experiment id="hero">
        <Variant name="control">
          <h1>Old</h1>
        </Variant>
        <Variant name="bold">
          <h1 className="bold">New</h1>
          <p>Sub</p>
        </Variant>
      </Experiment>
      <button onClick={() => track('signup')}>Go</button>
    </main>
  );
}
`;
    const r = run('Page.tsx', src, 'bold');
    expect(r.changed).toBe(true);
    expect(r.output).toContain(`    <main>
      <h1 className="bold">New</h1>
      <p>Sub</p>
      <button`);
    expect(r.output).not.toContain('Experiment');
    expect(r.output).toContain("import { useTrack } from '@splithub/react';");
    expect(r.leftovers).toEqual([]);
  });

  it('uses the content directly when <Experiment> is the returned expression', () => {
    const src = `import { Experiment, Variant } from '@splithub/react';
export const Hero = () => (
  <Experiment id="hero">
    <Variant name="control"><Old /></Variant>
    <Variant name="b">{label}</Variant>
  </Experiment>
);
`;
    expect(run('Hero.tsx', src, 'control').output).toBe("export const Hero = () => (\n  <Old />\n);\n");
    expect(run('Hero.tsx', src, 'b').output).toContain('export const Hero = () => (\n  (label)\n);');
  });

  it('replaces useValue with the kept literal', () => {
    const src = `import { useValue } from '@splithub/react';
export function T() {
  const text = useValue<string>('hero');
  const { headline } = useValue<{ headline: string }>("hero");
  return <h1 title={text}>{headline}</h1>;
}
`;
    const r = run('T.tsx', src, 'b', "it's new");
    expect(r.output).toContain("const text = 'it\\'s new';");
    expect(r.output).not.toContain('useValue');
    expect(r.output).not.toContain('@splithub/react');
    const mvt = run('T.tsx', src, 'new-blue', { headline: 'New', button: '#00f' });
    expect(mvt.output).toContain('const { headline } = {"headline":"New","button":"#00f"};');
  });

  it('folds useVariant comparisons, ternaries, && in JSX, if and switch', () => {
    const src = `import { useVariant } from '@splithub/react';
export function C() {
  const v = useVariant('hero');
  if (v === 'b') {
    log('b');
  } else {
    log('control');
  }
  switch (v) {
    case 'control':
      a();
      break;
    case 'b':
      b();
      break;
  }
  return (
    <div>
      {v === 'control' && <Old />}
      {v !== 'control' ? <New /> : <Old />}
    </div>
  );
}
`;
    const r = run('C.tsx', src, 'b');
    expect(r.output).toBe(`export function C() {
  log('b');
  b();
  return (
    <div>
      <New />
    </div>
  );
}
`);
    expect(r.leftovers).toEqual([]);
  });

  it('reports what it cannot rewrite, and leaves other experiments alone', () => {
    const src = `import { useVariant } from '@splithub/react';
const ID = 'hero';
export function X() {
  const other = useVariant('other');
  const v = useVariant('hero');
  return <Comp variant={v} which={other} />;
}
`;
    const r = run('X.tsx', src, 'b');
    expect(r.output).toContain("const v = 'b';");
    expect(r.output).toContain("useVariant('other')");
    expect(r.output).toContain("import { useVariant } from '@splithub/react';");
    expect(r.leftovers).toEqual([{ line: 2, text: "const ID = 'hero';", reason: expect.stringContaining('by hand') as unknown as string }]);
  });

  it('diffs only the changed lines', () => {
    const d = unifiedDiff('a.ts', 'a\nb\nc\n', 'a\nB\nc\n');
    expect(d).toBe('--- a/a.ts\n+++ b/a.ts\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n \n');
  });
});
