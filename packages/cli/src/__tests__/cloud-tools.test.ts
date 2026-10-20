// Notes, short links, alert rules and `analytics connect`: pure helpers, then the built CLI against a
// fake SplitHub Cloud that records every request.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeRule, parseCount, pickRule, ruleBody, ruleProgress, ruleTarget, type AlertRule } from '../commands/alerts';
import { trackSnippets, wireSource } from '../commands/connect';
import { destinationsFrom, nameFromUrl } from '../commands/links';

describe('alerts helpers', () => {
  it('reads counts the way people type them', () => {
    expect(parseCount('1000')).toBe(1000);
    expect(parseCount('1,000')).toBe(1000);
    expect(parseCount('10k')).toBe(10_000);
    expect(parseCount('1.5m')).toBe(1_500_000);
    expect(parseCount('lots')).toBeNaN();
  });

  it('builds rule bodies for every kind of condition', () => {
    expect(ruleBody('usage', { every: '1,000' })).toMatchObject({ condition: 'usage', params: { every: 1000 }, actions: { notify: true }, enabled: true });
    expect(ruleBody('event_count', { property: 'sh-abc123', event: 'Signup', count: '500', repeat: true })).toMatchObject({ params: { property: 'sh-abc123', event: 'Signup', count: 500, repeat: true } });
    expect(ruleBody('traffic_drop', { property: 'site' })).toMatchObject({ params: { property: 'site', percent: 50 } });
    expect(ruleBody('goal_silent', { property: 'site', goal: 'signup', hours: '6' })).toMatchObject({ params: { property: 'site', goal: 'signup', hours: 6 } });
    expect(ruleBody('loser', { experiment: 'hero', 'drop-loser': true })).toMatchObject({ experiment: 'hero', params: { lift: 10 }, actions: { dropLoser: true } });
    expect(ruleBody('winner', { disabled: true, name: 'Ship it', cooldown: '48' })).toMatchObject({ name: 'Ship it', cooldownHours: 48, enabled: false });
    expect(() => ruleBody('usage', {})).toThrow(/--every/);
    expect(() => ruleBody('usage', { every: '50' })).toThrow(/100 or more/);
    expect(() => ruleBody('traffic_spike', {})).toThrow(/--property/);
    expect(() => ruleBody('quota', { pause: true })).toThrow(/only send a message/);
    expect(() => ruleBody('quota', { experiment: 'x' })).toThrow(/drop --experiment/);
    expect(() => ruleBody('nope', {})).toThrow(/Which condition/);
  });

  it('describes rules, their target and progress', () => {
    const usage = { condition: 'usage' as const, params: { every: 1000, progress: { total: 2345, fired: 2, month: '2026-10' } }, experiment: null };
    expect(describeRule(usage)).toBe('Every 1,000 events used');
    expect(ruleTarget(usage)).toBe('this project');
    expect(ruleProgress(usage)).toBe('2,345 used this month, next at 3,000');
    const once = { condition: 'event_count' as const, params: { property: 'site', count: 100, progress: { total: 140, fired: 1 } }, experiment: null };
    expect(describeRule(once)).toBe('Any event reaches 100');
    expect(ruleTarget(once)).toBe('property site');
    expect(ruleProgress(once)).toBe('140 counted, done');
    expect(ruleProgress({ ...once, params: { ...once.params, repeat: true } })).toBe('140 of 200');
    expect(ruleTarget({ condition: 'winner', params: {}, experiment: null })).toBe('every running experiment');
    const rules = [{ id: 'abcd1234-0000', name: 'Clear winner' }, { id: 'ffff0000-1111', name: 'Usage' }] as AlertRule[];
    expect(pickRule(rules, 'abcd').id).toBe('abcd1234-0000');
    expect(pickRule(rules, 'usage').id).toBe('ffff0000-1111');
    expect(() => pickRule(rules, 'zz')).toThrow(/no alert rule/);
  });
});

