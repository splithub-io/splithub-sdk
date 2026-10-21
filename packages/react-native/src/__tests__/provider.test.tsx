import { createClient, defineConfig, memoryStorage, resetAnalyticsClaims, type EventBatch, type PageEvent, type SplitHubClient } from '@splithub/core';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rn, Platform } from './mocks/react-native';
import type { AsyncStorageLike } from '../optional';

const optional = vi.hoisted(() => ({
  async: null as AsyncStorageLike | null,
  pathname: '/',
  router: false,
  navContext: null as unknown,
}));

vi.mock('../optional', () => ({
  loadMMKV: () => null,
  loadAsyncStorage: () => optional.async,
  loadExpoApplication: () => null,
  loadExpoDevice: () => null,
  loadExpoConstants: () => null,
  loadExpoRouter: () => (optional.router ? { usePathname: () => optional.pathname } : null),
  loadNavigationRefContext: () => optional.navContext,
}));

import { createContext } from 'react';
import { Experiment, ExpoRouterScreens, NavigationScreens, SDK, SplitHubProvider, Variant, useExpoRouterTracking, useNavigationTracking, useSplitHub, type NavigationRefLike } from '../index';
import { resetSharedPlatform } from '../platform';

const config = defineConfig({
  project: 'shop',
  storage: { mode: 'self', endpoint: 'https://example.test/api/splithub' },
  experiments: { hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 } } },
  properties: { app: { kind: 'app' } },
});

function capture() {
  const batches: EventBatch[] = [];
  return { batches, transport: { send: (b: EventBatch) => void batches.push(b) }, events: () => batches.flatMap((b) => b.events) };
}

function Hero() {
  return (
    <Experiment id="hero">
      <Variant name="control">plain</Variant>
      <Variant name="bold">bold</Variant>
    </Experiment>
  );
}

let seen: SplitHubClient | null = null;
function Probe() {
  seen = useSplitHub();
  return null;
}

beforeEach(() => {
  rn.reset();
  resetSharedPlatform();
  resetAnalyticsClaims();
  optional.async = null;
  optional.router = false;
  seen = null;
});
afterEach(() => vi.restoreAllMocks());

describe('<SplitHubProvider> on React Native', () => {
  it('renders the assigned variant and sends app batches named react-native', async () => {
    const sink = capture();
    const view = render(
      <SplitHubProvider config={config} transport={sink.transport} app={{ version: '2.0.0', storage: memoryStorage() }}>
        <Hero />
        <Probe />
      </SplitHubProvider>
    );
    const key = seen!.assignment('hero').variant!.key;
    expect(view.container.textContent).toBe(key === 'bold' ? 'bold' : 'plain');
    expect(seen!.context).toMatchObject({ platform: 'ios', appVersion: '2.0.0' });
    await seen!.flush();
    expect(sink.batches[0]!.sdk).toBe(SDK);
    expect(SDK).toMatch(/^react-native\/\d+\.\d+\.\d+/);
    expect(sink.batches[0]!.app).toMatchObject({ platform: 'ios', version: '2.0.0', os: '18.1' });
    expect(sink.events()).toEqual([expect.objectContaining({ type: 'exposure', exp: 'hero', var: key })]);
    view.unmount();
  });

  it('renders the fallback until AsyncStorage is read, then keeps the stored visitor', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    optional.async = {
      getAllKeys: async () => ['splithub:sh_vid'],
      multiGet: async (keys) => {
        await gate;
        return keys.map((k) => [k, 'v_stored'] as const);
      },
      setItem: async () => undefined,
      removeItem: async () => undefined,
    };
    const view = render(
      <SplitHubProvider config={config} transport={{ send: () => undefined }} fallback="loading">
        <Hero />
        <Probe />
      </SplitHubProvider>
    );
    expect(view.container.textContent).toBe('loading');
    expect(seen).toBeNull();
    await act(async () => {
      release();
      await gate;
    });
    expect(seen!.visitorId).toBe('v_stored');
    expect(view.container.textContent).not.toBe('loading');
    view.unmount();
  });

  it('runs with only a public key: experiments come from the dashboard', () => {
    const fromDashboard = defineConfig({
      project: 'x',
      storage: { mode: 'cloud', key: 'pk_test' },
      experiments: { onboarding: { kind: 'component', status: 'running', variants: { control: 0, short: 1 } } },
    }).experiments;
    const view = render(
      <SplitHubProvider
        publicKey="pk_test"
        transport={{ send: () => undefined }}
        remote={{ overrides: { version: 1, experiments: {}, added: fromDashboard } }}
        app={{ storage: memoryStorage() }}
      >
        <Experiment id="onboarding">
          <Variant name="control">long</Variant>
          <Variant name="short">short</Variant>
        </Experiment>
        <Probe />
      </SplitHubProvider>
    );
    expect(seen!.config.storage).toEqual({ mode: 'cloud', key: 'pk_test' });
    expect(seen!.config.project).toBe('app');
    expect(view.container.textContent).toBe('short');
    view.unmount();
  });

  it('asks for a key or a config', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<SplitHubProvider>{null}</SplitHubProvider>)).toThrow(/publicKey/);
  });

  it('is the browser client on Expo web', () => {
    Platform.OS = 'web';
    const view = render(
      <SplitHubProvider config={config} transport={{ send: () => undefined }}>
        <Probe />
      </SplitHubProvider>
    );
    expect(seen!.context.platform).toBe('web');
    view.unmount();
  });
});

