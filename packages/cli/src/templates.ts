export function configTemplate(project: string, mode: 'self' | 'cloud', key?: string): string {
  const storage = mode === 'self' ? `{ mode: 'self', endpoint: '/api/splithub' }` : `{ mode: 'cloud', key: ${key ? `'${key}'` : "process.env.NEXT_PUBLIC_SPLITHUB_KEY ?? ''"} }`;
  return `import { defineConfig } from '@splithub/core';

// SplitHub experiments. This file is the source of truth: the SDK, the CLI
// and the dashboard all read it. Keys: lowercase a-z 0-9 - _. First variant = control.
export default defineConfig({
  project: '${project}',
  storage: ${storage},
  // Drafts behave like running tests while you develop (next dev, vite); production ignores them.
  runDraftsInDev: true,

  goals: {
    // call track('signup') where the conversion happens
    signup: { type: 'event' },
  },

  experiments: {
    // run \`npx splithub create\` or add entries here:
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
  },
});
`;
}

export function nextMiddlewareTemplate(configImport: string): string {
  return `import { splithubMiddleware } from '@splithub/next';
import splithub from '${configImport}';

// Sets the visitor cookie, forwards it to Server Components and serves
// redirect experiments with an invisible rewrite.
export default splithubMiddleware(splithub);

export const config = {
  matcher: ['/((?!_next|api|.*\\\\..*).*)'],
};
`;
}

export function nextRouteTemplate(configImport: string, store: { imports: string; factory: string } = { imports: "import { sqliteStore } from '@splithub/adapter-sqlite';", factory: "sqliteStore({ file: process.env.SPLITHUB_DB ?? './splithub.db' })" }): string {
  return `import { createSplitHubHandler } from '@splithub/node';
${store.imports}
import config from '${configImport}';

// Self-hosted ingest + results: events stay in your database. The CLI reads
// status / results from this route; set SPLITHUB_ADMIN_TOKEN to protect it.
const handler = createSplitHubHandler({
  config,
  store: ${store.factory},
  adminToken: process.env.SPLITHUB_ADMIN_TOKEN,
});

export const POST = handler;
export const GET = handler;
export const runtime = 'nodejs';
`;
}

export function componentVariantTemplate(name: string, experiment: string, variant: string): string {
  return `// Variant "${variant}" of experiment "${experiment}". Edit freely.
export function ${name}() {
  return (
    <section>
      <h2>${experiment} · ${variant}</h2>
    </section>
  );
}
`;
}

export const AGENTS_SECTION = `
## A/B testing (SplitHub)

This project uses SplitHub (\`@splithub/react\`). Experiments are declared in
\`splithub.config.ts\` and rendered with \`<Experiment id>\` / \`useVariant(id)\` /
\`useValue(id)\`. Conversions: \`useTrack()\` then \`track('<goal>')\`.

- Not connected yet? \`npx splithub init --mode cloud\` (or \`npx splithub login\`) prints a link: show it to the user, they sign in and approve, the CLI gets the keys. Never ask the user to paste keys.
- New experiment: \`npx splithub create --kind value|component|redirect|mvt --id <key> --variants control,<other> --goal <goal> --yes\`
  then wire it in code (value → \`useValue\`, component → \`<Experiment>\` with one \`<Variant>\` per key, redirect → nothing,
  mvt → \`--factor name=level:value,…\` and \`const { a, b } = useValue(id)\`).
- Results: \`npx splithub results <id> --json\`; report \`verdict.message\` verbatim, never call a winner from raw rates.
- Lifecycle: \`npx splithub start|pause|finish <id>\`. Check setup: \`npx splithub doctor\`.
- A \`finished\` test still has all its variants in the code: report the verdict, ask which variant to keep and whether to
  remove the test from the code, then follow .claude/skills/splithub-ship/SKILL.md. Never delete test code unasked.
- \`create\` writes \`status: 'running'\`: the test goes live when the code is deployed. Always tell the user that, and that
  \`npx splithub pause <id>\` or Pause in the dashboard holds it. Never change \`seed\` of a running experiment.
- Config ships to the browser: no secrets in it. Full rules: .claude/skills/splithub/SKILL.md
`;

export { SKILL_SPLITHUB as SKILL_MD } from './skills';
import { SKILL_SPLITHUB } from './skills';

export const CURSOR_RULE = `---
description: SplitHub A/B testing conventions
globs: ["splithub.config.ts", "splithub/**", "**/*.tsx"]
alwaysApply: false
---
${SKILL_SPLITHUB.replace(/^---[\s\S]*?---\n/, '')}`;
