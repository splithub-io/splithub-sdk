// Experiment slices, breakdowns, timelines, engagement, CSV and raw events, against a mocked fetch.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const root = resolve(__dirname, '../../.tmp/experiment-reports');
let dir = join(root, 'cloud');

vi.mock('../project', async (original) => {
  const real = await original<typeof import('../project')>();
  return { ...real, detectProject: () => real.detectProject(dir) };
});

const { results } = await import('../commands/results');
const { breakdownTable, describeScope, experimentEvents, timelineTable, visitLength } = await import('../commands/experiment-reports');
const { experimentOptions, parseFilterInput, MENU_BREAKDOWNS } = await import('../commands/menu');
const { EXPERIMENT_BY } = await import('../commands/experiment-reports');

const API = 'https://api.test/v1';
const calls: string[] = [];
let out: string[] = [];
let answer: (url: string) => { status?: number; body: unknown; text?: string } = () => ({ body: {} });

function project(name: string, mode: 'cloud' | 'self'): string {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'a', dependencies: { react: '18.3.1', vite: '5.4.0' } }));
  const storage = mode === 'cloud' ? `{ mode: 'cloud', key: 'pk_test' }` : `{ mode: 'self', endpoint: '/api/splithub' }`;
  writeFileSync(join(d, 'splithub.config.ts'), `export default { project: 'demo', storage: ${storage}, goals: {}, experiments: {} };\n`);
  return d;
}

const verdict = {
  status: 'insufficient_sample',
  message: 'Too early.',
  winner: null,
  comparisons: [{ variant: 'b', relativeLift: 0.1, probabilityToBeat: 0.7, pValue: 0.3, ci: { low: -0.1, high: 0.3 } }],
  sample: { variants: [{ variant: 'control', exposures: 40, conversions: 4 }, { variant: 'b', exposures: 42, conversions: 5 }] },
};
const scope = { filtered: true, range: { from: '2026-10-01', to: '2026-10-07' }, filters: { country: ['DE'] }, note: 'A slice of the experiment: the verdict for the whole experiment is on the unfiltered results.' };

beforeAll(() => {
  project('cloud', 'cloud');
  project('self', 'self');
  process.env.SPLITHUB_API = API;
  process.env.SPLITHUB_API_KEY = 'sk_test';
  delete process.env.SPLITHUB_URL;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  dir = join(root, 'cloud');
  calls.length = 0;
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => (out.push(String(s)), true));
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url.replace(API, ''));
    const a = answer(url.replace(API, ''));
    const status = a.status ?? 200;
    return { ok: status < 400, status, json: async () => a.body, text: async () => a.text ?? JSON.stringify(a.body) } as Response;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const lastJson = () => JSON.parse(out[out.length - 1]!) as Record<string, unknown>;
const text = () => out.join('\n');

