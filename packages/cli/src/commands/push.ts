import type { SplitHubConfig } from '@splithub/core';
import { relative } from 'node:path';
import { apiError, cloudTarget, requireCloudToken } from '../api';
import { hasExperiment, insertExperiment, loadConfig, readSource, writeConfigChecked } from '../config-file';
import { fail, printJson } from '../errors';
import { detectProject, requireConfig } from '../project';
import { c } from '../ui';
import type { Flags } from './init';

export interface CloudExperiment {
  key: string;
  kind: 'component' | 'value' | 'redirect' | 'mvt';
  status: 'draft' | 'running' | 'paused' | 'finished';
  goal: string | null;
  match: string | null;
  name?: string;
  description: string | null;
  variants: Array<{ key: string; weight: number; value?: unknown; to?: string; levels?: Record<string, string> }>;
  /** Multivariate: the factors whose combinations the variants are. */
  factors?: Array<{ key: string; levels: string[] }>;
  flow?: unknown;
  traffic?: number;
  maxExposures?: number | null;
  minDays?: number | null;
  goodSample?: number | null;
  schedule?: { startAt?: string | null; endAt?: string | null } | null;
}

interface PushResponse {
  ok: boolean;
  project: string;
  version: number;
  pushedAt: string;
  publicKey: string;
  experiments: number;
  /** Experiments created in the dashboard that the local file does not have yet. */
  cloudOnly?: CloudExperiment[];
  /** Experiments from an earlier push that the file lacks, left in the cloud as they are; `--prune` removes them. */
  kept?: string[];
  /** The file's analytics properties were not applied: the key or member lacks analytics:write. */
  propertiesSkipped?: boolean;
  hint?: string;
}

/** Write dashboard-created experiments into the local config file. Returns the keys written. */
/** Factor → level → value, read back from the combinations the cloud generated. */
function factorsOf(e: CloudExperiment): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const f of e.factors ?? []) {
    out[f.key] = {};
    for (const level of f.levels) {
      const combo = e.variants.find((v) => v.levels?.[f.key] === level);
      const value = (combo?.value as Record<string, unknown> | undefined)?.[f.key];
      out[f.key]![level] = typeof value === 'string' ? value : value === undefined ? level : JSON.stringify(value);
    }
  }
  return out;
}

async function adoptCloudExperiments(file: string, cloudOnly: CloudExperiment[] | undefined): Promise<string[]> {
  if (!cloudOnly || cloudOnly.length === 0) return [];
  const original = readSource(file);
  let source = original;
  const written: string[] = [];
  for (const e of cloudOnly) {
    if (hasExperiment(source, e.key)) continue;
    const total = e.variants.reduce((s, v) => s + v.weight, 0) || 1;
    source = insertExperiment(source, {
      key: e.key,
      kind: e.kind,
      status: e.status,
      goal: e.goal ?? undefined,
      match: e.match ?? undefined,
      name: e.name,
      description: e.description ?? undefined,
      flow: e.flow ?? undefined,
      traffic: e.traffic,
      maxExposures: e.maxExposures ?? undefined,
      minDays: e.minDays ?? undefined,
      goodSample: e.goodSample ?? undefined,
      schedule: e.schedule ?? undefined,
      variants: e.variants.map((v) => ({ key: v.key, weight: Math.round((v.weight / total) * 100), value: typeof v.value === 'string' ? v.value : v.value === undefined ? undefined : JSON.stringify(v.value), to: v.to })),
      ...(e.kind === 'mvt' && e.factors ? { factors: factorsOf(e) } : {}),
    });
    written.push(e.key);
  }
  if (written.length) {
    await writeConfigChecked(file, original, source, (config) => {
      const missing = written.filter((k) => !config.experiments.some((x) => x.key === k));
      return missing.length ? `${missing.join(', ')} did not load back` : null;
    });
  }
  return written;
}

type LocalExperiment = SplitHubConfig['experiments'][number];

export interface ConfigDiff {
  added: string[];
  removed: string[];
  /** In the cloud only; a push without `--prune` leaves them. */
  kept: string[];
  changed: Array<{ experiment: string; fields: string[] }>;
}

