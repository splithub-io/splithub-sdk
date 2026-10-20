import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveTarget } from '../api';
import { loadConfig } from '../config-file';
import { printJson } from '../errors';
import { detectProject, grepFiles, listSourceFiles } from '../project';
import { findRefs } from '../refs';
import { c } from '../ui';
import { versionReport } from '../update';
import type { Flags } from './init';

type Level = 'ok' | 'warn' | 'error';
interface Check {
  level: Level;
  message: string;
}

export async function doctor(flags: Flags): Promise<void> {
  const checks: Check[] = [];
  const add = (level: Level, message: string) => checks.push({ level, message });
  const project = detectProject();

  add('ok', `project "${project.name}" · ${project.framework} · ${project.packageManager}`);
  await versionChecks(project.root, add);

  if (!project.configFile) {
    add('error', 'splithub.config.ts not found. Run `npx splithub init`.');
    return report(checks, flags);
  }
  add('ok', `config: ${relative(project.root, project.configFile)}`);

  let config;
  try {
    config = await loadConfig(project.configFile);
    add('ok', `config loads · ${config.experiments.length} experiment(s) · storage ${config.storage.mode}`);
  } catch (error) {
    add('error', `config does not load: ${error instanceof Error ? error.message : String(error)}`);
    return report(checks, flags);
  }

  const files = listSourceFiles(project.root);
  const providerHits = grepFiles(files, 'SplitHubProvider').concat(grepFiles(files, 'SplitHubNextProvider'));
  if (providerHits.length === 0) add('error', 'no <SplitHubProvider> found in source. Wrap your app once.');
  else add('ok', `provider in ${relative(project.root, providerHits[0]!)}`);

  if (project.framework === 'next') {
    const mw = ['middleware.ts', 'src/middleware.ts', 'middleware.js', 'src/middleware.js'].map((f) => join(project.root, f)).find((f) => existsSync(f));
    const hasRedirects = config.experiments.some((e) => e.kind === 'redirect');
    if (!mw) add(hasRedirects ? 'error' : 'warn', 'no middleware.ts: visitor cookie is not set on the server (SSR may flicker)' + (hasRedirects ? '; redirect experiments will not run' : ''));
    else if (!readFileSync(mw, 'utf8').includes('splithubMiddleware')) add('warn', `${relative(project.root, mw)} does not call splithubMiddleware()`);
    else add('ok', `middleware: ${relative(project.root, mw)}`);
    if (config.storage.mode === 'self' && project.appDir) {
      const catchAll = join(project.root, project.appDir, 'api/splithub/[[...path]]/route.ts');
      const plain = join(project.root, project.appDir, 'api/splithub/route.ts');
      if (existsSync(catchAll)) add('ok', `ingest route: ${relative(project.root, catchAll)}`);
      else if (existsSync(plain)) add('error', `${relative(project.root, plain)} only serves POST /api/splithub; move it to api/splithub/[[...path]]/route.ts so /status and /results work`);
      else add('error', `self mode but ${relative(project.root, catchAll)} is missing (ingest endpoint)`);
    }
  }

  for (const exp of config.experiments) {
    const label = `${exp.key} (${exp.kind}, ${exp.status})`;
    if (!exp.goal) add(exp.status === 'running' ? 'error' : 'warn', `${label}: no goal; the verdict cannot be computed`);
    if (exp.kind !== 'redirect') {
      const used = findRefs(project.root, config, exp.key, files).refs.filter((r) => r.match === 'experiment').length;
      if (used === 0) add(exp.status === 'running' ? 'error' : 'warn', `${label}: not referenced in code (useValue/useVariant/<Experiment id>)`);
    }
    if (exp.status === 'running' && exp.variants.every((v) => v.weight === 0)) add('error', `${label}: all weights are 0`);
  }
  for (const goal of config.goals) {
    // An event goal is sent as its key or, when it has one, as its event name ('Video Played').
    const names = [goal.key, ...(goal.event ? [goal.event] : [])];
    if (goal.type === 'event' && names.every((n) => grepFiles(files, `'${n}'`).length + grepFiles(files, `"${n}"`).length === 0)) {
      add('warn', `goal "${goal.key}": track('${goal.event ?? goal.key}') is never called`);
    }
  }

  const target = resolveTarget(flags, project);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${target.url}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    add(res.ok ? 'ok' : 'warn', `endpoint ${target.url}/health → ${res.status}`);
  } catch {
    add('warn', `endpoint ${target.url} not reachable (is the dev server running?)`);
  }

  return report(checks, flags);
}

async function versionChecks(root: string, add: (level: Level, message: string) => void): Promise<void> {
  const v = await versionReport(root);
  const list = v.rows.map((r) => `${r.name} ${r.installed ?? 'not installed'}`).join(', ');
  if (v.mismatch) add('warn', `versions differ: ${list}. Update them together: ${v.command}`);
  else add('ok', `versions: ${list}`);
  if (v.offline) add('warn', "couldn't reach npm, so the latest versions weren't checked");
  else if (v.outdated.length) {
    const what = v.rows.filter((r) => v.outdated.includes(r.name)).map((r) => `${r.name} ${r.installed} → ${r.latest}`).join(', ');
    add('warn', `updates available: ${what}` + (v.mismatch ? '' : `. Run ${v.command}`));
  }
}

function report(checks: Check[], flags: Flags): void {
  const errors = checks.filter((x) => x.level === 'error').length;
  if (flags.json) {
    printJson({ ok: errors === 0, errors, warnings: checks.filter((x) => x.level === 'warn').length, checks });
  } else {
    for (const x of checks) {
      const icon = x.level === 'ok' ? c.green('✔') : x.level === 'warn' ? c.yellow('!') : c.red('✖');
      console.log(`${icon} ${x.message}`);
    }
    console.log();
    console.log(errors === 0 ? c.green('All good.') : c.red(`${errors} problem(s) to fix.`));
  }
  if (errors > 0) process.exitCode = 1;
}
