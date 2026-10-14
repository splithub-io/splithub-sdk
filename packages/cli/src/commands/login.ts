// `splithub login`: device-code sign-in. The CLI prints a short code and a
// URL; the user opens it, picks (or creates) a project and approves; the CLI
// receives a project API key and saves it for this directory. No browser
// automation, no secrets typed into the terminal — works over SSH and when a
// coding agent runs it: the agent shows the link, the human clicks it.
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { apiError, requireCloudToken, cloudTarget } from '../api';
import { CliError, fail } from '../errors';
import { credentialsFile, listCredentials, loadCredential, removeCredential, saveCredential, type SavedCredential } from '../credentials';
import { c } from '../ui';
import type { Flags } from './init';

interface Start {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  interval: number;
  expiresIn: number;
}
interface Poll {
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  apiKey?: string;
  projectId?: string | null;
  projectName?: string | null;
  publicKey?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DeviceLoginOptions {
  api: string;
  root?: string;
  json?: boolean;
  /** Project name or id to preselect on the approval page. */
  project?: string;
  /** Called with the link and code as soon as they exist (default: print them). */
  onCode?: (start: { verifyUrl: string; userCode: string; expiresIn: number }) => void;
}

/** Run the device flow and save the credential. Resolves with what was saved. */
export async function deviceLogin(options: DeviceLoginOptions): Promise<SavedCredential> {
  const { api } = options;
  const root = options.root ?? process.cwd();
  const label = `cli · ${basename(root)} @ ${hostname()}`.slice(0, 80);
  const startRes = await fetch(`${api}/auth/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }) });
  if (!startRes.ok) fail('API_ERROR', `${api}/auth/device responded ${startRes.status}.`);
  const start = (await startRes.json()) as Start;
  if (options.project) start.verifyUrl += `${start.verifyUrl.includes('?') ? '&' : '?'}project=${encodeURIComponent(options.project)}`;

  if (options.onCode) options.onCode(start);
  else if (options.json) console.log(JSON.stringify({ step: 'approve', userCode: start.userCode, verifyUrl: start.verifyUrl, expiresIn: start.expiresIn }));
  else {
    console.log(`\n${c.bold('Open this link to connect:')} ${c.cyan(start.verifyUrl)}`);
    console.log(`${c.dim('Code')} ${c.green(start.userCode)}   ${c.dim(`(expires in ${Math.round(start.expiresIn / 60)} min)`)}`);
    console.log(c.dim('Sign in, pick or create the project, approve. Waiting…'));
  }

  const deadline = Date.now() + start.expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(Math.max(2, start.interval) * 1000);
    const res = await fetch(`${api}/auth/device/${start.deviceCode}`);
    if (!res.ok) fail('API_ERROR', `${api}/auth/device responded ${res.status}.`);
    const poll = (await res.json()) as Poll;
    if (poll.status === 'pending') continue;
    if (poll.status === 'denied') fail('NOT_LOGGED_IN', 'The sign-in was denied in the dashboard.', 'Run npx splithub login again.');
    if (poll.status === 'expired') fail('NOT_LOGGED_IN', 'The sign-in code expired.', 'Run npx splithub login again.');
    if (poll.status === 'consumed' || !poll.apiKey) fail('NOT_LOGGED_IN', 'The key for this code was already collected.', 'Run npx splithub login again.');
    const cred: SavedCredential = { apiKey: poll.apiKey, projectId: poll.projectId ?? null, projectName: poll.projectName ?? null, publicKey: poll.publicKey ?? null, savedAt: new Date().toISOString() };
    saveCredential(api, root, cred);
    return cred;
  }
  throw new CliError('NOT_LOGGED_IN', 'The sign-in code expired.', 'Run npx splithub login again.');
}

export async function login(flags: Flags): Promise<void> {
  const api = cloudTarget({ api: flags.api }).url;
  const root = process.cwd();
  const existing = loadCredential(api, root);
  if (existing && !flags.yes) {
    const msg = `already logged in for ${c.cyan(existing.projectName ?? existing.projectId ?? 'a project')} (${credentialsFile()}). Use --yes to replace.`;
    if (flags.json) console.log(JSON.stringify({ ok: true, alreadyLoggedIn: true, projectId: existing.projectId, projectName: existing.projectName, publicKey: existing.publicKey ?? null }));
    else console.log(msg);
    return;
  }
  const cred = await deviceLogin({ api, root, json: Boolean(flags.json), ...(typeof flags.project === 'string' ? { project: flags.project } : {}) });
  if (flags.json) console.log(JSON.stringify({ ok: true, projectId: cred.projectId, projectName: cred.projectName, publicKey: cred.publicKey, credentials: credentialsFile() }));
  else {
    console.log(`${c.green('✔')} logged in to ${c.cyan(cred.projectName ?? cred.projectId ?? 'project')}`);
    console.log(c.dim(`key saved for ${root} in ${credentialsFile()}`));
    console.log(c.dim('next: npx splithub push'));
  }
}

export async function logout(flags: Flags): Promise<void> {
  const api = cloudTarget({ api: flags.api }).url;
  const removed = removeCredential(api, process.cwd());
  if (flags.json) console.log(JSON.stringify({ ok: true, removed }));
  else console.log(removed ? `${c.green('✔')} removed the saved key for this directory` : c.dim('nothing saved for this directory'));
}

export async function whoami(flags: Flags): Promise<void> {
  const target = requireCloudToken(flags);
  const res = await fetch(`${target.url}/status`, { headers: { authorization: `Bearer ${target.token}` } });
  const data = (await res.json().catch(() => ({}))) as { project?: string };
  if (!res.ok) throw apiError(res.status, data, `${target.url}/status responded ${res.status}`);
  const saved = loadCredential(target.url);
  if (flags.json) console.log(JSON.stringify({ ok: true, api: target.url, project: data.project, projectId: saved?.projectId ?? null, publicKey: saved?.publicKey ?? null }));
  else console.log(`${c.bold('api')} ${target.url}\n${c.bold('project')} ${c.cyan(data.project ?? '?')}\n${c.bold('public key')} ${saved?.publicKey ?? c.dim('unknown (log in again to fetch it)')}\n${c.bold('api key')} ${target.token.slice(0, 11)}…`);
}

/** `splithub projects`: what this machine is connected to, the current directory first. */
export async function projects(flags: Flags): Promise<void> {
  const api = cloudTarget({ api: flags.api }).url;
  const here = process.cwd();
  const rows = listCredentials(api).map((r) => ({ root: r.root, current: r.root === here, projectId: r.cred.projectId, projectName: r.cred.projectName, publicKey: r.cred.publicKey ?? null, savedAt: r.cred.savedAt }));
  if (flags.json) {
    console.log(JSON.stringify({ api, credentials: credentialsFile(), current: rows.find((r) => r.current) ?? null, projects: rows }));
    return;
  }
  if (rows.length === 0) {
    console.log(c.dim('no directory on this machine is connected yet. Run `splithub login` in your app.'));
    return;
  }
  for (const r of rows) console.log(`${r.current ? c.green('▸') : ' '} ${c.cyan(r.projectName ?? r.projectId ?? '?')} ${c.dim(`· ${r.root}`)}`);
  console.log(c.dim('\nswitch: run `splithub login --yes --project <name>` in that directory · disconnect: `splithub logout`'));
}
