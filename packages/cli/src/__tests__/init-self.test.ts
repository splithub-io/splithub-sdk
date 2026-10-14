// `init --mode self --db …` writes a working store + route for the chosen database,
// and the generated Postgres / MySQL stores typecheck against the Store interface.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PG_STORE, MYSQL_STORE, CUSTOM_STORE, storeUsage } from '../templates-store';
import { nextRouteTemplate } from '../templates';

const cli = resolve(__dirname, '../../dist/index.js');
const root = resolve(__dirname, '../../.tmp');

function scratch(name: string): string {
  const dir = join(root, `${name}-${Date.now().toString(36)}`);
  mkdirSync(join(dir, 'app'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dependencies: { next: '15.0.0', react: '18.3.1' } }));
  writeFileSync(join(dir, 'next.config.mjs'), 'export default {};\n');
  return dir;
}
const run = (dir: string, args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SPLITHUB_API: 'http://127.0.0.1:9' } }).trim().replace(/^[^{]*/, ''));

beforeAll(() => {
  if (!existsSync(cli)) execFileSync(process.execPath, [resolve(__dirname, '../../../../node_modules/tsup/dist/cli-default.js')], { cwd: resolve(__dirname, '../..'), stdio: 'ignore' });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('init --mode self', () => {
  it('postgres: writes splithub/store.ts and a route that uses it', () => {
    const dir = scratch('pg');
    const out = run(dir, ['init', '--mode', 'self', '--db', 'postgres', '--yes', '--no-install', '--no-mcp']);
    expect(out).toMatchObject({ mode: 'self', db: 'postgres', warning: null });
    expect(readFileSync(join(dir, 'splithub', 'store.ts'), 'utf8')).toBe(PG_STORE);
    const route = readFileSync(join(dir, 'app', 'api', 'splithub', '[[...path]]', 'route.ts'), 'utf8');
    expect(route).toContain("import { pgStore } from '../../../../splithub/store';");
    expect(route).toContain('store: pgStore()');
    expect(out.installCommands[0]).toContain('pg');
    expect(out.installCommands[0]).not.toContain('adapter-sqlite');
  });

  it('sqlite stays the zero-setup default; mysql and custom have their templates', () => {
    const dir = scratch('sq');
    const out = run(dir, ['init', '--mode', 'self', '--yes', '--no-install', '--no-mcp']);
    expect(out.db).toBe('sqlite');
    expect(existsSync(join(dir, 'splithub', 'store.ts'))).toBe(false);
    expect(readFileSync(join(dir, 'app', 'api', 'splithub', '[[...path]]', 'route.ts'), 'utf8')).toContain('sqliteStore(');
    expect(storeUsage('mysql', './store').factory).toBe('mysqlStore()');
    expect(MYSQL_STORE).toContain('INSERT IGNORE INTO splithub_events');
    expect(CUSTOM_STORE).toContain('implement variantCounts');
    expect(nextRouteTemplate('../config', storeUsage('custom', '../store'))).toContain("import { customStore } from '../store';");
  });

  it('cloud init without a key warns instead of staying silent', () => {
    const dir = scratch('cloud');
    const out = run(dir, ['init', '--mode', 'cloud', '--yes', '--no-install', '--no-login', '--no-mcp']);
    expect(out.publicKey).toBeNull();
    expect(out.warning).toMatch(/No public key yet/);
    expect(out.warning).toMatch(/push/);
    expect(out.warning).toMatch(/login/);
  });

  it('create in cloud mode tells the agent to push', () => {
    const dir = scratch('push');
    run(dir, ['init', '--mode', 'cloud', '--key', 'pk_live_test', '--yes', '--no-install', '--no-login', '--no-mcp']);
    const out = run(dir, ['create', '--kind', 'value', '--id', 'hero', '--variants', 'control,b', '--value', 'control=a', '--value', 'b=b', '--status', 'running', '--yes']);
    expect(out.nextStep).toContain('npx splithub push');
    expect(out.handoff).toMatch(/running in the config: it goes live for visitors when this code is deployed and pushed/);
  });

  it('create writes a running test by default', () => {
    const dir = scratch('default-running');
    run(dir, ['init', '--mode', 'cloud', '--key', 'pk_live_test', '--yes', '--no-install', '--no-login', '--no-mcp']);
    const out = run(dir, ['create', '--kind', 'value', '--id', 'hero', '--variants', 'control,b', '--value', 'control=a', '--value', 'b=b', '--yes']);
    expect(out.status).toBe('running');
    expect(out.handoff).toMatch(/pause hero/);
  });

  it('create as a draft tells the agent to say it is not live and ask to start it', () => {
    const dir = scratch('handoff');
    run(dir, ['init', '--mode', 'cloud', '--key', 'pk_live_test', '--yes', '--no-install', '--no-login', '--no-mcp']);
    const out = run(dir, ['create', '--kind', 'value', '--id', 'hero', '--variants', 'control,b', '--value', 'control=a', '--value', 'b=b', '--status', 'draft', '--yes']);
    expect(out.status).toBe('draft');
    expect(out.handoff).toMatch(/draft.*nothing is recorded.*ask whether to start/);
  });
});