function appClient() {
  const sink = capture();
  const client = createClient(config, { platform: { storage: memoryStorage(), app: { platform: 'android' } }, property: 'app', transport: sink.transport });
  return { client, pages: async () => (await client.flush(), sink.events().filter((e): e is PageEvent => e.type === 'page').map((e) => [e.url, e.title])) };
}

describe('screen tracking', () => {
  it('React Navigation: reports the focused route when ready and on each change', async () => {
    const { client, pages } = appClient();
    let route = 'Home';
    let ready = false;
    const listeners = new Set<() => void>();
    const ref: { current: NavigationRefLike } = {
      current: {
        isReady: () => ready,
        getCurrentRoute: () => ({ name: route }),
        addListener: (_t, cb) => (listeners.add(cb), () => void listeners.delete(cb)),
      },
    };
    let handlers: ReturnType<typeof useNavigationTracking> | null = null;
    function Nav() {
      handlers = useNavigationTracking(ref);
      return null;
    }
    const view = render(
      <SplitHubProvider client={client}>
        <Nav />
      </SplitHubProvider>
    );
    ready = true;
    handlers!.onReady();
    route = 'Settings';
    for (const l of listeners) l();
    // The container's onStateChange for the same route sends nothing more.
    handlers!.onStateChange();
    expect(await pages()).toEqual([
      ['/Home', 'Home'],
      ['/Settings', 'Settings'],
    ]);
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it('Expo Router: reports each pathname', async () => {
    optional.router = true;
    optional.pathname = '/';
    const { client, pages } = appClient();
    function Layout() {
      useExpoRouterTracking();
      return null;
    }
    const view = render(
      <SplitHubProvider client={client}>
        <Layout />
      </SplitHubProvider>
    );
    optional.pathname = '/product/42';
    view.rerender(
      <SplitHubProvider client={client}>
        <Layout />
      </SplitHubProvider>
    );
    expect(await pages()).toEqual([
      ['/', '/'],
      ['/product/42', '/product/42'],
    ]);
    view.unmount();
  });
});

describe('screen tracking components', () => {
  it('<NavigationScreens /> finds the container in context and counts the first screen without its handlers', async () => {
    const { client, pages } = appClient();
    let route = 'Home';
    let ready = false;
    const listeners = new Set<() => void>();
    const container: NavigationRefLike = {
      isReady: () => ready,
      getCurrentRoute: () => ({ name: route }),
      addListener: (_t, cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    };
    const RefContext = createContext<NavigationRefLike | null>(null);
    optional.navContext = RefContext;
    const view = render(
      <SplitHubProvider client={client}>
        <RefContext.Provider value={container}>
          <NavigationScreens />
        </RefContext.Provider>
      </SplitHubProvider>
    );
    ready = true; // the container gets ready after its children's effects
    await new Promise((r) => setTimeout(r, 10));
    route = 'Settings';
    for (const l of listeners) l();
    expect(await pages()).toEqual([
      ['/Home', 'Home'],
      ['/Settings', 'Settings'],
    ]);
    view.unmount();
    expect(listeners.size).toBe(0);
    optional.navContext = null;
  });

  it('<NavigationScreens /> outside a container warns once and sends nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, pages } = appClient();
    const view = render(
      <SplitHubProvider client={client}>
        <NavigationScreens />
      </SplitHubProvider>
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(await pages()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('<ExpoRouterScreens /> reports each pathname', async () => {
    optional.router = true;
    optional.pathname = '/cart';
    const { client, pages } = appClient();
    const view = render(
      <SplitHubProvider client={client}>
        <ExpoRouterScreens />
      </SplitHubProvider>
    );
    expect(await pages()).toEqual([['/cart', '/cart']]);
    view.unmount();
  });
});