describe('links helpers', () => {
  it('names a link after its URL and splits destinations by weight', () => {
    expect(nameFromUrl('https://example.com/spring?utm=x')).toBe('example.com/spring');
    expect(nameFromUrl('https://example.com/')).toBe('example.com');
    expect(destinationsFrom(['https://a.com', 'https://b.com'], '70,30')).toEqual([
      { id: 'd1', url: 'https://a.com', weight: 70 },
      { id: 'd2', url: 'https://b.com', weight: 30 },
    ]);
    expect(() => destinationsFrom(['example.com'])).toThrow(/full http/);
    expect(() => destinationsFrom(['https://a.com'], '1,2')).toThrow(/one number per URL/);
    expect(() => destinationsFrom([])).toThrow(/Where should it go/);
  });
});

describe('analytics connect: naming the property on the provider', () => {
  const app = `import { SplitHubProvider } from '@splithub/react';\n\nexport function Root() {\n  return <SplitHubProvider config={config} devtools={x > 1}><App /></SplitHubProvider>;\n}\n`;

  it('adds the property right after the component name', () => {
    const out = wireSource(app, 'sh-abc123');
    expect(out?.status).toBe('added');
    expect(out?.source).toContain('<SplitHubProvider property="sh-abc123" config={config} devtools={x > 1}>');
  });

  it('leaves the same property alone and asks before replacing another one', () => {
    const named = wireSource(app, 'sh-abc123')!.source!;
    expect(wireSource(named, 'sh-abc123')).toMatchObject({ status: 'already', source: null });
    expect(wireSource(named, 'sh-zzz999')).toMatchObject({ status: 'other', current: 'sh-abc123', source: null });
    expect(wireSource(named, 'sh-zzz999', true)?.source).toContain('property="sh-zzz999"');
    expect(wireSource(named, 'sh-zzz999', true)?.source).not.toContain('sh-abc123');
  });

  it('handles the Next.js provider and refuses to guess between two', () => {
    expect(wireSource('<SplitHubNextProvider\n  config={config}\n>{children}</SplitHubNextProvider>', 'sh-n')?.source).toContain('<SplitHubNextProvider property="sh-n"\n');
    expect(wireSource(`${app}\n${app}`, 'sh-x')).toBeNull();
    expect(wireSource('type P = SplitHubProviderProps;', 'sh-x')).toBeNull();
  });

  it('shows track and identify for the SDK, and the script tag with the public key', () => {
    const s = trackSnippets('next', 'sh-abc123', 'pk_live_1');
    expect(s.provider).toBe('<SplitHubNextProvider config={config} property="sh-abc123">');
    expect(s.script).toContain('data-key="pk_live_1" data-property="sh-abc123"');
    expect(s.track).toContain("track('Signup'");
    expect(s.identify).toContain('useIdentify');
  });
});

// ---------------------------------------------------------------------------
// The built CLI against a fake cloud
// ---------------------------------------------------------------------------

const cli = resolve(__dirname, '../../dist/index.js');
const root = resolve(__dirname, '../../.tmp-cloud-tools');
let server: Server;
let url = '';
const seen: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
let plan = 'pro';

function run(dir: string, args: string[], json = true): Promise<{ code: number; json: Record<string, unknown>; stdout: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [cli, ...args, ...(json ? ['--json'] : [])], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SPLITHUB_API_KEY: 'sk_test', SPLITHUB_URL: '', SPLITHUB_API: url } }, (error, stdout) => {
      const lines = stdout.trim().split('\n');
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
      } catch {
        // human output
      }
      done({ code: error ? 1 : 0, json: parsed, stdout });
    });
  });
}

const config = (mode: 'self' | 'cloud', extra = '') => `import { defineConfig } from '@splithub/core';

export default defineConfig({
  project: 'demo',
  storage: ${mode === 'self' ? `{ mode: 'self', endpoint: '/api/splithub' }` : `{ mode: 'cloud', key: 'pk_test' }`},
  goals: { signup: { type: 'event' } },
  experiments: {},${extra}
});
`;