/** What a push would change in the cloud, by experiment key. */
export function configDiff(local: LocalExperiment[], cloud: Array<CloudExperiment & { origin?: string }>, prune = false): ConfigDiff {
  const added = local.filter((e) => !cloud.some((x) => x.key === e.key)).map((e) => e.key);
  const missing = cloud.filter((x) => x.origin !== 'dashboard' && !local.some((e) => e.key === x.key)).map((x) => x.key);
  const removed = prune ? missing : [];
  const kept = prune ? [] : missing;
  const changed: ConfigDiff['changed'] = [];
  for (const e of local) {
    const x = cloud.find((y) => y.key === e.key);
    if (!x) continue;
    const fields: string[] = [];
    if (x.status !== e.status) fields.push('status');
    if ((x.goal ?? null) !== (e.goal ?? null)) fields.push('goal');
    if (x.kind !== e.kind) fields.push('kind');
    if (x.variants.map((v) => `${v.key}:${v.weight}`).join() !== e.variants.map((v) => `${v.key}:${v.weight}`).join()) fields.push('variants');
    if ((x.traffic ?? 1) !== (e.traffic ?? 1)) fields.push('traffic');
    if (fields.length) changed.push({ experiment: e.key, fields });
  }
  return { added, removed, kept, changed };
}

interface KeyConflict {
  key: string;
  reason: 'dashboard' | 'old_data';
  exposures?: number;
}

const keyList = (v: Flags[string]): string[] => (typeof v === 'string' ? v.split(',').map((k) => k.trim()).filter(Boolean) : []);

/** The cloud already has another test under a pushed key: say which, and the two ways on. */
function keyConflict(conflicts: KeyConflict[]): never {
  const why = conflicts.map((k) => (k.reason === 'dashboard' ? `${k.key} (a different experiment made in the dashboard)` : `${k.key} (an earlier experiment, ${(k.exposures ?? 0).toLocaleString('en-US')} visitors)`));
  const keys = conflicts.map((k) => k.key).join(',');
  fail(
    'KEY_CONFLICT',
    `These keys already belong to another experiment in the cloud: ${why.join('; ')}. Nothing was pushed.`,
    `New experiment: rename its key, or run npx splithub push --replace ${keys} (the old numbers are cleared). Same experiment: npx splithub push --same ${keys}.`
  );
}

async function cloudFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    fail('UNREACHABLE', `Can't reach ${url}: ${error instanceof Error ? error.message : String(error)}.`, 'Check your connection, or --api / SPLITHUB_API.');
  }
}

/**
 * `splithub push`: upload the normalized splithub.config.ts to SplitHub Cloud.
 * Needs a project API key (sk_...) via --token or SPLITHUB_API_KEY. The first
 * push returns the public key (pk_...) which is written into the config's
 * `storage.key` when it is still empty. `--dry-run` only checks and compares.
 * Experiments the cloud has from an earlier push that the file lacks are kept
 * unless `--prune`.
 */
