import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolveTarget } from '../api';
import { loadConfig } from '../config-file';
import { printJson } from '../errors';
import type { SplitHubConfig } from '@splithub/core';
import { ASYNC_STORAGE, isNativeApp, isReactNativeApp, nativeSdkInstalled, nativeSetup, RN_PACKAGE } from '../app-setup';
import { detectProject, grepFiles, listSourceFiles, type ProjectInfo } from '../project';
import { findRefs } from '../refs';
import { c } from '../ui';
import { versionReport } from '../update';
import type { Flags } from './init';

export type Level = 'ok' | 'warn' | 'error';
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

  if (isNativeApp(project.app)) {
    // Native SDKs take experiments from the cloud; there is no config file to check.
    const read = (f: string) => {
      try {
        return readFileSync(f, 'utf8');
      } catch {
        return null;
      }
    };
    const lines = nativeSetup(project.app, null);
    if (nativeSdkInstalled(project.root, project.app, read)) add('ok', `app: ${project.app}, SplitHub SDK in the build files`);
    else add('error', `app: ${project.app}, SplitHub SDK not found in the build files. Add it: ${lines.install.split('\n')[1]}`);
    add('warn', 'app: create experiments in the dashboard; they reach installed apps through the cloud, no release needed');
    return report(checks, flags);
  }
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

  if (isReactNativeApp(project.app)) appChecks(project, config, add);

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

/** React Native / Expo: the package, its storage module, and what the frozen config means for experiments. */
export function appChecks(project: Pick<ProjectInfo, 'app' | 'deps'>, config: Pick<SplitHubConfig, 'experiments' | 'storage'>, add: (level: Level, message: string) => void): void {
  if (!project.deps[RN_PACKAGE]) add('error', `app: ${RN_PACKAGE} is not in package.json. Install it: npm install ${RN_PACKAGE}`);
  else add('ok', `app: ${project.app}, ${RN_PACKAGE} ${project.deps[RN_PACKAGE]}`);
  if (!project.deps[ASYNC_STORAGE]) add('error', `app: ${ASYNC_STORAGE} is missing (the visitor id and the offline queue live there). Install it: ${project.app === 'expo' ? 'npx expo install' : 'npm install'} ${ASYNC_STORAGE}`);
  for (const exp of config.experiments) {
    if (exp.kind === 'redirect') add('warn', `${exp.key}: redirect experiments change URLs, so they do nothing in an app. Use a value or component experiment.`);
  }
  if (config.storage.mode === 'self') add('warn', 'app: self-hosted, so experiments only change with a store release (the config is built into the app). SplitHub Cloud starts and changes them live.');
  else add('warn', 'app: splithub.config.ts is frozen into the binary until the next store release. Create new experiments in the dashboard so installed apps get them now; push config changes too.');
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
