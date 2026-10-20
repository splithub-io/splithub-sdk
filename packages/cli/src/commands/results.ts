// `splithub results <id>`: one experiment. SplitHub Cloud sends the verdict with ready-to-print
// words (`display`, `voice`); this file only lays them out. A self-hosted endpoint sends raw counts.
import { fetchResults, isRawResults, resolveTarget, type Analysis, type CloudResults, type RawResults, type Results, type Verdict } from '../api';
import { fail, printJson } from '../errors';
import { detectProject } from '../project';
import { bar, c, pct, statusColor, table, verdictColor, verdictIcon } from '../ui';
import { breakdown, breakdownCsv, engagement, eventsByVariant, eventsByVariantCsv, fetchSlice, printScope, timeline, wantsSlice } from './experiment-reports';
import type { Flags } from './init';

export const HOLDOUT = '__holdout';

/** For finished tests on a self-hosted endpoint (the cloud sends `display.next`). */
const FINISHED_NEXT = 'This experiment is finished but its variants are still in the code. Decide which variant to keep, then run npx splithub ship <id> --keep <variant> (agents: the splithub-ship skill).';

export async function results(key: string | undefined, flags: Flags): Promise<void> {
  if (!key) fail('USAGE', 'Which experiment? npx splithub results <id>');
  // One view at a time: a breakdown, a timeline, engagement or events; each takes the same range and filters.
  const views = [flags.by !== undefined && !flags.export, flags.timeline === true, flags.engagement === true, flags.events === true].filter(Boolean).length;
  if (views > 1) fail('USAGE', 'One view at a time: --by, --timeline, --engagement or --events.');
  if (flags.export && flags.events) return eventsByVariantCsv(key, flags);
  if (flags.export) return breakdownCsv(key, flags);
  if (flags.events) return eventsByVariant(key, flags);
  if (flags.by !== undefined) return breakdown(key, flags);
  if (flags.timeline) return timeline(key, flags);
  if (flags.engagement) return engagement(key, flags);
  const slice = wantsSlice(flags);
  const r = slice ? await fetchSlice<Results>(key, flags) : await fetchResults(resolveTarget(flags, detectProject()), key);
  const raw = isRawResults(r);
  if (flags.json) {
    const next = raw && r.status === 'finished' && r.experiment !== HOLDOUT ? { next: FINISHED_NEXT } : {};
    // A slice carries no advice (current servers leave it out; an older one may not).
    printJson(!raw && r.scope ? { ...r, voice: undefined } : { ...r, ...next });
    return;
  }
  const title = r.experiment === HOLDOUT ? 'Holdout: long-term impact' : r.experiment;
  console.log(`${c.bold(title)} ${c.dim(`· ${r.kind} · `)}${statusColor(r.status)} ${c.dim(`· goal: ${r.goal ?? 'none'}`)}`);
  if (r.description) console.log(c.dim(r.description));
  console.log();
  if (raw) printRaw(r);
  else {
    printScope(r.scope);
    printCloud(r);
  }
}

/** Self-hosted: the counts as they are, and where verdicts come from. */
function printRaw(r: RawResults): void {
  const revenue = r.variants.some((v) => v.revenue !== undefined);
  console.log(
    table(
      ['VARIANT', 'VISITORS', 'CONV', 'RATE', ...(revenue ? ['REVENUE'] : [])],
      r.variants.map((v, i) => [i === 0 ? `${v.variant} ${c.dim('(control)')}` : v.variant, String(v.visitors), String(v.conversions), pct(v.rate), ...(revenue ? [v.revenue === undefined ? '–' : v.revenue.toFixed(2)] : [])])
    )
  );
  for (const m of r.metrics ?? []) {
    console.log();
    console.log(c.dim(m.role === 'guardrail' ? `GUARDRAIL ${m.metric}${m.worse === 'higher' ? ' (a rise is bad)' : ''}` : `ALSO ${m.metric}`));
    console.log(table(['VARIANT', 'CONV', 'RATE'], m.variants.map((v) => [v.variant, String(v.conversions), pct(v.rate)])));
  }
  console.log();
  console.log(c.dim(analysisLine(r.analysis)));
  if (r.status === 'finished' && r.experiment !== HOLDOUT) console.log(c.dim(FINISHED_NEXT));
}

/** "Verdicts, stars and recommendations come with SplitHub Cloud. https://…" */
export function analysisLine(a: Analysis): string {
  return `${a.message} ${a.url}`;
}

