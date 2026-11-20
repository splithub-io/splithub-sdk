// `splithub proxy`: put SplitHub Cloud behind the project's own domain. Writes a small
// handler (`createCloudProxy` from @splithub/node) where the framework expects it and says
// which variable points the SDK at it. Nothing is set up on the cloud's side.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fail, printJson } from '../errors';
import { detectProject, type ProjectInfo } from '../project';
import { c } from '../ui';
import type { Flags } from './init';

export type ProxyKind = 'next' | 'worker' | 'express';

export interface ProxyPlan {
  kind: ProxyKind;
  /** Files to write, relative to the project. */
  files: { path: string; body: string }[];
  /** The URL path the SDK sends to, on the site's own domain (Next, Express) or the Worker's. */
  endpointPath: string;
  /** The variable that points the SDK at the proxy, or null when the config has no such line. */
  envVar: string;
  install: string;
}

const clean = (p: string): string => p.replace(/^\/+|\/+$/g, '') || 'sh';

const nextRoute = `// SplitHub Cloud behind this site's own domain: the SDK sends to /<path>/v1/events here
// and this route forwards it, with the visitor's browser, language and country.
import { createCloudProxy } from '@splithub/node';

const proxy = createCloudProxy();
export { proxy as GET, proxy as POST, proxy as OPTIONS };
`;

const workerScript = `// SplitHub Cloud behind your own (sub)domain, as a Cloudflare Worker.
// Deploy: npx wrangler deploy, then attach a custom domain such as stats.example.com.
import { createCloudProxy } from '@splithub/node';

export default { fetch: createCloudProxy() };
`;

const workerToml = `name = "splithub-proxy"
main = "index.ts"
compatibility_date = "2026-03-24"
compatibility_flags = ["nodejs_compat"]
# routes = [{ pattern = "stats.example.com", custom_domain = true }]
`;

const expressScript = (path: string): string => `// SplitHub Cloud behind your own domain, on an Express (or any node:http) server.
import { createCloudProxy, toNodeListener } from '@splithub/node';

const proxy = toNodeListener(createCloudProxy());
// app.use('/${path}', proxy);  // Express: everything under /${path} goes to SplitHub Cloud
export default proxy;
`;

function envVarFor(project: ProjectInfo): string {
  if (project.app) return 'EXPO_PUBLIC_SPLITHUB_ENDPOINT';
  return project.framework === 'vite' ? 'VITE_SPLITHUB_ENDPOINT' : 'NEXT_PUBLIC_SPLITHUB_ENDPOINT';
}

/** What `splithub proxy` writes for this project; Next.js gets a route, anything else a Worker unless asked. */
export function proxyPlan(project: ProjectInfo, flags: { kind?: unknown; path?: unknown } = {}): ProxyPlan {
  const asked = typeof flags.kind === 'string' ? flags.kind : null;
  if (asked && !['next', 'worker', 'express'].includes(asked)) fail('USAGE', `Unknown proxy kind "${asked}".`, 'Use --kind next, worker or express.');
  const kind = (asked ?? (project.framework === 'next' ? 'next' : 'worker')) as ProxyKind;
  const path = clean(typeof flags.path === 'string' ? flags.path : 'sh');
  const install = `${project.packageManager === 'npm' ? 'npm i' : `${project.packageManager} add`} @splithub/node`;
  if (kind === 'next') {
    const appDir = project.appDir ?? 'app';
    return { kind, files: [{ path: `${appDir}/${path}/[...path]/route.ts`, body: nextRoute }], endpointPath: `/${path}/v1/events`, envVar: envVarFor(project), install };
  }
  if (kind === 'express') return { kind, files: [{ path: 'splithub-proxy.ts', body: expressScript(path) }], endpointPath: `/${path}/v1/events`, envVar: envVarFor(project), install };
  return {
    kind,
    files: [
      { path: 'splithub-proxy/index.ts', body: workerScript },
      { path: 'splithub-proxy/wrangler.toml', body: workerToml },
    ],
    endpointPath: '/v1/events',
    envVar: envVarFor(project),
    install: `${install} (in splithub-proxy, with wrangler)`,
  };
}

export async function proxy(flags: Flags): Promise<void> {
  const project = detectProject();
  const plan = proxyPlan(project, flags);
  const written: string[] = [];
  const kept: string[] = [];
  for (const f of plan.files) {
    const file = join(project.root, f.path);
    if (existsSync(file) && !flags.force) {
      kept.push(f.path);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, f.body, 'utf8');
    written.push(f.path);
  }
  const config = project.configFile && existsSync(project.configFile) ? readFileSync(project.configFile, 'utf8') : '';
  const configReadsEnv = config.includes(plan.envVar);
  const host = plan.kind === 'worker' ? 'https://stats.<your-domain>' : 'https://<your-domain>';
  const endpoint = `${host}${plan.endpointPath}`;
  const next = [
    `Install ${plan.install}.`,
    plan.kind === 'worker' ? 'Deploy the Worker (npx wrangler deploy in splithub-proxy) and give it a custom domain.' : 'Deploy the site.',
    configReadsEnv
      ? `Set ${plan.envVar}=${endpoint} in your hosting settings; unset, events go straight to SplitHub Cloud.`
      : `Point the SDK at it: storage: { mode: 'cloud', key, endpoint: process.env.${plan.envVar} } in ${project.configFile ? relative(project.root, project.configFile) : 'splithub.config.ts'}, then set ${plan.envVar}=${endpoint}.`,
    `sh.js: <script src="${endpoint.replace('/v1/events', '')}/sh.js" data-key="pk_…"></script> (it sends back to where it came from)`,
  ];
  if (flags.json) {
    printJson({ kind: plan.kind, written, kept, endpoint, envVar: plan.envVar, next });
    return;
  }
  for (const f of written) console.log(`${c.green('✔')} wrote ${f}`);
  for (const f of kept) console.log(c.dim(`${f} is already there; --force replaces it`));
  console.log('');
  for (const line of next) console.log(`  ${line}`);
}