export async function push(flags: Flags): Promise<void> {
  const project = requireConfig();
  const config = await loadConfig(project.configFile);
  if (flags['dry-run']) return dryRun(flags, config);
  if (config.storage.mode !== 'cloud') {
    fail('NOT_CLOUD', `This project stores events itself (storage.mode is "${config.storage.mode}"), so there's nothing to push.`, "Set storage: { mode: 'cloud' } in splithub.config.ts to use SplitHub Cloud.");
  }
  const target = requireCloudToken(flags);

  const res = await cloudFetch(`${target.url}/config`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ config, replace: keyList(flags.replace), same: keyList(flags.same), prune: Boolean(flags.prune) }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<PushResponse> & { error?: string; code?: string; conflicts?: KeyConflict[] };
  if (res.status === 409 && body.code === 'key_conflict' && body.conflicts?.length) keyConflict(body.conflicts);
  if (res.status === 409 && body.code === 'key_deleted') fail('KEY_DELETED', `${body.error ?? 'A deleted experiment used one of these keys'}. Nothing was pushed.`, 'Give the experiment a new key in splithub.config.ts and push again.');
  if (!res.ok) throw apiError(res.status, body, `${target.url}/config responded ${res.status}`);

  // Write the public key into the config when it is missing.
  let keyWritten = false;
  // The key goes into a file that is executed; anything but a plain pk_ key stays out.
  if (body.publicKey && /^pk_[A-Za-z0-9_]+$/.test(body.publicKey) && !config.storage.key) {
    const source = readSource(project.configFile);
    const updated = source.replace(/(mode\s*:\s*['"]cloud['"]\s*)(,?)(\s*\})/, (_m, a: string, _comma: string, b: string) => `${a}, key: '${body.publicKey}'${b}`);
    if (updated !== source) {
      await writeConfigChecked(project.configFile, source, updated, (loaded) => (loaded.storage.mode === 'cloud' && loaded.storage.key === body.publicKey ? null : 'storage.key did not load back'));
      keyWritten = true;
    }
  }

  const adopted = await adoptCloudExperiments(project.configFile, body.cloudOnly);
  const out = { ...body, configFile: relative(project.root, project.configFile), keyWritten, adopted };
  if (flags.json) {
    printJson(out);
    return;
  }
  console.log(`${c.green('✔')} pushed ${c.bold(String(body.project))} v${body.version} · ${body.experiments} experiment(s) → ${target.url}`);
  if (body.kept?.length) console.log(c.yellow(`! kept in the cloud, not in ${out.configFile}: ${body.kept.join(', ')}. They go on as they are; npx splithub push --prune removes them.`));
  if (body.propertiesSkipped) console.log(c.yellow(`! ${body.hint ?? 'Analytics properties were left as they are: changing them needs analytics:write.'}`));
  if (adopted.length) console.log(`${c.green('✔')} written into ${out.configFile} from the dashboard: ${adopted.join(', ')} (wire them in code if they are value/component experiments)`);
  if (body.publicKey) {
    console.log(keyWritten ? `${c.green('✔')} public key written to ${out.configFile}` : `${c.dim('public key:')} ${body.publicKey}`);
    if (!keyWritten && !config.storage.key) console.log(c.yellow(`Add it to splithub.config.ts: storage: { mode: 'cloud', key: '${body.publicKey}' }`));
  }
}

/** `push --dry-run`: the config loads; when connected, what a push would change. Writes nothing. */
async function dryRun(flags: Flags, config: SplitHubConfig): Promise<void> {
  const experiments = config.experiments.map((e) => ({ experiment: e.key, kind: e.kind, status: e.status, goal: e.goal ?? null }));
  let diff: ConfigDiff | null = null;
  let cloud: 'compared' | 'not connected' | 'self mode' = config.storage.mode === 'cloud' ? 'not connected' : 'self mode';
  if (config.storage.mode === 'cloud') {
    const target = cloudTarget(flags);
    if (target.token) {
      const res = await cloudFetch(`${target.url}/config`, { headers: { authorization: `Bearer ${target.token}` } });
      const body = (await res.json().catch(() => ({}))) as { config?: { experiments?: CloudExperiment[] } };
      const prune = Boolean(flags.prune);
      if (res.status === 404 || res.status === 409) diff = configDiff(config.experiments, [], prune);
      else if (!res.ok) throw apiError(res.status, body, `${target.url}/config responded ${res.status}`);
      else diff = configDiff(config.experiments, body.config?.experiments ?? [], prune);
      cloud = 'compared';
    }
  }
  const out = { ok: true, dryRun: true, mode: config.storage.mode, project: config.project, experiments, cloud, diff };
  if (flags.json) {
    printJson(out);
    return;
  }
  console.log(`${c.green('✔')} config loads · ${experiments.length} experiment(s) · ${config.storage.mode} mode`);
  if (!diff) console.log(c.dim(cloud === 'self mode' ? 'Self mode: nothing to push.' : 'Not connected, so nothing to compare. Run npx splithub login.'));
  else if (!diff.added.length && !diff.removed.length && !diff.kept.length && !diff.changed.length) console.log(c.dim('The cloud already has this config.'));
  else {
    for (const k of diff.added) console.log(`${c.green('+')} ${k}`);
    for (const k of diff.removed) console.log(`${c.red('-')} ${k}`);
    for (const ch of diff.changed) console.log(`${c.yellow('~')} ${ch.experiment} ${c.dim(`(${ch.fields.join(', ')})`)}`);
    for (const k of diff.kept) console.log(c.dim(`= ${k} (in the cloud only: kept; --prune removes it)`));
  }
}

/** `splithub pull`: print the config stored in the cloud (for inspection or recovery). */
export async function pull(flags: Flags): Promise<void> {
  const target = requireCloudToken(flags);
  const res = await cloudFetch(`${target.url}/config`, { headers: { authorization: `Bearer ${target.token}` } });
  const body = (await res.json().catch(() => ({}))) as { error?: string; config?: { experiments?: Array<CloudExperiment & { origin?: string }> }; version?: number; pushedAt?: string; publicKey?: string };
  if (!res.ok) throw apiError(res.status, body, `${target.url}/config responded ${res.status}`);
  const project = detectProject();
  const dashboardOnes = (body.config?.experiments ?? []).filter((e) => e.origin === 'dashboard');
  const adopted = project.configFile ? await adoptCloudExperiments(project.configFile, dashboardOnes) : [];
  if (flags.json) {
    printJson({ ...body, adopted });
    return;
  }
  console.log(`${c.bold('cloud config')} v${body.version} ${c.dim(`pushed ${body.pushedAt}`)} · public key ${body.publicKey}`);
  if (adopted.length) console.log(`${c.green('✔')} written into ${relative(project.root, project.configFile ?? '')}: ${adopted.join(', ')}`);
  else if (dashboardOnes.length) console.log(c.dim(`dashboard experiments already present locally: ${dashboardOnes.map((e) => e.key).join(', ')}`));
  else console.log(c.dim('no dashboard-created experiments to pull'));
}