function printCloud(r: CloudResults): void {
  const v = r.verdict;
  const d = r.display;
  // Older servers send no display: the factual message alone.
  console.log(verdictColor(v.status, d ? `${verdictIcon(v.status)} ${d.label}  ${v.message}` : v.message));
  if (d) {
    // A slice is numbers only: the friendly line speaks for the whole experiment.
    if (r.voice?.line && !r.scope) console.log(r.voice.line);
    for (const line of d.lines) if (line !== r.voice?.line) console.log(c.dim(line));
  }
  console.log();

  const rate = (cnt: { exposures: number; conversions: number }) => (cnt.exposures > 0 ? cnt.conversions / cnt.exposures : 0);
  const pValue = (cmp: Verdict['comparisons'][number]) => cmp.sequential?.pValue ?? cmp.pValue;
  const ci = (cmp: Verdict['comparisons'][number]) => cmp.sequential?.ci ?? cmp.ci;
  console.log(
    table(
      ['VARIANT', 'VISITORS', 'CONV', 'RATE', 'LIFT', 'P(BEAT)', 'P-VALUE', '95% CI'],
      // Always-valid (sequential) p-value and interval: the ones the verdict uses, safe to read any day.
      v.sample.variants.map((cnt, i) => {
        const cmp = v.comparisons.find((x) => x.variant === cnt.variant);
        const name = i === 0 ? `${cnt.variant} ${c.dim('(control)')}` : cnt.variant;
        return [
          v.winner === cnt.variant ? c.green(`★ ${name}`) : name,
          String(cnt.exposures),
          String(cnt.conversions),
          pct(rate(cnt)),
          cmp ? pct(cmp.relativeLift, true) : '–',
          cmp ? pct(cmp.probabilityToBeat) : '–',
          cmp ? pValue(cmp).toFixed(4) : '–',
          cmp ? `${pct(ci(cmp).low, true)} … ${pct(ci(cmp).high, true)}` : '–',
        ];
      })
    )
  );
  // Rates as bars, lift next to them; P(beat) as a second bar. Reads at a glance in a terminal.
  const maxRate = Math.max(0.0001, ...v.sample.variants.map(rate));
  const nameWidth = Math.max(...v.sample.variants.map((cnt) => cnt.variant.length));
  console.log();
  console.log(c.dim('RATE'));
  for (const cnt of v.sample.variants) {
    const cmp = v.comparisons.find((x) => x.variant === cnt.variant);
    const lift = cmp?.relativeLift ?? 0;
    const paint = v.winner === cnt.variant ? c.green : cmp && lift < 0 ? c.red : c.cyan;
    const liftText = cmp ? (lift >= 0 ? c.green(`▲ ${pct(cmp.relativeLift, true)}`) : c.red(`▼ ${pct(cmp.relativeLift, true)}`)) : c.dim('baseline');
    console.log(`${cnt.variant.padEnd(nameWidth)}  ${bar(rate(cnt), maxRate, 24, paint)}  ${pct(rate(cnt)).padStart(6)}  ${liftText}`);
  }
  if (v.comparisons.length) {
    console.log();
    console.log(c.dim('CHANCE TO BEAT THE CONTROL'));
    for (const cmp of v.comparisons) {
      const paint = cmp.probabilityToBeat >= 0.95 ? c.green : cmp.probabilityToBeat <= 0.05 ? c.red : c.yellow;
      console.log(`${cmp.variant.padEnd(nameWidth)}  ${bar(cmp.probabilityToBeat, 1, 24, paint)}  ${pct(cmp.probabilityToBeat).padStart(6)}`);
    }
  }
  if (r.factors?.length) {
    console.log();
    console.log(c.bold('Each factor on its own') + c.dim(' (a level sums every combination that uses it, compared with the first level)'));
    for (const f of r.factors) {
      console.log(
        table(
          [f.key.toUpperCase(), 'VISITORS', 'CONV', 'RATE', 'LIFT', 'P-VALUE'],
          f.levels.map((l) => [l.level + (f.best === l.level ? c.green(' ✔') : ''), String(l.exposures), String(l.conversions), pct(l.rate), l.relativeLift === null ? '–' : pct(l.relativeLift, true), l.pValue === null ? '–' : l.pValue.toFixed(3)])
        )
      );
    }
  }
  if (v.metrics?.length) {
    console.log();
    console.log(metricsText(v));
  }
  if (d?.next) {
    console.log();
    console.log(c.dim(d.next));
  }
}

/** Secondary metrics and guardrails, one small table each. A breached guardrail is marked. */
export function metricsText(v: Verdict): string {
  const out: string[] = [];
  for (const m of v.metrics ?? []) {
    const head = m.role === 'guardrail' ? `GUARDRAIL ${m.metric}${m.worse === 'higher' ? ' (a rise is bad)' : ''}` : `ALSO ${m.metric}`;
    out.push(c.dim(head));
    out.push(
      table(
        ['VARIANT', 'CONV', 'RATE', 'LIFT', 'P-VALUE', ''],
        m.variants.map((cnt) => {
          const cmp = m.comparisons.find((x) => x.variant === cnt.variant);
          const breach = v.guardrailBreached?.find((b) => b.metric === m.metric && b.variant === cnt.variant);
          return [cnt.variant, String(cnt.conversions), pct(cnt.exposures ? cnt.conversions / cnt.exposures : 0), cmp ? pct(cmp.relativeLift, true) : '–', cmp ? (cmp.sequential?.pValue ?? cmp.pValue).toFixed(4) : '–', breach ? c.red('✖ worse') : ''];
        })
      )
    );
  }
  return out.join('\n');
}
