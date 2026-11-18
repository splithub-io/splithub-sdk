// `splithub report`: status and verdicts as Markdown, for a PR or issue comment
// (the GitHub workflow from `ci init` posts it) or anywhere Markdown renders.
// SplitHub Cloud writes the report; a self-hosted endpoint gets a raw-numbers table built here.
import { fetchReport, fetchResults, fetchStatus, isRawResults, resolveTarget, type RawResults, type StatusData, type Target } from '../api';
import { printJson } from '../errors';
import { detectProject } from '../project';
import { pct } from '../ui';
import type { Flags } from './init';

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const title = (id: string) => (id === '__holdout' ? 'Holdout: long-term impact' : `\`${cell(id)}\``);

/** Raw numbers only: no verdicts, which come with SplitHub Cloud. */
export function rawReportMarkdown(data: StatusData, details: RawResults[]): string {
  const out: string[] = [`### SplitHub · ${cell(data.project)}`, ''];
  if (data.experiments.length === 0) {
    out.push('No experiments yet. Run `npx splithub create` in your app.');
    return out.join('\n');
  }
  out.push('| Experiment | Status | Visitors | Days |', '|---|---|---:|---:|');
  for (const r of data.experiments) out.push(`| ${title(r.experiment)} | ${r.status} | ${r.visitors.toLocaleString('en-US')} | ${r.days || '–'} |`);
  for (const d of details) {
    const revenue = d.variants.some((v) => v.revenue !== undefined);
    out.push('', `#### ${title(d.experiment)} · goal \`${cell(d.goal ?? 'none')}\``, '');
    out.push(`| Variant | Visitors | Conversions | Rate |${revenue ? ' Revenue |' : ''}`, `|---|---:|---:|---:|${revenue ? '---:|' : ''}`);
    d.variants.forEach((v, i) => out.push(`| ${cell(v.variant)}${i === 0 ? ' (control)' : ''} | ${v.visitors} | ${v.conversions} | ${pct(v.rate)} |${revenue ? ` ${v.revenue === undefined ? '–' : v.revenue.toFixed(2)} |` : ''}`));
  }
  const analysis = data.analysis ?? details[0]?.analysis;
  if (analysis) out.push('', `_${analysis.message} [SplitHub Cloud](${analysis.url})_`);
  return out.join('\n');
}

async function selfHostedReport(target: Target, data: StatusData): Promise<{ project: string; markdown: string }> {
  const worth = data.experiments.filter((e) => e.goal && (e.status === 'running' || e.status === 'finished' || e.status === 'paused'));
  const details = await Promise.all(worth.map((e) => fetchResults(target, e.experiment).catch(() => null)));
  return { project: data.project, markdown: rawReportMarkdown(data, details.filter((d): d is RawResults => d !== null && isRawResults(d))) };
}

export async function report(flags: Flags): Promise<void> {
  const target = resolveTarget(flags, detectProject());
  let out: { project: string; markdown: string };
  if (target.cloud) out = await fetchReport(target);
  else {
    // --url can point at either kind of server: the status answer says which.
    const data = await fetchStatus(target);
    out = data.analysis?.available === false ? await selfHostedReport(target, data) : await fetchReport(target);
  }
  if (flags.json) printJson({ project: out.project, markdown: out.markdown });
  else console.log(out.markdown);
}
