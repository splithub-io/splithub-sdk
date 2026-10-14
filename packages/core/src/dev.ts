// Plain-language notes for the developer, printed only in development
// (NODE_ENV=development): in the browser console for Vite apps, in the terminal
// for server code (Next.js middleware and Server Components). One line per
// experiment and situation, so a draft that "does nothing" explains itself
// without ?sh_debug. Production builds never print them.

import { isDevEnvironment } from './assignment';
import type { Assignment, Experiment } from './types';

const said = new Set<string>();

/** Print `message` once per `key` for this page or server process, in development only. */
export function devNote(key: string, message: string): void {
  if (!isDevEnvironment() || said.has(key)) return;
  said.add(key);
  // With the Vite plugin (@splithub/core/vite) the note goes to the dev server's terminal instead of the browser console.
  const w = typeof window !== 'undefined' ? (window as unknown as { __splithubTerminal?: boolean }) : null;
  if (w && typeof CustomEvent === 'function') window.dispatchEvent(new CustomEvent('splithub:dev', { detail: message }));
  if (w?.__splithubTerminal) return;
  if (typeof console !== 'undefined') console.info(`[splithub] ${message}`);
}

/** Forget what was printed (tests). */
export function resetDevNotes(): void {
  said.clear();
}

function others(experiment: Experiment, shown: string | undefined): string {
  return experiment.variants.map((v) => v.key).filter((k) => k !== shown).join('|');
}

/** Explain an assignment that may surprise a developer: a draft, a paused test, a test outside its dates. */
export function explainAssignment(experiment: Experiment | undefined, a: Assignment): void {
  if (!experiment || !isDevEnvironment()) return;
  const key = experiment.key;
  if (a.reason === 'dev') {
    const shown = a.variant?.key;
    devNote(`${key}:dev`, `"${key}" is a draft. You see it here because runDraftsInDev is on; this visitor gets "${shown}", try ?sh_force=${key}:${others(experiment, shown)} for the others. Visitors see it only after you start it: npx splithub start ${key}`);
    return;
  }
  if (a.reason === 'holdout') {
    devNote('holdout', `This visitor is in the holdout, so every test shows its control. Open ?sh_force=${key}:${experiment.variants[1]?.key ?? 'variant'} to see a variant.`);
    return;
  }
  if (a.reason === 'layer') {
    devNote(`${key}:layer`, `"${key}" shares layer "${experiment.layer?.key}" with other tests and this visitor's bucket belongs to another one, so they see the control.`);
    return;
  }
  if (a.reason !== 'not_running') return;
  const second = experiment.variants[1]?.key ?? 'variant';
  if (experiment.status === 'draft') {
    devNote(`${key}:draft`, `"${key}" is a draft, so everyone sees the control. To see it while you develop, add runDraftsInDev: true to splithub.config.ts, or open ?sh_force=${key}:${second}.`);
  } else if (experiment.status === 'running') {
    devNote(`${key}:schedule`, `"${key}" is outside its schedule, so everyone sees the control. Open ?sh_force=${key}:${second} to see a variant.`);
  } else {
    devNote(`${key}:${experiment.status}`, `"${key}" is ${experiment.status}, so everyone sees the control.`);
  }
}
