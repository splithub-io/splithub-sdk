import { createClient, defineConfig, memoryStorage, type EventBatch, type PageEvent, type PlatformAdapter } from '@splithub/core';
import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplitHubDevtools, SplitHubProvider, useScreen, useSplitHub, useTrack, useVariant } from '../index';

const config = defineConfig({
  project: 'p',
  storage: { mode: 'self', endpoint: 'https://example.test/api/splithub' },
  experiments: { hero: { kind: 'component', status: 'running', variants: { control: 1, bold: 1 } } },
  properties: { app: { kind: 'app' } },
});

afterEach(() => vi.restoreAllMocks());

function Screen({ name }: { name: string }) {
  useScreen(name);
  const track = useTrack();
  const variant = useVariant('hero');
  return <button onClick={() => track('Tapped')}>{variant}</button>;
}

describe('React on an app (a client with a platform adapter)', () => {
  it('reports screens, exposures and events, and no pageview of its own', async () => {
    vi.spyOn(navigator, 'product', 'get').mockReturnValue('ReactNative');
    const batches: EventBatch[] = [];
    const platform: PlatformAdapter = { storage: memoryStorage(), app: { platform: 'android', version: '1.4.0' } };
    const client = createClient(config, { platform, property: 'app', transport: { send: (b) => void batches.push(b) } });
    const view = render(
      <SplitHubProvider client={client}>
        <Screen name="Home" />
      </SplitHubProvider>
    );
    view.getByRole('button').click();
    view.rerender(
      <SplitHubProvider client={client}>
        <Screen name="Settings" />
      </SplitHubProvider>
    );
    await client.flush();
    const events = batches.flatMap((b) => b.events);
    expect(events.filter((e): e is PageEvent => e.type === 'page').map((e) => e.url)).toEqual(['/Home', '/Settings']);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['exposure', 'event']));
    expect(batches[0]!.app).toEqual({ platform: 'android', version: '1.4.0' });
    view.unmount();
  });

  it('keeps the app lifecycle bound after StrictMode unmounts and remounts the provider', () => {
    const bg = new Set<() => void>();
    const fg = new Set<() => void>();
    const platform: PlatformAdapter = {
      storage: memoryStorage(),
      app: { platform: 'ios', version: '3.0' },
      onBackground: (cb) => (bg.add(cb), () => void bg.delete(cb)),
      onForeground: (cb) => (fg.add(cb), () => void fg.delete(cb)),
    };
    const view = render(
      <StrictMode>
        <SplitHubProvider config={config} platform={platform} pageviews={false} transport={{ send: () => undefined }}>
          <span />
        </SplitHubProvider>
      </StrictMode>
    );
    // StrictMode builds the client twice (the spare one is never mounted, so never destroyed) and runs
    // the effect twice with destroy() in between: the live client must be bound again, before any
    // screen() or track(). Without the rebind only the spare one would listen.
    expect([bg.size, fg.size]).toEqual([2, 2]);
    view.unmount();
    expect([bg.size, fg.size]).toEqual([1, 1]);
  });

  it('builds the app client itself from config and platform', () => {
    let seen: ReturnType<typeof useSplitHub> | null = null;
    function Probe() {
      seen = useSplitHub();
      return null;
    }
    const storage = memoryStorage();
    render(
      <SplitHubProvider config={config} platform={{ storage, app: { platform: 'ios', version: '3.0' } }} transport={{ send: () => undefined }}>
        <Probe />
      </SplitHubProvider>
    );
    expect(seen!.context).toMatchObject({ platform: 'ios', appVersion: '3.0' });
    expect(storage.getItem('sh_vid')).toBe(seen!.visitorId);
  });

  it('shows no devtools panel in React Native', () => {
    vi.spyOn(navigator, 'product', 'get').mockReturnValue('ReactNative');
    const client = createClient(config, { visitorId: 'v', transport: { send: () => undefined } });
    const view = render(<SplitHubDevtools client={client} />);
    expect(view.container.innerHTML).toBe('');
  });
});
