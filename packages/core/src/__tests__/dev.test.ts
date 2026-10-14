import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assign } from '../assignment';
import { createClient } from '../client';
import { defineConfig } from '../config';
import { explainAssignment, resetDevNotes } from '../dev';

const make = (runDraftsInDev: boolean) =>
  defineConfig({
    project: 'site',
    storage: { mode: 'cloud', key: 'pk_live_x' },
    runDraftsInDev,
    goals: { click: { type: 'event' } },
    experiments: {
      hero: { kind: 'value', status: 'draft', variants: { control: { weight: 1, value: 'a' }, cta: { weight: 1, value: 'b' } } },
      old: { kind: 'value', status: 'paused', variants: { control: { weight: 1, value: 'a' }, b: { weight: 1, value: 'b' } } },
    },
  });

describe('development notes', () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetDevNotes();
    info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    info.mockRestore();
    vi.unstubAllEnvs();
  });
  const lines = () => info.mock.calls.map((c: unknown[]) => String(c[0]));

  it('explains a hidden draft once, with the way to see it', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const cfg = make(false);
    const exp = cfg.experiments[0]!;
    explainAssignment(exp, assign(cfg, 'hero', 'v1'));
    explainAssignment(exp, assign(cfg, 'hero', 'v2'));
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/"hero" is a draft, so everyone sees the control.*runDraftsInDev: true.*\?sh_force=hero:cta/);
  });

  it('says which variant a dev draft shows and how to start it; paused tests too', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const cfg = make(true);
    explainAssignment(cfg.experiments[0], assign(cfg, 'hero', 'v1'));
    explainAssignment(cfg.experiments[1], assign(cfg, 'old', 'v1'));
    expect(lines()[0]).toMatch(/"hero" is a draft\. You see it here.*npx splithub start hero/);
    expect(lines()[1]).toMatch(/"old" is paused/);
  });

  it('says once that development sends nothing to the cloud', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const client = createClient(make(true), { visitorId: 'v1', sessionId: 's1', transport: { send: () => undefined }, remote: { disabled: true } });
    client.value('hero');
    client.track('click');
    client.track('click');
    expect(lines().filter((l) => l.includes('Development sends nothing to the cloud'))).toHaveLength(1);
  });

  it('prints nothing in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const cfg = make(true);
    explainAssignment(cfg.experiments[0], assign(cfg, 'hero', 'v1'));
    expect(info).not.toHaveBeenCalled();
  });
});
