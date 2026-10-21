import { createClient, isDebug, isReactNative, isDevEnvironment, type ClientOptions, type SplitHubClient, type SplitHubConfig } from '@splithub/core';
import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';

// Loaded only when debug mode is on, so the panel is not part of the app's main bundle.
const SplitHubDevtools = lazy(() => import('./Devtools').then((m) => ({ default: m.SplitHubDevtools })));

// `pending` is in the value so every consumer re-renders once when a first visit's
// overrides arrive; the client object itself never changes.
const SplitHubContext = createContext<{ client: SplitHubClient; pending: boolean } | null>(null);

export interface SplitHubProviderProps extends ClientOptions {
  /** The object from `splithub.config.ts`. Optional when `client` is given. */
  config?: SplitHubConfig;
  /**
   * Pass a prebuilt client (tests, SSR with a request-scoped visitor id, an app's client made with
   * a `platform` adapter). The provider then never destroys it.
   */
  client?: SplitHubClient;
  /** Fire pageview goals on mount (web; an app reports screens with `useScreen`). Default true. */
  pageviews?: boolean;
  /** Track click goals (`type: 'click'` with a CSS selector) automatically. Default true. */
  autoGoals?: boolean;
  /** Show the debug panel when the page has ?sh_debug=1. Default true. */
  devtools?: boolean;
  children: ReactNode;
}

let warnedServer = false;

/**
 * Creates the client synchronously during the first render, so variants are
 * known before anything paints. Wrap the app once. On a first visit in cloud
 * mode the client may wait briefly for the dashboard's overrides: control
 * renders meanwhile, then the tree re-renders once with the decided variants.
 */
export function SplitHubProvider({ config, client: given, pageviews = true, autoGoals = true, devtools = true, children, ...options }: SplitHubProviderProps) {
  const [client] = useState<SplitHubClient>(() => {
    if (given) return given;
    if (!config) throw new Error('[splithub] <SplitHubProvider> needs config={config} (from splithub.config.ts) or a client.');
    // A server render: no page and no app adapter (React Native has a `window` but is no server).
    if (!options.visitorId && !options.platform && typeof document === 'undefined' && !isReactNative() && isDevEnvironment() && !warnedServer) {
      warnedServer = true;
      console.warn(
        '[splithub] <SplitHubProvider> rendered on the server without visitorId, so the server renders the control and the browser may hydrate another variant. Pass visitorId from the sh_vid cookie (Next.js: getSplitHub(config).visitorId).'
      );
    }
    return createClient(config, options);
  });
  const pending = useSyncExternalStore(client.subscribe, () => client.pending, () => client.pending);
  const value = useMemo(() => ({ client, pending }), [client, pending]);
  const [debug, setDebug] = useState(false);
  useEffect(() => {
    if (devtools) setDebug(isDebug());
  }, [devtools]);

  useEffect(() => {
    // StrictMode runs this effect twice with a destroy() in between: bind the app lifecycle again.
    client.resume();
    if (pageviews) client.pageview();
    const unbind = autoGoals ? client.autoGoals() : () => undefined;
    return () => {
      unbind();
      void client.flush();
      // Releases the page listeners. Safe under StrictMode's unmount/remount: the next event binds again.
      if (!given) client.destroy();
    };
  }, [client, given, pageviews, autoGoals]);

  return (
    <SplitHubContext.Provider value={value}>
      {children}
      {debug && (
        <Suspense fallback={null}>
          <SplitHubDevtools client={client} />
        </Suspense>
      )}
    </SplitHubContext.Provider>
  );
}

export function useSplitHub(): SplitHubClient {
  const value = useContext(SplitHubContext);
  if (!value) {
    throw new Error('[splithub] wrap your app in <SplitHubProvider config={config}> (see splithub.config.ts).');
  }
  return value.client;
}

/** True while a first visit waits for the dashboard's overrides; flips to false once. */
export function useSplitHubPending(): boolean {
  return useContext(SplitHubContext)?.pending ?? false;
}
