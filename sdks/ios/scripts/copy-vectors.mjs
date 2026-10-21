// Copies the shared assignment vectors from @splithub/core into the Swift test bundle.
// Run from anywhere: `node sdks/ios/scripts/copy-vectors.mjs`. Regenerate them first with
// `pnpm --filter @splithub/core build && node packages/core/scripts/vectors.mjs`.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, '../../../packages/core/test/vectors.json');
const to = resolve(here, '../Tests/SplitHubTests/Resources/vectors.json');

if (!existsSync(from)) {
  console.error(`No vectors at ${from}. Generate them with: node packages/core/scripts/vectors.mjs`);
  process.exit(1);
}
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`copied ${from} -> ${to}`);
