import { isSplitHubConfig, type ExperimentKind, type ExperimentStatus, type SplitHubConfig } from '@splithub/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError, fail } from './errors';

/** Load splithub.config.ts (TypeScript or JS) through jiti. CONFIG_PARSE when it does not load. */
export async function loadConfig(file: string): Promise<SplitHubConfig> {
  let mod: unknown;
  try {
    const { createJiti } = await import('jiti');
    const jiti = createJiti(pathToFileURL(file).href, { fsCache: false, moduleCache: false });
    mod = await jiti.import(file, { default: true });
  } catch (error) {
    fail('CONFIG_PARSE', `${basename(file)} doesn't load: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, 'Fix the error in the file, then run npx splithub doctor.');
  }
  if (!isSplitHubConfig(mod)) {
    fail('CONFIG_PARSE', `${basename(file)} must \`export default defineConfig({...})\` from @splithub/core.`);
  }
  return mod;
}

// ---------------------------------------------------------------------------
// Source scanning. Edits work on a "masked" copy of the file where string
// contents, template literals, regex literals and comments are blanked out
// (same length, newlines kept), so braces and quotes inside them never count.
// ---------------------------------------------------------------------------

const REGEX_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** Copy of `source` with strings (contents), templates, regexes and comments blanked. */
export function maskSource(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < out.length; j++) if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
  };
  let lastCode = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      lastCode = ch;
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < source.length) {
        const c = source[j]!;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (depth === 0 && c === '`') break;
        if (c === '$' && source[j + 1] === '{') {
          depth++;
          j += 2;
          continue;
        }
        if (depth > 0 && c === '{') depth++;
        else if (depth > 0 && c === '}') depth--;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      lastCode = '`';
      continue;
    }
    if (ch === '/' && REGEX_BEFORE.has(lastCode)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n') {
        const c = source[j]!;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      lastCode = '/';
      continue;
    }
    if (!/\s/.test(ch)) lastCode = /[\w$)\]]/.test(ch) ? 'x' : ch;
    i++;
  }
  return out.join('');
}

