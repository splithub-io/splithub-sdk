# SplitHub example: Next.js App Router, self-hosted

Generated with the CLI, then wired by hand (the parts an agent would do):

```bash
npx splithub init --yes                       # config, middleware.ts, app/api/splithub/[[...path]]/route.ts, agent docs
npx splithub create --kind value --id hero-title --variants control,direct \
  --value "control=Ship experiments, not guesses" --value "direct=Know which version wins" --goal signup --status running --yes
npx splithub create --kind component --id hero-cta --variants control,bold --goal signup --status running --yes
npx splithub create --kind redirect --id landing --variants control,v2 --match / --to control=/ --to v2=/home-v2 --goal signup --status running --yes
```

Run:

```bash
pnpm dev          # http://localhost:3000
pnpm doctor
pnpm status
```

What to look at: `middleware.ts` (visitor cookie + redirect rewrite),
`app/layout.tsx` (provider with the server visitor id), `app/page.tsx`
(Server Component reading assignments), `app/hero.tsx` (client experiment).
