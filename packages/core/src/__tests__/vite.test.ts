import { describe, expect, it } from 'vitest';
import { defineConfig } from '../config';
import { describeExperiment, splithub } from '../vite';

const config = (runDraftsInDev: boolean) =>
  defineConfig({
    project: 'site',
    storage: { mode: 'self', endpoint: '/api/splithub' },
    runDraftsInDev,
    experiments: {
      hero: { kind: 'value', status: 'draft', variants: { control: { weight: 1, value: 'a' }, cta: { weight: 1, value: 'b' } } },
    },
  });

function fakeServer(mod: Record<string, unknown>) {
  const lines: string[] = [];
  const handlers: Record<string, (data: unknown) => void> = {};
  const server = {
    config: { root: '/app', logger: { info: (m: string) => void lines.push(m.replace(/\x1b\[\d+m/g, '')) } },
    httpServer: null,
    ssrLoadModule: async (url: string) => {
      if (url !== '/splithub.config.ts') throw new Error('missing');
      return mod;
    },
    ws: { on: (event: string, fn: (data: unknown) => void) => void (handlers[event] = fn) },
  };
  return { server, lines, handlers };
}

describe('vite plugin', () => {
  it('describes drafts with and without runDraftsInDev, and dashboard starts', () => {
    const plain = (s: string) => s.replace(/\x1b\[\d+m/g, '');
    const off = config(false);
    expect(plain(describeExperiment(off, off.experiments[0]!))).toMatch(/draft, everyone sees the control, here too.*\?sh_force=hero:cta/);
    const on = config(true);
    expect(plain(describeExperiment(on, on.experiments[0]!))).toMatch(/shown here as if running.*npx splithub start hero/);
    expect(describeExperiment(on, on.experiments[0]!, { ...on.experiments[0]!, status: 'running' })).toBe('hero: running (started from the dashboard)');
  });

  it('prints a summary on start and forwards each browser note once', async () => {
    const { server, lines, handlers } = fakeServer({ default: config(true) });
    const plugin = splithub();
    plugin.configureServer(server);
    await new Promise((r) => setTimeout(r, 0));
    expect(lines[0]).toMatch(/site · self-hosted · 1 experiment · drafts run in development/);
    expect(lines[1]).toMatch(/hero: draft, shown here/);
    handlers['splithub:note']!('"hero" is a draft.');
    handlers['splithub:note']!('"hero" is a draft.');
    expect(lines.filter((l) => l.includes('"hero" is a draft.'))).toHaveLength(1);
    expect(plugin.transformIndexHtml()[0]!.attrs.src).toBe('/@id/virtual:splithub-dev');
    expect(plugin.load(plugin.resolveId('virtual:splithub-dev')!)).toContain("import.meta.hot.send('splithub:note'");
  });
});
