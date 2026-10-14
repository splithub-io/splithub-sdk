import * as p from '@clack/prompts';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { cloudTarget } from '../api';
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

function importPath(fromFile: string, toFile: string): string {
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

  let mode = str(flags.mode) as 'self' | 'cloud' | undefined;
  if (!mode) {
    if (yes) mode = 'self';
    else {
      const picked = await p.select({
        message: 'Where should events be stored?',
        options: [
          { value: 'self', label: 'My own database (self-hosted)', hint: 'free forever, nothing leaves your infra' },
          { value: 'cloud', label: 'SplitHub Cloud', hint: 'hosted dashboard, no server code' },
        ],
      });
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
  if (mode === 'self' && !flags.db && !yes) {
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
  const configFile = project.configFile ?? join(project.root, 'splithub.config.ts');
  writeIfMissing(configFile, configTemplate(project.name, mode, key), created, skipped);

  // 2a. store for self mode (postgres / mysql / custom); sqlite needs no file.
  const storeBody = mode === 'self' ? storeTemplate(db) : null;
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
  const runtime = ['@splithub/react', '@splithub/core'];
  if (project.framework === 'next') runtime.push('@splithub/next');
  if (mode === 'self') runtime.push('@splithub/node', ...runtimePackages(db));
  const installRuntime = installCommand(project.packageManager, runtime);
  const installDev = installCommand(project.packageManager, ['splithub'], true);
  let installed = false;
  if (!flags['no-install']) {
    const go = yes ? true : await p.confirm({ message: `Install packages now? (${installRuntime})` });
    if (p.isCancel(go)) return cancel();
    if (go) {
      const s = json ? null : p.spinner();
      s?.start('Installing');
      try {
        execSync(installRuntime, { cwd: project.root, stdio: json ? 'ignore' : 'inherit' });
        execSync(installDev, { cwd: project.root, stdio: json ? 'ignore' : 'inherit' });
        installed = true;
        s?.stop('Installed');
      } catch (error) {
        s?.stop('Install failed; run it manually');
        if (!json) p.log.error(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const providerHint =
    project.framework === 'next'
      ? `// ${project.appDir ?? 'app'}/layout.tsx\nimport { SplitHubNextProvider } from '@splithub/next/client';\nimport { getSplitHub } from '@splithub/next/server';\nimport config from '${importPath(join(project.root, project.appDir ?? 'app', 'layout.tsx'), configFile)}';\n\nexport default async function RootLayout({ children }) {\n  const sh = await getSplitHub(config);\n  return <html><body><SplitHubNextProvider config={config} visitorId={sh.visitorId ?? undefined} remoteOverrides={sh.overrides}>{children}</SplitHubNextProvider></body></html>;\n}`
      : `// main.tsx\nimport { SplitHubProvider } from '@splithub/react';\nimport config from './splithub.config';\n\n<SplitHubProvider config={config}><App /></SplitHubProvider>`;

  const warning = mode === 'cloud' && !key ? 'No public key yet: storage.key falls back to process.env.NEXT_PUBLIC_SPLITHUB_KEY. It is written into the config by the first `npx splithub push`, by `npx splithub login` (saved with the credentials), or pass --key pk_… (dashboard → Setup); SPLITHUB_API_KEY in the environment also resolves it.' : null;
  const summary = { project: project.name, framework: project.framework, mode, db: mode === 'self' ? db : null, connected, publicKey: key ?? null, warning, created, skipped, installed, installCommands: installed ? [] : [installRuntime, installDev], nextStep: providerHint, ...(project.framework === 'vite' ? { vitePlugin: VITE_PLUGIN_HINT } : {}) };

  if (json) {
    console.log(JSON.stringify(summary));
    return;
  }
  if (warning) p.log.warn(warning);
  if (mode === 'self' && db !== 'sqlite') p.note(db === 'custom' ? 'Fill in the three methods in splithub/store.ts (the comments say what each must return).' : `Set DATABASE_URL and run the SCHEMA_SQL from splithub/store.ts once (or add it to your migrations).`, `Database: ${db}`);
  if (created.length) p.note(created.map((f) => relative(project.root, f) || f).join('\n'), 'Created');
  if (skipped.length) p.note(skipped.map((f) => relative(project.root, f)).join('\n'), 'Already present, left untouched');
  if (!installed) p.note(`${installRuntime}\n${installDev}`, 'Install');
  p.note(providerHint, 'Wrap your app once');
  if (project.framework === 'vite') p.note(VITE_PLUGIN_HINT, 'Notes in your dev terminal');
  p.outro(`Next: ${c.cyan('npx splithub create')} to add your first experiment, ${c.cyan('npx splithub push')} to sync it, ${c.cyan('npx splithub doctor')} to verify.`);
}


function cancel(): void {
  p.cancel('Cancelled.');
  process.exit(0);
}
