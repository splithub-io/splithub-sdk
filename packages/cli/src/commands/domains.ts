// splithub domains — which origins may send events, per test and per analytics property.
//
//   splithub domains                                   every allowed domain and where it applies
//   splithub domains set test <id> example.com [...]   replace a test's list
//   splithub domains set property <id> example.com     replace a property's list
//   splithub domains clear test|property <id>          accept any origin again
//
// A test or property without domains accepts events from anywhere. SplitHub Cloud only.

import { request, requireCloudToken } from '../api';
import { fail, printJson } from '../errors';
import { c, table } from '../ui';
import type { Flags } from './init';

interface DomainsData {
  entries: Array<{ kind: 'experiment' | 'property'; key: string; host: string }>;
  entities: Array<{ kind: 'experiment' | 'property'; key: string; name: string | null; status: string }>;
  observed: Array<{ host: string; events: number; lastSeen: number; allowedIn: Array<{ kind: string; key: string }> }>;
}

const KINDS: Record<string, 'experiment' | 'property'> = { test: 'experiment', experiment: 'experiment', property: 'property' };
const label = (kind: string) => (kind === 'experiment' ? 'experiment' : 'property');

export async function domains(args: string[], flags: Flags): Promise<void> {
  const target = requireCloudToken(flags);
  const [action, kindArg, key, ...hosts] = args;
  if (!action) {
    const data = await request<DomainsData>(target, '/domains');
    if (flags.json) return printJson(data);
    const byHost = new Map<string, string[]>();
    for (const e of data.entries) byHost.set(e.host, [...(byHost.get(e.host) ?? []), `${label(e.kind)} ${e.key}`]);
    if (byHost.size === 0) console.log(c.dim('No experiment or property limits its origins: events are accepted from anywhere.'));
    else console.log(table(['DOMAIN', 'ALLOWED FOR'], [...byHost].map(([host, where]) => [c.bold(host), where.join(', ')])));
    const open = data.entities.filter((e) => !data.entries.some((x) => x.kind === e.kind && x.key === e.key));
    if (open.length && byHost.size) console.log(`\n${c.dim(`Any origin: ${open.map((e) => `${label(e.kind)} ${e.key}`).join(', ')}`)}`);
    if (data.observed.length) {
      console.log(`\n${c.bold('Seen sending events')}`);
      console.log(table(['ORIGIN', 'EVENTS', 'ALLOWED FOR'], data.observed.slice(0, 15).map((o) => [o.host, o.events.toLocaleString('en-US'), o.allowedIn.length ? o.allowedIn.map((a) => `${label(a.kind)} ${a.key}`).join(', ') : c.dim('–')])));
    }
    return;
  }
  if (action !== 'set' && action !== 'clear') fail('USAGE', `Unknown action "${action}". Use npx splithub domains set experiment <id> <domain...> or domains clear experiment <id>.`);
  const kind = KINDS[kindArg ?? ''];
  if (!kind || !key) fail('USAGE', `npx splithub domains ${action} experiment|property <id>${action === 'set' ? ' <domain...>' : ''}`);
  if (action === 'set' && hosts.length === 0) fail('USAGE', 'Which domains? npx splithub domains set experiment <id> example.com app.example.com (subdomains are included).');
  const out = await request<{ kind: string; key: string; hosts: string[] }>(target, `/domains/${kind}/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ hosts: action === 'clear' ? [] : hosts }) });
  if (flags.json) return printJson(out);
  if (out.hosts.length === 0) console.log(`${c.green('✔')} ${label(kind)} ${c.bold(key)} accepts events from any origin`);
  else console.log(`${c.green('✔')} ${label(kind)} ${c.bold(key)} accepts events from ${out.hosts.join(', ')} ${c.dim('(and their subdomains; live within 60s)')}`);
}
