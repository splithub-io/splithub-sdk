// splithub analytics connect — set up analytics in this app the way `init` sets up experiments:
// pick (or create) a property, name it on the app's SplitHub provider, show how to send events.
//
//   splithub analytics connect                   pick one, or create one when there is none
//   splithub analytics connect sh-x1h78w         use this property (added to the config when it is new)
//   splithub analytics connect --name "Site"     create a new one
//   --force                                      replace another property already named on the provider
//
// React / Next.js: `property="sh-…"` is added to the one <SplitHubProvider> / <SplitHubNextProvider>
// found in the code. Anything else: the sh.js tag to paste. Self-hosted projects keep their properties
// in splithub.config.ts; the cloud also knows the ones made in the dashboard.
import * as p from '@clack/prompts';
import { newPropertyId } from '@splithub/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { cloudTarget, request } from '../api';
import { loadConfig } from '../config-file';
import { fail, printJson } from '../errors';
import { listSourceFiles, requireConfig, type Framework } from '../project';
import { c } from '../ui';
import { addProperty, afterAdded, printLive } from './analytics';
import { str } from './analytics-reports';
import type { Flags } from './init';
import { propertyChoices, propertySnippets, type PropertyChoice } from './menu-analytics';

export type WireStatus = 'added' | 'already' | 'other' | 'none' | 'many';
export interface WireResult {
  status: WireStatus;
  file?: string;
  line?: number;
  /** The property already named on the provider (status other / already). */
  current?: string;
  /** Every provider found (status many). */
  files?: string[];
}

const PROVIDER = /<SplitHub(?:Next)?Provider\b/g;

/** The opening tag starting at `start`: up to the first `>` outside braces and strings. */
function tagEnd(src: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === quote && src[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) return i;
  }
  return -1;
}

/**
 * Names `key` on the provider in `src`: `property="key"` right after the component name. Returns the
 * new source (null when nothing changes) and what it found. Pure, so it is tested without files.
 */