describe('splithub results: a slice', () => {
  it('sends the range and filters, and prints the slice banner', async () => {
    answer = () => ({ body: { experiment: 'hero', kind: 'value', status: 'running', goal: 'signup', description: null, verdict, scope } });
    await results('hero', { from: '2026-10-01', to: ['2026-10-07'], filter: ['country=DE', 'channel=Paid Search'] });
    expect(calls).toEqual(['/results/hero?from=2026-10-01&to=2026-10-07&country=DE&channel=Paid+Search']);
    expect(text()).toContain('Filtered slice: first seen 2026-10-01 → 2026-10-07 · country=DE');
    expect(text()).toContain('verdict for the whole experiment is on the unfiltered results');
  });

  it('keeps the plain call unchanged and passes scope through --json', async () => {
    answer = () => ({ body: { experiment: 'hero', kind: 'value', status: 'running', goal: 'signup', description: null, verdict } });
    await results('hero', { json: true });
    expect(calls).toEqual(['/results/hero']);
    expect(text()).not.toContain('Filtered slice');
    answer = () => ({ body: { experiment: 'hero', kind: 'value', status: 'running', goal: 'signup', description: null, verdict, scope } });
    await results('hero', { json: true, filter: ['device=mobile'] });
    expect(lastJson()).toMatchObject({ experiment: 'hero', scope: { filtered: true } });
  });

  it('prints no friendly line for a slice, even from a server that still sends one', async () => {
    const voice = { scenario: 'clear_winner', advice: 'ship', line: 'bold takes it. Time to ship.' };
    const display = { label: 'WINNER', lines: [voice.line, 'Data ★★★☆☆ 3/5'] };
    answer = () => ({ body: { experiment: 'hero', kind: 'value', status: 'running', goal: 'signup', description: null, verdict, display, voice, scope } });
    await results('hero', { filter: ['country=DE'] });
    expect(text()).not.toContain('Time to ship');
    expect(text()).toContain('Data ★★★☆☆ 3/5');
    await results('hero', { json: true, filter: ['country=DE'] });
    expect(lastJson().voice).toBeUndefined();
    out.length = 0;
    answer = () => ({ body: { experiment: 'hero', kind: 'value', status: 'running', goal: 'signup', description: null, verdict, display, voice } });
    await results('hero', {});
    expect(text()).toContain('bold takes it. Time to ship.');
  });

  it('refuses unknown filters, bad days and two views at once', async () => {
    await expect(results('hero', { filter: ['plan=pro'] })).rejects.toMatchObject({ code: 'INVALID_FLAG' });
    await expect(results('hero', { from: 'yesterday' })).rejects.toMatchObject({ code: 'INVALID_FLAG' });
    await expect(results('hero', { by: 'country', timeline: true })).rejects.toMatchObject({ code: 'USAGE' });
    await expect(results('hero', { by: 'planet' })).rejects.toMatchObject({ code: 'INVALID_FLAG' });
    await expect(results('hero', { export: true })).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toEqual([]);
  });

  it('says slices come with SplitHub Cloud on a self-hosted project, and keeps raw results there', async () => {
    dir = join(root, 'self');
    await expect(results('hero', { from: '2026-10-01' })).rejects.toMatchObject({ code: 'NOT_CLOUD', hint: 'Read the raw counts with npx splithub results <id>.' });
    await expect(results('hero', { by: 'country' })).rejects.toMatchObject({ code: 'NOT_CLOUD' });
    await expect(experimentEvents('hero', {})).rejects.toMatchObject({ code: 'NOT_CLOUD' });
    expect(calls).toEqual([]);
  });
});

const breakdownBody = {
  experiment: 'hero',
  by: 'country',
  goal: 'signup',
  rows: [],
  order: ['control', 'b'],
  segments: [
    { dim: 'DE', cells: [{ variant: 'control', exposures: 500, conversions: 50 }, { variant: 'b', exposures: 510, conversions: 80 }], comparisons: [{ variant: 'b', lift: 0.569, liftCi: null, pValue: 0.01, significant: true, better: true }], total: 1010, small: false },
    { dim: '(none)', cells: [{ variant: 'control', exposures: 20, conversions: 1 }, null], comparisons: [{ variant: 'b', lift: null, liftCi: null, pValue: 1, significant: false, better: true }], total: 20, small: true },
  ],
};

