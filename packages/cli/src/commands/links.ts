// splithub links — short links on SplitHub Cloud: one short URL, one or more destinations split
// by weight (split visitors between landing pages without code), clicks counted per destination.
//
//   splithub links                                         every link with its clicks
//   splithub links <id|slug>                               clicks of one link: last 30 days, destinations, countries, devices, referrers
//   splithub links create <url> [<url> ...] [--slug spring] [--name "Spring sale"] [--weights 70,30]
//   splithub links edit <id|slug> [--name ...] [--slug ...] [--description ...]
//   splithub links pause|resume|delete <id|slug>
//
// Targeting a destination by country, device or a flow is done in the dashboard.

import { request, requireCloudToken, type Target } from '../api';
import { fail, printJson } from '../errors';
import { bar, c, statusColor, table } from '../ui';
import { cloudOnly, n, str } from './analytics-reports';
import type { Flags } from './init';

export interface Link {
  linkId: string;
  name: string;
  shortCode: string;
  shortUrl: string;
  status: string;
  destinations: Array<{
    id: string;
    url: string;
    weight: number;
    label?: string;
    countries?: string[];
    devices?: string[];
  }>;
  clickLimit: number;
  totalClicks: number;
  description: string | null;
  createdAt: string;
}

interface LinkStats {
  link: Link;
  totalClicks: number;
  uniqueVisitors: number;
  byDay: Array<{ day: string; clicks: number; visitors: number }>;
  byDestination: Array<{ destinationId: string; clicks: number }>;
  byCountry: Array<{ country: string; clicks: number }>;
  byDevice: Array<{ device: string; clicks: number }>;
  byReferrer: Array<{ referrer: string; clicks: number }>;
}

const SLUG = /^[a-zA-Z0-9_-]{3,32}$/;
const enc = encodeURIComponent;

/** A link by its id or its slug (short code). */
export async function findLink(t: Target, want: string): Promise<Link> {
  const { links } = await request<{ links: Link[] }>(t, '/links');
  const link = links.find((l) => l.linkId === want) ?? links.find((l) => l.shortCode === want) ?? links.find((l) => l.shortCode.toLowerCase() === want.toLowerCase());
  if (!link) fail('NOT_FOUND', `There's no short link "${want}".`, 'See them with npx splithub links.');
  return link;
}

/** `https://example.com/a/b?x` → `example.com/a/b`: a default name for a new link. */
export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

/** Destinations from typed URLs and `--weights 70,30` (equal weights by default). */
export function destinationsFrom(urls: string[], weights?: string): Link['destinations'] {
  if (urls.length === 0) fail('USAGE', 'Where should it go? npx splithub links create https://example.com/spring [--slug spring]');
  for (const u of urls) {
    let ok = false;
    try {
      ok = /^https?:$/.test(new URL(u).protocol);
    } catch {
      ok = false;
    }
    if (!ok) fail('INVALID_FLAG', `"${u}" is not a full http(s) URL, like https://example.com/page.`);
  }
  const w = weights ? weights.split(',').map((x) => Number(x.trim())) : urls.map(() => 1);
  if (w.length !== urls.length || w.some((x) => !Number.isFinite(x) || x < 0) || w.every((x) => x === 0)) fail('INVALID_FLAG', `--weights ${weights}: one number per URL, like --weights 70,30.`);
  return urls.map((url, i) => ({ id: `d${i + 1}`, url, weight: w[i]! }));
}

