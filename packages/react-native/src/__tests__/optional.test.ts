// @vitest-environment node
// Metro skips a missing module only when its require() has a literal name and sits directly in a
// try block. A helper taking a callback (or a computed name) turns a missing optional module into a
// bundling error in every app that lacks it, so both the source and the CommonJS build are checked.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const OPTIONAL = ['react-native-mmkv', '@react-native-async-storage/async-storage', 'expo-application', 'expo-device', 'expo-constants', 'expo-router', '@react-navigation/native'];

function requiresInTry(code: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  code = code.replace(/^\s*\/\/.*$/gm, '');
  const re = /require\((['"])([^'"]+)\1\)/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    // The statement before the require: `try {` then one assignment, nothing in between.
    const before = code.slice(Math.max(0, m.index - 80), m.index);
    out.set(m[2]!, /try\s*\{\s*[\w$]+\s*=\s*$/.test(before));
  }
  return out;
}

describe('optional modules', () => {
  it('are each loaded by a literal require directly inside a try block', () => {
    const found = requiresInTry(readFileSync(join(__dirname, '../optional.ts'), 'utf8'));
    for (const name of OPTIONAL) expect(found.get(name), name).toBe(true);
    expect([...found.keys()].sort()).toEqual([...OPTIONAL].sort());
  });

  it('stay that way in the CommonJS build Metro reads', () => {
    const dist = join(__dirname, '../../dist/index.cjs');
    if (!existsSync(dist)) return;
    const found = requiresInTry(readFileSync(dist, 'utf8'));
    for (const name of OPTIONAL) expect(found.get(name), name).toBe(true);
  });
});
