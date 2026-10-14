// `splithub plan`: sample size for a planned test. SplitHub Cloud sizes it (GET /plan, no login
// needed); with an experiment id and access to its numbers, the CLI adds the days at its pace.
import { cloudTarget, fetchPlan, fetchStatus, resolveTarget, type PlanResult } from '../api';
import { CliError, fail, printJson } from '../errors';
import { detectProject } from '../project';
import { c } from '../ui';
import type { Flags } from './init';

function num(flags: Flags, name: string): number | undefined {
  const v = flags[name];
  if (typeof v !== 'string' || v === '') return undefined;
  const n = Number(v.replace(/%$/, '')) / (v.endsWith('%') ? 100 : 1);
  if (!Number.isFinite(n)) fail('INVALID_FLAG', `--${name} "${v}" isn't a number.`);
  return n;
}

export type Plan = PlanResult;

/** Ask SplitHub Cloud for the sample size. Bad numbers are INVALID_FLAG; no connection says planning needs the cloud. */
export async function requestPlan(flags: Flags, baseline: number, mde: number, variants: number): Promise<Plan> {
  if (!(baseline > 0 && baseline < 1)) fail('INVALID_FLAG', `--baseline ${baseline} must be a rate between 0 and 1.`, 'For example --baseline 0.05 for 5% of visitors converting today.');
  if (!(mde > 0)) fail('INVALID_FLAG', `--mde ${mde} must be above 0.`, 'The smallest relative lift worth finding, e.g. --mde 0.1 for +10%.');
  if (!Number.isInteger(variants) || variants < 2) fail('INVALID_FLAG', '--variants must be a whole number of 2 or more.');
  const target = cloudTarget(flags);
  try {
    return await fetchPlan(target, { baseline, mde, variants });
  } catch (error) {
    if (error instanceof CliError && error.code === 'UNREACHABLE') fail('UNREACHABLE', `Planning a test needs SplitHub Cloud, and we can't reach ${target.url} right now.`, 'Check your connection and try again. No account needed.');
    if (error instanceof CliError && error.code === 'API_ERROR') fail('INVALID_FLAG', error.message, error.hint);
    throw error;
  }
}

/** `splithub plan --baseline 0.05 --mde 0.1 [--variants 2] [<id>]` */
export async function plan(id: string | undefined, flags: Flags): Promise<void> {
  const baseline = num(flags, 'baseline');
  const mde = num(flags, 'mde');
  if (baseline === undefined || mde === undefined) fail('USAGE', 'Pass --baseline (conversion rate today) and --mde (smallest lift worth finding).', 'For example: npx splithub plan --baseline 0.05 --mde 0.1');
  const p = await requestPlan(flags, baseline, mde, num(flags, 'variants') ?? 2);

  // With an experiment id: days at its current traffic, when its numbers are readable (signed in, or the app running).
  let traffic: { experiment: string; visitors: number; days: number; perDay: number; daysLeft: number | null } | null = null;
  if (id) {
    const data = await fetchStatus(resolveTarget(flags, detectProject())).catch(() => null);
    const row = data?.experiments.find((e) => e.experiment === id);
    if (data && !row) fail('EXPERIMENT_NOT_FOUND', `There's no experiment "${id}" in the results.`, 'See the ids with npx splithub status.');
    if (row) {
      const perDay = row.days > 0 ? row.visitors / row.days : 0;
      traffic = { experiment: id, visitors: row.visitors, days: row.days, perDay: Math.round(perDay), daysLeft: perDay > 0 ? Math.max(0, Math.ceil((p.total - row.visitors) / perDay)) : null };
    }
  }

  if (flags.json) {
    printJson({ ...p, traffic });
    return;
  }
  console.log(`${c.bold(p.perVariant.toLocaleString('en-US'))} visitors per variant, ${p.total.toLocaleString('en-US')} in all`);
  console.log(c.dim(`to find a ${(p.mde * 100).toFixed(0)}% lift on a ${(p.baseline * 100).toFixed(1)}% rate (${Math.round(p.confidence * 100)}% confidence, 80% power, safe to check daily)`));
  if (id && !traffic) console.log(c.dim(`Couldn't read ${id}'s traffic, so no days estimate. Sign in (npx splithub login) or start your app.`));
  if (traffic) {
    if (traffic.daysLeft === null) console.log(c.yellow(`${id} has no visitors yet, so there's no pace to go by.`));
    else if (traffic.daysLeft === 0) console.log(c.green(`${id} already has enough visitors (${traffic.visitors.toLocaleString('en-US')}).`));
    else console.log(`About ${traffic.daysLeft} more days for ${id} at ${traffic.perDay.toLocaleString('en-US')} visitors a day.`);
  }
}
