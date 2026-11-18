// Copies the self-running build into the worker so SplitHub Cloud serves it at /sh.js.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../dist/sh.js');
const dest = resolve(here, '../../../splithub-go/src/assets/sh.js.txt');
// The public SDK repository has no worker next to it; there the build stops at dist/sh.js.
if (existsSync(resolve(here, '../../../splithub-go'))) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`sh.js → ${dest} (${statSync(dest).size} bytes)`);
}
