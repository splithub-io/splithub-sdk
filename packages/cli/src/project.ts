import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fail } from './errors';

export type Framework = 'next' | 'vite' | 'unknown';
export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

export interface ProjectInfo {
  root: string;
  name: string;
  framework: Framework;
  packageManager: PackageManager;
  /** Next.js app directory (`app` or `src/app`), when present. */
  appDir: string | null;
  /** Whether sources live under `src/`. */
  hasSrc: boolean;
  configFile: string | null;
  typescript: boolean;
}

const CONFIG_NAMES = ['splithub.config.ts', 'splithub.config.mts', 'splithub.config.js', 'splithub.config.mjs'];

export function findConfigFile(root: string): string | null {
  for (const name of CONFIG_NAMES) {
    const p = join(root, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function detectProject(cwd = process.cwd()): ProjectInfo {
  const root = resolve(cwd);
  let name = 'my-app';
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    name = pkg.name ?? name;
    deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    // no package.json: still usable
  }
  const has = (file: string) => existsSync(join(root, file));
  const framework: Framework = deps.next || has('next.config.js') || has('next.config.mjs') || has('next.config.ts')
    ? 'next'
    : deps.vite || has('vite.config.ts') || has('vite.config.js') || has('vite.config.mjs')
      ? 'vite'
      : 'unknown';
  const packageManager: PackageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
  const appDir = has('src/app') ? 'src/app' : has('app') ? 'app' : null;
  return {
    root,
    name: name.replace(/^@[^/]+\//, ''),
    framework,
    packageManager,
    appDir,
    hasSrc: has('src'),
    configFile: findConfigFile(root),
    typescript: has('tsconfig.json'),
  };
}

/** The project and its config file; NO_CONFIG when there is none. */
export function requireConfig(cwd = process.cwd()): ProjectInfo & { configFile: string } {
  const project = detectProject(cwd);
  if (!project.configFile) fail('NO_CONFIG', "There's no splithub.config.ts here.", 'Run npx splithub init first, or run the command in your app folder.');
  return project as ProjectInfo & { configFile: string };
}

export function installCommand(pm: PackageManager, packages: string[], dev = false): string {
  const flag = dev ? (pm === 'npm' ? ' -D' : ' -D') : '';
  switch (pm) {
    case 'pnpm':
      return `pnpm add${flag} ${packages.join(' ')}`;
    case 'yarn':
      return `yarn add${flag} ${packages.join(' ')}`;
    case 'bun':
      return `bun add${dev ? ' -d' : ''} ${packages.join(' ')}`;
    default:
      return `npm install${flag} ${packages.join(' ')}`;
  }
}

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'coverage', 'out', '.turbo']);
const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;

/** Source files of the project (shallow enough for a doctor run). */
export function listSourceFiles(root: string, maxFiles = 5000): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= maxFiles || depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (CODE_EXT.test(entry)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

export interface LineHit {
  /** Path relative to the project root, forward slashes. */
  file: string;
  line: number;
  column: number;
  text: string;
  /** Which needle matched. */
  needle: string;
}

/** Quoted forms of a key as it appears in code: 'k', "k", `k`. */
export function quoted(key: string): string[] {
  return [`'${key}'`, `"${key}"`, `\`${key}\``];
}

/** Every line of `files` that contains one of `needles`, with its position. */
export function grepLines(root: string, files: string[], needles: string[]): LineHit[] {
  const hits: LineHit[] = [];
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (!needles.some((n) => src.includes(n))) continue;
    const lines = src.split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const needle of needles) {
        const col = text.indexOf(needle);
        if (col >= 0) {
          hits.push({ file: relative(root, f).replace(/\\/g, '/'), line: i + 1, column: col + 1, text: text.trim().slice(0, 200), needle });
          break;
        }
      }
    });
  }
  return hits;
}

export function grepFiles(files: string[], needle: string): string[] {
  const hits: string[] = [];
  for (const f of files) {
    try {
      if (readFileSync(f, 'utf8').includes(needle)) hits.push(f);
    } catch {
      // unreadable file
    }
  }
  return hits;
}
