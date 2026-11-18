import * as p from '@clack/prompts';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { cloudTarget } from '../api';
import { appPackages, appProviderSnippet, findAppEntry, isNativeApp, isReactNativeApp, nativeSetup, patchAppEntry, screenTracking, type EntryPatch } from '../app-setup';
import { findTypeScript } from '../typescript';
import { loadCredential } from '../credentials';
import { detectProject, installCommand } from '../project';
import { deviceLogin } from './login';
import { configTemplate, nextMiddlewareTemplate, nextRouteTemplate } from '../templates';
import { DB_KINDS, runtimePackages, storeTemplate, storeUsage, type DbKind } from '../templates-store';
import { installSkills, loadSkillFiles } from './skills';
import { writeWorkflow } from './ci';
import { c } from '../ui';

export type Flags = Record<string, string | boolean | string[] | undefined>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function writeIfMissing(file: string, content: string, created: string[], skipped: string[]): void {
  if (existsSync(file)) {
    skipped.push(file);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  created.push(file);
}

export function importPath(fromFile: string, toFile: string): string {
  let rel = relative(dirname(fromFile), toFile).replace(/\\/g, '/').replace(/\.(ts|mts|js|mjs)$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

// Vite apps run the SDK in the browser; this plugin prints what each experiment does in the dev server's terminal.
const VITE_PLUGIN_HINT = `// vite.config.ts
import { splithub } from '@splithub/core/vite';

export default defineConfig({ plugins: [react(), splithub()] });`;

export async function init(flags: Flags): Promise<void> {
  const yes = Boolean(flags.yes);
  const json = Boolean(flags.json);
  const project = detectProject();
  const created: string[] = [];
  const skipped: string[] = [];

  if (!json) p.intro(c.bold('splithub init'));

  // Apps: React Native / Expo get the npm package and a wrapped entry; native iOS / Android get install lines.
  const rn = isReactNativeApp(project.app);
  const native = isNativeApp(project.app);
  const notes: string[] = [];

  let mode = str(flags.mode) as 'self' | 'cloud' | undefined;
  if (native && mode === 'self') {
    notes.push('Native apps read their experiments from SplitHub Cloud, so this project is set up for the cloud.');
    mode = 'cloud';
  }
  if (!mode) {
    // An app cannot reach a self-hosted endpoint without a server URL, and only the cloud starts experiments without a release.
    if (yes || native) mode = project.app ? 'cloud' : 'self';
    else {
      const self = { value: 'self', label: 'My own database (self-hosted)', hint: rn ? 'your server keeps the events; experiments ship with each release' : 'free forever, nothing leaves your infra' };
      const cloud = { value: 'cloud', label: 'SplitHub Cloud', hint: rn ? 'start and change experiments without a store release' : 'hosted dashboard, no server code' };
      const picked = await p.select({ message: 'Where should events be stored?', options: rn ? [cloud, self] : [self, cloud] });
      if (p.isCancel(picked)) return cancel();
      mode = picked as 'self' | 'cloud';
    }
  }

  // Cloud: connect this directory to a project. A saved login or SPLITHUB_API_KEY
  // is enough; otherwise run the device flow — print a link, the human signs in
  // and picks (or creates) the project, the CLI gets the keys. Works when an
  // agent runs init: it relays the link, the user clicks it.
  // Self mode: which database keeps the events. sqlite needs nothing; postgres / mysql
  // get a ready Store in splithub/store.ts; custom gets a documented stub.
  let db: DbKind = (DB_KINDS as string[]).includes(str(flags.db) ?? '') ? (str(flags.db) as DbKind) : 'sqlite';
  if (mode === 'self' && !project.app && !flags.db && !yes) {
    const picked = await p.select({
      message: 'Where should events be stored?',
      options: [
        { value: 'sqlite', label: 'SQLite file (zero setup)', hint: './splithub.db via node:sqlite' },
        { value: 'postgres', label: 'Postgres', hint: 'pg + DATABASE_URL, table splithub_events' },
        { value: 'mysql', label: 'MySQL / MariaDB / PlanetScale', hint: 'mysql2 + DATABASE_URL' },
        { value: 'custom', label: 'My own store (Prisma, Drizzle, Supabase, Mongo…)', hint: 'a stub with the three methods to fill in' },
      ],
    });
    if (p.isCancel(picked)) return cancel();
    db = picked as DbKind;
  }

  let key = str(flags.key);
  let connected: { projectName: string | null; projectId: string | null } | null = null;
  if (mode === 'cloud') {
    const api = cloudTarget(flags).url;
    const saved = loadCredential(api, project.root);
    if (saved) {
      key ??= saved.publicKey ?? undefined;
      connected = { projectName: saved.projectName, projectId: saved.projectId };
    } else if (!process.env.SPLITHUB_API_KEY && !flags['no-login']) {
      if (!json) p.log.step('Connect to SplitHub Cloud');
      try {
        const cred = await deviceLogin({
          api,
          root: project.root,
          json,
          onCode: json
            ? (s) => console.log(JSON.stringify({ step: 'approve', verifyUrl: s.verifyUrl, userCode: s.userCode, expiresIn: s.expiresIn, hint: 'Show this link to the user and wait; init continues once approved.' }))
            : (s) => p.note(`${c.cyan(s.verifyUrl)}\n\nCode ${c.green(s.userCode)} · sign in, pick or create the project, approve.`, 'Open this link'),
        });
        key ??= cred.publicKey ?? undefined;
        connected = { projectName: cred.projectName, projectId: cred.projectId };
        if (!json) p.log.success(`connected to ${c.cyan(cred.projectName ?? cred.projectId ?? 'project')}`);
      } catch (error) {
        if (!json) p.log.warn(`not connected: ${error instanceof Error ? error.message : String(error)}. Run ${c.cyan('npx splithub login')} later.`);
      }
    }
    // An API key in the environment (CI, agents) identifies the project: ask the cloud for its public key.
    if (!key && process.env.SPLITHUB_API_KEY) {
      try {
        const res = await fetch(`${api}/config`, { headers: { authorization: `Bearer ${process.env.SPLITHUB_API_KEY}` } });
        const body = (await res.json().catch(() => ({}))) as { publicKey?: string };
        if (typeof body.publicKey === 'string' && body.publicKey.startsWith('pk_')) {
          key = body.publicKey;
          connected ??= { projectName: null, projectId: null };
        }
      } catch {
        // offline: the first push writes the key into the config anyway
      }
    }
    if (!key && !yes) {
      const k = await p.text({ message: 'Cloud public key (pk_...), leave empty to set later via NEXT_PUBLIC_SPLITHUB_KEY', placeholder: 'pk_' });
      if (p.isCancel(k)) return cancel();
      key = k || undefined;
    }
  }

  // 1. config
  // Native apps never read the file (the SDK gets experiments from the cloud), so they get none.
  const configFile = project.configFile ?? join(project.root, 'splithub.config.ts');
  if (!native) writeIfMissing(configFile, configTemplate(project.name, mode, key, { app: rn }), created, skipped);

  // 2a. store for self mode (postgres / mysql / custom); sqlite needs no file. An app's events go to a server set up on its own.
  const storeBody = mode === 'self' && !project.app ? storeTemplate(db) : null;
  if (rn && mode === 'self') notes.push('Self-hosted: the app sends to storage.endpoint in the config. Point it at your server, and run npx splithub init --mode self there for the ingest route.');

  // 2b. app entry: wrap it in <SplitHubProvider>, with screen tracking.
  const screens = screenTracking(project);
  let entry: { file: string | null; patch: EntryPatch } | null = null;
  if (rn) {
    const file = findAppEntry(project.root, project.expoRouter);
    const ts = file ? await findTypeScript(project.root) : null;
    if (!file) entry = { file: null, patch: { source: null, status: 'manual', screens: false, reason: project.expoRouter ? 'no app/_layout.tsx' : 'no App.tsx' } };
    else if (!ts) entry = { file, patch: { source: null, status: 'manual', screens: false, reason: 'TypeScript is not installed, so the entry was left as it is' } };
    else {
      const patch = patchAppEntry(ts, file, readFileSync(file, 'utf8'), { configImport: importPath(file, configFile), screens });
      if (patch.source !== null) writeFileSync(file, patch.source, 'utf8');
      entry = { file, patch };
    }
  }
  const storeFile = storeBody ? join(project.root, 'splithub', 'store.ts') : null;
  if (storeFile && storeBody) writeIfMissing(storeFile, storeBody, created, skipped);

  // 2. framework files
  if (project.framework === 'next') {
    const mwFile = join(project.root, project.hasSrc ? 'src/middleware.ts' : 'middleware.ts');
    writeIfMissing(mwFile, nextMiddlewareTemplate(importPath(mwFile, configFile)), created, skipped);
    if (mode === 'self' && project.appDir) {
      const routeFile = join(project.root, project.appDir, 'api/splithub/[[...path]]/route.ts');
      writeIfMissing(routeFile, nextRouteTemplate(importPath(routeFile, configFile), storeUsage(db, storeFile ? importPath(routeFile, storeFile) : '')), created, skipped);
    }
  }

  // 3. agent skills (+ MCP server registration): the agent learns the library, how to test
  //    well, the API and the MCP tools from .claude/skills/*; Cursor gets the rule file.
  let mcp = !flags['no-mcp'];
  if (!yes && !json && mcp) {
    const want = await p.confirm({ message: 'Register the SplitHub MCP server for Claude Code / Cursor (.mcp.json, .cursor/mcp.json)?', initialValue: true });
    if (p.isCancel(want)) return cancel();
    mcp = want;
  }
  const skillsResult = installSkills(project.root, { mcp, ...(await loadSkillFiles(flags)) });
  created.push(...skillsResult.written, ...skillsResult.mcp.map((f) => `${f} (MCP server)`));
  skipped.push(...skillsResult.skipped);

  // 3b. GitHub workflow: checks on PRs, results comment on a schedule.
  if (flags['github-action']) {
    const wf = writeWorkflow(project.root, Boolean(flags.force));
    (wf.written ? created : skipped).push(join(project.root, wf.file));
  }

  // 4. dependencies
  const pkgs = rn ? appPackages(project) : null;
  const runtime = pkgs ? pkgs.runtime : ['@splithub/react', '@splithub/core'];
  if (project.framework === 'next' && !rn) runtime.push('@splithub/next');
  if (mode === 'self' && !project.app) runtime.push('@splithub/node', ...runtimePackages(db));
  const installRuntime = installCommand(project.packageManager, runtime);
  // Expo picks the native module version that matches the app's SDK.
  const installExpo = pkgs?.expo.length ? `npx expo install ${pkgs.expo.join(' ')}` : null;
  const installDev = installCommand(project.packageManager, ['splithub'], true);
  const commands = native ? [] : [installRuntime, ...(installExpo ? [installExpo] : []), installDev];
  let installed = false;
  if (!flags['no-install'] && commands.length) {
    const go = yes ? true : await p.confirm({ message: `Install packages now? (${commands.slice(0, -1).join(' && ')})` });
    if (p.isCancel(go)) return cancel();
    if (go) {
      const s = json ? null : p.spinner();
      s?.start('Installing');
      try {
        for (const cmd of commands) execSync(cmd, { cwd: project.root, stdio: json ? 'ignore' : 'inherit' });
        installed = true;
        s?.stop('Installed');
      } catch (error) {
        s?.stop('Install failed; run it manually');
        if (!json) p.log.error(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const entryFile = entry?.file ?? join(project.root, project.expoRouter ? 'app/_layout.tsx' : 'App.tsx');
  const nativeKit = native ? nativeSetup(project.app as 'ios' | 'android', key ?? null) : null;
  const providerHint = nativeKit
    ? `${nativeKit.install}\n\n${nativeKit.quickStart}`
    : rn
      ? appProviderSnippet(importPath(entryFile, configFile), screens)
      : project.framework === 'next'
      ? `// ${project.appDir ?? 'app'}/layout.tsx\nimport { SplitHubNextProvider } from '@splithub/next/client';\nimport { getSplitHub } from '@splithub/next/server';\nimport config from '${importPath(join(project.root, project.appDir ?? 'app', 'layout.tsx'), configFile)}';\n\nexport default async function RootLayout({ children }) {\n  const sh = await getSplitHub(config);\n  return <html><body><SplitHubNextProvider config={config} visitorId={sh.visitorId ?? undefined} remoteOverrides={sh.overrides}>{children}</SplitHubNextProvider></body></html>;\n}`
      : `// main.tsx\nimport { SplitHubProvider } from '@splithub/react';\nimport config from './splithub.config';\n\n<SplitHubProvider config={config}><App /></SplitHubProvider>`;

  const warning =
    mode === 'cloud' && !key
      ? native
        ? 'No public key yet: run `npx splithub login` (or pass --key pk_…, dashboard → Setup) and put it in SplitHub.start.'
        : `No public key yet: storage.key falls back to process.env.${rn ? 'EXPO_PUBLIC_SPLITHUB_KEY' : 'NEXT_PUBLIC_SPLITHUB_KEY'}. It is written into the config by the first \`npx splithub push\`, by \`npx splithub login\` (saved with the credentials), or pass --key pk_… (dashboard → Setup); SPLITHUB_API_KEY in the environment also resolves it.`
      : null;
  if (rn && entry?.file && entry.patch.status === 'added') created.push(`${entry.file} (wrapped in <SplitHubProvider>${entry.patch.screens && screens ? ', screens tracked' : ''})`);
  if (rn && entry?.patch.status === 'added' && !entry.patch.screens && screens) notes.push(`Screens: add <NavigationScreens /> inside your <NavigationContainer> (from @splithub/react-native).`);
  if (rn && !screens) notes.push("Screens: call useScreen('Home') in each screen (from @splithub/react-native).");
  if (project.app) notes.push('Experiments in splithub.config.ts ship inside the app binary. Create them in the dashboard to start them without a store release.');
  const app = project.app
    ? {
        kind: project.app,
        screens: rn ? screens ?? 'useScreen' : null,
        entry: entry ? { file: entry.file ? relative(project.root, entry.file).replace(/\\/g, '/') : null, status: entry.patch.status, screens: entry.patch.screens, ...(entry.patch.reason ? { reason: entry.patch.reason } : {}) } : null,
        ...(nativeKit ? { install: nativeKit.install, quickStart: nativeKit.quickStart } : {}),
      }
    : null;
  const providerDone = entry?.patch.status === 'added' || entry?.patch.status === 'already';
  const summary = { project: project.name, framework: project.framework, app, mode, db: mode === 'self' && !project.app ? db : null, connected, publicKey: key ?? null, warning, notes, created, skipped, installed, installCommands: installed ? [] : commands, nextStep: providerDone ? null : providerHint, ...(project.framework === 'vite' && !rn ? { vitePlugin: VITE_PLUGIN_HINT } : {}) };

  if (json) {
    console.log(JSON.stringify(summary));
    return;
  }
  if (warning) p.log.warn(warning);
  for (const note of notes) p.log.info(note);
  if (mode === 'self' && !project.app && db !== 'sqlite') p.note(db === 'custom' ? 'Fill in the three methods in splithub/store.ts (the comments say what each must return).' : `Set DATABASE_URL and run the SCHEMA_SQL from splithub/store.ts once (or add it to your migrations).`, `Database: ${db}`);
  if (created.length) p.note(created.map((f) => relative(project.root, f) || f).join('\n'), 'Created');
  if (skipped.length) p.note(skipped.map((f) => relative(project.root, f)).join('\n'), 'Already present, left untouched');
  if (!installed && commands.length) p.note(commands.join('\n'), 'Install');
  if (nativeKit) {
    p.note(nativeKit.install, project.app === 'ios' ? 'Add the Swift package' : 'Add the Gradle dependency');
    p.note(nativeKit.quickStart, 'Quick start');
    p.outro(`Next: create an experiment in the dashboard, then ${c.cyan('npx splithub status')} and ${c.cyan('npx splithub results <id>')} read it here.`);
    return;
  }
  if (rn && entry?.patch.status === 'manual') p.log.warn(`Left ${entry.file ? relative(project.root, entry.file) : 'the entry'} as it is: ${entry.patch.reason}. Add the provider by hand.`);
  if (!providerDone) p.note(providerHint, 'Wrap your app once');
  if (project.framework === 'vite' && !rn) p.note(VITE_PLUGIN_HINT, 'Notes in your dev terminal');
  const analyticsNext = rn ? `, ${c.cyan('npx splithub analytics connect')} for screens and retention` : '';
  p.outro(`Next: ${c.cyan('npx splithub create')} to add your first experiment, ${c.cyan('npx splithub push')} to sync it${analyticsNext}, ${c.cyan('npx splithub doctor')} to verify.`);
}


function cancel(): void {
  p.cancel('Cancelled.');
  process.exit(0);
}
