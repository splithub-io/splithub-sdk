// Spawns the built server over stdio with the MCP client and exercises the
// tools against a scratch project (no cloud: cloud-only tools answer with the
// "not connected" hint; a fake cloud answers /plan, everything else 404s so skills
// fall back to the bundled copies). Needs `pnpm build` of cli and mcp first.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dist = resolve(__dirname, '../../dist/index.js');
const cli = resolve(__dirname, '../../../cli/dist/index.js');
// Inside the repo so the generated splithub.config.ts can resolve @splithub/core from the root node_modules.
const dir = resolve(__dirname, '../../.tmp', `p${Date.now()}`);
let client: Client;
let cloud: Server;

beforeAll(async () => {
  // The server and the CLI run from their builds; build them when missing (fresh clone, pre-commit hook).
  const tsup = resolve(__dirname, '../../../../node_modules/tsup/dist/cli-default.js');
  if (!existsSync(cli)) execSync(`"${process.execPath}" "${tsup}"`, { cwd: resolve(__dirname, '../../../cli'), stdio: 'ignore' });
  if (!existsSync(dist)) execSync(`"${process.execPath}" "${tsup}"`, { cwd: resolve(__dirname, '../..'), stdio: 'ignore' });
  cloud = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/plan?')) res.end(JSON.stringify({ baseline: 0.05, mde: 0.2, variants: 2, confidence: 0.95, perVariant: 8000, total: 16000 }));
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => cloud.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mcp-test', dependencies: { react: '18.3.1', vite: '5.4.0' } }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [dist], env: { ...process.env, SPLITHUB_PROJECT_DIR: dir, SPLITHUB_CLI: cli, SPLITHUB_API: api, NO_COLOR: '1' } as Record<string, string> });
  client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  cloud?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('@splithub/mcp', () => {
  it('lists the tools', async () => {
    expect(existsSync(dist)).toBe(true);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['splithub_analytics', 'splithub_analytics_events', 'splithub_analytics_funnel', 'splithub_analytics_funnels', 'splithub_analytics_paths', 'splithub_analytics_realtime', 'splithub_analytics_retention', 'splithub_analytics_connect', 'splithub_notes', 'splithub_links', 'splithub_alerts', 'splithub_segments', 'splithub_create_experiment', 'splithub_create_property', 'splithub_doctor', 'splithub_domains', 'splithub_experiment_create', 'splithub_experiment_events', 'splithub_experiment_status', 'splithub_property_create', 'splithub_property_status', 'splithub_set_property_status', 'splithub_init', 'splithub_login', 'splithub_plan', 'splithub_projects', 'splithub_pull', 'splithub_push', 'splithub_refs', 'splithub_remove', 'splithub_results', 'splithub_review', 'splithub_set_status', 'splithub_ship', 'splithub_status', 'splithub_whoami'].sort());
    // The old names stay for one release and point at the new ones.
    for (const [old, now] of [['splithub_create_experiment', 'splithub_experiment_create'], ['splithub_set_status', 'splithub_experiment_status'], ['splithub_create_property', 'splithub_property_create'], ['splithub_set_property_status', 'splithub_property_status']]) {
      const alias = tools.find((t) => t.name === old)!;
      expect(alias.description).toBe(`Old name of ${now}, kept for one release: call ${now} instead.`);
      expect(alias.inputSchema).toEqual(tools.find((t) => t.name === now)!.inputSchema);
    }
    const propertyStatus = tools.find((t) => t.name === 'splithub_property_status')!.inputSchema as { properties: { status: { enum: string[] } } };
    expect(propertyStatus.properties.status.enum).toEqual(['running', 'paused', 'archived', 'restored', 'removed']);
    // App dimensions: breakdowns and filters take platform and app_version wherever they take device.
    type Schema = { properties: Record<string, { enum?: string[]; propertyNames?: { enum: string[] } }> };
    const schema = (name: string) => tools.find((t) => t.name === name)!.inputSchema as Schema;
    for (const name of ['splithub_results', 'splithub_analytics', 'splithub_analytics_funnel']) expect(schema(name).properties.by!.enum).toEqual(expect.arrayContaining(['device', 'platform', 'app_version']));
    expect(schema('splithub_results').properties.filters!.propertyNames!.enum).toEqual(expect.arrayContaining(['platform', 'app_version']));
    expect(Object.keys(schema('splithub_analytics_retention').properties)).toEqual(expect.arrayContaining(['property', 'period', 'from', 'to', 'filters']));
    expect(tools.find((t) => t.name === 'splithub_analytics_retention')!.description).toContain('cohorts[] { start, users, retained[] }');
    expect(schema('splithub_property_create').properties.kind!.enum).toEqual(['site', 'app']);
  });

  it('sets up a project, creates an experiment and reads it back', async () => {
    const init = await client.callTool({ name: 'splithub_init', arguments: { mode: 'self' } });
    const initText = (init.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(initText)).toMatchObject({ mode: 'self' });
    expect(existsSync(join(dir, 'splithub.config.ts'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'skills', 'ab-testing', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);

    const created = await client.callTool({ name: 'splithub_experiment_create', arguments: { id: 'hero-title', kind: 'value', variants: ['control', 'bold'], values: { control: 'Old', bold: 'New' }, goal: 'signup' } });
    expect(created.isError).toBeFalsy();
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).toContain("'hero-title'");

    const played = await client.callTool({ name: 'splithub_create_experiment', arguments: { id: 'player', kind: 'value', variants: ['control', 'big'], values: { control: 'S', big: 'L' }, goal: 'Video Played' } });
    expect(played.isError).toBeFalsy();
    expect(JSON.parse((played.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ experiment: 'player', goal: 'video-played' });

    const paused = await client.callTool({ name: 'splithub_experiment_status', arguments: { experiment: 'hero-title', status: 'running' } });
    expect(JSON.parse((paused.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ experiment: 'hero-title', status: 'running' });

    const refs = await client.callTool({ name: 'splithub_refs', arguments: { experiment: 'hero-title' } });
    expect(refs.structuredContent).toMatchObject({ experiment: 'hero-title', goal: 'signup', count: 0 });

    const ship = await client.callTool({ name: 'splithub_ship', arguments: { experiment: 'hero-title', keep: 'bold', dryRun: true } });
    expect(ship.isError).toBeFalsy();
    expect(ship.structuredContent).toMatchObject({ experiment: 'hero-title', kept: 'bold', dryRun: true, leftovers: [] });
    expect((ship.structuredContent as { diff: string }).diff).toContain("-    'hero-title': {");

    const missing = await client.callTool({ name: 'splithub_set_status', arguments: { experiment: 'nope', status: 'paused' } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse((missing.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'EXPERIMENT_NOT_FOUND', next: expect.stringContaining('splithub_status') });

    const property = await client.callTool({ name: 'splithub_property_create', arguments: { id: 'site', name: 'Site', goals: ['signup'] } });
    expect(property.isError).toBeFalsy();
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).toContain(`site: { name: 'Site', goals: ['signup'] }`);
    const pausedProperty = await client.callTool({ name: 'splithub_property_status', arguments: { property: 'site', status: 'paused' } });
    expect(JSON.parse((pausedProperty.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ property: 'site', status: 'paused' });
    // The old name runs the same command.
    const resumed = await client.callTool({ name: 'splithub_set_property_status', arguments: { property: 'site', status: 'running' } });
    expect(JSON.parse((resumed.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ property: 'site', status: 'running' });
    // Archiving is a SplitHub Cloud state; a self-hosted project pauses instead.
    const archived = await client.callTool({ name: 'splithub_property_status', arguments: { property: 'site', status: 'archived' } });
    expect(archived.isError).toBe(true);
    expect(JSON.parse((archived.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'NOT_CLOUD' });

    const plan = await client.callTool({ name: 'splithub_plan', arguments: { baseline: 0.05, mde: 0.2 } });
    expect(JSON.parse((plan.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ perVariant: 8000, total: 16000 });
  }, 60_000);

  it('explains how to connect when a cloud tool is used without credentials', async () => {
    const r = await client.callTool({ name: 'splithub_push', arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'NOT_CLOUD' });
    const funnel = await client.callTool({ name: 'splithub_analytics_funnel', arguments: { property: 'site', steps: ['page:/', 'event:Signup'] } });
    expect(funnel.isError).toBe(true);
    expect(JSON.parse((funnel.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'NOT_CLOUD' });
    const saved = await client.callTool({ name: 'splithub_analytics_funnels', arguments: { property: 'site', save: 'Signup', steps: ['page:/', 'event:Signup'] } });
    expect(saved.isError).toBe(true);
    expect(JSON.parse((saved.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'NOT_CLOUD' });
    for (const [name, args] of [['splithub_notes', { action: 'add', text: 'Launch' }], ['splithub_links', {}], ['splithub_alerts', { condition: 'usage', every: 1000 }]] as const) {
      const r2 = await client.callTool({ name, arguments: args });
      expect(r2.isError).toBe(true);
      expect(JSON.parse((r2.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'NOT_CLOUD', next: expect.stringContaining('notes, links and alerts') });
    }
    // Slices, views and raw experiment events are cloud reports too; the plain results stay raw counts.
    for (const [name, args] of [['splithub_results', { experiment: 'hero-title', filters: { country: 'DE' } }], ['splithub_results', { experiment: 'hero-title', by: 'country' }], ['splithub_results', { experiment: 'hero-title', events: true }], ['splithub_experiment_events', { experiment: 'hero-title' }]] as const) {
      const r3 = await client.callTool({ name, arguments: args });
      expect(r3.isError).toBe(true);
      expect(JSON.parse((r3.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'NOT_CLOUD', next: expect.stringContaining('Experiment slices') });
    }
  }, 30_000);

  it('sets up analytics in the app with splithub_analytics_connect', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'main.tsx'), `createRoot(el).render(<SplitHubProvider config={config}><App /></SplitHubProvider>);\n`);
    const r = await client.callTool({ name: 'splithub_analytics_connect', arguments: { name: 'Docs' } });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { property: string; wired: { status: string } };
    expect(out).toMatchObject({ created: true, wired: { status: 'added', file: 'src/main.tsx' } });
    expect(readFileSync(join(dir, 'src', 'main.tsx'), 'utf8')).toContain(`property="${out.property}"`);
  }, 30_000);
});
