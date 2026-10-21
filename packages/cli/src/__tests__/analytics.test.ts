// Analytics properties in the CLI: config edits, and the built CLI against a fake
// self-hosted endpoint (raw counts) and a fake cloud (reports, domains).
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertProperty, removeProperty, renderProperty, setPropertyStatus } from '../config-file';

const base = `import { defineConfig } from '@splithub/core';

export default defineConfig({
  project: 'demo',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: {},
});
`;

describe('config-file: properties', () => {
  it('adds a properties block when there is none, then appends to it', () => {
    const one = insertProperty(base, { key: 'site', goals: ['signup'] });
    expect(one).toContain(`properties: {\n    site: { goals: ['signup'] },\n  },`);
    const two = insertProperty(one, { key: 'app', name: 'App', status: 'paused' });
    expect(two).toContain(`app: { status: 'paused', name: 'App' },`);
    expect(() => insertProperty(two, { key: 'site' })).toThrow(/already/);
    expect(renderProperty({ key: 'x' })).toBe('x: {}');
    // site is the default and never written; an app says so.
    expect(renderProperty({ key: 'x', kind: 'site' })).toBe('x: {}');
    expect(renderProperty({ key: 'x', kind: 'app', name: 'Shop' })).toBe(`x: { kind: 'app', name: 'Shop' }`);
  });

  it('flips status and removes a property', () => {
    const src = insertProperty(base, { key: 'site' });
    const paused = setPropertyStatus(src, 'site', 'paused');
    expect(paused).toMatch(/site: \{\s*status: 'paused',?\s*\}/);
    expect(setPropertyStatus(paused, 'site', 'running')).toMatch(/site: \{\s*status: 'running',?\s*\}/);
    expect(removeProperty(src, 'site')).not.toContain('site:');
    expect(() => setPropertyStatus(base, 'nope', 'paused')).toThrow(/no analytics property/);
  });
});

const cli = resolve(__dirname, '../../dist/index.js');
const root = resolve(__dirname, '../../.tmp-analytics');
let server: Server;
let url = '';
const seen: string[] = [];

function run(dir: string, args: string[]): Promise<{ code: number; json: Record<string, unknown> }> {
  return new Promise((done) => {
    execFile(process.execPath, [cli, ...args, '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SPLITHUB_API_KEY: 'sk_test', SPLITHUB_URL: '', SPLITHUB_API: url } }, (error, stdout) => {
      const lines = stdout.trim().split('\n');
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
      } catch {
        // not JSON
      }
      done({ code: error ? 1 : 0, json });
    });
  });
}

