import { createClient, defineConfig, type EventBatch } from '@splithub/core';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Experiment, SplitHubProvider, Variant, useTrack, useValue, useVariant } from '../index';

const config = defineConfig({
  project: 'p',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: {
    hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 }, goal: 'signup' },
    title: {
      kind: 'value',
      status: 'running',
      variants: { control: { weight: 1, value: 'Plain' }, loud: { weight: 1, value: 'LOUD' } },
    },
    paused: { kind: 'component', status: 'paused', variants: { control: 1, b: 1 } },
  },
});

function setup(visitorId: string, overrides?: Record<string, string>) {
  const batches: EventBatch[] = [];
  const client = createClient(config, { visitorId, sessionId: 's', overrides, transport: { send: (b) => void batches.push(b) } });
  return { client, batches };
}

function Page() {
  const variant = useVariant('hero');
  const title = useValue<string>('title');
  const track = useTrack();
  return (
    <div>
      <h1>{title}</h1>
      <Experiment id="hero">
        <Variant name="control">
          <p>control hero</p>
        </Variant>
        <Variant name="bold">
          <p>bold hero</p>
        </Variant>
      </Experiment>
      <Experiment id="paused">
        <Variant name="control">
          <p>paused control</p>
        </Variant>
        <Variant name="b">
          <p>paused b</p>
        </Variant>
      </Experiment>
      <span data-testid="hook">{variant}</span>
      <button onClick={() => track('signup')}>go</button>
    </div>
  );
}

describe('<Experiment>', () => {
  it('renders the forced variant and the hook agrees', async () => {
    const { client, batches } = setup('v_1', { hero: 'bold', title: 'loud' });
    render(
      <SplitHubProvider config={config} client={client}>
        <Page />
      </SplitHubProvider>
    );
    expect(screen.getByText('bold hero')).toBeTruthy();
    expect(screen.getByTestId('hook').textContent).toBe('bold');
    expect(screen.getByText('LOUD')).toBeTruthy();
    expect(screen.getByText('paused control')).toBeTruthy();
    fireEvent.click(screen.getByText('go'));
    await act(() => client.flush());
    const events = batches.flatMap((b) => b.events);
    // overrides do not record exposures; the goal is still sent
    expect(events.map((e) => e.type)).toEqual(['goal']);
  });

  it('records exactly one exposure per experiment for a real assignment', async () => {
    const { client, batches } = setup('v_42');
    render(
      <SplitHubProvider config={config} client={client}>
        <Page />
      </SplitHubProvider>
    );
    await act(() => client.flush());
    const exposures = batches.flatMap((b) => b.events).filter((e) => e.type === 'exposure');
    expect(exposures.map((e) => (e as { exp: string }).exp).sort()).toEqual(['hero', 'title']);
  });

  it('leaves no page listener behind under StrictMode', async () => {
    sessionStorage.clear(); // exposures are deduplicated per session
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(
      <StrictMode>
        <SplitHubProvider config={config} visitorId="v_strict" sessionId="s" pageviews={false}>
          <Page />
        </SplitHubProvider>
      </StrictMode>
    );
    view.unmount();
    const count = (spy: typeof add, type: string) => spy.mock.calls.filter((c) => c[0] === type).length;
    expect(count(add, 'pagehide')).toBeGreaterThan(0);
    expect(count(remove, 'pagehide')).toBe(count(add, 'pagehide'));
    add.mockRestore();
    remove.mockRestore();
  });
});

describe('first visit in cloud mode', () => {
  const cloud = defineConfig({
    project: 'p',
    storage: { mode: 'cloud', key: 'pk_live_react' },
    experiments: { hero: { kind: 'component', status: 'draft', variants: { control: 0, bold: 1 } } },
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders control until the overrides arrive, then the decided variant once', async () => {
    sessionStorage.clear();
    let answer!: (body: unknown) => void;
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => (answer = (body) => resolve(new Response(JSON.stringify(body))))));
    const batches: EventBatch[] = [];
    const client = createClient(cloud, { visitorId: 'v_1', sessionId: 's', transport: { send: (b) => void batches.push(b) } });
    const seen: string[] = [];
    function Hero() {
      const variant = useVariant('hero');
      seen.push(variant);
      return <span data-testid="hero">{variant}</span>;
    }
    render(
      <SplitHubProvider config={cloud} client={client}>
        <Hero />
      </SplitHubProvider>
    );
    expect(screen.getByTestId('hero').textContent).toBe('control');

    // Started in the dashboard: splithub.config.ts still says draft.
    await act(async () => {
      answer({ version: 1, experiments: { hero: { status: 'running' } } });
      await client.ready;
    });
    expect(screen.getByTestId('hero').textContent).toBe('bold');
    expect(seen).toEqual(['control', 'bold']);
    await act(() => client.flush());
    expect(batches.flatMap((b) => b.events).map((e) => (e as { var?: string }).var)).toEqual(['bold']);
  });
});
