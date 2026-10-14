import { assign, isActive } from './assignment';
import { normalizePath, matchPath } from './paths';
import type { Assignment, Experiment, SplitHubConfig, TargetingContext } from './types';

export interface RedirectDecision {
  experiment: string;
  variant: string;
  /** Destination (`to` of the variant) when the visitor must be moved; null when they stay. */
  to: string | null;
  /** Why this variant: `assigned`, `dev` (a draft in development) or `override` (`?sh_force`). */
  reason: Assignment['reason'];
}

/**
 * Which redirect experiment applies to `pathname`, and where the visitor goes.
 * The first active experiment that matches and assigns a variant wins. Pure:
 * sh.js and the Next.js middleware ask the same question and get the same answer.
 * `explain` hears every assignment it made for a matching experiment (the
 * middleware prints the surprising ones in development).
 */
export function decideRedirect(
  config: SplitHubConfig,
  pathname: string,
  visitorId: string,
  context: TargetingContext = {},
  overrides: Record<string, string> = {},
  explain?: (experiment: Experiment, assignment: Assignment) => void
): RedirectDecision | null {
  for (const exp of config.experiments) {
    if (exp.kind !== 'redirect' || !exp.match || !matchPath(exp.match, pathname)) continue;
    if (!isActive(config, exp, context.now)) {
      explain?.(exp, { experiment: exp.key, variant: null, reason: 'not_running' });
      continue;
    }
    const a = assign(config, exp.key, visitorId, { overrides, context });
    explain?.(exp, a);
    if (!a.variant) continue;
    const to = a.variant.to || null;
    const stays = !to || normalizePath(to.split(/[?#]/)[0] ?? '') === normalizePath(pathname);
    return { experiment: exp.key, variant: a.variant.key, to: stays ? null : to, reason: a.reason };
  }
  return null;
}
