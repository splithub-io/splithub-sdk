import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from '../index';
// @ts-ignore plain ES module without types
import { buildVectors } from '../../scripts/vectors.mjs';

describe('test/vectors.json (what the native SDKs check against)', () => {
  it('matches the code; regenerate with `npx tsup && node scripts/vectors.mjs`', () => {
    const file = JSON.parse(readFileSync(new URL('../../test/vectors.json', import.meta.url), 'utf8')) as unknown;
    const fresh = JSON.parse(JSON.stringify(buildVectors(core))) as unknown;
    expect(file).toEqual(fresh);
  });
});
