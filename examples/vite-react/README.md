# SplitHub example: Vite + React, self-hosted

End-to-end demo with zero external services: the ingest handler runs inside
the Vite dev server and writes to `./splithub.db`.

```bash
pnpm dev          # http://localhost:5173
pnpm simulate     # 3000 synthetic visitors through the real SDK
pnpm status       # or: node ../../packages/cli/dist/index.js status
pnpm results      # visitors, conversions and rate per variant of hero-cta
```

Force a variant: `http://localhost:5173/?sh_force=hero-cta:bold,hero-title:direct`.

Files worth reading: `splithub.config.ts`, `src/App.tsx`, `vite.config.ts`.
