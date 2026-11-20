/** How the project's bundler inlines a public variable: Expo and Next read process.env, Vite import.meta.env. */
function publicEnv(name: string, options: { app?: boolean; framework?: 'next' | 'vite' | 'unknown' }): string {
  if (options.app) return `process.env.EXPO_PUBLIC_${name}`;
  // `?.`: the CLI also loads this file in Node, where import.meta.env does not exist.
  if (options.framework === 'vite') return `import.meta.env?.VITE_${name}`;
  return `process.env.NEXT_PUBLIC_${name}`;
}

export function configTemplate(project: string, mode: 'self' | 'cloud', key?: string, options: { app?: boolean; framework?: 'next' | 'vite' | 'unknown' } = {}): string {
  // An app has no origin of its own: self-hosted events go to the server's full URL, and Expo inlines EXPO_PUBLIC_* variables.
  const endpoint = options.app ? `${publicEnv('SPLITHUB_ENDPOINT', options)} ?? 'https://example.com/api/splithub'` : "'/api/splithub'";
  // Cloud: the endpoint is optional. Unset, events go to SplitHub Cloud; set it (a domain or a URL) to send
  // through your own proxy or anywhere else, from an environment variable, without touching the packages.
  const storage = mode === 'self'
    ? `{ mode: 'self', endpoint: ${endpoint} }`
    : `{ mode: 'cloud', key: ${key ? `'${key}'` : `${publicEnv('SPLITHUB_KEY', options)} ?? ''`}, endpoint: ${publicEnv('SPLITHUB_ENDPOINT', options)} }`;
  const appNote = options.app
    ? `
// In an app this file is built into the binary: a new experiment here reaches users with the next
// store release. Create experiments in the dashboard to start them without a release.`
    : '';
  return `import { defineConfig } from '@splithub/core';

// SplitHub experiments. This file is the source of truth: the SDK, the CLI
// and the dashboard all read it. Keys: lowercase a-z 0-9 - _. First variant = control.${appNote}
export default defineConfig({
  project: '${project}',
  storage: ${storage},
  // Drafts behave like running experiments while you develop (next dev, vite); production ignores them.
  runDraftsInDev: true,

  goals: {
    // events you mark as goals: call track('signup') where it happens.
    // An experiment's goal may also be any other event name you track().
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
\`useValue(id)\`. Events: \`useTrack()\` then \`track('<event name>')\`; an experiment's goal is any event name.

- Not connected yet? \`npx splithub init --mode cloud\` (or \`npx splithub login\`) prints a link: show it to the user, they sign in and approve, the CLI gets the keys. Never ask the user to paste keys.
- New experiment: \`npx splithub create --kind value|component|redirect|mvt --id <key> --variants control,<other> --goal <event name> --yes\`
  then wire it in code (value → \`useValue\`, component → \`<Experiment>\` with one \`<Variant>\` per key, redirect → nothing,
  mvt → \`--factor name=level:value,…\` and \`const { a, b } = useValue(id)\`).
- Results: \`npx splithub results <id> --json\`; report \`verdict.message\` verbatim, never call a winner from raw rates.
- Lifecycle: \`npx splithub start|pause|finish <id>\`. Check setup: \`npx splithub doctor\`.
- A \`finished\` experiment still has all its variants in the code: report the verdict, ask which variant to keep and whether to
  remove the experiment from the code, then follow .claude/skills/splithub-ship/SKILL.md. Never delete experiment code unasked.
- \`create\` writes \`status: 'running'\`: the experiment goes live when the code is deployed. Always tell the user that, and that
  \`npx splithub pause <id>\` or Pause in the dashboard holds it. Never change \`seed\` of a running experiment.
- Analytics: set it up with \`npx splithub analytics connect --json\` (names the property on the provider), read it with
  \`npx splithub analytics <property> --json\`; also \`funnel\`, \`paths\`, \`retention\`, \`realtime\`, \`export\` (SplitHub Cloud).
  Details: .claude/skills/splithub-analytics/SKILL.md
- Notes, alerts, links, domains (SplitHub Cloud): \`npx splithub notes add "<what shipped>"\` when you ship, \`npx splithub alerts\` (rules, e.g.
  \`alerts add usage --every 1000\`), \`npx splithub links\` (short links), \`npx splithub domains\`. Humans: \`npx splithub\` opens the menu.
- Apps (React Native / Expo / iOS / Android): new experiments start in the dashboard (the config is built into the binary);
  screens are page events. Details: .claude/skills/splithub-apps/SKILL.md
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