/** Index of the bracket closing the one at `open` in masked text, or null. */
function matchingClose(masked: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

export interface Entry {
  /** Property name; null for spreads and computed keys. */
  key: string | null;
  /** object: `key: { ... }` · expr: any other value (identifier, call, shorthand) · spread: `...x` · computed: `[k]: v`. */
  kind: 'object' | 'expr' | 'spread' | 'computed';
  start: number;
  valueStart: number;
  /** Exclusive end of the value (trailing whitespace excluded). */
  valueEnd: number;
  /** After the trailing comma when there is one, else `valueEnd`. */
  end: number;
}

/** Top-level properties of the object literal between `open` and `close` (its braces). */
export function objectEntries(source: string, masked: string, open: number, close: number): Entry[] {
  const entries: Entry[] = [];
  let i = open + 1;
  const ws = () => {
    while (i < close && /[\s,]/.test(masked[i]!)) i++;
  };
  // A value runs to the next comma at depth 0 (or the closing brace).
  const valueTo = (from: number): number => {
    let j = from;
    while (j < close) {
      const ch = masked[j]!;
      if (ch === ',') break;
      if (ch === '{' || ch === '(' || ch === '[') {
        const m = matchingClose(masked, j);
        j = m === null ? close : m + 1;
        continue;
      }
      j++;
    }
    return j;
  };
  for (;;) {
    ws();
    if (i >= close) break;
    const start = i;
    let key: string | null = null;
    let kind: Entry['kind'] = 'expr';
    if (masked.startsWith('...', i)) {
      kind = 'spread';
      i += 3;
    } else {
      const ch = masked[i]!;
      if (ch === "'" || ch === '"') {
        const end = masked.indexOf(ch, i + 1);
        key = source.slice(i + 1, end).replace(/\\(.)/g, '$1');
        i = end + 1;
      } else if (ch === '[') {
        kind = 'computed';
        const m = matchingClose(masked, i);
        i = m === null ? close : m + 1;
      } else {
        const m = /^[\w$-]+/.exec(masked.slice(i, close));
        if (!m) break;
        key = m[0];
        i += m[0].length;
      }
      while (i < close && /\s/.test(masked[i]!)) i++;
      if (masked[i] === ':') i++;
    }
    while (i < close && /\s/.test(masked[i]!)) i++;
    const valueStart = i;
    const stop = valueTo(i);
    let valueEnd = stop;
    while (valueEnd > valueStart && /\s/.test(masked[valueEnd - 1]!)) valueEnd--;
    if (kind === 'expr' && masked[valueStart] === '{' && matchingClose(masked, valueStart) === valueEnd - 1) kind = 'object';
    const end = masked[stop] === ',' ? stop + 1 : valueEnd;
    entries.push({ key, kind, start, valueStart, valueEnd, end });
    i = stop;
  }
  return entries;
}

interface Located {
  masked: string;
  open: number;
  close: number;
  entries: Entry[];
}

/** The `experiments: { ... }` object of the config, with its entries. */
function locateExperiments(source: string): Located {
  const masked = maskSource(source);
  let open = -1;
  // Prefer the object passed to defineConfig({ ... }) / export default { ... }.
  const root = /defineConfig\s*\(\s*\{|export\s+default\s+\{/.exec(masked);
  if (root) {
    const rootOpen = root.index + root[0].length - 1;
    const rootClose = matchingClose(masked, rootOpen);
    if (rootClose !== null) {
      const exp = objectEntries(source, masked, rootOpen, rootClose).find((e) => e.key === 'experiments');
      if (exp && exp.kind !== 'object') {
        fail('CONFIG_UNSAFE', '`experiments` in the config is not written inline, so the CLI cannot edit it safely.', 'Edit the experiments where they are defined, or write them inline as experiments: { ... }.');
      }
      if (exp) open = exp.valueStart;
    }
  }
  if (open < 0) {
    const m = /\bexperiments\s*:\s*\{/.exec(masked);
    if (!m) fail('CONFIG_UNSAFE', "Couldn't find `experiments: {` in the config file.", 'Add experiments: {} to defineConfig({...}) and retry.');
    open = m.index + m[0].length - 1;
  }
  const close = matchingClose(masked, open);
  if (close === null) fail('CONFIG_PARSE', 'The braces after `experiments: {` are not balanced.');
  return { masked, open, close, entries: objectEntries(source, masked, open, close) };
}

function unsafeHint(key: string): string {
  return `Edit "${key}" where it is defined (it comes from a spread or an imported constant), then run npx splithub doctor.`;
}

/** The literal `key: { ... }` entry of an experiment. Throws when it can't be edited safely. */
function experimentEntry(source: string, key: string): Located & { entry: Entry } {
  const loc = locateExperiments(source);
  const entry = loc.entries.find((e) => e.key === key);
  if (!entry) {
    if (loc.entries.some((e) => e.kind === 'spread' || e.kind === 'computed')) {
      fail('CONFIG_UNSAFE', `"${key}" isn't written inline in the config (the experiments use a spread), so the CLI can't edit it safely.`, unsafeHint(key));
    }
    fail('EXPERIMENT_NOT_FOUND', `There's no experiment "${key}" in the config.`, 'See the ids with npx splithub status.');
  }
  return { ...loc, entry };
}

export function hasExperiment(source: string, key: string): boolean {
  try {
    return locateExperiments(source).entries.some((e) => e.key === key);
  } catch {
    return false;
  }
}

/** Indentation of the line holding `index`. */
function indentAt(source: string, index: number): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))?.[0] ?? '';
}

/**
 * Append `render(indent)` as the last property of the object `open..close`,
 * adding the comma the previous property may be missing.
 */
function appendProperty(source: string, masked: string, open: number, close: number, render: (indent: string) => string): string {
  const outerIndent = indentAt(source, open);
  const indent = outerIndent + '  ';
  let last = close - 1;
  while (last > open && /\s/.test(masked[last]!)) last--;
  const needsComma = last > open && masked[last] !== ',';
  const lineStart = source.lastIndexOf('\n', close - 1) + 1;
  const closeOnOwnLine = source.slice(lineStart, close).trim() === '';
  const block = `${indent}${render(indent)},\n`;
  const at = closeOnOwnLine && lineStart > last ? lineStart : close;
  const text = at === close ? `\n${block}${outerIndent}` : block;
  const comma = needsComma ? ',' : '';
  // Inline object (`{ a: 1 }`): the whitespace before `}` gives way to the new line.
  const head = at === close ? source.slice(0, last + 1) + comma : source.slice(0, last + 1) + comma + source.slice(last + 1, at);
  return head + text + source.slice(at);
}

export interface NewExperiment {
  key: string;
  kind: ExperimentKind;
  status: ExperimentStatus;
  variants: Array<{ key: string; weight: number; value?: string; to?: string }>;
  /** Multivariate: factor → level → value; the variants are derived and not written. */
  factors?: Record<string, Record<string, string>>;
  goal?: string;
  match?: string;
  /** Human name shown instead of the key. */
  name?: string;
  description?: string;
  /** Targeting graph from the dashboard, written verbatim as JSON. */
  flow?: unknown;
  traffic?: number;
  maxExposures?: number;
  /** Days before a verdict (0..30); absent means the default of 0 (none). */
  minDays?: number;
  /** Total visitors for a good sample (100..10,000,000); absent means the default of 5000. */
  goodSample?: number;
  schedule?: { startAt?: string | null; endAt?: string | null };
  /** Secondary goals to watch, and guardrails that must not get worse. */
  metrics?: { secondary?: string[]; guardrails?: Array<string | { goal: string; worse: 'lower' | 'higher' }> };
  /** Mutual exclusion layer and its bucket range [start, end). */
  layer?: { key: string; range: [number, number] };
}

/** Single-quoted string literal. */
function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/** Object key: bare when it is a valid identifier, quoted otherwise. */
function k(s: string): string {
  return /^[a-z_$][\w$]*$/i.test(s) ? s : q(s);
}

/** Render an experiment entry. Every line after the first carries its own indentation. */
export function renderExperiment(e: NewExperiment, indent = '    '): string {
  const i2 = indent + '  ';
  const i3 = i2 + '  ';
  const lines: string[] = [`${k(e.key)}: {`];
  lines.push(`${i2}kind: ${q(e.kind)},`);
  lines.push(`${i2}status: ${q(e.status)},`);
  if (e.match) lines.push(`${i2}match: ${q(e.match)},`);
  if (e.kind === 'mvt') {
    lines.push(`${i2}factors: {`);
    for (const [factor, levels] of Object.entries(e.factors ?? {})) {
      lines.push(`${i3}${k(factor)}: { ${Object.entries(levels).map(([l, v]) => `${k(l)}: ${q(v)}`).join(', ')} },`);
    }
    lines.push(`${i2}},`);
  } else if (e.kind === 'component') {
    lines.push(`${i2}variants: { ${e.variants.map((v) => `${k(v.key)}: ${v.weight}`).join(', ')} },`);
  } else {
    lines.push(`${i2}variants: {`);
    for (const v of e.variants) {
      const extra = e.kind === 'value' ? `value: ${q(v.value ?? '')}` : `to: ${q(v.to ?? '/')}`;
      lines.push(`${i3}${k(v.key)}: { weight: ${v.weight}, ${extra} },`);
    }
    lines.push(`${i2}},`);
  }
  if (e.goal) lines.push(`${i2}goal: ${q(e.goal)},`);
  if (e.traffic !== undefined && e.traffic !== 1) lines.push(`${i2}traffic: ${e.traffic},`);
  if (e.maxExposures) lines.push(`${i2}maxExposures: ${e.maxExposures},`);
  if (e.minDays !== undefined) lines.push(`${i2}minDays: ${e.minDays},`);
  if (e.goodSample !== undefined) lines.push(`${i2}goodSample: ${e.goodSample},`);
  if (e.schedule && (e.schedule.startAt || e.schedule.endAt)) lines.push(`${i2}schedule: { ${[e.schedule.startAt ? `startAt: ${q(e.schedule.startAt)}` : null, e.schedule.endAt ? `endAt: ${q(e.schedule.endAt)}` : null].filter(Boolean).join(', ')} },`);
  if (e.metrics && (e.metrics.secondary?.length || e.metrics.guardrails?.length)) {
    const parts: string[] = [];
    if (e.metrics.secondary?.length) parts.push(`secondary: [${e.metrics.secondary.map(q).join(', ')}]`);
    if (e.metrics.guardrails?.length) parts.push(`guardrails: [${e.metrics.guardrails.map((g) => (typeof g === 'string' ? q(g) : `{ goal: ${q(g.goal)}, worse: ${q(g.worse)} }`)).join(', ')}]`);
    lines.push(`${i2}metrics: { ${parts.join(', ')} },`);
  }
  if (e.layer) lines.push(`${i2}layer: { key: ${q(e.layer.key)}, range: [${e.layer.range[0]}, ${e.layer.range[1]}] },`);
  if (e.name) lines.push(`${i2}name: ${q(e.name)},`);
  if (e.description) lines.push(`${i2}description: ${q(e.description)},`);
  if (e.flow) {
    const json = JSON.stringify(e.flow, null, 2).split('\n');
    lines.push(`${i2}// targeting graph from the dashboard; edit it there or by hand\n${i2}flow: ${json.map((l, n) => (n === 0 ? l : i2 + l)).join('\n')},`);
  }
  lines.push(`${indent}}`);
  return lines.join('\n');
}

/** Append a new experiment at the end of the `experiments: { ... }` object. */
export function insertExperiment(source: string, e: NewExperiment): string {
  const { masked, open, close, entries } = locateExperiments(source);
  if (entries.some((x) => x.key === e.key)) fail('EXPERIMENT_EXISTS', `There's already an experiment "${e.key}".`, 'Pick another id: an old id keeps its history.');
  return appendProperty(source, masked, open, close, (indent) => renderExperiment(e, indent));
}

export function setExperimentStatus(source: string, key: string, status: ExperimentStatus): string {
  const { masked, entry } = experimentEntry(source, key);
  if (entry.kind !== 'object') fail('CONFIG_UNSAFE', `"${key}" points to a value defined elsewhere, so the CLI can't edit it safely.`, unsafeHint(key));
  const inner = objectEntries(source, masked, entry.valueStart, entry.valueEnd - 1);
  const field = inner.filter((x) => x.key === 'status').pop();
  if (field) {
    const raw = masked.slice(field.valueStart, field.valueEnd);
    if (!/^(['"])\s*\1$/.test(raw)) fail('CONFIG_UNSAFE', `The status of "${key}" isn't a plain string, so the CLI can't change it safely.`, `Set status: '${status}' by hand.`);
    const quote = raw[0]!;
    return source.slice(0, field.valueStart) + `${quote}${status}${quote}` + source.slice(field.valueEnd);
  }
  // No status written (or only through a spread): append one, so it wins over any spread.
  return appendProperty(source, masked, entry.valueStart, entry.valueEnd - 1, () => `status: ${q(status)}`);
}

/** Remove an experiment's entry (and its line) from the config source. */
export function removeExperiment(source: string, key: string): string {
  return removeEntry(source, experimentEntry(source, key).entry);
}

/** Remove a property, its whole line when it stands alone. */
function removeEntry(source: string, entry: Entry): string {
  const lineStart = source.lastIndexOf('\n', entry.start - 1) + 1;
  const from = source.slice(lineStart, entry.start).trim() === '' ? lineStart : entry.start;
  let to = entry.end;
  const lineEnd = source.indexOf('\n', to);
  const rest = source.slice(to, lineEnd < 0 ? source.length : lineEnd);
  if (rest.trim() === '' && from === lineStart) to = lineEnd < 0 ? source.length : lineEnd + 1;
  return source.slice(0, from) + source.slice(to);
}

/** The object passed to defineConfig({ ... }) / export default { ... }. */
function locateRoot(source: string): Located {
  const masked = maskSource(source);
  const root = /defineConfig\s*\(\s*\{|export\s+default\s+\{/.exec(masked);
  if (!root) fail('CONFIG_UNSAFE', "Couldn't find defineConfig({ ... }) in the config file.", 'Make the change by hand in splithub.config.ts.');
  const open = root.index + root[0].length - 1;
  const close = matchingClose(masked, open);
  if (close === null) fail('CONFIG_PARSE', 'The braces of defineConfig({ ... }) are not balanced.');
  return { masked, open, close, entries: objectEntries(source, masked, open, close) };
}

/** Set a top-level config property (`holdout: { ... }`), replacing it when it is there. */
export function setTopLevel(source: string, name: string, valueText: string | null): string {
  const { masked, open, close, entries } = locateRoot(source);
  const entry = entries.find((e) => e.key === name);
  if (valueText === null) return entry ? removeEntry(source, entry) : source;
  if (entry) return source.slice(0, entry.valueStart) + valueText + source.slice(entry.valueEnd);
  return appendProperty(source, masked, open, close, () => `${k(name)}: ${valueText}`);
}

// ---------------------------------------------------------------------------
// Analytics properties: `properties: { site: { goals: [...] } }` at the top level
// ---------------------------------------------------------------------------

export interface NewProperty {
  key: string;
  status?: 'running' | 'paused';
  name?: string;
  description?: string;
  goals?: string[];
}

export function renderProperty(p: NewProperty): string {
  const parts: string[] = [];
  if (p.status && p.status !== 'running') parts.push(`status: ${q(p.status)}`);
  if (p.name) parts.push(`name: ${q(p.name)}`);
  if (p.goals?.length) parts.push(`goals: [${p.goals.map(q).join(', ')}]`);
  if (p.description) parts.push(`description: ${q(p.description)}`);
  return `${k(p.key)}: { ${parts.join(', ')}${parts.length ? ' ' : ''}}`.replace('{ }', '{}');
}

/** The `properties: { ... }` object, created empty when the config has none. */
function locateProperties(source: string): { source: string } & Located {
  let src = source;
  let root = locateRoot(src);
  let entry = root.entries.find((e) => e.key === 'properties');
  if (!entry) {
    src = appendProperty(src, root.masked, root.open, root.close, () => 'properties: {}');
    root = locateRoot(src);
    entry = root.entries.find((e) => e.key === 'properties')!;
  }
  if (entry.kind !== 'object') fail('CONFIG_UNSAFE', '`properties` in the config is not written inline, so the CLI cannot edit it safely.', 'Edit the properties where they are defined.');
  return { source: src, masked: root.masked, open: entry.valueStart, close: entry.valueEnd - 1, entries: objectEntries(src, root.masked, entry.valueStart, entry.valueEnd - 1) };
}

function propertyEntry(source: string, key: string): Located & { entry: Entry } {
  const root = locateRoot(source);
  const props = root.entries.find((e) => e.key === 'properties');
  if (!props || props.kind !== 'object') fail('PROPERTY_NOT_FOUND', `There's no analytics property "${key}" in the config.`, 'See the ids with npx splithub analytics.');
  const entries = objectEntries(source, root.masked, props.valueStart, props.valueEnd - 1);
  const entry = entries.find((e) => e.key === key);
  if (!entry) fail('PROPERTY_NOT_FOUND', `There's no analytics property "${key}" in the config.`, 'See the ids with npx splithub analytics.');
  return { masked: root.masked, open: props.valueStart, close: props.valueEnd - 1, entries, entry };
}

export function insertProperty(source: string, p: NewProperty): string {
  const loc = locateProperties(source);
  if (loc.entries.some((x) => x.key === p.key)) fail('PROPERTY_EXISTS', `There's already an analytics property "${p.key}".`, 'Pick another id.');
  return appendProperty(loc.source, loc.masked, loc.open, loc.close, () => renderProperty(p));
}

export function setPropertyStatus(source: string, key: string, status: 'running' | 'paused'): string {
  const { masked, entry } = propertyEntry(source, key);
  if (entry.kind !== 'object') fail('CONFIG_UNSAFE', `"${key}" points to a value defined elsewhere, so the CLI can't edit it safely.`, `Set status: '${status}' by hand.`);
  const inner = objectEntries(source, masked, entry.valueStart, entry.valueEnd - 1);
  const field = inner.filter((x) => x.key === 'status').pop();
  if (field) {
    const raw = masked.slice(field.valueStart, field.valueEnd);
    if (!/^(['"])\s*\1$/.test(raw)) fail('CONFIG_UNSAFE', `The status of "${key}" isn't a plain string, so the CLI can't change it safely.`, `Set status: '${status}' by hand.`);
    const quote = raw[0]!;
    return source.slice(0, field.valueStart) + `${quote}${status}${quote}` + source.slice(field.valueEnd);
  }
  return appendProperty(source, masked, entry.valueStart, entry.valueEnd - 1, () => `status: ${q(status)}`);
}

export function removeProperty(source: string, key: string): string {
  return removeEntry(source, propertyEntry(source, key).entry);
}

/** Make sure `layers: { <key>: {} }` declares a layer. */
export function ensureLayer(source: string, key: string): string {
  const { masked, open, close, entries } = locateRoot(source);
  const layers = entries.find((e) => e.key === 'layers');
  if (!layers) return appendProperty(source, masked, open, close, () => `layers: { ${k(key)}: {} }`);
  if (layers.kind !== 'object') fail('CONFIG_UNSAFE', '`layers` in the config is not written inline.', `Add ${key}: {} to layers by hand.`);
  if (objectEntries(source, masked, layers.valueStart, layers.valueEnd - 1).some((e) => e.key === key)) return source;
  return appendProperty(source, masked, layers.valueStart, layers.valueEnd - 1, () => `${k(key)}: {}`);
}

export function readSource(file: string): string {
  return readFileSync(file, 'utf8');
}

export function writeSource(file: string, source: string): void {
  writeFileSync(file, source, 'utf8');
}

/**
 * Write the config, load it back and check the change landed. On any problem the
 * original file is restored and CONFIG_WRITE is thrown: the CLI never leaves a broken config.
 */
export async function writeConfigChecked(file: string, original: string, updated: string, verify: (config: SplitHubConfig) => string | null): Promise<SplitHubConfig> {
  writeSource(file, updated);
  let problem: string | null = null;
  let config: SplitHubConfig | null = null;
  try {
    config = await loadConfig(file);
    problem = verify(config);
  } catch (error) {
    problem = error instanceof CliError || error instanceof Error ? error.message : String(error);
  }
  if (problem || !config) {
    writeSource(file, original);
    fail('CONFIG_WRITE', `Couldn't update ${basename(file)}: ${problem ?? 'it did not load'}. The file is back as it was.`, 'Make the change by hand in the config, then run npx splithub doctor.');
  }
  return config;
}
