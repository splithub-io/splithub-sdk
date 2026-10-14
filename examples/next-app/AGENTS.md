# example-next-app

## A/B testing (SplitHub)

This project uses SplitHub (`@splithub/react`). Experiments are declared in
`splithub.config.ts` and rendered with `<Experiment id>` / `useVariant(id)` /
`useValue(id)`. Conversions: `useTrack()` then `track('<goal>')`.

- New experiment: `npx splithub create --kind value|component|redirect --id <key> --variants control,<other> --goal <goal> --yes`
  then wire it in code (value → `useValue`, component → `<Experiment>` with one `<Variant>` per key).
- Results: `npx splithub results <id> --json`; report `verdict.message` verbatim, never call a winner from raw rates.
- Lifecycle: `npx splithub start|pause|finish <id>`. Check setup: `npx splithub doctor`.
- Keep `status: 'draft'` until the user confirms. Never change `seed` of a running experiment.
- Config ships to the browser: no secrets in it. Full rules: .claude/skills/splithub/SKILL.md
