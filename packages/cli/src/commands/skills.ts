// `splithub skills [--mcp] [--force]`: install or refresh the agent skills in
// this project (.claude/skills/<name>/SKILL.md, .cursor/rules/splithub.mdc,
// an AGENTS.md section) and, with --mcp, register the SplitHub MCP server in
// .mcp.json (Claude Code) and .cursor/mcp.json (Cursor). `init` calls this too.
// The text comes from SplitHub Cloud (GET /v1/skills) so it updates with a deploy;
// the copies bundled here are the offline fallback.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fetchSkills, type SkillFile } from '../api';
import { detectProject } from '../project';
import { AGENTS_SECTION, CURSOR_RULE } from '../templates';
import { MCP_SERVER_ENTRY, SKILLS } from '../skills';
import { c } from '../ui';
import type { Flags } from './init';

export interface SkillsResult {
  written: string[];
  skipped: string[];
  mcp: string[];
  /** Where the text came from: SplitHub Cloud, or the copies bundled with the CLI. */
  source: 'cloud' | 'bundled';
}

/** The copies shipped with this CLI, in the shape GET /v1/skills serves. */
export const BUNDLED_SKILL_FILES: SkillFile[] = [
  ...SKILLS.map((s) => ({ path: `.claude/skills/${s.dir}/SKILL.md`, body: s.body })),
  { path: '.cursor/rules/splithub.mdc', body: CURSOR_RULE },
  { path: 'AGENTS.md', body: AGENTS_SECTION },
];

/** Only where skills belong: a server answer never writes anywhere else in the project. */
const SAFE_PATH = /^(\.claude\/skills\/[a-z0-9][a-z0-9-]*\/SKILL\.md|\.cursor\/rules\/[a-z0-9][a-z0-9-]*\.mdc|AGENTS\.md)$/;

/** Fresh text from SplitHub Cloud (1.5 s at most), else the bundled copies. */
export async function loadSkillFiles(flags: Record<string, unknown> = {}): Promise<{ files: SkillFile[]; source: 'cloud' | 'bundled' }> {
  const remote = (await fetchSkills(flags))?.filter((f) => SAFE_PATH.test(f.path));
  return remote?.length ? { files: remote, source: 'cloud' } : { files: BUNDLED_SKILL_FILES, source: 'bundled' };
}

function writeFile(file: string, content: string, force: boolean, out: SkillsResult): void {
  if (existsSync(file) && !force) {
    const current = readFileSync(file, 'utf8');
    if (current === content) {
      out.skipped.push(file);
      return;
    }
    // Skills we wrote earlier get refreshed; a user-edited file is left alone unless --force.
    if (!/SplitHub|splithub/.test(current)) {
      out.skipped.push(file);
      return;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  out.written.push(file);
}

/** Merge our server into an MCP config file ({ mcpServers: {...} }) without touching other entries. */
function registerMcp(file: string, out: SkillsResult): void {
  let json: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      json = JSON.parse(readFileSync(file, 'utf8')) as typeof json;
    } catch {
      out.skipped.push(`${file} (not valid JSON, left untouched)`);
      return;
    }
  }
  const servers = json.mcpServers ?? {};
  if (JSON.stringify(servers.splithub) === JSON.stringify(MCP_SERVER_ENTRY)) {
    out.skipped.push(file);
    return;
  }
  json.mcpServers = { ...servers, splithub: MCP_SERVER_ENTRY };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
  out.mcp.push(file);
}

export function installSkills(root: string, options: { mcp?: boolean; force?: boolean; files?: SkillFile[]; source?: 'cloud' | 'bundled' } = {}): SkillsResult {
  const out: SkillsResult = { written: [], skipped: [], mcp: [], source: options.source ?? (options.files ? 'cloud' : 'bundled') };
  const files = options.files ?? BUNDLED_SKILL_FILES;
  for (const f of files) if (f.path !== 'AGENTS.md') writeFile(join(root, ...f.path.split('/')), f.body, Boolean(options.force), out);

  const section = files.find((f) => f.path === 'AGENTS.md')?.body ?? AGENTS_SECTION;
  const agentsFile = ['AGENTS.md', 'CLAUDE.md'].map((f) => join(root, f)).find((f) => existsSync(f)) ?? join(root, 'AGENTS.md');
  if (!existsSync(agentsFile)) {
    writeFileSync(agentsFile, `# ${detectProject(root).name}
${section}`, 'utf8');
    out.written.push(agentsFile);
  } else if (!/SplitHub/.test(readFileSync(agentsFile, 'utf8'))) {
    writeFileSync(agentsFile, readFileSync(agentsFile, 'utf8') + `
${section}`, 'utf8');
    out.written.push(`${agentsFile} (section appended)`);
  } else {
    out.skipped.push(agentsFile);
  }

  if (options.mcp) {
    registerMcp(join(root, '.mcp.json'), out);
    registerMcp(join(root, '.cursor', 'mcp.json'), out);
  }
  return out;
}

export async function skills(flags: Flags): Promise<void> {
  const project = detectProject();
  const result = installSkills(project.root, { mcp: Boolean(flags.mcp), force: Boolean(flags.force), ...(await loadSkillFiles(flags)) });
  if (flags.json) {
    console.log(JSON.stringify(result));
    return;
  }
  const rel = (f: string) => relative(project.root, f) || f;
  if (result.written.length) console.log(`${c.green('✔')} wrote\n  ${result.written.map(rel).join('\n  ')}`);
  if (result.mcp.length) console.log(`${c.green('✔')} MCP server registered in\n  ${result.mcp.map(rel).join('\n  ')}`);
  if (result.skipped.length) console.log(c.dim(`unchanged: ${result.skipped.map(rel).join(', ')}`));
  if (result.source === 'bundled') console.log(c.dim("couldn't reach SplitHub Cloud, so these are the copies bundled with this CLI"));
  if (!flags.mcp) console.log(c.dim(`add --mcp to register the SplitHub MCP server (Claude Code .mcp.json, Cursor .cursor/mcp.json; Codex and Copilot read AGENTS.md)`));
  console.log(c.dim('skills: splithub (library + CLI), ab-testing (how to run experiments well), splithub-analytics (pageviews, events, reports), splithub-api (HTTP API), splithub-mcp (MCP tools), splithub-self-hosted (your own database), splithub-ship (keep the winner, remove the experiment), splithub-loop (the whole loop, tool by tool)'));
}