export function wireSource(
  src: string,
  key: string,
  force = false
): {
  source: string | null;
  status: Exclude<WireStatus, 'none' | 'many'>;
  current?: string;
  index: number;
} | null {
  const hits = [...src.matchAll(PROVIDER)];
  if (hits.length !== 1) return null;
  const at = hits[0]!.index!;
  const end = tagEnd(src, at);
  if (end < 0) return null;
  const tag = src.slice(at, end);
  const existing = /\sproperty=(?:\{\s*)?(["'`])([^"'`]*)\1(?:\s*\})?|\sproperty=\{[^}]*\}/.exec(tag);
  if (existing) {
    const current = existing[2] ?? existing[0].trim().slice('property='.length);
    if (current === key) return { source: null, status: 'already', current, index: at };
    if (!force) return { source: null, status: 'other', current, index: at };
    const from = at + existing.index;
    return {
      source: `${src.slice(0, from)} property="${key}"${src.slice(from + existing[0].length)}`,
      status: 'added',
      current,
      index: at,
    };
  }
  const name = at + hits[0]![0].length;
  return {
    source: `${src.slice(0, name)} property="${key}"${src.slice(name)}`,
    status: 'added',
    index: at,
  };
}

/** Finds the app's SplitHub provider and names the property on it. */
export function wireProvider(root: string, key: string, force = false): WireResult {
  const found: Array<{ file: string; src: string; count: number }> = [];
  for (const file of listSourceFiles(root)) {
    if (!/\.(tsx|jsx)$/.test(file)) continue;
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const count = [...src.matchAll(PROVIDER)].length;
    if (count) found.push({ file, src, count });
  }
  const rel = (f: string) => relative(root, f).replace(/\\/g, '/');
  if (found.length === 0) return { status: 'none' };
  if (found.length > 1 || found[0]!.count > 1) return { status: 'many', files: found.map((f) => rel(f.file)) };
  const { file, src } = found[0]!;
  const out = wireSource(src, key, force);
  if (!out) return { status: 'many', files: [rel(file)] };
  const line = src.slice(0, out.index).split('\n').length;
  if (out.source !== null) writeFileSync(file, out.source, 'utf8');
  return {
    status: out.status,
    file: rel(file),
    line,
    ...(out.current ? { current: out.current } : {}),
  };
}

/** How to send events once the property is named, per setup. */
export function trackSnippets(framework: Framework, key: string, publicKey?: string | null): { provider: string; script: string; track: string; identify: string } {
  const s = propertySnippets(key, publicKey);
  const provider = framework === 'next' ? s.provider.replace('<SplitHubProvider', '<SplitHubNextProvider') : s.provider;
  return {
    provider,
    script: s.script,
    track: `import { useTrack } from '@splithub/react';\n\nconst track = useTrack();\ntrack('Signup', { plan: 'pro' }); // any name; props are optional`,
    identify: `import { useIdentify } from '@splithub/react';\n\nconst identify = useIdentify();\nidentify(user.id, { plan: 'pro' }); // after sign-in; identify(null) on sign-out`,
  };
}

async function knownProperties(flags: Flags, configFile: string, cloud: boolean): Promise<PropertyChoice[]> {
  const config = await loadConfig(configFile);
  const local = (config.properties ?? []).map((prop) => ({
    value: prop.key,
    label: prop.name ? `${prop.name} (${prop.key})` : prop.key,
    hint: prop.status,
    status: prop.status,
  }));
  if (!cloud) return local;
  const t = cloudTarget(flags);
  if (!t.token) return local;
  try {
    const remote = propertyChoices(await request<{ properties: Array<Record<string, unknown>> }>(t, '/properties'));
    return [...remote, ...local.filter((l) => !remote.some((r) => r.value === l.value))];
  } catch {
    return local;
  }
}

export async function connect(given: string | undefined, flags: Flags): Promise<void> {
  const project = requireConfig();
  const config = await loadConfig(project.configFile);
  const cloud = config.storage.mode === 'cloud';
  const interactive = !flags.json && !flags.yes && process.stdin.isTTY && process.stdout.isTTY;
  const known = await knownProperties(flags, project.configFile, cloud);
  const name = str(flags.name);

  let key = given;
  let created = false;
  let live = 'skipped';
  if (!key && !name) {
    if (interactive) {
      const picked = await p.select<string>({
        message: 'Which property should this app send to?',
        options: [...known.map(({ value, label, hint }) => ({ value, label, hint })), { value: '__new', label: 'Create a new property' }],
      });
      if (p.isCancel(picked)) return;
      if (picked !== '__new') key = picked;
    } else if (known.length === 1) key = known[0]!.value;
    else if (known.length > 1) fail('USAGE', `This project has ${known.length} properties: ${known.map((k) => k.value).join(', ')}.`, 'Pick one: npx splithub analytics connect <id>, or create one with --name "Site".');
  }
  if (!key || !known.some((k) => k.value === key)) {
    let label = name;
    if (!label && !key && interactive) {
      const typed = await p.text({
        message: 'Name of the property',
        placeholder: project.name,
        defaultValue: project.name,
      });
      if (p.isCancel(typed)) return;
      label = typed.trim() || project.name;
    }
    key ??= newPropertyId();
    live = (await addProperty(key, { ...flags, name: label ?? (given ? undefined : project.name) })).live;
    created = true;
  }

  const wired = wireProvider(project.root, key, Boolean(flags.force));
  const publicKey = typeof (config.storage as { key?: unknown }).key === 'string' && String((config.storage as { key?: unknown }).key).startsWith('pk_') ? String((config.storage as { key: string }).key) : null;
  const snippets = trackSnippets(project.framework, key, publicKey);
  const configFile = relative(project.root, project.configFile);
  const next = [...(created ? afterAdded(cloud, live) : []), 'deploy the app (development never sends to the cloud)', cloud ? `npx splithub analytics realtime ${key}` : `npx splithub analytics ${key}`];
  if (flags.json)
    return printJson({
      property: key,
      created,
      configFile: created ? configFile : null,
      live: created ? live : null,
      wired,
      snippets,
      next,
    });

  const ok = (s: string) => console.log(`${c.green('✔')} ${s}`);
  ok(created ? `property ${c.bold(key)} added to ${c.dim(configFile)}` : `using property ${c.bold(key)}`);
  if (created) printLive(cloud, live);
  if (wired.status === 'added') ok(`named on the provider in ${c.dim(`${wired.file}:${wired.line}`)}`);
  else if (wired.status === 'already') ok(`already named on the provider in ${c.dim(`${wired.file}:${wired.line}`)}`);
  else if (wired.status === 'other') console.log(c.yellow(`! ${wired.file}:${wired.line} already sends to ${wired.current}. Run again with --force to switch to ${key}.`));
  else if (wired.status === 'many') console.log(c.yellow(`! More than one SplitHub provider (${wired.files?.join(', ')}): add property="${key}" to the one that wraps the app.`));
  else if (project.framework === 'unknown') console.log(`\nPaste this into the <head> of every page:\n  ${c.cyan(snippets.script)}`);
  else console.log(`\nNo SplitHub provider in the code yet. Wrap the app once:\n  ${c.cyan(snippets.provider)}\nNo SDK? The script tag works too:\n  ${c.cyan(snippets.script)}`);
  console.log(`\n${c.bold('Send events')} ${c.dim('(pageviews are sent for you)')}`);
  if (project.framework === 'unknown' && wired.status === 'none') console.log(`  ${c.cyan("window.splithub.track('Signup', { plan: 'pro' })")}`);
  else
    console.log(
      snippets.track
        .split('\n')
        .map((l) => `  ${c.cyan(l)}`)
        .join('\n')
    );
  console.log(c.dim(`\nTie visits to your users: useIdentify() (sh.js: splithub.identify(id)). Mark an event as a goal to count it as a conversion.`));
  console.log(c.dim(`Next: ${next.join(', then ')}.`));
}
