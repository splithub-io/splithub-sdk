// Vite plugin: SplitHub notes in the terminal that runs `vite` / `npm run dev`.
//
//   // vite.config.ts
//   import { splithub } from '@splithub/core/vite';
//   export default defineConfig({ plugins: [react(), splithub()] });
//
// On start and on every save of splithub.config.ts it prints what each
// experiment does in development (draft hidden or shown, running, paused,
// started from the dashboard). The SDK's development notes from the browser
// ("this visitor got control", "events held back") are forwarded here too,
// once per message until the config changes. Dev server only; builds are untouched.
//
// Vite's types are described structurally so @splithub/core keeps zero dependencies.

import { CLOUD_ENDPOINT } from './client';
import { isSplitHubConfig } from './config';
import { applyRemoteOverrides, fetchRemoteOverrides, resolveOverridesUrl } from './remote';
import type { Experiment, SplitHubConfig } from './types';

interface Logger {
  info(message: string, options?: { timestamp?: boolean }): void;
}
interface DevServer {
  config: { root: string; logger: Logger };
  httpServer: { once(event: 'listening', listener: () => void): unknown } | null;
  ssrLoadModule(url: string): Promise<Record<string, unknown>>;
  ws: { on(event: string, listener: (data: unknown) => void): void };
}
interface HotContext {
  file: string;
  server: DevServer;
}
export interface SplitHubVitePlugin {
  name: string;
  apply: 'serve';
  configureServer(server: DevServer): void;
  handleHotUpdate(ctx: HotContext): void;
  resolveId(id: string): string | undefined;
  load(id: string): string | undefined;
  transformIndexHtml(): Array<{ tag: string; attrs: Record<string, string>; injectTo: 'head-prepend' }>;
}

export interface SplitHubViteOptions {
  /** Path of the config, relative to the Vite root. Default: splithub.config.ts, .js or .mjs. */
  config?: string;
  /** Print the experiment summary on start and on config changes. Default true. */
  summary?: boolean;
  /** Forward the SDK's development notes from the browser. Default true. */
  browserNotes?: boolean;
}

const VIRTUAL = 'virtual:splithub-dev';
const RESOLVED = '\0' + VIRTUAL;
const CANDIDATES = ['splithub.config.ts', 'splithub.config.js', 'splithub.config.mjs'];
const tag = (s: string) => `\x1b[36m[splithub]\x1b[39m ${s}`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

// The browser side: the SDK announces notes as a window event; this sends them to the
// dev server and tells the SDK that the terminal has them, so the browser console stays quiet.
const CLIENT = `if (import.meta.hot) {
  window.__splithubTerminal = true;
  window.addEventListener('splithub:dev', (e) => import.meta.hot.send('splithub:note', e.detail));
}`;

/** One line per experiment, in the words a developer needs. `live` is the experiment after dashboard changes. */
export function describeExperiment(config: SplitHubConfig, e: Experiment, live?: Experiment): string {
  const changed = live && live.status !== e.status ? live.status : null;
  const status = changed ?? e.status;
  const second = e.variants[1]?.key ?? 'variant';
  if (status === 'running') return `${e.key}: running${changed ? ' (started from the dashboard)' : ''}`;
  if (status === 'draft') {
    return config.runDraftsInDev
      ? `${e.key}: draft, shown here as if running; visitors see it after ${dim(`npx splithub start ${e.key}`)}`
      : `${e.key}: draft, everyone sees the control, here too; add runDraftsInDev: true or open ${dim(`?sh_force=${e.key}:${second}`)}`;
  }
  return `${e.key}: ${status}${changed ? ' from the dashboard' : ''}, everyone sees the control`;
}

async function liveConfig(config: SplitHubConfig): Promise<SplitHubConfig | null> {
  if (config.storage.mode !== 'cloud' || !config.storage.key) return null;
  const url = resolveOverridesUrl(config.storage.endpoint ?? CLOUD_ENDPOINT, config.storage.key);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
  const overrides = await Promise.race([fetchRemoteOverrides(url), timeout]);
  return overrides ? applyRemoteOverrides(config, overrides) : null;
}

export function splithub(options: SplitHubViteOptions = {}): SplitHubVitePlugin {
  const seen = new Set<string>();
  let configPath: string | null = null;

  async function load(server: DevServer): Promise<SplitHubConfig | null> {
    for (const file of options.config ? [options.config] : CANDIDATES) {
      const path = file.replace(/^\.?\//, '');
      try {
        const mod = await server.ssrLoadModule(`/${path}`);
        if (isSplitHubConfig(mod.default)) {
          configPath = path;
          return mod.default;
        }
      } catch {
        // not this file, or it does not compile right now: try the next one
      }
    }
    return null;
  }

  async function summary(server: DevServer): Promise<void> {
    if (options.summary === false) return;
    const log = server.config.logger;
    const config = await load(server);
    if (!config) {
      log.info(tag('no splithub.config.ts found; run npx splithub init'), { timestamp: true });
      return;
    }
    const live = await liveConfig(config).catch(() => null);
    const mode = config.storage.mode === 'cloud' ? (config.storage.key ? 'cloud' : 'cloud, no public key yet') : 'self-hosted';
    const count = `${config.experiments.length} experiment${config.experiments.length === 1 ? '' : 's'}`;
    log.info(tag(`${config.project} · ${mode} · ${count}${config.runDraftsInDev ? ' · drafts run in development' : ''}`), { timestamp: true });
    for (const e of config.experiments) log.info(tag(`  ${describeExperiment(config, e, live?.experiments.find((x) => x.key === e.key))}`));
    if (config.storage.mode === 'cloud') {
      log.info(tag(dim('  development sends nothing to the cloud; deployed builds do')));
      if (!(live ?? config).experiments.some((e) => e.status === 'running')) log.info(tag(dim('  nothing is running yet, so deployed builds record nothing either')));
    }
  }

  return {
    name: 'splithub',
    apply: 'serve',
    configureServer(server) {
      if (options.browserNotes !== false) {
        server.ws.on('splithub:note', (data) => {
          if (typeof data !== 'string' || seen.has(data)) return;
          seen.add(data);
          server.config.logger.info(tag(data), { timestamp: true });
        });
      }
      const start = () => void summary(server);
      if (server.httpServer) server.httpServer.once('listening', start);
      else start();
    },
    handleHotUpdate({ file, server }) {
      if (!configPath || !file.replace(/\\/g, '/').endsWith(`/${configPath}`)) return;
      seen.clear();
      void summary(server);
    },
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      return options.browserNotes === false ? '' : CLIENT;
    },
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { type: 'module', src: `/@id/${VIRTUAL}` }, injectTo: 'head-prepend' }];
    },
  };
}
