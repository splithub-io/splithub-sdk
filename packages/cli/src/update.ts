// Update check and self-update. One GET to the npm registry per run, started at
// startup in parallel with the command; the answer is used only if it arrived
// before the command finished, so a slow network never delays anything. Nothing
// is written to disk.
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { c } from './ui';

export const REGISTRY = 'https://registry.npmjs.org';
const CHECK_TIMEOUT_MS = 1500;

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function currentVersion(): string {
  // From src/ and from dist/ alike, ../package.json is the CLI's own.
  return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
}

// ---------- semver ----------

interface Semver {
  nums: [number, number, number];
  pre: string[];
}

function parse(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Negative when a < b, 0 when equal, positive when a > b (semver precedence). Unparseable sorts lowest. */
export function compareSemver(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? 0 : 1) - (y.pre.length ? 0 : 1);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether `latest` is worth offering: newer, and not a prerelease unless the user already runs one. */
export function isNewer(latest: string, current: string): boolean {
  const l = parse(latest);
  const cur = parse(current);
  if (!l || !cur) return false;
  if (l.pre.length && !cur.pre.length) return false;
  return compareSemver(latest, current) > 0;
}

// ---------- registry ----------

/** The `latest` dist-tag of a package, or null on any error or timeout. */
export async function fetchLatest(name: string, opts: { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: FetchLike } = {}): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? CHECK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${REGISTRY}/${name.replace('/', '%2f')}/latest`, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown } | null;
    return typeof body?.version === 'string' && parse(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

// ---------- gating ----------

const CI_VARS = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TRAVIS', 'JENKINS_URL', 'TEAMCITY_VERSION', 'TF_BUILD', 'BITBUCKET_BUILD_NUMBER', 'CODEBUILD_BUILD_ID', 'BUILD_NUMBER', 'RUN_ID'];

export function isCi(env: NodeJS.ProcessEnv): boolean {
  return CI_VARS.some((k) => {
    const v = env[k];
    return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  });
}

export interface GateInput {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdinTTY: boolean | undefined;
  stdoutTTY: boolean | undefined;
}

/** The automatic check runs only for a person at a terminal: never for agents, CI, the MCP server or pipes. */
export function shouldCheckForUpdates({ argv, env, stdinTTY, stdoutTTY }: GateInput): boolean {
  if (!stdinTTY || !stdoutTTY) return false;
  if (argv.includes('--json')) return false;
  if (env.SPLITHUB_NO_UPDATE_CHECK === '1' || env.SPLITHUB_MCP === '1') return false;
  if (isCi(env)) return false;
  // `update` checks on its own; `dev` never finishes, so there is no "after" to ask in.
  const command = argv.find((a) => !a.startsWith('-'));
  return command !== 'update' && command !== 'dev';
}

// ---------- install mode ----------

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

export type InstallMode =
  | { mode: 'project'; root: string; pm: PackageManager; packages: { name: string; dev: boolean }[] }
  | { mode: 'global' }
  | { mode: 'npx' }
  | { mode: 'unknown' };

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const isOurs = (name: string) => name === 'splithub' || name.startsWith('@splithub/');

function readPkg(file: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/** Nearest directory at or above `cwd` with a package.json. */
export function findProjectRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Package manager from the nearest lockfile at or above `root` (workspaces keep it at the top). */
export function detectPackageManager(root: string): PackageManager {
  let dir = resolve(root);
  for (;;) {
    const has = (f: string) => existsSync(join(dir, f));
    if (has('pnpm-lock.yaml')) return 'pnpm';
    if (has('yarn.lock')) return 'yarn';
    if (has('bun.lockb') || has('bun.lock')) return 'bun';
    if (has('package-lock.json')) return 'npm';
    const up = dirname(dir);
    if (up === dir) return 'npm';
    dir = up;
  }
}

/** splithub and every @splithub/* package the project lists, with its section. */
export function projectPackages(root: string): { name: string; dev: boolean }[] {
  const pkg = readPkg(join(root, 'package.json'));
  if (!pkg) return [];
  const prod = Object.keys(pkg.dependencies ?? {}).filter(isOurs).map((name) => ({ name, dev: false }));
  const dev = Object.keys(pkg.devDependencies ?? {})
    .filter((n) => isOurs(n) && !prod.some((p) => p.name === n))
    .map((name) => ({ name, dev: true }));
  return [...prod, ...dev];
}

function npmGlobalPrefix(): string | null {
  if (process.env.npm_config_prefix) return process.env.npm_config_prefix;
  try {
    return execSync('npm prefix -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || null;
  } catch {
    return null;
  }
}

const norm = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase();

export interface DetectInput {
  /** Path of the running CLI (process.argv[1]). */
  scriptPath: string;
  cwd: string;
  /** npm's global prefix; looked up lazily when omitted. */
  globalPrefix?: () => string | null;
}

export function detectInstall({ scriptPath, cwd, globalPrefix = npmGlobalPrefix }: DetectInput): InstallMode {
  let real = scriptPath;
  try {
    real = realpathSync(scriptPath);
  } catch {
    // keep the path as given
  }
  const script = norm(real);
  if (/\/_npx\//.test(script) || /\/dlx-[^/]*\//.test(script)) return { mode: 'npx' };

  const root = findProjectRoot(cwd);
  const packages = root ? projectPackages(root) : [];
  // Running from node_modules of this project (or a workspace root above it).
  const local = root !== null && (() => {
    let dir = root;
    for (;;) {
      if (script.startsWith(norm(join(dir, 'node_modules')) + '/')) return true;
      const up = dirname(dir);
      if (up === dir) return false;
      dir = up;
    }
  })();
  if (root && local && packages.length) return { mode: 'project', root, pm: detectPackageManager(root), packages };

  const prefix = globalPrefix();
  if (prefix) {
    const p = norm(prefix);
    if (script.startsWith(`${p}/lib/node_modules/`) || script.startsWith(`${p}/node_modules/`)) return { mode: 'global' };
  }
  if (root && packages.length) return { mode: 'project', root, pm: detectPackageManager(root), packages };
  return { mode: 'unknown' };
}

// ---------- commands ----------

export interface Command {
  cmd: string;
  args: string[];
  cwd?: string;
}

export const commandText = (x: Command): string => [x.cmd, ...x.args].join(' ');

/** Commands that move this install to the latest release (empty for npx: nothing to install). */
export function buildUpdateCommands(install: InstallMode): Command[] {
  if (install.mode === 'npx') return [];
  if (install.mode !== 'project') return [{ cmd: 'npm', args: ['install', '-g', 'splithub@latest'] }];
  const list = install.packages.some((p) => p.name === 'splithub') ? install.packages : [...install.packages, { name: 'splithub', dev: true }];
  const add = { pnpm: ['add'], yarn: ['add'], bun: ['add'], npm: ['install'] }[install.pm];
  const devFlag = { pnpm: '-D', yarn: '--dev', bun: '--dev', npm: '-D' }[install.pm];
  const out: Command[] = [];
  for (const dev of [false, true]) {
    const names = list.filter((p) => p.dev === dev).map((p) => `${p.name}@latest`);
    if (names.length) out.push({ cmd: install.pm, args: [...add, ...(dev ? [devFlag] : []), ...names], cwd: install.root });
  }
  return out;
}

function run(x: Command): Promise<boolean> {
  return new Promise((done) => {
    // npm, pnpm and yarn are .cmd shims on Windows; the arguments are package names only.
    const child = spawn(x.cmd, x.args, { cwd: x.cwd, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
  });
}

// ---------- flows ----------

/** The update check started at launch: read its answer without waiting, then stop it. */
export interface StartedCheck {
  settled(): string | null | undefined;
  stop(): void;
}

export function startUpdateCheck(input: GateInput, fetchImpl?: FetchLike): StartedCheck | null {
  if (!shouldCheckForUpdates(input)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  timer.unref?.();
  let latest: string | null | undefined;
  void fetchLatest('splithub', { signal: ctrl.signal, ...(fetchImpl ? { fetchImpl } : {}) }).then((v) => {
    latest = v;
  });
  return {
    settled: () => latest,
    stop: () => {
      clearTimeout(timer);
      ctrl.abort();
    },
  };
}

/** After the command: if the registry answered in time with a newer version, offer it. */
export async function offerUpdateAfterCommand(check: StartedCheck | null): Promise<void> {
  if (!check) return;
  const latest = check.settled();
  check.stop();
  const current = currentVersion();
  if (!latest || !isNewer(latest, current)) return;
  try {
    console.log();
    await updateFlow({ current, latest, yes: false, install: detectInstall({ scriptPath: process.argv[1] ?? '', cwd: process.cwd() }) });
  } catch {
    // An update offer must never turn a finished command into a failure.
  }
}

export async function updateFlow({ current, latest, yes, install }: { current: string; latest: string; yes: boolean; install: InstallMode }): Promise<void> {
  const news = `splithub ${latest} is out (you have ${current}).`;
  if (install.mode === 'npx') {
    console.log(`${c.cyan(news)} Run npx splithub@latest next time to get it.`);
    return;
  }
  const commands = buildUpdateCommands(install);
  const text = commands.map(commandText).join(' && ');
  if (!yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(`${news} Update with: ${text}`);
      return;
    }
    const p = await import('@clack/prompts');
    const go = await p.confirm({ message: `${news} Update now?`, initialValue: true });
    if (p.isCancel(go) || !go) return;
  }
  for (const x of commands) {
    console.log(c.dim(`$ ${commandText(x)}`));
    if (!(await run(x))) {
      console.log(c.red("The update didn't finish."), `Run it by hand: ${text}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(c.green(`Updated to splithub ${latest}.`));
}

