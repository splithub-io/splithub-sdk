// The built CLI end to end in scratch projects: --json shapes (one line), error codes,
// lifecycle, create flags, refs, ship and results/status against a fake results server.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cli = resolve(__dirname, '../../dist/index.js');
const root = resolve(__dirname, '../../.tmp-e2e');

interface Run {
  code: number;
  stdout: string;
  json: Record<string, unknown>;
}

// SplitHub Cloud is never the real one here: a closed port unless a test passes --api.
function run(dir: string, args: string[], json = true): Promise<Run> {
  return new Promise((done) => {
    execFile(process.execPath, [cli, ...args, ...(json ? ['--json'] : [])], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', SPLITHUB_API_KEY: '', SPLITHUB_URL: '', SPLITHUB_API: 'http://127.0.0.1:9' } }, (error, stdout) => {
      const lines = stdout.trim().split('\n');
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
      } catch {
        // human output
      }
      done({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, json: parsed });
    });
  });
}

function scratch(name: string): string {
  const dir = join(root, `${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dependencies: { react: '18.3.1', vite: '5.4.0' } }));
  writeFileSync(
    join(dir, 'splithub.config.ts'),
    `import { defineConfig } from '@splithub/core';

export default defineConfig({
  project: '${name}',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' }, refunds: { type: 'event' }, pricing: { type: 'event' } },
  experiments: {
    // a { brace in a comment
    hero: {
      kind: 'value',
      status: 'running',
      variants: { control: { weight: 1, value: 'Old } text' }, bold: { weight: 1, value: 'New text' } },
      goal: 'signup',
    },
  },
});
`
  );
  return dir;
}

let server: Server;
const overrides: string[] = [];
let archiveRoute = true;
let url = '';
const RESULTS = {
  experiment: 'hero',
  kind: 'value',
  status: 'running',
  goal: 'signup',
  description: null,
  daysToVerdict: 6,
  visitorsPerDay: 120,
  voice: { scenario: 'early_leader', advice: 'wait', line: 'bold is ahead at +10.0%, too early to be sure.' },
  display: {
    label: 'TOO EARLY',
    lines: ['bold is ahead at +10.0%, too early to be sure.', 'About 6 more days to a verdict at this traffic.', 'Data ★☆☆☆☆ 1/5', '  ✗ Running for a full week', '· Split check skipped for this experiment.'],
  },
  verdict: {
    status: 'insufficient_sample',
    message: 'Too early to call.',
    winner: null,
    notes: ['Split check skipped for this experiment.'],
    srm: null,
    comparisons: [{ variant: 'bold', baseline: 'control', relativeLift: 0.1, probabilityToBeat: 0.8, pValue: 0.01, ci: { low: -0.01, high: 0.03 }, sequential: { pValue: 0.2, ci: { low: -0.02, high: 0.04 } } }],
    sample: { variants: [{ variant: 'control', exposures: 100, conversions: 10 }, { variant: 'bold', exposures: 100, conversions: 11 }], totalExposures: 200, neededPerVariant: 900, quality: 'ok', goodSample: 5000, minExposuresPerVariant: 100, minTotalConversions: 50, stars: 1, checks: [{ key: 'minimum', met: true, label: 'At least 100 visitors per variant and 50 conversions' }, { key: 'week', met: false, label: 'Running for a full week' }] },
  },
};
const GUARD = {
  ...RESULTS,
  experiment: 'guard',
  display: { label: "DON'T SHIP", lines: [] },
  verdict: {
    ...RESULTS.verdict,
    status: 'guardrail_breached',
    message: '"bold" wins (+10.0%) but hurts refunds (+40.0%, always-valid p=0.0010). Don\'t ship it yet; find out what broke first.',
    guardrailBreached: [{ metric: 'refunds', variant: 'bold', lift: 0.4, pValue: 0.001 }],
    metrics: [{ metric: 'refunds', role: 'guardrail', worse: 'higher', variants: [{ variant: 'control', exposures: 100, conversions: 5 }, { variant: 'bold', exposures: 100, conversions: 7 }], comparisons: [{ variant: 'bold', baseline: 'control', relativeLift: 0.4, probabilityToBeat: 0.9, pValue: 0.001, ci: { low: 0, high: 0.1 }, sequential: { pValue: 0.001, ci: { low: 0, high: 0.1 } }, harmPValue: 0.001 }] }],
  },
};
// An older server: no display, the factual message only.
const OLD = { ...RESULTS, experiment: 'old', display: undefined, voice: undefined };
const ANALYSIS = { available: false, message: 'Verdicts, stars and recommendations come with SplitHub Cloud.', url: 'https://splithub.io/cloud' };
const RAW = { experiment: 'hero', kind: 'value', status: 'finished', goal: 'signup', description: null, variants: [{ variant: 'control', visitors: 100, conversions: 10, rate: 0.1 }, { variant: 'bold', visitors: 100, conversions: 12, rate: 0.12 }], days: 2, analysis: ANALYSIS };
const RAW_STATUS = { project: 'mine', experiments: [{ experiment: 'hero', kind: 'value', status: 'finished', goal: 'signup', description: null, exposures: 200, visitors: 200, days: 2 }], analysis: ANALYSIS };
const REPORT = { project: 'demo', markdown: '### SplitHub · demo\n\nfrom the server' };
const SKILLS = { version: 'abc', files: [{ path: '.claude/skills/splithub/SKILL.md', body: '---\nname: splithub\n---\nfrom the server\n' }, { path: '../evil.md', body: 'nope' }, { path: 'AGENTS.md', body: '\n## A/B testing (SplitHub)\nserver section\n' }] };
const STATUS = { project: 'demo', experiments: [{ experiment: 'hero', kind: 'value', status: 'running', goal: 'signup', description: null, exposures: 200, visitors: 200, days: 2, verdict: 'insufficient_sample', headline: '#2 +10% (too early)', best: null, sample: 'ok', stars: 1, daysToVerdict: 6, display: { label: 'TOO EARLY', lines: ['#2 +10% (too early)'] } }, { experiment: '__holdout', kind: 'value', status: 'running', goal: 'signup', description: null, exposures: 10, visitors: 10, days: 2, verdict: 'insufficient_sample', headline: 'too early', best: null }] };

const pushes: Array<{ replace?: string[]; same?: string[] }> = [];

beforeAll(async () => {
  if (!existsSync(cli)) execFileSync(process.execPath, [resolve(__dirname, '../../../../node_modules/tsup/dist/cli-default.js')], { cwd: resolve(__dirname, '../..'), stdio: 'ignore' });
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/status') res.end(JSON.stringify(STATUS));
    else if (req.url === '/self/status') res.end(JSON.stringify(RAW_STATUS));
    else if (req.url === '/self/results/hero') res.end(JSON.stringify(RAW));
    else if (req.url === '/report') res.end(JSON.stringify(REPORT));
    else if (req.url === '/skills') res.end(JSON.stringify(SKILLS));
    else if (req.url?.startsWith('/plan?')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const variants = Number(q.get('variants'));
      res.end(JSON.stringify({ baseline: Number(q.get('baseline')), mde: Number(q.get('mde')), variants, confidence: 0.95, perVariant: 8000, total: 8000 * variants }));
    } else if (req.url === '/results/old') res.end(JSON.stringify(OLD));
    else if (req.url === '/results/hero') res.end(JSON.stringify(RESULTS));
    else if (req.url === '/results/guard') res.end(JSON.stringify(GUARD));
    else if (archiveRoute && req.method === 'PUT' && req.url === '/archive/hero') res.end(JSON.stringify({ ok: true, archived: true }));
    else if (req.method === 'PUT' && req.url === '/overrides/hero') {
      overrides.push('hero');
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === 'PUT' && req.url === '/config') {
      // The cloud's key check: "hero" already belongs to another test until the push says replace or same.
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as { replace?: string[]; same?: string[] };
        pushes.push(body);
        if (body.replace?.includes('hero') || body.same?.includes('hero')) res.end(JSON.stringify({ ok: true, project: 'p', version: 2, pushedAt: 'now', publicKey: 'pk_test', experiments: 1 }));
        else {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: 'hero: this key already belongs to another test', code: 'key_conflict', conflicts: [{ key: 'hero', reason: 'old_data', exposures: 1200 }] }));
        }
      });
    } else if (req.url === '/scope') {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "This API key can't change this project.", code: 'insufficient_scope', needed: 'write' }));
    }
    else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'unknown experiment' }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(() => {
  server?.close();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Windows may still hold a handle; the folder is ignored scratch.
  }
});

describe('--json errors', () => {
  it('prints one line { error, code, hint } and exits 1', async () => {
    const empty = join(root, `empty-${Date.now().toString(36)}`);
    mkdirSync(empty, { recursive: true });
    const r = await run(empty, ['start', 'hero']);
    expect(r.code).toBe(1);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect(r.json).toMatchObject({ code: 'NO_CONFIG', error: expect.any(String) as unknown, hint: expect.stringContaining('init') as unknown });
    expect((await run(empty, ['nope'])).json.code).toBe('USAGE');
  });

  it('uses stable codes for common mistakes', async () => {
    const dir = scratch('codes');
    expect((await run(dir, ['pause', 'missing'])).json.code).toBe('EXPERIMENT_NOT_FOUND');
    expect((await run(dir, ['create', '--kind', 'value', '--id', 'hero', '--yes'])).json.code).toBe('EXPERIMENT_EXISTS');
    expect((await run(dir, ['push'])).json.code).toBe('NOT_CLOUD');
    expect((await run(dir, ['results', 'hero', '--url', 'http://127.0.0.1:9'])).json.code).toBe('UNREACHABLE');
    expect((await run(dir, ['results', 'other', '--url', url])).json.code).toBe('EXPERIMENT_NOT_FOUND');
    expect((await run(dir, ['ship', 'hero', '--keep', 'nope'])).json.code).toBe('VARIANT_NOT_FOUND');
  }, 60_000);
});

describe('create flags', () => {
  it('validates traffic, max visitors, dates and weights', async () => {
    const dir = scratch('flags');
    const base = ['create', '--kind', 'component', '--id', 'x', '--variants', 'control,b', '--yes'];
    for (const bad of [['--traffic', '0'], ['--traffic', '150'], ['--max-visitors', '1.5'], ['--min-days', '31'], ['--min-days', '2.5'], ['--good-sample', '99'], ['--good-sample', '10000001'], ['--good-sample', '1e3x'], ['--start', 'soon'], ['--start', '2026-12-01', '--end', '2026-11-01'], ['--weights', '50'], ['--weights', '0,0'], ['--weights', 'a,b']]) {
      const r = await run(dir, [...base, ...bad]);
      expect(r.json.code, bad.join(' ')).toBe('INVALID_FLAG');
    }
    expect((await run(dir, ['create', '--kind', 'mvt', '--id', 'm', '--factor', 'h=a:A,b:B', '--variants', 'x,y', '--yes'])).json.code).toBe('INVALID_FLAG');
    const ok = await run(dir, [...base, '--weights', '90,10', '--traffic', '50', '--max-visitors', '5000', '--min-days', '7', '--good-sample', '2000', '--start', '2026-11-01', '--end', '2026-12-01']);
    expect(ok.code).toBe(0);
    expect(ok.stdout.trim().split('\n')).toHaveLength(1);
    expect(ok.json).toMatchObject({ experiment: 'x', traffic: 0.5, maxVisitors: 5000, minDays: 7, goodSample: 2000, schedule: { startAt: '2026-11-01T00:00:00.000Z', endAt: '2026-12-01T00:00:00.000Z' } });
    const src = readFileSync(join(dir, 'splithub.config.ts'), 'utf8');
    expect(src).toContain('variants: { control: 90, b: 10 }');
    expect(src).toContain('traffic: 0.5,');
    expect(src).toContain('maxExposures: 5000,');
    expect(src).toContain('minDays: 7,');
    expect(src).toContain('goodSample: 2000,');
  }, 60_000);
});

describe('lifecycle', () => {
  it('validates first, writes the status, and reads it back', async () => {
    const dir = scratch('life');
    const r = await run(dir, ['pause', 'hero']);
    expect(r.json).toMatchObject({ experiment: 'hero', status: 'paused', previous: 'running', live: 'skipped' });
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).toContain("status: 'paused'");
    const fin = await run(dir, ['finish', 'hero']);
    expect(fin.json.next).toMatch(/splithub ship hero --keep/);

    // A config that doesn't load is reported, never edited.
    const file = join(dir, 'splithub.config.ts');
    const broken = readFileSync(file, 'utf8').replace("project: 'life", "project: life'");
    writeFileSync(file, broken);
    expect((await run(dir, ['start', 'hero'])).json.code).toBe('CONFIG_PARSE');
    expect(readFileSync(file, 'utf8')).toBe(broken);
  }, 60_000);
});

describe('results and status --json', () => {
  it('passes the server shape through on one line, daysToVerdict included', async () => {
    const dir = scratch('res');
    const r = await run(dir, ['results', 'hero', '--url', url]);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    // The server's shape passes through untouched, voice included.
    expect(r.json).toEqual({ ...RESULTS });
    const s = await run(dir, ['status', '--url', url]);
    expect(s.stdout.trim().split('\n')).toHaveLength(1);
    expect(s.json).toEqual(STATUS);
  });

  it('prints the server label, friendly line and lines, with the always-valid p-value', async () => {
    const dir = scratch('human');
    const r = await run(dir, ['results', 'hero', '--url', url], false);
    expect(r.stdout).toContain('TOO EARLY  Too early to call.');
    // The friendly line sits under the factual one, once.
    expect(r.stdout).toMatch(/Too early to call\.\r?\n.*bold.*\+10\.0%/);
    expect(r.stdout.match(/too early to be sure/g)).toHaveLength(1);
    expect(r.stdout).toContain('About 6 more days to a verdict');
    expect(r.stdout).toContain('Split check skipped for this experiment.');
    expect(r.stdout).toContain('Data ★☆☆☆☆ 1/5');
    expect(r.stdout).toContain('✗ Running for a full week');
    expect(r.stdout).toContain('0.2000');
    expect(r.stdout).not.toContain('0.0100');
    const old = await run(dir, ['results', 'old', '--url', url], false);
    expect(old.stdout).toContain('Too early to call.');
    expect(old.stdout).not.toContain('TOO EARLY');
    expect(old.stdout).not.toContain('too early to be sure');
    const st = (await run(dir, ['status', '--url', url], false)).stdout;
    expect(st).toContain('in ~6d');
    expect(st).toContain('SAMPLE');
    expect(st).toContain('★☆☆☆☆');
    expect(st).toContain('TOO EARLY');
    // The cloud writes the report.
    expect((await run(dir, ['report', '--url', url])).json).toEqual(REPORT);
  });

  it('self-hosted: raw numbers and where verdicts come from, never a verdict', async () => {
    const dir = scratch('self');
    const r = await run(dir, ['results', 'hero', '--url', `${url}/self`], false);
    expect(r.stdout).toMatch(/bold\s+100\s+12\s+12\.0%/);
    expect(r.stdout).toContain('Verdicts, stars and recommendations come with SplitHub Cloud. https://splithub.io/cloud');
    expect(r.stdout).not.toMatch(/WINNER|TOO EARLY|P-VALUE/);
    const j = await run(dir, ['results', 'hero', '--url', `${url}/self`]);
    expect(j.json).toMatchObject({ ...RAW, next: expect.stringContaining('splithub ship') as unknown });
    const st = (await run(dir, ['status', '--url', `${url}/self`], false)).stdout;
    expect(st).not.toContain('VERDICT');
    expect(st).toContain('come with SplitHub Cloud');
    const md = await run(dir, ['report', '--url', `${url}/self`]);
    expect(md.json.markdown).toContain('| `hero` | finished | 200 | 2 |');
    expect(md.json.markdown).toContain('| bold | 100 | 12 | 12.0% |');
    expect(md.json.markdown).toContain('come with SplitHub Cloud');
  });
});

describe('skills from the cloud', () => {
  it('writes what the server sends (safe paths only) and falls back to the bundled copies offline', async () => {
    const dir = scratch('skills');
    const r = await run(dir, ['skills', '--api', url]);
    expect(r.json).toMatchObject({ source: 'cloud' });
    expect(readFileSync(join(dir, '.claude', 'skills', 'splithub', 'SKILL.md'), 'utf8')).toContain('from the server');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('server section');
    expect(existsSync(join(root, 'evil.md'))).toBe(false);
    const offline = scratch('skills-off');
    const o = await run(offline, ['skills']);
    expect(o.json).toMatchObject({ source: 'bundled' });
    expect(readFileSync(join(offline, '.claude', 'skills', 'ab-testing', 'SKILL.md'), 'utf8')).toContain('name: ab-testing');
  });
});

describe('refs, remove, ship, plan', () => {
  it('refs lists files and lines for the experiment and its goal', async () => {
    const dir = scratch('refs');
    writeFileSync(join(dir, 'src', 'Hero.tsx'), "import { useValue, useTrack } from '@splithub/react';\nexport function Hero() {\n  const t = useValue<string>('hero');\n  const track = useTrack();\n  return <button onClick={() => track('signup')}>{t}</button>;\n}\n");
    const r = await run(dir, ['refs', 'hero']);
    expect(r.json).toMatchObject({ experiment: 'hero', goal: 'signup', goalShared: false, inConfig: true, count: 2 });
    expect(r.json.refs).toEqual([
      { file: 'src/Hero.tsx', line: 3, column: 30, text: "const t = useValue<string>('hero');", match: 'experiment' },
      { file: 'src/Hero.tsx', line: 5, column: 39, text: "return <button onClick={() => track('signup')}>{t}</button>;", match: 'goal' },
    ]);
  });

  it('ship --dry-run shows the diff and changes nothing; ship applies it', async () => {
    const dir = scratch('ship');
    const hero = "import { useValue } from '@splithub/react';\nexport function Hero() {\n  const t = useValue<string>('hero');\n  return <h1>{t}</h1>;\n}\n";
    writeFileSync(join(dir, 'src', 'Hero.tsx'), hero);
    const dry = await run(dir, ['ship', 'hero', '--keep', 'bold', '--dry-run']);
    expect(dry.json).toMatchObject({ experiment: 'hero', kept: 'bold', dryRun: true, files: ['src/Hero.tsx'], leftovers: [] });
    expect(dry.json.diff).toContain("+  const t = 'New text';");
    expect(dry.json.diff).toContain("-    hero: {");
    expect(readFileSync(join(dir, 'src', 'Hero.tsx'), 'utf8')).toBe(hero);
    const done = await run(dir, ['ship', 'hero', '--keep', 'bold']);
    expect(done.code).toBe(0);
    expect(readFileSync(join(dir, 'src', 'Hero.tsx'), 'utf8')).toBe("export function Hero() {\n  const t = 'New text';\n  return <h1>{t}</h1>;\n}\n");
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).not.toContain('hero:');
  }, 60_000);

  it('remove takes the experiment out and lists what still uses it', async () => {
    const dir = scratch('remove');
    writeFileSync(join(dir, 'src', 'Hero.tsx'), "const t = useValue('hero');\n");
    const r = await run(dir, ['remove', 'hero']);
    expect(r.json).toMatchObject({ experiment: 'hero', removed: true, cloud: 'skipped' });
    expect((r.json.refs as unknown[]).length).toBe(1);
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).toContain('experiments: {\n    // a { brace in a comment\n  },');
  });

  it('plan asks the cloud and, with an id, counts the days at its pace', async () => {
    const dir = scratch('plan');
    const r = await run(dir, ['plan', '--baseline', '0.05', '--mde', '0.2', '--api', url]);
    expect(r.json).toMatchObject({ baseline: 0.05, mde: 0.2, variants: 2, perVariant: 8000, total: 16000, traffic: null });
    const withId = await run(dir, ['plan', 'hero', '--baseline', '0.05', '--mde', '0.2', '--api', url, '--url', url]);
    expect((withId.json.traffic as { perDay: number }).perDay).toBe(100);
    expect((await run(dir, ['plan', '--baseline', '2', '--mde', '0.1'])).json.code).toBe('INVALID_FLAG');
    const offline = await run(dir, ['plan', '--baseline', '0.05', '--mde', '0.2']);
    expect(offline.json).toMatchObject({ code: 'UNREACHABLE', error: expect.stringContaining('needs SplitHub Cloud') as unknown });
  });

  it('ci init writes a self-contained workflow', async () => {
    const dir = scratch('ci');
    mkdirSync(join(dir, '.git'));
    const r = await run(dir, ['ci', 'init']);
    expect(r.json).toMatchObject({ written: true, file: '.github/workflows/splithub.yml', workingDirectory: '.', secret: 'SPLITHUB_API_KEY' });
    const wf = readFileSync(join(dir, String(r.json.file)), 'utf8');
    expect(wf).not.toContain('splithub-io/');
    expect(wf.match(/uses: .+/g)).toEqual(['uses: actions/checkout@v4', 'uses: actions/setup-node@v4']);
    expect(wf).toContain('SPLITHUB_API_KEY: ${{ secrets.SPLITHUB_API_KEY }}');
    expect(wf).toContain('npx -y splithub@latest push --dry-run --json');
    expect(wf).toContain('npx -y splithub@latest report --json');
    expect(wf).toContain('<!-- splithub:$MODE -->');
    expect(wf).toContain('gh api -X PATCH');
  });
});

describe('metrics, layers, holdout, archive, scopes', () => {
  it('create writes secondary metrics, guardrails and a layer (declaring it), and the file loads', async () => {
    const dir = scratch('metrics');
    const r = await run(dir, ['create', '--kind', 'component', '--id', 'x', '--variants', 'control,b', '--goal', 'signup', '--secondary', 'pricing', '--guardrail', 'refunds:higher', '--layer', 'checkout:0-50', '--yes']);
    expect(r.code).toBe(0);
    const src = readFileSync(join(dir, 'splithub.config.ts'), 'utf8');
    expect(src).toContain("metrics: { secondary: ['pricing'], guardrails: [{ goal: 'refunds', worse: 'higher' }] },");
    expect(src).toContain("layer: { key: 'checkout', range: [0, 50] },");
    expect(src).toContain('layers: { checkout: {} },');
    expect((await run(dir, ['create', '--kind', 'component', '--id', 'y', '--goal', 'signup', '--guardrail', 'no?pe', '--yes'])).json.code).toBe('INVALID_FLAG');
    expect((await run(dir, ['create', '--kind', 'component', '--id', 'y', '--goal', 'signup', '--secondary', 'Signup', '--yes'])).json.code).toBe('INVALID_FLAG');
    expect((await run(dir, ['create', '--kind', 'component', '--id', 'y', '--goal', 'signup', '--guardrail', 'refunds:up', '--yes'])).json.code).toBe('INVALID_FLAG');
    expect((await run(dir, ['create', '--kind', 'component', '--id', 'y', '--layer', 'checkout:60-40', '--yes'])).json.code).toBe('INVALID_FLAG');
  }, 60_000);

  it('create takes any event name as the goal, without declaring it first', async () => {
    const dir = scratch('event-goal');
    const r = await run(dir, ['create', '--kind', 'value', '--id', 'player', '--variants', 'control,big', '--goal', 'Video Played', '--guardrail', 'refund_requested', '--json', '--yes']);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ experiment: 'player', goal: 'video-played' });
    expect(String(r.json.goalNote)).toContain("track('Video Played')");
    const src = readFileSync(join(dir, 'splithub.config.ts'), 'utf8');
    expect(src).toContain("goal: 'Video Played',");
    expect((await run(dir, ['create', '--kind', 'value', '--id', 'z', '--variants', 'control,b', '--goal', 'signup', '--json', '--yes'])).json.goalNote).toBeUndefined();
    expect((await run(dir, ['create', '--kind', 'value', '--id', 'w', '--goal', '<b>', '--json', '--yes'])).json.code).toBe('INVALID_FLAG');
  }, 60_000);

  it('holdout set / off edits the config', async () => {
    const dir = scratch('holdout');
    expect((await run(dir, ['holdout', 'set', '5'])).json).toMatchObject({ holdout: { percent: 5 } });
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).toContain('holdout: { percent: 5 },');
    expect((await run(dir, ['holdout', 'set', '80'])).json.code).toBe('INVALID_FLAG');
    await run(dir, ['holdout', 'off']);
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).not.toContain('holdout:');
  }, 60_000);

  it('says not to ship on a breached guardrail and labels the holdout', async () => {
    const dir = scratch('guard');
    const r = await run(dir, ['results', 'guard', '--url', url], false);
    expect(r.stdout).toContain("DON'T SHIP");
    expect(r.stdout).toContain('GUARDRAIL refunds (a rise is bad)');
    expect(r.stdout).toContain('✖ worse');
    expect((await run(dir, ['status', '--url', url], false)).stdout).toContain('Holdout: long-term impact');
  });

  it('remove archives in the cloud, and falls back to finished on older servers', async () => {
    const dir = scratch('archive');
    const file = join(dir, 'splithub.config.ts');
    const cloud = readFileSync(file, 'utf8').replace("storage: { mode: 'self', endpoint: '/api/splithub' }", "storage: { mode: 'cloud', key: 'pk_test' }");
    writeFileSync(file, cloud);
    expect((await run(dir, ['remove', 'hero', '--api', url, '--token', 'sk_test'])).json).toMatchObject({ cloud: 'archived' });
    writeFileSync(file, cloud);
    archiveRoute = false;
    expect((await run(dir, ['remove', 'hero', '--api', url, '--token', 'sk_test'])).json).toMatchObject({ cloud: 'finished' });
    archiveRoute = true;
    expect(overrides).toEqual(['hero']);
  }, 60_000);
});

describe('names and keys', () => {
  it('create --name writes the name beside the key', async () => {
    const dir = scratch('named');
    const r = await run(dir, ['create', '--kind', 'component', '--id', 'cta', '--variants', 'control,b', '--name', 'Signup button', '--yes']);
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, 'splithub.config.ts'), 'utf8')).toContain("name: 'Signup button'");
  }, 60_000);

  it('push stops on a key that belongs to another test until --replace or --same', async () => {
    const dir = scratch('conflict');
    const file = join(dir, 'splithub.config.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace("storage: { mode: 'self', endpoint: '/api/splithub' }", "storage: { mode: 'cloud', key: 'pk_test' }"));
    const stopped = await run(dir, ['push', '--api', url, '--token', 'sk_test']);
    expect(stopped.json).toMatchObject({ code: 'KEY_CONFLICT' });
    expect(String(stopped.json.hint)).toContain('--replace hero');
    expect((await run(dir, ['push', '--api', url, '--token', 'sk_test', '--same', 'hero'])).code).toBe(0);
    expect(pushes.at(-1)).toMatchObject({ replace: [], same: ['hero'] });
  }, 60_000);
});
