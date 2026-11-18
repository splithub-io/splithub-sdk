import { fetchStatus, resolveTarget, type StatusData } from '../api';
import { detectProject } from '../project';
import { printJson } from '../errors';
import { bar, c, starText, statusColor, table, verdictColor, verdictIcon } from '../ui';
import { analysisLine } from './results';

export async function status(flags: Record<string, unknown>): Promise<void> {
  const target = resolveTarget(flags, detectProject());
  const data = await fetchStatus(target);
  const finished = data.experiments.filter((e) => e.status === 'finished').map((e) => e.experiment);
  const next = finished.length ? `Finished but still in the code: ${finished.join(', ')}. Decide which variant to keep, then run npx splithub ship <id> --keep <variant> (agents: the splithub-ship skill).` : null;
  if (flags.json) {
    printJson(next ? { ...data, next } : data);
    return;
  }
  console.log(`${c.bold('SplitHub')} ${c.dim('·')} project ${c.cyan(data.project)} ${c.dim(`· ${target.url}`)}\n`);
  if (data.experiments.length === 0) {
    console.log(c.dim('No experiments in splithub.config.ts yet. Run `splithub create`.'));
    printProperties(data);
    return;
  }
  const raw = data.analysis?.available === false;
  const name = (id: string) => (id === '__holdout' ? c.bold('Holdout: long-term impact') : c.bold(id));
  // Visitors as a bar relative to the busiest experiment.
  const maxVisitors = Math.max(1, ...data.experiments.map((e) => e.visitors));
  const visitors = (e: { visitors: number; status: string }) => [String(e.visitors), bar(e.visitors, maxVisitors, 12, e.status === 'running' ? c.green : c.dim)];
  if (raw) {
    console.log(table(['EXPERIMENT', 'KIND', 'STATUS', 'VISITORS', '', 'DAYS'], data.experiments.map((e) => [name(e.experiment), e.kind, statusColor(e.status), ...visitors(e), e.days ? String(e.days) : '–'])));
    if (data.analysis) console.log(`\n${c.dim(analysisLine(data.analysis))}`);
  } else {
    console.log(
      table(
        ['EXPERIMENT', 'KIND', 'STATUS', 'VISITORS', '', 'DAYS', 'VERDICT', 'SAMPLE', 'DATA', 'NEXT CHECK'],
        data.experiments.map((e) => {
          const headline = e.headline ?? (e.goal ? 'no data' : 'no goal');
          return [
            name(e.experiment),
            e.kind,
            statusColor(e.status),
            ...visitors(e),
            e.days ? String(e.days) : '–',
            verdictColor(e.verdict ?? null, `${verdictIcon(e.goal ? e.verdict : null)} ${e.display ? `${e.display.label} · ${headline}` : headline}`),
            e.sample === 'good' ? c.green('good') : e.sample === 'ok' ? 'ok' : e.sample === 'small' ? c.dim('small') : '',
            typeof e.stars === 'number' ? c.yellow(starText(e.stars)) : '',
            e.status === 'running' && e.daysToVerdict && e.daysToVerdict > 0 ? c.dim(`in ~${Math.ceil(e.daysToVerdict)}d`) : '',
          ];
        })
      )
    );
  }
  printProperties(data);
  if (next) console.log(`\n${c.dim(next)}`);
}

const change = (x: number | null, before: number) => (x === null ? (before === 0 ? c.dim('new') : '–') : x >= 0 ? c.green(`+${Math.round(x * 100)}%`) : c.red(`${Math.round(x * 100)}%`));

/** One line per analytics property: its last 7 days against the 7 before (SplitHub Cloud). */
export function printProperties(data: Pick<StatusData, 'properties' | 'propertiesRange'>): void {
  if (!data.properties?.length) return;
  const range = data.propertiesRange ? ` ${c.dim(`· ${data.propertiesRange.from} to ${data.propertiesRange.to}`)}` : '';
  console.log(`\n${c.bold('Analytics')}${range}`);
  console.log(
    table(
      ['PROPERTY', 'STATUS', 'VISITORS', 'VS WEEK BEFORE', 'GOALS'],
      data.properties.map((p) => [c.bold(p.name), statusColor(p.status), String(p.visitors), change(p.change, p.previousVisitors), p.conversions.map((g) => `${g.goal} ${g.conversions}`).join(', ') || c.dim('–')])
    )
  );
  console.log(c.dim('Details: npx splithub analytics <property>'));
}
