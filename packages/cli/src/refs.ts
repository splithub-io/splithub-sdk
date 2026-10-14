// Where an experiment and its goal appear in the project's code. Shared by
// `doctor` (is it wired?), `refs` (what to touch) and `ship` (what is left).
import type { SplitHubConfig } from '@splithub/core';
import { grepLines, listSourceFiles, quoted, type LineHit } from './project';

export interface Ref extends Omit<LineHit, 'needle'> {
  /** experiment: the id in quotes · goal: the goal key in quotes. */
  match: 'experiment' | 'goal';
}

export interface RefsResult {
  experiment: string;
  goal: string | null;
  /** True when another experiment measures the same goal: keep its track() calls. */
  goalShared: boolean;
  refs: Ref[];
}

const CONFIG_FILE = /(^|\/)splithub\.config\.[mc]?[jt]s$/;

export function findRefs(root: string, config: SplitHubConfig | null, id: string, files = listSourceFiles(root)): RefsResult {
  const exp = config?.experiments.find((e) => e.key === id);
  const goal = exp?.goal ?? null;
  const goalShared = Boolean(goal && config?.experiments.some((e) => e.key !== id && e.goal === goal));
  const code = files.filter((f) => !CONFIG_FILE.test(f.replace(/\\/g, '/')));
  const refs: Ref[] = grepLines(root, code, quoted(id)).map(({ needle: _n, ...hit }) => ({ ...hit, match: 'experiment' as const }));
  if (goal) {
    for (const { needle: _n, ...hit } of grepLines(root, code, quoted(goal))) {
      if (!refs.some((r) => r.file === hit.file && r.line === hit.line)) refs.push({ ...hit, match: 'goal' });
    }
  }
  refs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { experiment: id, goal, goalShared, refs };
}
