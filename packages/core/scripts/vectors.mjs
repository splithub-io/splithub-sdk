// Writes test/vectors.json: inputs and expected outputs of the assignment code, so the native
// SDKs (sdks/ios, sdks/android) can check their ports against this one, case by case.
// Run after a build: `npx tsup && node scripts/vectors.mjs`. A vitest test fails when the file
// no longer matches the code (src/__tests__/vectors.test.ts).
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NOW = Date.UTC(2026, 9, 12, 15, 30); // Monday 2026-10-12 15:30 UTC

const HASH_INPUTS = ['', 'a', 'ab', 'abc', 'abcd', 'abcde', 'hello world', 'v_123:hero:variant:abc', 'Привет', 'こんにちは世界', 'emoji 🎉🚀', 'ümlaut-ß', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢'];
const SEEDS = [0, 1, 42, 0x9747b28c, 4294967295];

const visitors = (n) => [...Array.from({ length: n }, (_, i) => `v_${i}`), 'vid-ünïcødé', 'v_😀', ''];

/** The config the `assign` cases run on, as written in splithub.config.ts. */
export const VECTOR_CONFIG = {
  project: 'vectors',
  storage: { mode: 'cloud', key: 'pk_test' },
  goals: { signup: { type: 'event' } },
  layers: { checkout: {}, pricing: { seed: 'pricing-v2' } },
  holdout: { percent: 10, seed: 'hold-seed' },
  experiments: {
    hero: { kind: 'component', status: 'running', goal: 'signup', variants: { control: 50, bold: 50 } },
    weighted: { kind: 'component', status: 'running', goal: 'signup', seed: 'reshuffled', traffic: 0.6, variants: { control: 1, a: 2, b: 3 } },
    price: { kind: 'value', status: 'running', goal: 'signup', variants: { control: { weight: 1, value: 9 }, cheaper: { weight: 1, value: 7 } } },
    paused: { kind: 'component', status: 'paused', variants: { control: 1, b: 1 } },
    scheduled: { kind: 'component', status: 'running', schedule: { startAt: '2026-11-01T00:00:00Z' }, variants: { control: 1, b: 1 } },
    layered: { kind: 'component', status: 'running', layer: { key: 'checkout', range: [0, 50] }, variants: { control: 1, b: 1 } },
    layered2: { kind: 'component', status: 'running', layer: { key: 'pricing', range: [30, 100] }, variants: { control: 1, b: 1 } },
    grid: { kind: 'mvt', status: 'running', factors: { headline: { old: 'Old', new: 'New' }, button: { blue: '#00f', green: '#0f0', red: '#f00' } } },
    targeted: {
      kind: 'component',
      status: 'running',
      traffic: 0.9,
      variants: { control: 1, bold: 1, wide: 1 },
      flow: {
        start: 'app',
        nodes: {
          app: { type: 'condition', match: 'all', conditions: [{ field: 'platform', op: 'in', value: 'ios, android' }], then: 'version', else: 'geo' },
          version: { type: 'condition', conditions: [{ field: 'app_version', op: 'gte', value: '2.10' }, { field: 'app_version', op: 'lt', value: '3' }], then: 'split', else: 'control' },
          geo: { type: 'condition', match: 'any', conditions: [{ field: 'country', op: 'is', value: 'DE' }, { field: 'device', op: 'not_in', value: 'desktop,tablet' }], then: 'utm', else: 'skip' },
          utm: { type: 'condition', conditions: [{ field: 'utm_source', op: 'matches', value: '^goo' }, { field: 'cookie', key: 'plan', op: 'exists' }], match: 'any', then: 'split', else: 'bold' },
          split: { type: 'split', outputs: [{ weight: 20, to: 'control' }, { weight: 30, to: 'bold' }, { weight: 50, to: 'wide' }] },
          control: { type: 'variant', variant: 'control' },
          bold: { type: 'variant', variant: 'bold' },
          wide: { type: 'variant', variant: 'wide' },
          skip: { type: 'skip' },
        },
      },
    },
  },
};

const CONTEXTS = [
  { now: NOW },
  { now: NOW, platform: 'ios', appVersion: '2.10.1' },
  { now: NOW, platform: 'android', appVersion: '2.9.9' },
  { now: NOW, platform: 'ios', appVersion: '3.0' },
  { now: NOW, platform: 'web', country: 'DE', device: 'desktop', url: 'https://x.test/?utm_source=google' },
  { now: NOW, platform: 'web', country: 'US', device: 'mobile', url: 'https://x.test/pricing' },
  { now: NOW, platform: 'web', country: 'US', device: 'desktop', cookies: { plan: 'pro' } },
  { now: NOW, device: 'bot' },
];

const CONDITIONS = [
  [{ field: 'country', op: 'is', value: 'de' }, { country: 'DE' }],
  [{ field: 'country', op: 'is_not', value: 'de' }, {}],
  [{ field: 'country', op: 'in', value: 'DE, AT,CH' }, { country: 'at' }],
  [{ field: 'country', op: 'not_in', value: 'DE, AT' }, { country: 'FR' }],
  [{ field: 'country', op: 'not_in', value: 'DE, AT' }, {}],
  [{ field: 'device', op: 'is', value: 'mobile' }, { device: 'tablet' }],
  [{ field: 'browser', op: 'contains', value: 'chrom' }, { browser: 'chrome' }],
  [{ field: 'os', op: 'not_contains', value: 'win' }, { os: 'macos' }],
  [{ field: 'url', op: 'starts_with', value: 'https://x.test/pri' }, { url: 'https://x.test/pricing' }],
  [{ field: 'path', op: 'is', value: '/pricing' }, { url: 'https://x.test/pricing?a=1#top' }],
  [{ field: 'query', key: 'ref', op: 'is', value: 'a b' }, { url: 'https://x.test/?ref=a+b' }],
  [{ field: 'utm_campaign', op: 'matches', value: 'spring|fall' }, { url: 'https://x.test/?utm_campaign=Spring-Sale' }],
  [{ field: 'utm_campaign', op: 'matches', value: '(' }, { url: 'https://x.test/?utm_campaign=x' }],
  [{ field: 'cookie', key: 'plan', op: 'exists' }, { cookies: { plan: 'pro' } }],
  [{ field: 'cookie', key: 'plan', op: 'not_exists' }, { cookies: {} }],
  [{ field: 'language', op: 'is', value: 'de' }, { language: 'de-DE,de;q=0.9' }],
  [{ field: 'visitor', op: 'is', value: 'new' }, { visitor: 'new' }],
  [{ field: 'hour', op: 'is', value: '15' }, { now: NOW }],
  [{ field: 'hour', op: 'is', value: '17' }, { now: NOW, timezone: 'Europe/Berlin' }],
  [{ field: 'hour', op: 'gte', value: '9' }, { now: NOW }],
  [{ field: 'weekday', op: 'in', value: 'sat,sun' }, { now: NOW }],
  [{ field: 'platform', op: 'is', value: 'ios' }, { platform: 'ios' }],
  [{ field: 'platform', op: 'in', value: 'ios,android' }, { platform: 'web' }],
  [{ field: 'platform', op: 'exists' }, {}],
  [{ field: 'app_version', op: 'gte', value: '2.9' }, { appVersion: '2.10.0' }],
  [{ field: 'app_version', op: 'lt', value: '2.9' }, { appVersion: '2.10.0' }],
  [{ field: 'app_version', op: 'gte', value: '2' }, { appVersion: '2.0.0' }],
  [{ field: 'app_version', op: 'lt', value: '2.0.1' }, { appVersion: '2' }],
  [{ field: 'app_version', op: 'gte', value: '1.2' }, {}],
  [{ field: 'app_version', op: 'lt', value: '1.2' }, {}],
  [{ field: 'app_version', op: 'gte', value: '' }, { appVersion: '1.0' }],
  [{ field: 'app_version', op: 'gte', value: '2.0.0-beta' }, { appVersion: '2.0.0-rc' }],
  [{ field: 'app_version', op: 'starts_with', value: '2.' }, { appVersion: '2.4.1' }],
];

const VERSION_PAIRS = [['2.10.0', '2.9'], ['2.9', '2.10.0'], ['2.0', '2'], ['2', '2.0.0'], ['1.2.3', '1.2.4'], ['10', '9'], ['1.0.0-beta', '1.0.0-alpha'], ['1.a', '1.10'], ['3', '3.0.1'], ['007', '7']];

/** Every vector, computed with the core module passed in (the built `dist`, or `src` in the test). */
export function buildVectors(core) {
  const config = core.defineConfig(VECTOR_CONFIG);
  const pickExperiments = [
    { key: 'hero', seed: 'hero', traffic: 1, variants: [{ key: 'control', weight: 0.5 }, { key: 'bold', weight: 0.5 }] },
    { key: 'three', seed: 'three', traffic: 1, variants: [{ key: 'a', weight: 0.2 }, { key: 'b', weight: 0.3 }, { key: 'c', weight: 0.5 }] },
    { key: 'partial', seed: 'other-seed', traffic: 0.25, variants: [{ key: 'control', weight: 0.5 }, { key: 'x', weight: 0.5 }] },
    { key: 'zero', seed: 'zero', traffic: 1, variants: [{ key: 'control', weight: 0 }, { key: 'only', weight: 1 }] },
  ];
  const vs = visitors(24);
  return {
    format: 'splithub-vectors',
    version: 1,
    about:
      'Generated by packages/core/scripts/vectors.mjs from @splithub/core. Every section lists inputs and the expected output; ports must match each case exactly. Hash strings are UTF-8. Units are murmur3 / 2^32.',
    keys: {
      pickVariant: 'traffic: hashToUnit(`${seed}:${key}:traffic:${visitor}`) < traffic, then variant: hashToUnit(`${seed}:${key}:variant:${visitor}`) against cumulative weights',
      layerBucket: 'min(99, floor(hashToUnit(`${layerSeed}:layer:${layer}:${visitor}`) * 100)), layerSeed defaults to the layer key',
      holdoutGroup: 'hashToUnit(`${seed}:__holdout:${visitor}`) < percent / 100 → holdout, else enrolled',
      flowSplit: 'hashToUnit(`${seed}:${key}:flow:${nodeId}:${visitor}`) * total weight against cumulative output weights',
    },
    murmur3: HASH_INPUTS.flatMap((input) => SEEDS.map((seed) => ({ input, seed, expected: core.murmur3(input, seed) }))),
    hashToUnit: HASH_INPUTS.map((input) => ({ input, seed: 0, expected: core.hashToUnit(input) })),
    pickVariant: pickExperiments.map((experiment) => ({
      experiment,
      cases: vs.map((visitor) => ({ visitor, expected: core.pickVariant({ ...experiment, kind: 'component', status: 'running' }, visitor)?.key ?? null })),
    })),
    layerBucket: [
      { layer: 'checkout', seed: 'checkout' },
      { layer: 'pricing', seed: 'pricing-v2' },
    ].flatMap(({ layer, seed }) => vs.map((visitor) => ({ layer, seed, visitor, expected: core.layerBucket({ layers: { [layer]: { seed } } }, layer, visitor) }))),
    holdoutGroup: [
      { percent: 10, seed: 'hold-seed' },
      { percent: 50, seed: 'vectors' },
    ].flatMap(({ percent, seed }) => vs.map((visitor) => ({ percent, seed, visitor, expected: core.holdoutGroup({ holdout: { percent, seed, goal: null } }, visitor) }))),
    compareVersions: VERSION_PAIRS.map(([a, b]) => ({ a, b, expected: core.compareVersions(a, b) })),
    conditions: CONDITIONS.map(([condition, context]) => ({ condition, context, expected: core.evaluateCondition(condition, context) })),
    mvt: [
      { key: 'grid', factors: { headline: { old: 'Old', new: 'New' }, button: { blue: '#00f', green: '#0f0', red: '#f00' } } },
      { key: 'triple', factors: { a: { x: 1, y: 2 }, b: { p: 1, q: 2 }, c: { m: 1, n: 2 } } },
    ].map(({ key, factors }) => {
      const { variants } = core.mvtVariants(key, factors);
      return { key, factors, expected: variants.map((v) => ({ key: v.key, weight: v.weight, levels: v.levels, value: v.value })) };
    }),
    assign: {
      about: 'config is the input of defineConfig; normalized is what defineConfig returns (also the shape of experiments added in the dashboard). context.now is the clock.',
      config: VECTOR_CONFIG,
      normalized: config,
      cases: config.experiments.flatMap((e) =>
        CONTEXTS.flatMap((context, contextIndex) =>
          vs.slice(0, e.flow ? 24 : 8).map((visitor) => {
            const a = core.assign(config, e.key, visitor, { context });
            return { experiment: e.key, visitor, context: contextIndex, expected: { variant: a.variant?.key ?? null, reason: a.reason } };
          })
        )
      ),
      contexts: CONTEXTS,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const core = await import(new URL('../dist/index.js', import.meta.url).href);
  const out = fileURLToPath(new URL('../test/vectors.json', import.meta.url));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(fileURLToPath(new URL('../test/', import.meta.url)), { recursive: true });
  writeFileSync(out, JSON.stringify(buildVectors(core), null, 2) + '\n');
  console.log(`wrote ${out}`);
}
