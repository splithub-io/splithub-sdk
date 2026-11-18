// splithub notes — what happened on a day ("launched the new pricing page", "checkout broke on
// Safari"). One list for the project: a note belongs to one experiment, one analytics property, or
// the whole project (shown on every chart). SplitHub Cloud only.
//
//   splithub notes [--experiment <key> | --property <id>] [--kind note|issue|win] [--days 30 | --from --to]
//   splithub notes add "<text>" [--kind issue|win|note] [--experiment <key> | --property <id>] [--day YYYY-MM-DD]
//   splithub notes edit <id> ["<new text>"] [--kind ...] [--day ...]
//   splithub notes delete <id>

import { request } from '../api';
import { fail, printJson } from '../errors';
import { c, table } from '../ui';
import { cloudOnly, reportQuery, str } from './analytics-reports';
import type { Flags } from './init';

export const NOTE_KINDS = ['note', 'issue', 'win'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const enc = encodeURIComponent;

export interface Note {
  id: string;
  day: string;
  kind: (typeof NOTE_KINDS)[number];
  text: string;
  experimentKey: string | null;
  propertyKey: string | null;
  createdAt: string;
  author: { name: string | null; email: string | null } | null;
}

const KIND_MARK: Record<string, (s: string) => string> = {
  note: c.dim,
  issue: c.red,
  win: c.green,
};
export const noteKind = (k: string) => (KIND_MARK[k] ?? c.dim)(k);
export const noteScope = (n: Pick<Note, 'experimentKey' | 'propertyKey'>) => (n.experimentKey ? `experiment ${n.experimentKey}` : n.propertyKey ? `property ${n.propertyKey}` : c.dim('whole project'));

function kindFlag(flags: Flags): string | undefined {
  const kind = str(flags.kind);
  if (kind && !(NOTE_KINDS as readonly string[]).includes(kind)) fail('INVALID_FLAG', `--kind ${kind}: use note, issue or win.`);
  return kind;
}

function dayFlag(flags: Flags): string | undefined {
  const day = str(flags.day);
  if (day && !DAY.test(day)) fail('INVALID_FLAG', `--day ${day}: use a day like 2026-10-01.`);
  return day;
}

export async function notes(args: string[], flags: Flags): Promise<void> {
  const [action, ...rest] = args;
  const t = cloudOnly(flags, 'Notes', false);
  if (action === 'add') {
    const text = rest.join(' ').trim();
    if (!text) fail('USAGE', 'What happened? npx splithub notes add "Launched the new pricing page" [--kind win] [--experiment <key> | --property <id>]');
    const experiment = str(flags.experiment);
    const property = str(flags.property);
    if (experiment && property) fail('USAGE', 'A note belongs to one experiment or one property, not both.');
    const kind = kindFlag(flags);
    const day = dayFlag(flags);
    const body = {
      text,
      ...(kind ? { kind } : {}),
      ...(day ? { day } : {}),
      ...(experiment ? { experimentKey: experiment } : {}),
      ...(property ? { propertyKey: property } : {}),
    };
    const out = await request<{ note: Note }>(t, '/notes', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (flags.json) return printJson(out);
    console.log(`${c.green('✔')} noted on ${out.note.day} ${c.dim(`(${out.note.kind}, ${noteScope(out.note)})`)}`);
    return;
  }
  if (action === 'edit') {
    const [id, ...words] = rest;
    if (!id) fail('USAGE', 'Which note? npx splithub notes edit <id> "New text" [--kind win] [--day 2026-10-01]');
    const text = words.join(' ').trim();
    const kind = kindFlag(flags);
    const day = dayFlag(flags);
    if (!text && !kind && !day) fail('USAGE', 'Nothing to change: give new text, --kind or --day.');
    const out = await request<{ note: Note }>(t, `/notes/${enc(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...(text ? { text } : {}),
        ...(kind ? { kind } : {}),
        ...(day ? { day } : {}),
      }),
    });
    if (flags.json) return printJson(out);
    console.log(`${c.green('✔')} note updated ${c.dim(`(${out.note.day}, ${out.note.kind})`)}`);
    return;
  }
  if (action === 'delete' || action === 'remove') {
    const id = rest[0];
    if (!id) fail('USAGE', 'Which note? npx splithub notes delete <id> (ids are in npx splithub notes).');
    await request(t, `/notes/${enc(id)}`, { method: 'DELETE' });
    if (flags.json) return printJson({ ok: true, id });
    console.log(`${c.green('✔')} note deleted`);
    return;
  }
  if (action && action !== 'list') fail('USAGE', `Unknown "notes ${action}". Use notes, notes add "<text>", notes edit <id> or notes delete <id>.`);
  return listNotes(flags);
}

async function listNotes(flags: Flags): Promise<void> {
  const t = cloudOnly(flags, 'Notes', false);
  const q = new URLSearchParams(reportQuery(flags).slice(1));
  for (const k of [...q.keys()]) if (k !== 'from' && k !== 'to') q.delete(k);
  const experiment = str(flags.experiment);
  const property = str(flags.property);
  const kind = kindFlag(flags);
  if (experiment) q.set('experiment', experiment);
  else if (property) q.set('property', property);
  if (kind) q.set('kind', kind);
  const s = q.toString();
  const data = await request<{ notes: Note[] }>(t, `/notes${s ? `?${s}` : ''}`);
  if (flags.json) return printJson(data);
  if (data.notes.length === 0) return void console.log(c.dim('No notes yet. Add one when you ship something: npx splithub notes add "Launched the new pricing page"'));
  const rows = data.notes.slice(0, Number(flags.limit) || 50);
  console.log(
    table(
      ['DAY', 'KIND', 'NOTE', 'FOR', 'BY', 'ID'],
      rows.map((n) => [n.day, noteKind(n.kind), n.text.length > 80 ? `${n.text.slice(0, 79)}…` : n.text, noteScope(n), n.author?.name ?? n.author?.email ?? c.dim('–'), c.dim(n.id)])
    )
  );
  if (data.notes.length > rows.length) console.log(c.dim(`\n${data.notes.length - rows.length} more: --limit ${data.notes.length}, or narrow with --days, --experiment, --property, --kind.`));
}
