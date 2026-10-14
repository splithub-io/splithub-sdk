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
    expect(tools.map((t) => t.name).sort()).toEqual(['splithub_create_experiment', 'splithub_doctor', 'splithub_init', 'splithub_login', 'splithub_plan', 'splithub_projects', 'splithub_pull', 'splithub_push', 'splithub_refs', 'splithub_remove', 'splithub_results', 'splithub_review', 'splithub_set_status', 'splithub_ship', 'splithub_status', 'splithub_whoami'].sort());
  });

  it('sets up a project, creates an experiment and reads it back', async () => {
    const init = await client.callTool({ name: 'splithub_init', arguments: { mode: 'self' } });
    const initText = (init.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(initText)).toMatchObject({ mode: 'self' });
    expect(existsSync(join(dir, 'splithub.config.ts'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'skills', 'ab-testing', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);

    const created = await client.callTool({ name: 'splithub_create_experiment', arguments: { id: 'hero-title', kind: 'value', variants: ['control', 'bold'], values: { control: 'Old', bold: 'New' }, goal: 'signup' } });
    expect(created.isError).toBeFalsy();
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).toContain("'hero-title'");

    const paused = await client.callTool({ name: 'splithub_set_status', arguments: { experiment: 'hero-title', status: 'running' } });
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

    const plan = await client.callTool({ name: 'splithub_plan', arguments: { baseline: 0.05, mde: 0.2 } });
    expect(JSON.parse((plan.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ perVariant: 8000, total: 16000 });
  }, 60_000);

  it('explains how to connect when a cloud tool is used without credentials', async () => {
    const r = await client.callTool({ name: 'splithub_push', arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ code: 'NOT_CLOUD' });
  }, 30_000);
});