export async function links(args: string[], flags: Flags): Promise<void> {
  const t = cloudOnly(flags, 'Short links', false);
  if (!t.token) requireCloudToken(flags);
  const [action, ...rest] = args;
  if (!action || action === 'list') return listLinks(t, flags);
  if (action === 'create' || action === 'add') {
    const destinations = destinationsFrom(rest, str(flags.weights));
    const slug = str(flags.slug);
    if (slug && !SLUG.test(slug)) fail('INVALID_FLAG', `--slug ${slug}: 3 to 32 letters, digits, - or _.`);
    const body = {
      name: str(flags.name) ?? nameFromUrl(destinations[0]!.url),
      destinations,
      ...(slug ? { shortCode: slug } : {}),
      ...(str(flags.description) ? { description: str(flags.description) } : {}),
    };
    const out = await request<{ link: Link }>(t, '/links', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (flags.json) return printJson(out);
    console.log(`${c.green('✔')} ${c.bold(out.link.shortUrl)} → ${destinations.length === 1 ? destinations[0]!.url : `${destinations.length} destinations, split by weight`}`);
    console.log(c.dim(`Clicks: npx splithub links ${out.link.shortCode}`));
    return;
  }
  if (['edit', 'pause', 'resume', 'delete', 'remove'].includes(action)) {
    const want = rest[0];
    if (!want) fail('USAGE', `Which link? npx splithub links ${action} <id|slug>`);
    const link = await findLink(t, want);
    if (action === 'delete' || action === 'remove') {
      await request(t, `/links/${enc(link.linkId)}`, { method: 'DELETE' });
      if (flags.json) return printJson({ ok: true, linkId: link.linkId, shortCode: link.shortCode });
      console.log(`${c.green('✔')} ${link.shortUrl} deleted ${c.dim('(it stops redirecting now)')}`);
      return;
    }
    let body: Record<string, unknown>;
    if (action === 'edit') {
      const slug = str(flags.slug);
      if (slug && !SLUG.test(slug)) fail('INVALID_FLAG', `--slug ${slug}: 3 to 32 letters, digits, - or _.`);
      body = {
        ...(str(flags.name) ? { name: str(flags.name) } : {}),
        ...(slug ? { shortCode: slug } : {}),
        ...(flags.description !== undefined ? { description: str(flags.description) ?? null } : {}),
      };
      if (Object.keys(body).length === 0) fail('USAGE', 'Nothing to change: --name, --slug or --description.');
    } else body = { status: action === 'pause' ? 'paused' : 'active' };
    const out = await request<{ link: Link }>(t, `/links/${enc(link.linkId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    if (flags.json) return printJson(out);
    if (action === 'edit') console.log(`${c.green('✔')} ${out.link.shortUrl} saved`);
    else console.log(`${c.green('✔')} ${out.link.shortUrl} ${action === 'pause' ? 'paused: visitors see "Link is paused"' : 'redirects again'}`);
    return;
  }
  return stats(t, action, flags);
}

async function listLinks(t: Target, flags: Flags): Promise<void> {
  const data = await request<{ links: Link[] }>(t, '/links');
  if (flags.json) return printJson(data);
  if (data.links.length === 0) return void console.log(c.dim('No short links yet. Make one: npx splithub links create https://example.com/spring --slug spring'));
  const max = Math.max(1, ...data.links.map((l) => l.totalClicks));
  console.log(
    table(
      ['LINK', 'NAME', 'STATUS', 'CLICKS', '', 'GOES TO'],
      data.links.map((l) => [
        c.bold(l.shortUrl),
        l.name,
        l.status === 'active' ? c.green('active') : statusColor(l.status),
        n(l.totalClicks),
        bar(l.totalClicks, max, 12),
        l.destinations.length === 1 ? l.destinations[0]!.url : `${l.destinations.length} destinations`,
      ])
    )
  );
}

async function stats(t: Target, want: string, flags: Flags): Promise<void> {
  const link = await findLink(t, want);
  const data = await request<LinkStats>(t, `/links/${enc(link.linkId)}/stats`);
  if (flags.json) return printJson(data);
  console.log(`${c.bold(link.shortUrl)} ${c.dim(`· ${link.name} · ${link.status}`)}\n`);
  console.log(`${c.bold(n(data.totalClicks))} clicks from ${c.bold(n(data.uniqueVisitors))} visitors ${c.dim('(all time)')}`);
  if (data.byDestination.length > 1 || link.destinations.length > 1) {
    const total = Math.max(
      1,
      data.byDestination.reduce((s, d) => s + d.clicks, 0)
    );
    console.log(`\n${c.bold('Destinations')}`);
    console.log(
      table(
        ['GOES TO', 'WEIGHT', 'CLICKS', 'SHARE'],
        link.destinations.map((d) => {
          const clicks = data.byDestination.find((x) => x.destinationId === d.id)?.clicks ?? 0;
          return [d.label ? `${d.label} ${c.dim(d.url)}` : d.url, String(d.weight), n(clicks), `${((clicks / total) * 100).toFixed(1)}%`];
        })
      )
    );
  }
  if (data.byDay.length) {
    const max = Math.max(1, ...data.byDay.map((d) => d.clicks));
    console.log(`\n${c.bold('Last 30 days')}`);
    console.log(
      table(
        ['DAY', 'CLICKS', '', 'VISITORS'],
        data.byDay.slice(-14).map((d) => [d.day, n(d.clicks), bar(d.clicks, max, 16), n(d.visitors)])
      )
    );
  }
  const top = (title: string, head: string, rows: Array<{ value: string; clicks: number }>) => {
    if (!rows.length) return;
    console.log(`\n${c.bold(title)}`);
    console.log(
      table(
        [head, 'CLICKS'],
        rows.slice(0, 8).map((r) => [r.value, n(r.clicks)])
      )
    );
  };
  top(
    'Countries',
    'COUNTRY',
    data.byCountry.map((r) => ({ value: r.country, clicks: r.clicks }))
  );
  top(
    'Devices',
    'DEVICE',
    data.byDevice.map((r) => ({ value: r.device, clicks: r.clicks }))
  );
  top(
    'Referrers',
    'REFERRER',
    data.byReferrer.map((r) => ({
      value: r.referrer === '(direct)' ? c.dim('direct') : r.referrer,
      clicks: r.clicks,
    }))
  );
}