describe('splithub results: views', () => {
  it('prints a breakdown with lift per segment', async () => {
    answer = () => ({ body: breakdownBody });
    await results('hero', { by: 'country', filter: ['device=mobile'] });
    expect(calls).toEqual(['/experiments/hero/breakdown/country?device=mobile']);
    expect(text()).toContain('LIFT b');
    expect(text()).toMatch(/DE\s+1,010\s+10\.0% of 500\s+15\.7% of 510\s+\+56\.9% ✔/);
    await results('hero', { by: 'country', json: true });
    expect(lastJson()).toMatchObject({ experiment: 'hero', view: 'breakdown', segments: [{ dim: 'DE' }, { dim: '(none)' }] });
  });

  it('takes page as the analytics word for a page, and titles url as PAGE', async () => {
    answer = () => ({ body: { ...breakdownBody, by: 'url' } });
    await results('hero', { by: 'page', filter: ['page=/pricing'] });
    expect(calls).toEqual(['/experiments/hero/breakdown/page?page=%2Fpricing']);
    expect(text()).toContain('by page');
    expect(text()).toMatch(/PAGE\s+VISITORS/);
  });

  it('prints a timeline per day and variant', async () => {
    answer = () => ({ body: { experiment: 'hero', goal: 'signup', mode: 'cohort', exposures: [{ day: '2026-10-02', variant: 'control', n: 10 }, { day: '2026-10-01', variant: 'control', n: 20 }, { day: '2026-10-01', variant: 'b', n: 18 }], conversions: [{ day: '2026-10-01', variant: 'b', n: 3 }], notes: [{ day: '2026-10-01', kind: 'win', text: 'Launch' }] } });
    await results('hero', { timeline: true, days: '7' });
    expect(calls[0]).toMatch(/^\/experiments\/hero\/timeline\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
    const lines = text().split('\n');
    const first = lines.findIndex((l) => l.startsWith('2026-10-01'));
    expect(lines[first]).toMatch(/2026-10-01\s+20\s+0\s+0\.0%\s+18\s+3\s+16\.7%/);
    expect(lines[first + 1]).toMatch(/^2026-10-02/);
    expect(text()).toContain('Launch');
  });

  it('prints engagement per variant, or says there is no analytics yet', async () => {
    answer = () => ({ body: { property: 'sh-site', variants: [{ variant: 'control', visitors: 100, sessions: 120, pageviews: 300, bounces: 60, duration: 7_200_000, pagesPerVisit: 2.5, bounceRate: 0.5, avgVisit: 65_000 }, { variant: 'b', visitors: 90, sessions: 100, pageviews: 310, bounces: 30, duration: 6_000_000, pagesPerVisit: 3.1, bounceRate: 0.3, avgVisit: 42_000 }] } });
    await results('hero', { engagement: true });
    expect(calls).toEqual(['/experiments/hero/engagement']);
    expect(text()).toMatch(/b\s+90\s+100\s+3\.10\s+30\.0%\s+42s/);
    expect(text()).toContain('1m 05s');
    out = [];
    answer = () => ({ body: { property: null, variants: [] } });
    await results('hero', { engagement: true });
    expect(text()).toContain('No analytics on these visitors yet');
  });

  it('prints every goal and event per variant with lift, and its CSV', async () => {
    const cell = (visitors: number, total: number) => ({ visitors, count: visitors * 2, rate: visitors / total, revenue: 0 });
    answer = () => ({
      body: {
        experiment: 'hero',
        goal: 'signup',
        property: 'sh-site',
        variants: ['control', 'b'],
        visitors: { control: 1000, b: 1000 },
        rows: [
          { name: 'signup', goalKey: 'signup', isGoal: true, measured: 'goal', perVariant: { control: cell(50, 1000), b: cell(80, 1000) }, comparisons: [{ variant: 'b', lift: 0.6, pValue: 0.01, significant: true, better: true }], small: false },
          { name: 'Video Played', goalKey: null, isGoal: false, measured: null, perVariant: { control: cell(40, 1000), b: cell(38, 1000) }, comparisons: [{ variant: 'b', lift: -0.05, pValue: 0.8, significant: false, better: false }], small: false },
        ],
      },
    });
    await results('hero', { events: true, filter: 'country=DE' });
    expect(calls).toEqual(['/experiments/hero/events-summary?country=DE']);
    expect(text()).toMatch(/signup\s+goal\s+50 · 5\.0%\s+80 · 8\.0%\s+\+60\.0% ✔/);
    expect(text()).toMatch(/Video Played\s+40 · 4\.0%\s+38 · 3\.8%\s+-5\.0%/);
    out = [];
    await results('hero', { events: true, json: true });
    expect(lastJson()).toMatchObject({ view: 'events', property: 'sh-site' });
    out = [];
    calls.length = 0;
    answer = () => ({ body: {}, text: 'event,goal\r\nsignup,signup\r\n' });
    await results('hero', { events: true, export: true });
    expect(calls).toEqual(['/experiments/hero/export.events-summary.csv']);
    expect(out.join('')).toBe('event,goal\nsignup,signup\n');
    await expect(results('hero', { events: true, timeline: true })).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('writes the breakdown CSV to stdout', async () => {
    answer = () => ({ body: {}, text: 'segment,variant,visitors\r\nDE,control,500\r\n' });
    await results('hero', { export: true, by: 'channel', from: '2026-10-01' });
    expect(calls).toEqual(['/experiments/hero/export.breakdown.csv?from=2026-10-01&by=channel']);
    expect(out.join('')).toBe('segment,variant,visitors\nDE,control,500\n');
  });

  it('turns a missing experiment into EXPERIMENT_NOT_FOUND', async () => {
    answer = () => ({ status: 404, body: { error: 'unknown experiment "nope"' } });
    await expect(results('nope', { timeline: true })).rejects.toMatchObject({ code: 'EXPERIMENT_NOT_FOUND' });
  });
});

describe('splithub events --experiment', () => {
  it('lists raw events with filters and paging', async () => {
    answer = () => ({ body: { events: [{ id: '1', type: 'exposure', experiment: 'hero', variant: 'b', goal: null, visitorId: 'v_abcdef1234567', ts: Date.UTC(2026, 9, 1, 12), url: '/', country: 'DE' }, { id: '2', type: 'goal', experiment: null, variant: null, goal: 'signup', visitorId: 'v_x', ts: Date.UTC(2026, 9, 1, 13), url: null, country: null }], nextBefore: 123 } });
    await experimentEvents('hero', { type: 'goal', limit: '10', filter: ['country=DE'] });
    expect(calls).toEqual(['/experiments/hero/events?country=DE&limit=10&type=goal']);
    expect(text()).toMatch(/2026-10-01 12:00:00\s+exposure\s+b\s+v_abcdef1234/);
    expect(text()).toContain('--before 123');
    await expect(experimentEvents(undefined, {})).rejects.toMatchObject({ code: 'USAGE' });
    await expect(experimentEvents('hero', { type: 'page' })).rejects.toMatchObject({ code: 'INVALID_FLAG' });
  });
});

describe('helpers', () => {
  it('describes a slice and formats tables', () => {
    expect(describeScope(undefined)).toBeNull();
    expect(describeScope({ filtered: false, range: null, filters: {} })).toBeNull();
    expect(describeScope({ filtered: true, range: null, filters: { country: ['DE', 'FR'], device: 'mobile' } })).toBe('country=DE,FR · device=mobile');
    expect(visitLength(0)).toBe('0s');
    expect(visitLength(125_000)).toBe('2m 05s');
    expect(breakdownTable({ experiment: 'x', by: 'device', goal: null, order: ['a', 'b'], segments: [] })).toContain('LIFT b');
    expect(timelineTable({ experiment: 'x', goal: null, exposures: [], conversions: [] })).toContain('DAY');
  });

  it('offers the menu views only in cloud mode and reads typed filters', () => {
    expect(experimentOptions().map((o) => o.value)).toEqual(['create', 'status', 'results', 'filtered', 'breakdown', 'timeline', 'events', 'start', 'pause', 'finish', 'back']);
    expect(experimentOptions('self').map((o) => o.value)).toEqual(['create', 'status', 'results', 'start', 'pause', 'finish', 'back']);
    for (const b of MENU_BREAKDOWNS) expect(EXPERIMENT_BY).toContain(b);
    expect(parseFilterInput('  ')).toEqual({ filters: [] });
    expect(parseFilterInput('country=DE,FR channel=Paid Search')).toEqual({ filters: ['country=DE,FR', 'channel=Paid Search'] });
    expect(parseFilterInput('plan=pro')).toMatchObject({ error: expect.stringContaining('"plan"') });
    expect(parseFilterInput('country=')).toMatchObject({ error: expect.stringContaining('name=value') });
  });
});