function scratch(mode: 'self' | 'cloud', files: Record<string, string> = {}, extra = ''): string {
  const dir = join(root, `${mode}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'a', dependencies: { react: '18.3.1', vite: '5.4.0' } }));
  writeFileSync(join(dir, 'splithub.config.ts'), config(mode, extra));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return dir;
}

const NOTE = { id: 'n1', day: '2026-10-02', kind: 'win', text: 'Launch', experimentKey: null, propertyKey: 'site', createdAt: 'x', createdBy: null, author: { name: 'Ann', email: null }, updatedAt: null, updatedBy: null };
const LINK = { linkId: 'l1', name: 'Spring', shortCode: 'spring', shortUrl: 'https://go.splithub.io/l/spring', status: 'active', destinations: [{ id: 'd1', url: 'https://a.com', weight: 1 }], flow: null, clickLimit: 0, totalClicks: 12, description: null, createdAt: 'x', updatedAt: 'x' };
const RULE = { id: 'r1aaaaaa-0000', experiment: null, name: 'Every 1,000 events used', condition: 'usage', params: { every: 1000, progress: { total: 1500, fired: 1, month: '2026-10' } }, actions: { channels: [], pause: false, finish: false, dropLoser: false }, enabled: true, cooldownHours: 24, lastFiredAt: null, createdAt: 'x', updatedAt: 'x' };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d: Buffer) => (raw += d.toString()));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const u = req.url ?? '';
      const m = req.method ?? 'GET';
      seen.push({ method: m, url: u, body });
      res.setHeader('content-type', 'application/json');
      const send = (status: number, value: unknown) => {
        res.statusCode = status;
        res.end(JSON.stringify(value));
      };
      if (u.startsWith('/notes')) {
        if (m === 'POST') return send(201, { note: { ...NOTE, id: 'n2', text: body?.text, kind: body?.kind ?? 'note', day: body?.day ?? '2026-10-20', experimentKey: body?.experimentKey ?? null, propertyKey: body?.propertyKey ?? null } });
        if (m === 'PATCH') return send(200, { note: { ...NOTE, ...(body ?? {}) } });
        if (m === 'DELETE') return send(200, { ok: true, id: 'n1' });
        return send(200, { notes: [NOTE] });
      }
      if (u === '/links/l1/stats') return send(200, { link: LINK, totalClicks: 12, uniqueVisitors: 9, byDay: [{ day: '2026-10-19', clicks: 12, visitors: 9 }], byDestination: [{ destinationId: 'd1', clicks: 12 }], byCountry: [{ country: 'DE', clicks: 12 }], byDevice: [], byReferrer: [{ referrer: '(direct)', clicks: 12 }] });
      if (u === '/links' && m === 'POST') return send(201, { link: { ...LINK, linkId: 'l2', name: body?.name, shortCode: body?.shortCode ?? 'x8k2m9ab', destinations: body?.destinations } });
      if (u === '/links/l1' && m === 'PATCH') return send(200, { link: { ...LINK, ...(body ?? {}) } });
      if (u === '/links/l1' && m === 'DELETE') return send(200, { ok: true });
      if (u === '/links') return send(200, { links: [LINK] });
      if (u === '/alerts') return send(200, { plan, rules: [RULE], channels: [], digest: {}, conditions: [], history: [{ id: 'h1', experiment: null, kind: 'usage', message: '1,000 events used this month', createdAt: '2026-10-19T10:00:00Z', delivered: true, ruleId: 'r1aaaaaa-0000', actions: [] }] });
      if (u === '/alerts/rules' && m === 'POST') {
        if (plan !== 'pro' && body?.enabled !== false) return send(402, { error: 'alert rules run on Pro', code: 'pro_required' });
        return send(201, { rule: { ...RULE, id: 'r2', condition: body?.condition, params: body?.params, enabled: body?.enabled !== false, name: body?.name ?? 'New rule' } });
      }
      if (u === '/alerts/rules/r1aaaaaa-0000/test') return send(200, { matches: [{ experiment: null, message: '1,500 events used' }] });
      if (u === '/alerts/rules/r1aaaaaa-0000' && m === 'PATCH') return send(200, { rule: { ...RULE, enabled: body?.enabled } });
      if (u === '/alerts/rules/r1aaaaaa-0000' && m === 'DELETE') return send(200, { ok: true });
      if (u === '/properties') return send(200, { properties: [{ key: 'sh-cloud1', name: 'Cloud site', status: 'running', last30: { visitors: 3 } }] });
      send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const last = (method: string, path: string) => [...seen].reverse().find((s) => s.method === method && s.url.startsWith(path));

describe('splithub notes (built CLI)', () => {
  it('lists, adds, edits and deletes notes', async () => {
    const dir = scratch('cloud');
    expect((await run(dir, ['notes', '--property', 'site', '--kind', 'win', '--days', '7'])).json).toMatchObject({ notes: [{ id: 'n1', text: 'Launch' }] });
    const listed = last('GET', '/notes')!.url;
    expect(listed).toContain('property=site');
    expect(listed).toContain('kind=win');
    expect(listed).toMatch(/from=\d{4}-\d{2}-\d{2}/);
    expect((await run(dir, ['notes', 'add', 'Checkout', 'broke', '--kind', 'issue', '--experiment', 'hero', '--day', '2026-10-05'])).json).toMatchObject({ note: { text: 'Checkout broke', kind: 'issue', experimentKey: 'hero' } });
    expect(last('POST', '/notes')!.body).toEqual({ text: 'Checkout broke', kind: 'issue', day: '2026-10-05', experimentKey: 'hero' });
    expect((await run(dir, ['notes', 'edit', 'n1', 'Big launch', '--kind', 'win'])).json).toMatchObject({ note: { text: 'Big launch' } });
    expect(last('PATCH', '/notes/n1')!.body).toEqual({ text: 'Big launch', kind: 'win' });
    expect((await run(dir, ['notes', 'delete', 'n1'])).json).toMatchObject({ ok: true, id: 'n1' });
    expect((await run(dir, ['notes', 'add', 'x', '--kind', 'oops'])).json).toMatchObject({ code: 'INVALID_FLAG' });
    expect((await run(dir, ['notes', 'add', 'x', '--experiment', 'a', '--property', 'b'])).json).toMatchObject({ code: 'USAGE' });
    expect((await run(dir, ['notes', 'edit', 'n1'])).json).toMatchObject({ code: 'USAGE' });
    expect((await run(dir, ['annotate', 'old'])).json).toMatchObject({ code: 'USAGE' });
    const human = await run(dir, ['notes'], false);
    expect(human.stdout).toContain('Launch');
    expect(human.stdout).toContain('property site');
  });
});

describe('splithub links (built CLI)', () => {
  it('lists, creates, shows clicks, pauses and deletes links', async () => {
    const dir = scratch('cloud');
    expect((await run(dir, ['links'])).json).toMatchObject({ links: [{ shortCode: 'spring', totalClicks: 12 }] });
    const made = await run(dir, ['links', 'create', 'https://a.com/x', 'https://b.com/y', '--weights', '70,30', '--slug', 'sale']);
    expect(made.json).toMatchObject({ link: { shortCode: 'sale', name: 'a.com/x' } });
    expect(last('POST', '/links')!.body).toMatchObject({ name: 'a.com/x', shortCode: 'sale', destinations: [{ url: 'https://a.com/x', weight: 70 }, { url: 'https://b.com/y', weight: 30 }] });
    expect((await run(dir, ['links', 'spring'])).json).toMatchObject({ totalClicks: 12, uniqueVisitors: 9 });
    expect((await run(dir, ['links', 'pause', 'spring'])).json).toMatchObject({ link: { status: 'paused' } });
    expect(last('PATCH', '/links/l1')!.body).toEqual({ status: 'paused' });
    expect((await run(dir, ['links', 'edit', 'l1', '--name', 'Spring sale'])).json).toMatchObject({ link: { name: 'Spring sale' } });
    expect((await run(dir, ['links', 'delete', 'spring'])).json).toMatchObject({ ok: true, linkId: 'l1' });
    expect((await run(dir, ['links', 'nope'])).json).toMatchObject({ code: 'NOT_FOUND' });
    expect((await run(dir, ['links', 'create', 'example.com'])).json).toMatchObject({ code: 'INVALID_FLAG' });
    expect((await run(dir, ['links', 'create', 'https://a.com', '--slug', 'a b'])).json).toMatchObject({ code: 'INVALID_FLAG' });
    const human = await run(dir, ['links', 'spring'], false);
    expect(human.stdout).toContain('12 clicks from 9 visitors');
  });
});

describe('splithub alerts (built CLI)', () => {
  it('lists rules with progress, adds, toggles, tests and deletes', async () => {
    const dir = scratch('cloud');
    plan = 'pro';
    expect((await run(dir, ['alerts'])).json).toMatchObject({ plan: 'pro', rules: [{ id: 'r1aaaaaa-0000' }], history: [{ message: '1,000 events used this month' }] });
    const human = await run(dir, ['alerts'], false);
    expect(human.stdout).toContain('Every 1,000 events used');
    expect(human.stdout).toContain('1,500 used this month, next at 2,000');
    expect((await run(dir, ['alerts', 'add', 'usage', '--every', '10k'])).json).toMatchObject({ rule: { condition: 'usage', params: { every: 10000 } }, savedOff: false });
    expect((await run(dir, ['alerts', 'add', 'event_count', '--property', 'site', '--event', 'Signup', '--count', '100', '--repeat'])).json).toMatchObject({ rule: { params: { property: 'site', event: 'Signup', count: 100, repeat: true } } });
    expect((await run(dir, ['alerts', 'disable', 'r1aa'])).json).toMatchObject({ rule: { enabled: false } });
    expect(last('PATCH', '/alerts/rules/r1aaaaaa-0000')!.body).toEqual({ enabled: false });
    expect((await run(dir, ['alerts', 'test', 'r1aaaaaa-0000'])).json).toMatchObject({ rule: 'r1aaaaaa-0000', matches: [{ message: '1,500 events used' }] });
    expect((await run(dir, ['alerts', 'delete', 'Every 1,000 events used'])).json).toMatchObject({ ok: true });
    expect((await run(dir, ['alerts', 'add', 'traffic_drop'])).json).toMatchObject({ code: 'USAGE' });
    expect((await run(dir, ['alerts', 'enable', 'zzzz'])).json).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('saves a rule switched off on a plan without alerts', async () => {
    const dir = scratch('cloud');
    plan = 'free';
    expect((await run(dir, ['alerts', 'add', 'winner'])).json).toMatchObject({ rule: { enabled: false }, savedOff: true });
    expect((await run(dir, ['alerts', 'add', 'winner'], false)).stdout).toContain('alert rules run on Pro');
    plan = 'pro';
  });
});

describe('splithub analytics connect (built CLI)', () => {
  const main = `import { SplitHubProvider } from '@splithub/react';\nimport config from '../splithub.config';\n\ncreateRoot(el).render(<SplitHubProvider config={config}><App /></SplitHubProvider>);\n`;

  it('creates a property in the config and names it on the provider (self-hosted)', async () => {
    const dir = scratch('self', { 'src/main.tsx': main });
    const out = await run(dir, ['analytics', 'connect', '--name', 'Blog']);
    expect(out.json).toMatchObject({ created: true, wired: { status: 'added', file: 'src/main.tsx', line: 4 } });
    const key = out.json.property as string;
    expect(key).toMatch(/^sh-[a-z2-9]{6}$/);
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).toContain(`'${key}': { name: 'Blog' }`);
    expect(readFileSync(join(dir, 'src/main.tsx'), 'utf8')).toContain(`<SplitHubProvider property="${key}" config={config}>`);
    expect((await run(dir, ['analytics', 'connect'])).json).toMatchObject({ property: key, created: false, wired: { status: 'already' } });
    expect((await run(dir, ['analytics', 'connect', 'other'])).json).toMatchObject({ property: 'other', created: true, wired: { status: 'other', current: key } });
    expect((await run(dir, ['analytics', 'connect', 'other', '--force'])).json).toMatchObject({ wired: { status: 'added' } });
    expect((await run(dir, ['analytics', 'connect'])).json).toMatchObject({ code: 'USAGE' });
  });

  it('uses the cloud property when there is one, and gives the script tag when there is no provider', async () => {
    const dir = scratch('cloud');
    const out = await run(dir, ['analytics', 'connect']);
    expect(out.json).toMatchObject({ property: 'sh-cloud1', created: false, wired: { status: 'none' }, snippets: { script: expect.stringContaining('data-key="pk_test" data-property="sh-cloud1"') } });
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).not.toContain('sh-cloud1');
  });
});
