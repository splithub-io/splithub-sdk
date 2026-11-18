// splithub dev — test experiments locally with full visibility.
//
//   splithub dev                     opens the app (localhost:3000 for Next.js, 5173 for Vite) with ?sh_debug=1
//   splithub dev --url http://…      a different page
//   splithub dev --hold              redirect experiments log the target instead of navigating
//   splithub dev --no-open           only print the link and watch
//
// With ?sh_debug the SDK and the drop-in script log every decision (which
// variant and why), every exposure and goal with its payload, and the remote
// overrides they applied, in the browser console and in a floating panel that
// can force a variant, start a new visitor or hold redirects. Meanwhile this
// command polls `status` and prints new visitors / conversions as they land.

import { spawn } from 'node:child_process';
import { fetchStatus, resolveTarget } from '../api';
import { detectProject } from '../project';
import { c } from '../ui';

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // no browser available: the link is printed anyway
  }
}

export async function dev(flags: Record<string, unknown>): Promise<void> {
  const project = detectProject();
  const port = project?.framework === 'next' ? 3000 : 5173;
  const page = (typeof flags.url === 'string' && flags.url) || `http://localhost:${port}/`;
  const u = new URL(page);
  u.searchParams.set('sh_debug', flags.hold ? 'hold' : '1');
  const link = u.toString();

  console.log(`${c.bold('SplitHub dev mode')}\n`);
  console.log(`  ${c.cyan(link)}\n`);
  console.log(c.dim('  In the browser: the console shows every assignment (variant + reason), exposure and goal; the panel'));
  console.log(c.dim('  in the corner forces variants, starts a new visitor and can hold redirects. Add ?sh_debug=0 to stop.\n'));
  if (!flags['no-open']) openBrowser(link);

  const target = resolveTarget(flags, project);
  console.log(c.dim(`  Watching ${target.url} every 5 s. Ctrl+C to stop.\n`));
  const seen = new Map<string, { visitors: number; headline: string | null }>();
  let first = true;
  const poll = async () => {
    let data: Awaited<ReturnType<typeof fetchStatus>>;
    try {
      data = await fetchStatus(target);
    } catch (e) {
      if (first) console.log(c.yellow(`  results endpoint not reachable yet (${e instanceof Error ? e.message : String(e)}); is the dev server running?`));
      first = false;
      return;
    }
    const now = new Date().toLocaleTimeString();
    for (const e of data.experiments) {
      const prev = seen.get(e.experiment);
      if (!prev) console.log(`  ${c.dim(now)} ${c.bold(e.experiment)} ${c.dim(e.status)} · ${e.visitors} visitors${e.headline ? ` · ${e.headline}` : ''}`);
      else if (prev.visitors !== e.visitors || prev.headline !== (e.headline ?? null)) console.log(`  ${c.dim(now)} ${c.bold(e.experiment)} ${c.green(`+${e.visitors - prev.visitors}`)} → ${e.visitors} visitors${e.headline ? ` · ${e.headline}` : ''}`);
      seen.set(e.experiment, { visitors: e.visitors, headline: e.headline ?? null });
    }
    first = false;
  };
  await poll();
  await new Promise<void>((resolve) => {
    const t = setInterval(() => void poll(), 5000);
    process.on('SIGINT', () => {
      clearInterval(t);
      resolve();
    });
  });
}
