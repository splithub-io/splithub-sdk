import { defineConfig } from '@splithub/core';

export default defineConfig({
  project: 'example',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  // Drafts run while you develop; the production build ignores them.
  runDraftsInDev: true,

  goals: {
    signup: { type: 'event', description: 'Clicked the main CTA' },
    pricing_view: { type: 'pageview', path: '/pricing' },
  },

  experiments: {
    'hero-cta': {
      kind: 'component',
      status: 'running',
      variants: { control: 50, bold: 50 },
      goal: 'signup',
      description: 'Bolder hero with a single CTA',
    },
    'hero-title': {
      kind: 'value',
      status: 'running',
      variants: {
        control: { weight: 50, value: 'Ship experiments, not guesses' },
        direct: { weight: 50, value: 'Know which version wins' },
      },
      goal: 'signup',
    },
  },
});
