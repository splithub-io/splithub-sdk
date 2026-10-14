import type { SplitHubConfig } from '@splithub/core';
import { loadConfig } from '../config-file';
import { fail, printJson } from '../errors';
import { requireConfig } from '../project';
import { findRefs } from '../refs';
import { c } from '../ui';
import type { Flags } from './init';

/** `splithub refs <id>`: every file and line that mentions the experiment or its goal. */
export async function refs(id: string | undefined, flags: Flags): Promise<void> {
  if (!id) fail('USAGE', 'Which experiment? npx splithub refs <id>');
  const project = requireConfig();
  // A config that doesn't load still lets us search for the id itself.
  let config: SplitHubConfig | null = null;
  try {
    config = await loadConfig(project.configFile);
  } catch {
    config = null;
  }
  const result = findRefs(project.root, config, id);
  const inConfig = Boolean(config?.experiments.some((e) => e.key === id));
  if (flags.json) {
    printJson({ ...result, inConfig, count: result.refs.length });
    return;
  }
  if (result.refs.length === 0) {
    console.log(c.dim(`Nothing in the code mentions "${id}"${result.goal ? ` or its goal "${result.goal}"` : ''}.`));
    return;
  }
  for (const r of result.refs) console.log(`${c.cyan(`${r.file}:${r.line}`)}  ${r.match === 'goal' ? c.dim('[goal] ') : ''}${r.text}`);
  if (result.goal && result.goalShared) console.log(c.dim(`\nAnother experiment also measures "${result.goal}": keep its track() calls.`));
}
