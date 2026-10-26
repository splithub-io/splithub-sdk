// Runs the splithub CLI as a child process with --json and parses the reply.
// The MCP server is a thin layer: credentials, config parsing and the cloud
// protocol stay in one place (the CLI).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function cliPath(): string {
  if (process.env.SPLITHUB_CLI) return process.env.SPLITHUB_CLI;
  return require.resolve('splithub/dist/index.js');
}

export function projectDir(): string {
  return process.env.SPLITHUB_PROJECT_DIR || process.cwd();
}

/** What the CLI prints with --json when a command fails. */
export interface CliErrorBody {
  error: string;
  code: string;
  hint?: string;
  scope?: string;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

/**
 * The CLI prints one line of JSON per --json command; init and login print a step
 * line first (the sign-in link), so the result is the last JSON line.
 */
export function parseJson(text: string): unknown {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') || l.startsWith('['));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!);
    } catch {
      // not JSON after all; try the line before
    }
  }
  return null;
}

export function errorBody(json: unknown): CliErrorBody | null {
  const j = json as Partial<CliErrorBody> | null;
  return j && typeof j.error === 'string' && typeof j.code === 'string' ? (j as CliErrorBody) : null;
}

/**
 * Flags the tools pass to the CLI. Tool values come from the model, so a value
 * like `--api=https://elsewhere` would otherwise be parsed as an option and send
 * the credential to another host. Anything starting with `-` must be one of these,
 * written alone (the tools never use `--flag=value`).
 */
export const TOOL_FLAGS = new Set([
  'baseline', 'before', 'by', 'compare', 'conversions', 'cooldown', 'count', 'day', 'days', 'delete', 'description', 'disabled',
  'drop-loser', 'dry-run', 'end', 'engagement', 'event', 'events', 'every', 'experiment', 'factor', 'filter', 'finish', 'force',
  'from', 'funnel', 'github-action', 'goal', 'goals', 'good-sample', 'guardrail', 'hours', 'id', 'keep', 'key', 'kind', 'layer',
  'lift', 'limit', 'match', 'max-visitors', 'mde', 'min-days', 'min-visitors', 'mode', 'name', 'no-install', 'no-login', 'page',
  'pause', 'percent', 'period', 'prev', 'property', 'prune', 'repeat', 'replace', 'return', 'same', 'save', 'secondary', 'segment',
  'slug', 'start', 'status', 'steps', 'timeline', 'to', 'traffic', 'type', 'value', 'variants', 'visitors', 'weights', 'within', 'yes',
].map((f) => `--${f}`));

export function unsafeArg(args: string[]): string | null {
  return args.find((a) => a.startsWith('-') && !TOOL_FLAGS.has(a)) ?? null;
}

export function runCli(args: string[], options: { timeoutMs?: number } = {}): Promise<CliResult> {
  const bad = unsafeArg(args);
  if (bad !== null) {
    const json: CliErrorBody = { error: `"${bad.slice(0, 80)}" is not a value the tool can pass on: values cannot start with "-".`, code: 'INVALID_ARGUMENT', hint: 'Use the id, host or text without a leading dash.' };
    return Promise.resolve({ code: 1, stdout: JSON.stringify(json), stderr: '', json });
  }
  const extra: string[] = [];
  if (process.env.SPLITHUB_API) extra.push('--api', process.env.SPLITHUB_API);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath(), ...args, ...extra, '--json'], { cwd: projectDir(), env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, json: parseJson(stdout) });
    });
  });
}

/**
 * `login` prints the sign-in link first and then waits (up to 10 min) for the
 * approval. Return the link at once and let the process finish on its own.
 */
export function startLogin(): Promise<{ verifyUrl: string; userCode: string; expiresIn: number } | { error: string; code?: string }> {
  const extra: string[] = [];
  if (process.env.SPLITHUB_API) extra.push('--api', process.env.SPLITHUB_API);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath(), 'login', '--yes', ...extra, '--json'], { cwd: projectDir(), env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    let buf = '';
    let done = false;
    child.stdout.on('data', (d) => {
      buf += d;
      if (done) return;
      for (const line of buf.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const j = JSON.parse(line) as { step?: string; verifyUrl?: string; userCode?: string; expiresIn?: number; alreadyLoggedIn?: boolean; error?: string; code?: string };
          if (j.step === 'approve' && j.verifyUrl) {
            done = true;
            resolve({ verifyUrl: j.verifyUrl, userCode: j.userCode ?? '', expiresIn: j.expiresIn ?? 600 });
          } else if (j.alreadyLoggedIn) {
            done = true;
            resolve({ error: 'already logged in' });
          } else if (typeof j.error === 'string') {
            done = true;
            resolve({ error: j.error, ...(j.code ? { code: j.code } : {}) });
          }
        } catch {
          // partial line
        }
      }
    });
    child.on('close', (code) => {
      if (!done) resolve({ error: `login exited with code ${code}: ${buf.slice(0, 300)}` });
    });
    child.unref();
  });
}
