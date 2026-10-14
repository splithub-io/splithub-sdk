import { relative } from 'node:path';
import { archiveLive } from '../api';
import { loadConfig, readSource, removeExperiment, writeConfigChecked } from '../config-file';
import { fail, printJson } from '../errors';
import { requireConfig } from '../project';
import { findRefs } from '../refs';
import { c } from '../ui';
import type { Flags } from './init';

/**
 * Take an experiment out of splithub.config.ts. In cloud mode it is also set to
 * finished, so visitors stop entering it right away and its numbers stay readable.
 */
export async function removeFromConfig(id: string, flags: Flags): Promise<{ configFile: string; cloud: string; mode: string }> {
  const project = requireConfig();
  const before = await loadConfig(project.configFile);
  if (!before.experiments.some((e) => e.key === id)) fail('EXPERIMENT_NOT_FOUND', `There's no experiment "${id}" in the config.`, 'See the ids with npx splithub status.');
  const original = readSource(project.configFile);
  await writeConfigChecked(project.configFile, original, removeExperiment(original, id), (config) => (config.experiments.some((e) => e.key === id) ? `"${id}" is still in the config` : config.experiments.length !== before.experiments.length - 1 ? 'another experiment went missing' : null));
  const cloud = before.storage.mode === 'cloud' ? await archiveLive(flags, id) : 'skipped';
  return { configFile: relative(project.root, project.configFile), cloud, mode: before.storage.mode };
}

/** `splithub remove <id>` */
export async function remove(id: string | undefined, flags: Flags): Promise<void> {
  if (!id) fail('USAGE', 'Which experiment? npx splithub remove <id>');
  const project = requireConfig();
  const { configFile, cloud, mode } = await removeFromConfig(id, flags);
  const left = findRefs(project.root, null, id).refs;
  const next = [mode === 'cloud' ? 'npx splithub push' : null, left.length ? `remove the ${left.length} line(s) in the code that still use "${id}" (npx splithub refs ${id})` : null].filter(Boolean).join(', then ');
  if (flags.json) {
    printJson({ experiment: id, removed: true, configFile, cloud, refs: left, ...(next ? { next } : {}) });
    return;
  }
  console.log(`${c.green('✔')} removed ${c.bold(id)} from ${configFile}`);
  if (cloud === 'archived' || cloud === 'finished') console.log(`${c.green('✔')} ${cloud} in the cloud; its numbers stay readable`);
  else if (cloud !== 'skipped') console.log(c.yellow(`! ${cloud}`));
  for (const r of left) console.log(`  ${c.cyan(`${r.file}:${r.line}`)}  ${r.text}`);
  if (next) console.log(c.dim(`Next: ${next}.`));
}
