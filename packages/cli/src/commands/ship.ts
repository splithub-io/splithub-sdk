// `splithub ship <id> --keep <variant> [--dry-run]`: finish the test, remove it from the
// config and rewrite the code so it behaves like the kept variant. Returns the diff and
// whatever it could not rewrite safely.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import type * as TS from 'typescript';
import { archiveLive } from '../api';
import { shipSource, type Leftover } from '../codemod';
import { loadConfig, readSource, removeExperiment, writeConfigChecked } from '../config-file';
import { unifiedDiff } from '../diff';
import { fail, printJson } from '../errors';
import { grepFiles, listSourceFiles, quoted, requireConfig } from '../project';
import { findRefs } from '../refs';
import { c } from '../ui';
import type { Flags } from './init';

/** TypeScript from the user's project first (same version as their code), else ours. */
async function loadTypeScript(root: string): Promise<typeof TS> {
  try {
    return createRequire(join(root, 'package.json'))('typescript') as typeof TS;
  } catch {
    try {
      const mod = (await import('typescript')) as typeof TS & { default?: typeof TS };
      return mod.default ?? mod;
    } catch {
      fail('TYPESCRIPT_MISSING', '`splithub ship` rewrites code with the TypeScript compiler, and it is not installed here.', 'Run npm install -D typescript (any 5.x), then retry.');
    }
  }
}

export interface ShipFile {
  file: string;
  diff: string;
  leftovers: Leftover[];
}

export async function ship(id: string | undefined, flags: Flags): Promise<void> {
  if (!id) fail('USAGE', 'Which experiment? npx splithub ship <id> --keep <variant>');
  const keep = typeof flags.keep === 'string' ? flags.keep : '';
  const project = requireConfig();
  const config = await loadConfig(project.configFile);
  const exp = config.experiments.find((e) => e.key === id);
  if (!exp) fail('EXPERIMENT_NOT_FOUND', `There's no experiment "${id}" in the config.`, 'See the ids with npx splithub status.');
  if (!keep) fail('USAGE', 'Which variant stays? Pass --keep <variant>.', `Variants of ${id}: ${exp.variants.map((v) => v.key).join(', ')}. Read the verdict first: npx splithub results ${id}.`);
  const variant = exp.variants.find((v) => v.key === keep);
  if (!variant) fail('VARIANT_NOT_FOUND', `"${id}" has no variant "${keep}".`, `Pick one of: ${exp.variants.map((v) => v.key).join(', ')}.`);
  const dryRun = Boolean(flags['dry-run']);

  const ts = await loadTypeScript(project.root);
  const hasValue = exp.kind === 'value' || exp.kind === 'mvt';
  const target = { id, keep, value: (variant as { value?: unknown }).value, hasValue };

  // Rewrite in memory first: nothing is written unless the config change works too.
  const files = grepFiles(listSourceFiles(project.root), id).filter((f) => !/(^|[\\/])splithub\.config\.[mc]?[jt]s$/.test(f));
  const changes: Array<ShipFile & { abs: string; output: string }> = [];
  const leftovers: Array<Leftover & { file: string }> = [];
  for (const abs of files) {
    const source = readFileSync(abs, 'utf8');
    if (!quoted(id).some((q) => source.includes(q))) continue;
    const rel = relative(project.root, abs).replace(/\\/g, '/');
    const r = shipSource(ts, abs, source, target);
    for (const l of r.leftovers) leftovers.push({ file: rel, ...l });
    if (r.changed) changes.push({ file: rel, abs, output: r.output, diff: unifiedDiff(rel, source, r.output), leftovers: r.leftovers });
  }

  const configRel = relative(project.root, project.configFile).replace(/\\/g, '/');
  const original = readSource(project.configFile);
  const updatedConfig = removeExperiment(original, id);
  const configDiff = unifiedDiff(configRel, original, updatedConfig);

  let live = 'skipped';
  if (!dryRun) {
    await writeConfigChecked(project.configFile, original, updatedConfig, (loaded) => (loaded.experiments.some((e) => e.key === id) ? `"${id}" is still in the config` : null));
    for (const ch of changes) writeFileSync(ch.abs, ch.output, 'utf8');
    if (config.storage.mode === 'cloud') live = await archiveLive(flags, id);
  }

  // Goals: keep track() calls when another experiment still measures the goal.
  const goalRefs = exp.goal ? findRefs(project.root, config, id).refs.filter((r) => r.match === 'goal') : [];
  const goalNote = exp.goal ? (config.experiments.some((e) => e.key !== id && e.goal === exp.goal) ? `Keep track('${exp.goal}'): another experiment measures it.` : `Nothing else measures "${exp.goal}". Remove its track() calls and the goal if you no longer need it.`) : null;
  const loser = exp.kind === 'component' ? `Delete the components only the other variants used (e.g. splithub/${id}/).` : exp.kind === 'redirect' ? `Make the kept page the real one: ${String((variant as { to?: unknown }).to ?? '')}.` : null;
  // Archived in the cloud, a push drops it; otherwise the push keeps it unless it prunes.
  const pushStep = config.storage.mode !== 'cloud' ? null : live === 'archived' || live === 'finished' ? 'npx splithub push' : 'npx splithub push --prune';
  const next = [pushStep, 'npx splithub doctor', "the project's typecheck and tests", loser, goalNote].filter((x): x is string => Boolean(x));

  const diff = [configDiff, ...changes.map((ch) => ch.diff)].join('');
  const out = {
    experiment: id,
    kept: keep,
    kind: exp.kind,
    dryRun,
    finished: dryRun ? false : true,
    live,
    configFile: configRel,
    files: changes.map((ch) => ch.file),
    diff,
    leftovers,
    goal: exp.goal ?? null,
    goalRefs: goalRefs.length,
    next,
  };
  if (flags.json) {
    printJson(out);
    return;
  }
  console.log(diff || c.dim('No code changes.'));
  if (leftovers.length) {
    console.log(c.yellow(`${leftovers.length} place(s) to finish by hand:`));
    for (const l of leftovers) console.log(`  ${c.cyan(`${l.file}:${l.line}`)}  ${l.text}  ${c.dim(l.reason)}`);
  }
  if (dryRun) console.log(c.dim(`Dry run: nothing changed. Run it without --dry-run to apply.`));
  else {
    console.log(`${c.green('✔')} kept ${c.bold(keep)}, removed ${c.bold(id)} from ${configRel}${changes.length ? ` and rewrote ${changes.length} file(s)` : ''}`);
    if (live === 'archived' || live === 'finished') console.log(`${c.green('✔')} ${live} in the cloud; its numbers stay readable`);
    else if (live !== 'skipped') console.log(c.yellow(`! ${live}`));
  }
  console.log(c.dim(`Next: ${next.join(' · ')}`));
}
