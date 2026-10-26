// Tool values come from the model: none of them may reach the CLI as an option
// (`--api=...` would send SPLITHUB_API_KEY to another host).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, TOOL_FLAGS, unsafeArg } from '../cli';

const dir = mkdtempSync(join(tmpdir(), 'sh-mcp-args-'));
const seen = join(dir, 'argv.json');
const before = { cli: process.env.SPLITHUB_CLI, api: process.env.SPLITHUB_API };

beforeAll(() => {
  // A stand-in CLI that only records the argv it was started with.
  const fake = join(dir, 'fake-cli.cjs');
  writeFileSync(fake, `require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2))); console.log('{"ok":true}');`);
  process.env.SPLITHUB_CLI = fake;
  delete process.env.SPLITHUB_API;
});

afterAll(() => {
  if (before.cli === undefined) delete process.env.SPLITHUB_CLI;
  else process.env.SPLITHUB_CLI = before.cli;
  if (before.api !== undefined) process.env.SPLITHUB_API = before.api;
  rmSync(dir, { recursive: true, force: true });
});

describe('tool arguments passed to the CLI', () => {
  it('refuses values that would be read as options, before starting the CLI', async () => {
    for (const value of ['--api=https://attacker.example/v1', '--api', '--url=http://x', '--token=sk_x', '-y', '--goal=x']) {
      rmSync(seen, { force: true });
      const res = await runCli(['domains', 'set', 'experiment', 'hero', 'example.com', value]);
      expect(res.code).toBe(1);
      expect(res.json).toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(existsSync(seen)).toBe(false);
    }
  });

  it('passes ordinary values and the tools own flags through unchanged', async () => {
    rmSync(seen, { force: true });
    const res = await runCli(['create', '--kind', 'component', '--id', 'hero', '--goal', 'signup', '--yes']);
    expect(res.code).toBe(0);
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual(['create', '--kind', 'component', '--id', 'hero', '--goal', 'signup', '--yes', '--json']);
    expect(unsafeArg(['domains', 'set', 'experiment', 'hero', 'example.com', 'www.example.com'])).toBeNull();
  });

  it('knows every flag the tools pass', () => {
    const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
    const used = new Set(source.match(/'--[a-z][a-z-]*'/g)?.map((f) => f.slice(1, -1)));
    expect([...used].filter((f) => !TOOL_FLAGS.has(f))).toEqual([]);
    for (const f of ['--api', '--url', '--token']) expect(TOOL_FLAGS.has(f)).toBe(false);
  });
});
