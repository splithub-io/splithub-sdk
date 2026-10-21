import { defineConfig, type SplitHubConfig } from '@splithub/core';
import { SplitHubProvider as WebProvider, type SplitHubProviderProps as WebProviderProps } from '@splithub/react';
import { useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { sharedPlatform, type AppPlatform, type AppPlatformOptions } from './platform';

export const SDK = `react-native/${__SDK_VERSION__}`;

export interface SplitHubProviderProps extends Omit<WebProviderProps, 'config' | 'pageviews' | 'autoGoals' | 'devtools'> {
  /** The object from `splithub.config.ts`. Optional: with only `publicKey`, every experiment comes from the dashboard. */
  config?: SplitHubConfig;
  /** Your project's public key (`pk_...`), for an app with no config file. */
  publicKey?: string;
  /** Project name sent with the events when there is no config. Default `app`. */
  project?: string;
  /** App id, version, build, device and storage, when Expo cannot tell them (see `createAppPlatform`). */
  app?: AppPlatformOptions;
  /** Rendered while the stored visitor is read from AsyncStorage (one short read on launch). Default nothing. */
  fallback?: ReactNode;
}

/**
 * A config with no experiments: the cloud's overrides add every experiment and property made in the dashboard,
 * and on iOS / Android (a platform adapter, so `?all=1`) the ones pushed from `splithub.config.ts` too. Expo web
 * runs the plain web client, which gets the dashboard-made ones only.
 */
export function cloudConfig(publicKey: string, project = 'app'): SplitHubConfig {
  return defineConfig({ project, storage: { mode: 'cloud', key: publicKey }, experiments: {} });
}

/**
 * Wrap the app once. On React Native it keeps the visitor in MMKV or AsyncStorage, reports the app's
 * version and device, sends events when the app goes to the background and keeps them while offline.
 * Screens are reported by `useScreen`, `useNavigationTracking` or `useExpoRouterTracking`.
 * On the web (Expo web) it is the browser client, with pageviews.
 */
export function SplitHubProvider({ config, publicKey, project, app, fallback = null, platform, client, sdk, children, ...options }: SplitHubProviderProps) {
  const [resolved] = useState<SplitHubConfig | undefined>(() => {
    if (config) return config;
    if (publicKey) return cloudConfig(publicKey, project);
    if (client) return undefined;
    throw new Error('[splithub] <SplitHubProvider> needs publicKey="pk_..." from the dashboard, or config from splithub.config.ts.');
  });
  const web = Platform.OS === 'web';
  const [adapter] = useState<AppPlatform | NonNullable<WebProviderProps['platform']> | null>(() => (client || web ? null : platform ?? sharedPlatform(app)));
  const [loaded, setLoaded] = useState(() => !adapter || !('loaded' in adapter) || adapter.loaded);

  useEffect(() => {
    if (loaded || !adapter || !('ready' in adapter)) return;
    let live = true;
    void adapter.ready.then(() => {
      if (live) setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [adapter, loaded]);

  if (!loaded) return <>{fallback}</>;
  return (
    <WebProvider
      {...options}
      {...(client ? { client } : { config: resolved })}
      {...(adapter ? { platform: adapter } : {})}
      sdk={sdk ?? SDK}
      pageviews={web}
      autoGoals={web}
      devtools={web}
    >
      {children}
    </WebProvider>
  );
}
