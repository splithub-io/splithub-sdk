---
name: splithub
description: Add, change or read A/B experiments in a React app that uses @splithub/react. Use when the user asks to A/B test a component, headline, image, price, CTA or page, or asks which variant is winning.
---

# SplitHub for coding agents

SplitHub experiments live in `splithub.config.ts` (source of truth) and are
rendered with `<Experiment>` / `useVariant` / `useValue` from `@splithub/react`.
Results are read with `npx splithub results <id> --json`.

## Create an experiment

1. Add it to `experiments` in `splithub.config.ts`. Pick `kind`:
   - `value` when only data changes (text, image URL, number, JSON). Prefer this: no new components.
   - `component` when layout or structure changes. Put each variant in its own component.
   - `redirect` when a whole page changes (needs `@splithub/next` middleware).
2. Set `goal` to an existing key in `goals`. If none fits, add one (`{ type: 'event' }` and call `track('<goal>')` where the conversion happens, or `{ type: 'pageview', path }`).
3. Wire it in code:
   - value: `const text = useValue<string>('<id>')`
   - component: `<Experiment id="<id>"><Variant name="control">…</Variant><Variant name="<other>">…</Variant></Experiment>`
4. Keep `status: 'draft'` until the user confirms, then `running`.

Keys: lowercase, `a-z0-9-_`, max 64 chars. First variant is `control`.
Weights are relative numbers (50/50, 1/1, 90/10 all work).

## Read results

```bash
npx splithub status --json
npx splithub results <id> --json
```

`verdict.status` is one of `no_data`, `insufficient_sample`, `srm_detected`,
`winner_found`, `no_significant_difference`. Report `verdict.message` to the
user verbatim; it is the recommendation. Do not declare a winner yourself from
raw rates.

## Finish an experiment

Set `status: 'finished'`, replace the `<Experiment>` or `useValue` call with the
winning content, remove losing components. Leave the config entry in place for history.

## Do not

- Do not nest an `<Experiment>` inside a `<Variant>` of the same id.
- Do not call `useVariant`/`useValue` conditionally (they are hooks).
- Do not change `seed` of a running experiment (it reshuffles visitors).
- Do not put secrets in `splithub.config.ts`; it ships to the browser. The
  cloud `key` is a public key. Database credentials belong in the server env.
- Do not add more than 3 running experiments on one page for a low-traffic site.
