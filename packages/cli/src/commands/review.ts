import { apiError, requireCloudToken } from '../api';
import { c } from '../ui';
import type { Flags } from './init';

interface Review {
  id: string;
  experiment: string | null;
  kind: string;
  trigger: string;
  body: string;
  model: string | null;
  createdAt: string;
}

/** `splithub review [<experiment>]`: the AI reviews stored in the cloud (Pro), newest first. */
export async function review(key: string | undefined, flags: Flags): Promise<void> {
  const target = requireCloudToken(flags);
  const res = await fetch(`${target.url}/reviews${key ? `/${encodeURIComponent(key)}` : ''}`, { headers: { authorization: `Bearer ${target.token}` } });
  const data = (await res.json().catch(() => ({}))) as { reviews?: Review[]; error?: string };
  if (!res.ok) throw apiError(res.status, data, `${target.url}/reviews responded ${res.status}`, key);
  const reviews = data.reviews ?? [];
  if (flags.json) {
    console.log(JSON.stringify({ experiment: key ?? null, reviews }));
    return;
  }
  if (reviews.length === 0) {
    console.log(c.dim(key ? `no reviews for ${key} yet (Pro writes one at the start, when the verdict changes while running, and on finish; or click "Review now" in the dashboard)` : 'no reviews yet'));
    return;
  }
  for (const r of reviews) {
    console.log(`${c.bold(r.experiment ?? 'project')} ${c.dim(`· ${r.kind}${r.trigger && r.trigger !== 'manual' ? ` · ${r.trigger}` : ''} · ${new Date(r.createdAt).toLocaleString()}`)}`);
    console.log(r.body.trim());
    console.log();
  }
}
