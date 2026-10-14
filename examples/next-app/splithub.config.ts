import { defineConfig } from '@splithub/core';

// SplitHub experiments. This file is the source of truth: the SDK, the CLI
// and the dashboard all read it. Keys: lowercase a-z 0-9 - _. First variant = control.
export default defineConfig({
  project: 'example-next-app',
  storage: { mode: 'self', endpoint: '/api/splithub' },

  goals: {
    // call track('signup') where the conversion happens
    signup: { type: 'event' },
  },

  experiments: {
    // run `npx splithub create` or add entries here:
    //
    // 'hero-title': {
    //   kind: 'value',
    //   status: 'running',
    //   variants: {
    //     control: { weight: 50, value: 'Ship faster' },
    //     direct:  { weight: 50, value: 'Know which version wins' },
    //   },
    //   goal: 'signup',
    // },
    'hero-title': {
      kind: 'value',
      status: 'running',
      variants: {
        control: { weight: 1, value: 'Ship experiments, not guesses' },
        direct: { weight: 1, value: 'Know which version wins' },
      },
      goal: 'signup',
    },
    'hero-cta': {
      kind: 'component',
      status: 'running',
      variants: { control: 1, bold: 1 },
      goal: 'signup',
    },
    landing: {
      kind: 'redirect',
      status: 'running',
      match: '/',
      variants: {
        control: { weight: 1, to: '/' },
        v2: { weight: 1, to: '/home-v2' },
      },
      goal: 'signup',
    },
  },
});
