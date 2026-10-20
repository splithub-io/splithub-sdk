import type { ExperimentStatus } from '@splithub/core';
import { relative } from 'node:path';
import { applyLiveStatus } from '../api';
import { loadConfig, readSource, setExperimentStatus, writeConfigChecked } from '../config-file';
import { fail, printJson } from '../errors';
import { requireConfig } from '../project';
import { c } from '../ui';
import type { Flags } from './init';

const MAP: Record<string, ExperimentStatus> = { start: 'running', pause: 'paused', finish: 'finished' };

export async function lifecycle(command: string, id: string | undefined, flags: Flags): Promise<void> {
  const status = MAP[command];
  if (!status) fail('USAGE', `Unknown command "${command}".`);
  if (!id) fail('USAGE', `Which experiment? npx splithub ${command} <id>`);
  const project = requireConfig();
  const file = relative(project.root, project.configFile);

  // Validate before touching the file: the config must load and know the experiment.
  const before = await loadConfig(project.configFile);
  const current = before.experiments.find((e) => e.key === id);
  if (!current) fail('EXPERIMENT_NOT_FOUND', `There's no experiment "${id}" in ${file}.`, 'See the ids with npx splithub status.');

  if (current.status !== status) {
    const original = readSource(project.configFile);
    const updated = setExperimentStatus(original, id, status);
    await writeConfigChecked(project.configFile, original, updated, (config) => {
      const e = config.experiments.find((x) => x.key === id);
      return !e ? `"${id}" disappeared` : e.status !== status ? `"${id}" is still ${e.status}` : null;
    });
  }

  // Cloud mode: also apply it live through a remote override, so no deploy is needed.
  const live = before.storage.mode === 'cloud' ? await applyLiveStatus(flags, id, status) : 'skipped';

  // A finished test keeps its numbers, but every variant is still in the code until someone decides.
  const next = status === 'finished' ? `Read the verdict (npx splithub results ${id}), decide which variant to keep, then run npx splithub ship ${id} --keep <variant> to remove the experiment from the code and the config.` : null;
  if (flags.json) printJson({ experiment: id, status, previous: current.status, configFile: file, live, ...(next ? { next } : {}) });
  else {
    console.log(`${c.green('✔')} ${c.bold(id)} → ${status} ${c.dim(`(${file})`)}`);
    if (live === 'applied') console.log(`${c.green('✔')} live in the cloud within 60s, no deploy needed (the config change ships with your next deploy)`);
    else if (live !== 'skipped') console.log(c.yellow(`! ${live}`));
    if (next) console.log(c.dim(`Next: ${next}`));
  }
}
