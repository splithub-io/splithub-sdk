import { SplitHubNextProvider } from '@splithub/next/client';
import { getSplitHub } from '@splithub/next/server';
import type { ReactNode } from 'react';
import config from '../splithub.config';

export const metadata = { title: 'SplitHub Next example' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The middleware sets the sh_vid cookie; passing it (and any live overrides) down keeps SSR and hydration in sync.
  const sh = await getSplitHub(config);
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#0b0b0f', color: '#eee' }}>
        <SplitHubNextProvider config={config} visitorId={sh.visitorId ?? undefined} remoteOverrides={sh.overrides}>
          {children}
        </SplitHubNextProvider>
      </body>
    </html>
  );
}
