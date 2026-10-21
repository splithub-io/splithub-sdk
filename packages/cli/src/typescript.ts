import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as TS from 'typescript';

/** TypeScript from the user's project first (same version as their code), else ours; null when neither is installed. */
export async function findTypeScript(root: string): Promise<typeof TS | null> {
  try {
    return createRequire(join(root, 'package.json'))('typescript') as typeof TS;
  } catch {
    try {
      const mod = (await import('typescript')) as typeof TS & { default?: typeof TS };
      return mod.default ?? mod;
    } catch {
      return null;
    }
  }
}
