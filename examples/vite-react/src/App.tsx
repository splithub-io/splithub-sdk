import { Experiment, Variant, useSplitHub, useTrack, useValue } from '@splithub/react';

function HeroControl() {
  const title = useValue<string>('hero-title');
  const track = useTrack();
  return (
    <section className="control">
      <h1>{title}</h1>
      <p>SplitHub runs A/B tests inside your React app. No flicker, no third-party script, your data stays in your database.</p>
      <button onClick={() => track('signup')}>Get started</button>
    </section>
  );
}

function HeroBold() {
  const title = useValue<string>('hero-title');
  const track = useTrack();
  return (
    <section className="bold">
      <h1>{title}</h1>
      <button onClick={() => track('signup')}>Start free →</button>
    </section>
  );
}

export function App() {
  const client = useSplitHub();
  return (
    <main>
      <Experiment id="hero-cta">
        <Variant name="control">
          <HeroControl />
        </Variant>
        <Variant name="bold">
          <HeroBold />
        </Variant>
      </Experiment>

      <div className="debug">
        visitor {client.visitorId} · hero-cta={client.assignment('hero-cta').variant?.key ?? 'control'} · hero-title=
        {client.assignment('hero-title').variant?.key ?? 'control'}
        <br />
        Force a variant: <code>?sh_force=hero-cta:bold,hero-title:direct</code>
        <br />
        Then run <code>pnpm status</code> or <code>pnpm results</code> in examples/vite-react.
      </div>
    </main>
  );
}
