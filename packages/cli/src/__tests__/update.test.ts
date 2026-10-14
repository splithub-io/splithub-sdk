import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildUpdateCommands,
  commandText,
  compareSemver,
  detectInstall,
  detectPackageManager,
  fetchLatest,
  isNewer,
  shouldCheckForUpdates,
  startUpdateCheck,
  versionReport,
  type GateInput,
} from '../update';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sh-update-'));
  dirs.push(d);
  return d;
}
function write(file: string, body: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const okFetch = (versions: Record<string, string>) =>
  vi.fn(async (url: string) => {
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', '').replace('/latest', ''));
    const version = versions[name];
    return { ok: version !== undefined, json: async () => ({ version }) };
  });

describe('semver', () => {
  it('orders releases and prereleases', () => {
    expect(compareSemver('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
  });
  it('ignores prereleases unless the current version is one', () => {
    expect(isNewer('0.3.0', '0.2.0')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
    expect(isNewer('0.3.0-beta.1', '0.2.0')).toBe(false);
    expect(isNewer('0.3.0-beta.2', '0.3.0-beta.1')).toBe(true);
    expect(isNewer('garbage', '0.2.0')).toBe(false);
  });
});

describe('fetchLatest', () => {
  it('reads the latest dist-tag and is silent on errors', async () => {
    const f = okFetch({ splithub: '0.3.0', '@splithub/react': '0.3.0' });
    expect(await fetchLatest('splithub', { fetchImpl: f })).toBe('0.3.0');
    expect(f.mock.calls[0]![0]).toBe('https://registry.npmjs.org/splithub/latest');
    expect(await fetchLatest('@splithub/react', { fetchImpl: f })).toBe('0.3.0');
    expect(f.mock.calls[1]![0]).toBe('https://registry.npmjs.org/@splithub%2freact/latest');
    expect(await fetchLatest('nope', { fetchImpl: f })).toBeNull();
    expect(await fetchLatest('splithub', { fetchImpl: async () => Promise.reject(new Error('offline')) })).toBeNull();
  });
});

describe('gating', () => {
  const base: GateInput = { argv: ['status'], env: {}, stdinTTY: true, stdoutTTY: true };
  it('checks for a person at a terminal', () => {
    expect(shouldCheckForUpdates(base)).toBe(true);
    expect(shouldCheckForUpdates({ ...base, env: { CI: 'false' } })).toBe(true);
  });
  it('never checks for agents, CI, pipes, the MCP server or with the opt-out', () => {
    expect(shouldCheckForUpdates({ ...base, argv: ['status', '--json'] })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, env: { CI: 'true' } })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, env: { GITHUB_ACTIONS: 'true' } })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, env: { SPLITHUB_NO_UPDATE_CHECK: '1' } })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, env: { SPLITHUB_MCP: '1' } })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, stdoutTTY: false })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, stdinTTY: undefined })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, argv: ['update'] })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, argv: ['dev'] })).toBe(false);
  });
  it('does not start a request when gated off', () => {
    const f = okFetch({ splithub: '9.0.0' });
    expect(startUpdateCheck({ ...base, argv: ['status', '--json'] }, f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
  it('uses the answer only once it has arrived', async () => {
    const f = okFetch({ splithub: '9.0.0' });
    const check = startUpdateCheck(base, f)!;
    expect(check.settled()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(check.settled()).toBe('9.0.0');
    check.stop();
  });
});

describe('install mode', () => {
  it('detects npx from the cache path', () => {
    const root = tmp();
    write(join(root, 'package.json'), { devDependencies: { splithub: '^0.2.0' } });
    const scriptPath = join(root, 'npm-cache', '_npx', 'abc123', 'node_modules', 'splithub', 'dist', 'index.js');
    expect(detectInstall({ scriptPath, cwd: root, globalPrefix: () => null }).mode).toBe('npx');
  });
  it('detects a project dependency run from its node_modules', () => {
    const root = tmp();
    write(join(root, 'package.json'), { dependencies: { '@splithub/react': '^0.2.0' }, devDependencies: { splithub: '^0.2.0', vite: '^5' } });
    write(join(root, 'pnpm-lock.yaml'), '');
    const scriptPath = join(root, 'node_modules', 'splithub', 'dist', 'index.js');
    const install = detectInstall({ scriptPath, cwd: join(root, 'src'), globalPrefix: () => null });
    expect(install).toEqual({
      mode: 'project',
      root,
      pm: 'pnpm',
      packages: [
        { name: '@splithub/react', dev: false },
        { name: 'splithub', dev: true },
      ],
    });
  });
  it('detects a global install under the npm prefix', () => {
    const root = tmp();
    const prefix = join(root, 'usr', 'local');
    const scriptPath = join(prefix, 'lib', 'node_modules', 'splithub', 'dist', 'index.js');
    expect(detectInstall({ scriptPath, cwd: root, globalPrefix: () => prefix }).mode).toBe('global');
    const win = join(root, 'AppData', 'Roaming', 'npm');
    expect(detectInstall({ scriptPath: join(win, 'node_modules', 'splithub', 'dist', 'index.js'), cwd: root, globalPrefix: () => win }).mode).toBe('global');
  });
  it('prefers the global install when the project does not run its own copy', () => {
    const root = tmp();
    write(join(root, 'app', 'package.json'), { dependencies: { '@splithub/react': '^0.2.0' } });
    const prefix = join(root, 'prefix');
    const scriptPath = join(prefix, 'lib', 'node_modules', 'splithub', 'dist', 'index.js');
    expect(detectInstall({ scriptPath, cwd: join(root, 'app'), globalPrefix: () => prefix }).mode).toBe('global');
  });
  it('is unknown outside any project and prefix', () => {
    const root = tmp();
    expect(detectInstall({ scriptPath: join(root, 'x', 'index.js'), cwd: root, globalPrefix: () => null }).mode).toBe('unknown');
  });
});

describe('package manager', () => {
  it('reads the lockfile, walking up to a workspace root', () => {
    const cases: [string, string][] = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
      ['bun.lock', 'bun'],
      ['package-lock.json', 'npm'],
    ];
    for (const [file, pm] of cases) {
      const root = tmp();
      write(join(root, file), '');
      write(join(root, 'apps', 'web', 'package.json'), {});
      expect(detectPackageManager(join(root, 'apps', 'web'))).toBe(pm);
    }
  });
});

describe('update commands', () => {
  it('keeps prod and dev sections apart', () => {
    const packages = [
      { name: '@splithub/react', dev: false },
      { name: '@splithub/next', dev: false },
      { name: 'splithub', dev: true },
    ];
    const text = (pm: 'pnpm' | 'yarn' | 'bun' | 'npm') => buildUpdateCommands({ mode: 'project', root: '/app', pm, packages }).map(commandText);
    expect(text('pnpm')).toEqual(['pnpm add @splithub/react@latest @splithub/next@latest', 'pnpm add -D splithub@latest']);
    expect(text('npm')).toEqual(['npm install @splithub/react@latest @splithub/next@latest', 'npm install -D splithub@latest']);
    expect(text('yarn')).toEqual(['yarn add @splithub/react@latest @splithub/next@latest', 'yarn add --dev splithub@latest']);
    expect(text('bun')).toEqual(['bun add @splithub/react@latest @splithub/next@latest', 'bun add --dev splithub@latest']);
    expect(buildUpdateCommands({ mode: 'project', root: '/app', pm: 'pnpm', packages })[0]!.cwd).toBe('/app');
  });
  it('adds the CLI as a dev dependency when the project lists only the SDK', () => {
    const cmds = buildUpdateCommands({ mode: 'project', root: '/app', pm: 'npm', packages: [{ name: 'splithub', dev: false }, { name: '@splithub/core', dev: false }] }).map(commandText);
    expect(cmds).toEqual(['npm install splithub@latest @splithub/core@latest']);
    const sdkOnly = buildUpdateCommands({ mode: 'project', root: '/app', pm: 'npm', packages: [{ name: '@splithub/react', dev: false }] }).map(commandText);
    expect(sdkOnly).toEqual(['npm install @splithub/react@latest', 'npm install -D splithub@latest']);
  });
  it('updates a global install globally and installs nothing for npx', () => {
    expect(buildUpdateCommands({ mode: 'global' }).map(commandText)).toEqual(['npm install -g splithub@latest']);
    expect(buildUpdateCommands({ mode: 'npx' })).toEqual([]);
  });
});

describe('doctor versions', () => {
  it('flags SDK packages that disagree with the CLI and outdated ones', async () => {
    const root = tmp();
    write(join(root, 'package.json'), { dependencies: { '@splithub/react': '^0.1.0' }, devDependencies: { splithub: '^0.2.0' } });
    write(join(root, 'yarn.lock'), '');
    write(join(root, 'node_modules', '@splithub', 'react', 'package.json'), { version: '0.1.0' });
    write(join(root, 'node_modules', 'splithub', 'package.json'), { version: '0.2.0' });
    const v = await versionReport(root, { fetchImpl: okFetch({ splithub: '0.2.0', '@splithub/react': '0.2.0' }) });
    expect(v.rows).toEqual([
      { name: '@splithub/react', installed: '0.1.0', latest: '0.2.0' },
      { name: 'splithub', installed: '0.2.0', latest: '0.2.0' },
    ]);
    expect(v.mismatch).toBe(true);
    expect(v.outdated).toEqual(['@splithub/react']);
    expect(v.command).toBe('yarn add @splithub/react@latest && yarn add --dev splithub@latest');
  });
  it('skips the npm comparison when offline', async () => {
    const root = tmp();
    write(join(root, 'package.json'), { devDependencies: { splithub: '^0.2.0' } });
    write(join(root, 'node_modules', 'splithub', 'package.json'), { version: '0.2.0' });
    const v = await versionReport(root, { fetchImpl: async () => Promise.reject(new Error('offline')) });
    expect(v.offline).toBe(true);
    expect(v.mismatch).toBe(false);
    expect(v.command).toBeNull();
  });
});
