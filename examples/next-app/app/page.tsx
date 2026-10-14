import { getSplitHub } from '@splithub/next/server';
import config from '../splithub.config';
import { Hero } from './hero';

// Server Component: assignments are available without any client JS.
export default async function Home() {
  const sh = await getSplitHub(config);
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '64px 24px' }}>
      <Hero />
      <p style={{ marginTop: 48, fontSize: 12, color: '#666', fontFamily: 'ui-monospace, monospace' }}>
        server: visitor {sh.visitorId ?? 'none'} · hero-cta={sh.variant('hero-cta')} · hero-title={sh.variant('hero-title')}
        <br />
        Force: <code>?sh_force=hero-cta:bold,hero-title:direct,landing:v2</code>
      </p>
    </main>
  );
}
