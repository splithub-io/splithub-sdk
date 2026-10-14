'use client';

import { Experiment, Variant, useTrack, useValue } from '@splithub/next/client';
import { HeroCtaBold } from '../splithub/hero-cta/Bold';
import { HeroCtaControl } from '../splithub/hero-cta/Control';

export function Hero() {
  const title = useValue<string>('hero-title');
  const track = useTrack();
  return (
    <>
      <h1 style={{ fontSize: 40, margin: '0 0 16px' }}>{title}</h1>
      <Experiment id="hero-cta">
        <Variant name="control">
          <HeroCtaControl />
        </Variant>
        <Variant name="bold">
          <HeroCtaBold />
        </Variant>
      </Experiment>
      <button onClick={() => track('signup')} style={{ marginTop: 16, padding: '12px 20px', borderRadius: 8, border: 0, cursor: 'pointer' }}>
        Sign up
      </button>
    </>
  );
}