// ---------- doctor ----------

/** Installed version of a package, from the nearest node_modules at or above `root`. */
export function installedVersion(root: string, name: string): string | null {
  let dir = resolve(root);
  for (;;) {
    const pkg = readPkg(join(dir, 'node_modules', ...name.split('/'), 'package.json')) as { version?: string } | null;
    if (pkg?.version) return pkg.version;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export interface VersionRow {
  name: string;
  installed: string | null;
  latest: string | null;
}

export interface VersionReport {
  rows: VersionRow[];
  offline: boolean;
  /** Installed SDK packages and the CLI disagree. */
  mismatch: boolean;
  outdated: string[];
  command: string | null;
}

/** Versions of splithub and @splithub/* in the project vs npm, for `splithub doctor`. */
export async function versionReport(root: string, opts: { fetchImpl?: FetchLike; cliVersion?: string; timeoutMs?: number } = {}): Promise<VersionReport> {
  const listed = projectPackages(root);
  const names = listed.map((p) => p.name);
  if (!names.includes('splithub')) names.push('splithub');
  const latest = await Promise.all(names.map((n) => fetchLatest(n, { timeoutMs: opts.timeoutMs ?? 2500, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })));
  const cli = opts.cliVersion ?? currentVersion();
  const rows = names.map((name, i) => ({ name, installed: installedVersion(root, name) ?? (name === 'splithub' ? cli : null), latest: latest[i] ?? null }));
  const offline = latest.every((v) => v === null);
  const installed = new Set(rows.map((r) => r.installed).filter((v): v is string => v !== null));
  const outdated = rows.filter((r) => r.installed && r.latest && isNewer(r.latest, r.installed)).map((r) => r.name);
  const install: InstallMode = listed.length ? { mode: 'project', root, pm: detectPackageManager(root), packages: listed } : { mode: 'global' };
  const mismatch = installed.size > 1;
  const command = mismatch || outdated.length ? buildUpdateCommands(install).map(commandText).join(' && ') : null;
  return { rows, offline, mismatch, outdated, command };
}
