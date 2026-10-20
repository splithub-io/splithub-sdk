'use client';

import type { RemoteOverrides } from '@splithub/core';
import { SplitHubProvider, useSplitHub, type SplitHubProviderProps } from '@splithub/react';
import { useEffect } from 'react';

export { SplitHubProvider, useSplitHub, Experiment, Variant, useVariant, useValue, useTrack, usePageview, useIdentify } from '@splithub/react';

export interface SplitHubNextProviderProps extends SplitHubProviderProps {
  /** Overrides the server applied (`(await getSplitHub(config)).overrides`), so client and server agree. */
  remoteOverrides?: RemoteOverrides | null;
}

/**
 * Same as SplitHubProvider; pass `visitorId` from the server layout so SSR
 * and hydration agree:
 *
 * ```tsx
 * // app/layout.tsx (server component)
 * const sh = await getSplitHub(config);
 * <SplitHubNextProvider config={config} visitorId={sh.visitorId ?? undefined} remoteOverrides={sh.overrides}>{children}</SplitHubNextProvider>
 * ```
 */
export function SplitHubNextProvider({ remoteOverrides, remote, ...props }: SplitHubNextProviderProps) {
  // The HTML is already decided on the server: never wait for overrides here, or the
  // first client render (control) would disagree with it.
  const remoteOptions = { waitMs: 0, ...(remote ?? {}), ...(remoteOverrides !== undefined ? { overrides: remoteOverrides } : {}) };
  return <SplitHubProvider {...props} remote={remoteOptions} />;
}

/** Records an exposure for an experiment rendered by a Server Component. */
export function Exposure({ id }: { id: string }) {
  const client = useSplitHub();
  useEffect(() => {
    client.exposure(id);
  }, [client, id]);
  return null;
}
