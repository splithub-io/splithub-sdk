import { describe, expect, it } from 'vitest';
import { proxyPlan } from '../commands/proxy';
import type { ProjectInfo } from '../project';

const project = (over: Partial<ProjectInfo>): ProjectInfo => ({ root: '/p', name: 'shop', framework: 'unknown', packageManager: 'npm', appDir: null, configFile: null, app: null, ...over }) as ProjectInfo;

describe('splithub proxy', () => {
  it('Next.js gets a catch-all route under the chosen path', () => {
    const plan = proxyPlan(project({ framework: 'next', appDir: 'src/app', packageManager: 'pnpm' }), { path: '/stats/' });
    expect(plan.kind).toBe('next');
    expect(plan.files.map((f) => f.path)).toEqual(['src/app/stats/[...path]/route.ts']);
    expect(plan.files[0]!.body).toContain('export { proxy as GET, proxy as POST, proxy as OPTIONS }');
    expect(plan.endpointPath).toBe('/stats/v1/events');
    expect(plan.envVar).toBe('NEXT_PUBLIC_SPLITHUB_ENDPOINT');
    expect(plan.install).toBe('pnpm add @splithub/node');
  });

  it('a Vite site gets a Cloudflare Worker and the Vite variable', () => {
    const plan = proxyPlan(project({ framework: 'vite' }));
    expect(plan.kind).toBe('worker');
    expect(plan.files.map((f) => f.path)).toEqual(['splithub-proxy/index.ts', 'splithub-proxy/wrangler.toml']);
    expect(plan.envVar).toBe('VITE_SPLITHUB_ENDPOINT');
  });

  it('refuses an unknown kind', () => {
    expect(() => proxyPlan(project({}), { kind: 'nginx' })).toThrow(/kind/);
  });
});