function scratch(mode: 'self' | 'cloud'): string {
  const dir = join(root, `${mode}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'a', dependencies: { react: '18.3.1', vite: '5.4.0' } }));
  const storage = mode === 'self' ? `{ mode: 'self', endpoint: '/api/splithub' }` : `{ mode: 'cloud', key: 'pk_test' }`;
  writeFileSync(join(dir, 'splithub.config.ts'), base.replace(`{ mode: 'self', endpoint: '/api/splithub' }`, storage));
  return dir;
}

const json = (body: unknown) => JSON.stringify(body);

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    const u = req.url ?? '';
    if (u.startsWith('/api/splithub/properties')) {
      return res.end(json({ properties: [{ property: 'site', status: 'running', name: null, goals: [], days: 30, counts: { pageviews: 5, visitors: 2, sessions: 3, events: [] }, analysis: { available: false, message: 'cloud', url: 'x' } }] }));
    }
    const totals = { visitors: 2, newVisitors: 2, sessions: 3, pageviews: 5, events: 1, bounces: 1, duration: 60000 };
    if (u.startsWith('/properties/site/summary')) {
      const previous = u.includes('compare=previous') ? { previous: { range: { from: '2026-09-01', to: '2026-09-30' }, totals: { ...totals, visitors: 1 }, goals: [] } } : {};
      return res.end(json({ range: { from: '2026-10-01', to: '2026-10-30' }, totals, goals: [], days: [], notes: [{ id: 'n1', day: '2026-10-02', kind: 'win', text: 'Launch' }], ...previous }));
    }
    // Saved funnels (before /funnel, which it starts with).
    if (u === '/properties/site/funnels' && req.method === 'POST') {
      let raw = '';
      req.on('data', (d: Buffer) => (raw += d.toString()));
      return req.on('end', () => {
        const b = JSON.parse(raw) as Record<string, unknown>;
        res.statusCode = 201;
        res.end(json({ funnel: { id: 'fn2', name: b.name, steps: b.steps, within: b.within ?? 'visit', updatedAt: 'x' } }));
      });
    }
    if (u.startsWith('/properties/site/funnels/fn1') && req.method === 'PATCH') return res.end(json({ funnel: { id: 'fn1', name: 'Signup', steps: ['page:/', 'goal:paid'], within: '7d', updatedAt: 'x' } }));
    if (u.startsWith('/properties/site/funnels/fn1') && req.method === 'DELETE') return res.end(json({ ok: true, id: 'fn1' }));
    if (u.startsWith('/properties/site/funnels')) return res.end(json({ property: 'site', funnels: [{ id: 'fn1', name: 'Signup', steps: ['page:/', 'event:Signup'], within: '7d', updatedAt: 'x' }] }));
    if (u.startsWith('/properties/site/funnel')) {
      return res.end(json({ range: { from: '2026-10-01', to: '2026-10-30' }, within: 'visit', steps: [{ step: 'page:/', label: '/', visitors: 10, conversion: 1, dropoff: 0 }, { step: 'event:Signup', label: 'Signup', visitors: 4, conversion: 0.4, dropoff: 0.6 }] }));
    }
    if (u.startsWith('/properties/site/paths')) return res.end(json({ range: { from: '2026-10-01', to: '2026-10-30' }, page: '/pricing', direction: 'next', rows: [{ value: '/signup', visits: 3 }, { value: '(exit)', visits: 1 }] }));
    if (u.startsWith('/properties/site/retention')) return res.end(json({ range: { from: '2026-10-01', to: '2026-10-30' }, start: 'visit', return: 'visit', period: 'week', cohorts: [{ cohort: '2026-10-05', size: 10, returned: [10, 3] }] }));
    if (u.startsWith('/properties/site/realtime')) return res.end(json({ property: 'site', activeVisitors5m: 3, pageviews: [{ minute: 1, n: 4 }], events: [], pages: [{ value: '/', n: 4 }], sources: [] }));
    if (u.startsWith('/properties/site/export.csv')) {
      res.setHeader('content-type', 'text/csv');
      return res.end('value,visitors\r\n/,2\r\n');
    }
    const readBody = (then: (b: Record<string, unknown>) => void) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => then(JSON.parse(body) as Record<string, unknown>));
    };
    if (u === '/segments' && req.method === 'POST') {
      return readBody((b) => {
        res.statusCode = 201;
        res.end(json({ segment: { id: 'seg1', name: b.name, propertyKey: null, filters: b.filters, createdAt: 'x' } }));
      });
    }
    if (u.startsWith('/segments/seg1') && req.method === 'DELETE') return res.end(json({ ok: true, id: 'seg1' }));
    if (u.startsWith('/segments')) return res.end(json({ segments: [{ id: 'seg1', name: 'Germany', propertyKey: null, filters: { country: ['DE'] }, createdAt: 'x' }] }));
    if (u.startsWith('/properties/site/breakdown')) {
      return res.end(json({ range: { from: '2026-10-01', to: '2026-10-30' }, rows: [{ value: '/', visitors: 2, sessions: 3, pageviews: 4, events: 0, bounces: 1, duration: 0, newVisitors: 0, entries: 3, exits: 2, conversions: 0, revenue: 0 }] }));
    }
    if (u.startsWith('/properties/site') && req.method === 'PATCH') {
      return readBody((b) => res.end(json({ property: { key: 'site', status: 'paused', ...(typeof b.archived === 'boolean' ? { archived: b.archived } : {}) } })));
    }
    if (u === '/properties' && req.method === 'POST') {
      return readBody((b) => {
        if (b.key === 'site') {
          res.statusCode = 409;
          return res.end(json({ error: 'property "site" already exists' }));
        }
        res.statusCode = 201;
        res.end(json({ property: { key: b.key, name: b.name, status: b.status, goals: b.goals, origin: 'dashboard' } }));
      });
    }
    if (u === '/properties') {
      return res.end(json({ properties: [{ key: 'site', name: null, status: 'paused', origin: 'config', goals: [], domains: [], archived: true, last30: null }, { key: 'blog', name: null, status: 'running', origin: 'dashboard', goals: [], domains: [], archived: false, last30: null }] }));
    }
    if (u.startsWith('/domains/property/site')) return res.end(json({ kind: 'property', key: 'site', hosts: ['example.com'] }));
    res.statusCode = 404;
    res.end(json({ error: 'not found' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

describe('splithub analytics (built CLI)', () => {
  it('creates, pauses and removes a property in the config file', async () => {
    const dir = scratch('self');
    const created = await run(dir, ['analytics', 'create', 'site', '--goals', 'signup']);
    expect(created.json).toMatchObject({ property: 'site', goals: ['signup'] });
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).toContain(`site: { goals: ['signup'] }`);
    expect((await run(dir, ['analytics', 'create', 'x', '--goals', 'nope'])).json).toMatchObject({ code: 'GOAL_NOT_FOUND' });
    expect((await run(dir, ['analytics', 'pause', 'site'])).json).toMatchObject({ status: 'paused', live: 'skipped' });
    expect((await run(dir, ['analytics', 'remove', 'site'])).json).toMatchObject({ removed: true });
    const generated = await run(dir, ['analytics', 'create', '--name', 'Blog']);
    expect(generated.json.property).toMatch(/^sh-[a-z2-9]{6}$/);
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).not.toContain('site:');
  });

  it('creates a cloud property in the cloud too, so no push is needed', async () => {
    const dir = scratch('cloud');
    seen.length = 0;
    const created = await run(dir, ['analytics', 'create', 'blog', '--name', 'Blog']);
    expect(created.json).toMatchObject({ property: 'blog', live: 'applied', next: expect.not.stringContaining('push') });
    expect(seen).toContain('POST /properties');
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).toContain("blog: { name: 'Blog' }");
    // An id the cloud already has (made in the dashboard) is live as it is.
    expect((await run(dir, ['analytics', 'create', 'site'])).json).toMatchObject({ property: 'site', live: 'applied' });
    const text = await new Promise<string>((done) => execFile(process.execPath, [cli, 'analytics', 'create', 'docs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SPLITHUB_API_KEY: 'sk_test', SPLITHUB_URL: '', SPLITHUB_API: url } }, (_e, stdout) => done(stdout)));
    expect(text).toContain('no push needed');
    // Not signed in: the file has it, the push adds it to the cloud.
    const offline = await new Promise<Record<string, unknown>>((done) => execFile(process.execPath, [cli, 'analytics', 'create', 'shop', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SPLITHUB_API_KEY: '', SPLITHUB_URL: '', SPLITHUB_API: url, XDG_CONFIG_HOME: dir } }, (_e, stdout) => done(JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? '{}') as Record<string, unknown>)));
    expect(offline).toMatchObject({ property: 'shop', live: expect.stringContaining('no API key'), next: expect.stringContaining('npx splithub push') });
  });

  it('reads raw counts from a self-hosted endpoint', async () => {
    const dir = scratch('self');
    const r = await run(dir, ['analytics', '--url', `${url}/api/splithub`]);
    expect(r.json).toMatchObject({ properties: [{ property: 'site', counts: { pageviews: 5 } }] });
  });

  it('reads cloud reports, applies pause live and sets domains', async () => {
    const dir = scratch('cloud');
    const r = await run(dir, ['analytics', 'site', '--days', '7', '--filter', 'country=DE']);
    expect(r.json).toMatchObject({ totals: { pageviews: 5 }, topPages: [{ value: '/' }], notes: [{ text: 'Launch', kind: 'win' }] });
    expect(seen.some((s) => s.includes('/properties/site/summary?from=') && s.includes('country=DE'))).toBe(true);
    const by = await run(dir, ['analytics', 'site', '--by', 'page']);
    expect(by.json).toMatchObject({ rows: [{ value: '/' }] });
    expect((await run(dir, ['analytics', 'site', '--by', 'nope'])).json).toMatchObject({ code: 'INVALID_FLAG' });
    expect((await run(dir, ['analytics', 'pause', 'site'])).json).toMatchObject({ live: 'applied' });
    expect((await run(dir, ['domains', 'set', 'property', 'site', 'example.com'])).json).toEqual({ kind: 'property', key: 'site', hosts: ['example.com'] });
    expect((await run(dir, ['domains', 'set', 'nope', 'site'])).json).toMatchObject({ code: 'USAGE' });
  });

  it('reads funnels, paths, retention, realtime, props and compares periods', async () => {
    const dir = scratch('cloud');
    const f = await run(dir, ['analytics', 'funnel', 'site', '--steps', 'page:/,event:Signup', '--within', '7d', '--days', '7']);
    expect(f.json).toMatchObject({ steps: [{ visitors: 10 }, { visitors: 4, dropoff: 0.6 }] });
    expect(seen.some((s) => s.includes('/properties/site/funnel?from=') && s.includes('steps=page%3A%2F%2Cevent%3ASignup') && s.includes('within=7d'))).toBe(true);
    expect((await run(dir, ['analytics', 'funnel', 'site', '--steps', 'page:/'])).json).toMatchObject({ code: 'USAGE' });
    expect((await run(dir, ['analytics', 'paths', 'site', '--page', '/pricing', '--prev'])).json).toMatchObject({ rows: [{ value: '/signup' }, { value: '(exit)' }] });
    expect(seen.some((s) => s.includes('/properties/site/paths?') && s.includes('page=%2Fpricing') && s.includes('direction=prev'))).toBe(true);
    expect((await run(dir, ['analytics', 'paths', 'site'])).json).toMatchObject({ code: 'USAGE' });
    expect((await run(dir, ['analytics', 'retention', 'site', '--start', 'event:Signup', '--period', 'day'])).json).toMatchObject({ cohorts: [{ size: 10 }] });
    expect(seen.some((s) => s.includes('/properties/site/retention?') && s.includes('start=event%3ASignup') && s.includes('period=day') && s.includes('return=visit'))).toBe(true);
    await run(dir, ['analytics', 'retention', 'site', '--from', '2026-09-01', '--to', '2026-09-30', '--filter', 'platform=ios']);
    expect(seen.some((s) => s.includes('/properties/site/retention?') && s.includes('from=2026-09-01') && s.includes('to=2026-09-30') && s.includes('platform=ios') && s.includes('period=week'))).toBe(true);
    expect((await run(dir, ['analytics', 'retention', 'site', '--period', 'month'])).json).toMatchObject({ code: 'INVALID_FLAG' });
    expect((await run(dir, ['analytics', 'realtime', 'site'])).json).toMatchObject({ activeVisitors5m: 3 });
    await run(dir, ['analytics', 'props', 'site', '--event', 'Signup', '--key', 'plan']);
    expect(seen.some((s) => s.includes('/properties/site/breakdown?') && s.includes('by=prop') && s.includes('name=Signup') && s.includes('key=plan'))).toBe(true);
    expect((await run(dir, ['analytics', 'props', 'site'])).json).toMatchObject({ code: 'USAGE' });
    const compared = await run(dir, ['analytics', 'site', '--compare']);
    expect(compared.json).toMatchObject({ previous: { totals: { visitors: 1 } } });
    await run(dir, ['analytics', 'site', '--by', 'channel', '--compare']);
    expect(seen.some((s) => s.includes('/properties/site/breakdown?') && s.includes('by=channel') && s.includes('compare=previous'))).toBe(true);
    await run(dir, ['analytics', 'site', '--compare', 'year']);
    expect(seen.some((s) => s.includes('/properties/site/summary?') && s.includes('compare=year'))).toBe(true);
    await run(dir, ['analytics', 'site', '--by', 'page', '--compare', '2026-08-01..2026-08-31']);
    expect(seen.some((s) => s.includes('/properties/site/breakdown?') && s.includes('by=page') && s.includes('compare=custom') && s.includes('cfrom=2026-08-01') && s.includes('cto=2026-08-31'))).toBe(true);
    // A bare --compare before the id still means the period right before.
    seen.length = 0;
    await run(dir, ['analytics', '--compare', 'site']);
    expect(seen.some((s) => s.includes('/properties/site/summary?') && s.includes('compare=previous'))).toBe(true);
    expect((await run(dir, ['analytics', 'site', '--compare', '2026-09-30..2026-09-01'])).json).toMatchObject({ code: 'INVALID_FLAG' });
  });

  it('lists, saves, runs and deletes saved funnels', async () => {
    const dir = scratch('cloud');
    expect((await run(dir, ['analytics', 'funnels', 'site'])).json).toMatchObject({ funnels: [{ id: 'fn1', name: 'Signup' }] });
    // A new name creates; a saved name (any case) updates.
    expect((await run(dir, ['analytics', 'funnels', 'site', '--save', 'Checkout', '--steps', 'page:/cart,goal:paid'])).json).toMatchObject({ funnel: { id: 'fn2', steps: ['page:/cart', 'goal:paid'] } });
    expect((await run(dir, ['analytics', 'funnels', 'site', '--save', 'signup', '--steps', 'page:/,goal:paid'])).json).toMatchObject({ funnel: { id: 'fn1' } });
    expect((await run(dir, ['analytics', 'funnels', 'site', '--save', 'Nope'])).json).toMatchObject({ code: 'USAGE' });
    seen.length = 0;
    await run(dir, ['analytics', 'funnel', 'site', '--funnel', 'Signup']);
    expect(seen.some((s) => s.includes('/properties/site/funnel?') && s.includes('funnel=fn1') && !s.includes('steps=') && !s.includes('within='))).toBe(true);
    expect((await run(dir, ['analytics', 'funnel', 'site', '--funnel', 'Missing'])).json).toMatchObject({ code: 'INVALID_FLAG' });
    expect((await run(dir, ['analytics', 'funnels', 'site', '--delete', 'Signup'])).json).toMatchObject({ ok: true, id: 'fn1' });
  });

  it('exports CSV to stdout and applies saved segments', async () => {
    const dir = scratch('cloud');
    const csv = await new Promise<string>((done) => execFile(process.execPath, [cli, 'analytics', 'export', 'site', '--by', 'page'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SPLITHUB_API_KEY: 'sk_test', SPLITHUB_URL: '', SPLITHUB_API: url } }, (_e, stdout) => done(stdout)));
    expect(csv).toBe('value,visitors\n/,2\n');
    expect(seen.some((s) => s.includes('/properties/site/export.csv?') && s.includes('by=page'))).toBe(true);
    await run(dir, ['analytics', 'site', '--by', 'page', '--segment', 'germany', '--filter', 'device=mobile']);
    expect(seen.some((s) => s.includes('/properties/site/breakdown?') && s.includes('country=DE') && s.includes('device=mobile'))).toBe(true);
    expect((await run(dir, ['analytics', 'site', '--segment', 'nope'])).json).toMatchObject({ code: 'INVALID_FLAG' });
    expect((await run(dir, ['analytics', 'segments'])).json).toMatchObject({ segments: [{ name: 'Germany' }] });
    expect((await run(dir, ['analytics', 'segments', '--save', 'Paid', 'channel=Paid Search,Paid Social'])).json).toMatchObject({ segment: { name: 'Paid', filters: { channel: ['Paid Search', 'Paid Social'] } } });
    expect((await run(dir, ['analytics', 'segments', '--delete', 'Germany'])).json).toMatchObject({ ok: true, id: 'seg1' });
  });

  it('archives and restores a property in the cloud, and lists it as archived', async () => {
    const dir = scratch('cloud');
    seen.length = 0;
    expect((await run(dir, ['analytics', 'archive', 'site'])).json).toMatchObject({ property: 'site', status: 'archived', archived: true, live: 'applied' });
    expect((await run(dir, ['analytics', 'restore', 'site'])).json).toMatchObject({ property: 'site', status: 'paused', archived: false, next: expect.stringContaining('analytics resume site') });
    expect(seen.filter((s) => s === 'PATCH /properties/site')).toHaveLength(2);
    // The config file is left as it is, as in the dashboard.
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).not.toContain('archived');
    const text = await new Promise<string>((done) => execFile(process.execPath, [cli, 'analytics'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SPLITHUB_API_KEY: 'sk_test', SPLITHUB_URL: '', SPLITHUB_API: url } }, (_e, stdout) => done(stdout)));
    expect(text).toMatch(/site\s+archived/);
    expect(text).toMatch(/blog\s+running/);
    // Archiving is a SplitHub Cloud state: a self-hosted project pauses instead.
    expect((await run(scratch('self'), ['analytics', 'archive', 'site'])).json).toMatchObject({ code: 'NOT_CLOUD' });
  });

  it('reads self-hosted raw counts for a from / to range and refuses cloud-only flags', async () => {
    const dir = scratch('self');
    seen.length = 0;
    await run(dir, ['analytics', 'site', '--url', `${url}/api/splithub`, '--from', '2026-10-01', '--to', '2026-10-07']);
    expect(seen).toContain('GET /api/splithub/properties/site?from=2026-10-01&to=2026-10-07');
    await run(dir, ['analytics', 'site', '--url', `${url}/api/splithub`, '--days', '7']);
    expect(seen).toContain('GET /api/splithub/properties/site?days=7');
    expect((await run(dir, ['analytics', 'site', '--url', `${url}/api/splithub`, '--from', 'monday'])).json).toMatchObject({ code: 'INVALID_FLAG' });
    const filtered = await run(dir, ['analytics', 'site', '--url', `${url}/api/splithub`, '--filter', 'country=DE', '--by', 'page']);
    expect(filtered.json).toMatchObject({ code: 'NOT_CLOUD', error: expect.stringContaining('--filter, --by come with SplitHub Cloud') });
    expect(seen.filter((s) => s.includes('country=DE'))).toEqual([]);
  });

  it('says the cloud reports come with SplitHub Cloud on a self-hosted project', async () => {
    const dir = scratch('self');
    expect((await run(dir, ['analytics', 'funnel', 'site', '--steps', 'page:/,page:/b'])).json).toMatchObject({ code: 'NOT_CLOUD' });
    expect((await run(dir, ['notes', 'add', 'Launch'])).json).toMatchObject({ code: 'NOT_CLOUD' });
    expect((await run(dir, ['notes'])).json).toMatchObject({ code: 'NOT_CLOUD' });
    expect((await run(dir, ['links'])).json).toMatchObject({ code: 'NOT_CLOUD' });
    expect((await run(dir, ['alerts', 'add', 'usage', '--every', '1000'])).json).toMatchObject({ code: 'NOT_CLOUD' });
  });
});
