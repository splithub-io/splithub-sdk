// `npx splithub` with no arguments: a menu that walks through everything step
// by step (like an interactive assistant), so nobody has to learn the flags.
// Agents and scripts keep using the subcommands + --json.
import * as p from '@clack/prompts';
import { readFileSync } from 'node:fs';
import { cloudTarget, fetchStatus, resolveTarget } from '../api';
import { loadCredential } from '../credentials';
import { detectProject } from '../project';
import { c } from '../ui';
import { create } from './create';
import { dev } from './dev';
import { doctor } from './doctor';
import { init, type Flags } from './init';
import { lifecycle } from './lifecycle';
import { login, logout } from './login';
import { pull, push } from './push';
import { results } from './results';
import { skills } from './skills';
import { status } from './status';

type Action = 'init' | 'create' | 'status' | 'results' | 'start' | 'pause' | 'finish' | 'push' | 'pull' | 'login' | 'logout' | 'dev' | 'doctor' | 'skills' | 'exit';

function state(flags: Flags) {
  const project = detectProject();
  const api = cloudTarget({ api: flags.api }).url;
  const cred = loadCredential(api, project.root);
  const mode = project.configFile ? (/mode\s*:\s*['"]cloud['"]/.test(readSafe(project.configFile)) ? 'cloud' : 'self') : null;
  return { project, cred, mode, connected: Boolean(cred || process.env.SPLITHUB_API_KEY) };
}

function readSafe(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

async function pickExperiment(flags: Flags, message: string): Promise<string | null> {
  try {
    const data = await fetchStatus(resolveTarget(flags, detectProject()));
    if (data.experiments.length === 0) {
      p.log.warn('no experiments yet');
      return null;
    }
    const picked = await p.select({ message, options: data.experiments.map((e) => ({ value: e.experiment, label: e.experiment, hint: `${e.status} · ${e.visitors} visitors${e.headline ? ` · ${e.headline}` : ''}` })) });
    if (p.isCancel(picked)) return null;
    return picked as string;
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

export async function menu(flags: Flags): Promise<void> {
  p.intro(c.bold('splithub'));
  for (;;) {
    const s = state(flags);
    const where = s.project.configFile ? `${c.green('config')} ${s.mode === 'cloud' ? 'cloud mode' : 'self-hosted'}` : c.yellow('no config yet');
    const who = s.cred ? `${c.green('connected')} to ${c.cyan(s.cred.projectName ?? s.cred.projectId ?? 'project')}` : s.mode === 'cloud' ? c.yellow('not connected') : c.dim('local only');
    p.log.info(`${c.bold(s.project.name)} (${s.project.framework}) · ${where} · ${who}`);

    const options: Array<{ value: Action; label: string; hint?: string }> = [];
    if (!s.project.configFile) options.push({ value: 'init', label: 'Set up this app', hint: 'config, framework files, agent docs, sign-in link' });
    else {
      if (s.mode === 'cloud' && !s.connected) options.push({ value: 'login', label: 'Connect to SplitHub Cloud', hint: 'opens a sign-in link' });
      options.push({ value: 'create', label: 'Create an experiment', hint: 'step by step' });
      options.push({ value: 'status', label: 'Status of all experiments' });
      options.push({ value: 'results', label: 'Results of one experiment', hint: 'verdict, lift, confidence' });
      options.push({ value: 'start', label: 'Start an experiment' }, { value: 'pause', label: 'Pause an experiment' }, { value: 'finish', label: 'Finish an experiment' });
      if (s.mode === 'cloud') options.push({ value: 'push', label: 'Push config to the cloud', hint: 'after editing splithub.config.ts' }, { value: 'pull', label: 'Pull dashboard changes into the file' });
      options.push({ value: 'dev', label: 'Test locally in the browser', hint: 'debug panel: variants, reasons, events' });
      options.push({ value: 'doctor', label: 'Check the installation' });
      options.push({ value: 'skills', label: 'Install agent skills + MCP server', hint: 'Claude Code, Cursor, Codex' });
      if (s.cred) options.push({ value: 'logout', label: 'Disconnect this folder' });
    }
    options.push({ value: 'exit', label: 'Exit' });

    const action = await p.select<Action>({ message: 'What do you want to do?', options });
    if (p.isCancel(action) || action === 'exit') break;
    try {
      switch (action) {
        case 'init':
          await init({ ...flags, mode: flags.mode ?? 'cloud' });
          break;
        case 'login':
          await login({ ...flags, yes: true });
          break;
        case 'create':
          await create(flags);
          break;
        case 'status':
          await status(flags);
          break;
        case 'results': {
          const key = await pickExperiment(flags, 'Which experiment?');
          if (key) await results(key, flags);
          break;
        }
        case 'start':
        case 'pause':
        case 'finish': {
          const key = await pickExperiment(flags, `Which experiment to ${action}?`);
          if (key) await lifecycle(action, key, flags);
          break;
        }
        case 'push':
          await push(flags);
          break;
        case 'pull':
          await pull(flags);
          break;
        case 'logout':
          await logout(flags);
          break;
        case 'dev':
          await dev(flags);
          break;
        case 'doctor':
          await doctor(flags);
          break;
        case 'skills':
          await skills({ ...flags, mcp: true });
          break;
      }
    } catch (error) {
      p.log.error(error instanceof Error ? error.message : String(error));
    }
    console.log();
  }
  p.outro(`Scripts and agents: ${c.cyan('splithub --help')} lists every command; add ${c.cyan('--json')} for machine output.`);
}
