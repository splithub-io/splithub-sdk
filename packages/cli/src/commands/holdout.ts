// `splithub holdout set <percent> [--goal g]` / `splithub holdout off`: a share of visitors
// that never sees any test, compared with everyone else as `__holdout` (long-term impact).
import { relative } from 'node:path';
import { loadConfig, readSource, setTopLevel, writeConfigChecked } from '../config-file';
import { fail, printJson } from '../errors';
import { requireConfig } from '../project';
import { c } from '../ui';
import type { Flags } from './init';

export async function holdout(action: string | undefined, value: string | undefined, flags: Flags): Promise<void> {
  if (action !== 'set' && action !== 'off') fail('USAGE', 'Use npx splithub holdout set <percent> or npx splithub holdout off.');
  const project = requireConfig();
  const config = await loadConfig(project.configFile);
  const percent = action === 'off' ? 0 : Number(value);
  if (action === 'set' && (!Number.isFinite(percent) || percent <= 0 || percent > 50)) fail('INVALID_FLAG', `Holdout "${value ?? ''}" must be a percent above 0 and at most 50.`, 'Most teams keep 5-10% out.');
  const goal = typeof flags.goal === 'string' ? flags.goal : undefined;
  if (goal && !config.goals.some((g) => g.key === goal)) fail('GOAL_NOT_FOUND', `There's no goal "${goal}" in the config.`);

  const original = readSource(project.configFile);
  const text = percent === 0 ? null : `{ percent: ${percent}${goal ? `, goal: '${goal}'` : ''} }`;
  await writeConfigChecked(project.configFile, original, setTopLevel(original, 'holdout', text), (loaded) => {
    const h = (loaded as { holdout?: { percent: number } | null }).holdout;
    return percent === 0 ? (h ? 'the holdout is still there' : null) : h?.percent === percent ? null : 'the holdout did not load back';
  });
  const out = { holdout: percent === 0 ? null : { percent, goal: goal ?? null }, configFile: relative(project.root, project.configFile), next: config.storage.mode === 'cloud' ? 'npx splithub push' : 'deploy the app' };
  if (flags.json) {
    printJson(out);
    return;
  }
  console.log(percent === 0 ? `${c.green('✔')} holdout off` : `${c.green('✔')} ${percent}% of visitors stay out of every test; status shows them as "Holdout: long-term impact".`);
  console.log(c.dim(`Next: ${out.next}.`));
}
