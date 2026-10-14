// Credentials saved by `splithub login`: ~/.config/splithub/credentials.json
// { "<api base>": { "<project root>": { apiKey, projectId, projectName, savedAt } } }
// `cloudTarget` falls back to the entry for the current directory when neither
// --token nor SPLITHUB_API_KEY is set.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface SavedCredential {
  apiKey: string;
  projectId: string | null;
  projectName: string | null;
  /** Public key of the project (pk_...), written into splithub.config.ts by init. */
  publicKey?: string | null;
  savedAt: string;
}

type Store = Record<string, Record<string, SavedCredential>>;

export function credentialsFile(): string {
  const base = process.env.XDG_CONFIG_HOME || (process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming') : join(homedir(), '.config'));
  return join(base, 'splithub', 'credentials.json');
}

function read(): Store {
  const file = credentialsFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Store;
  } catch {
    return {};
  }
}

export function loadCredential(api: string, root = process.cwd()): SavedCredential | null {
  return read()[api]?.[resolve(root)] ?? null;
}

export function saveCredential(api: string, root: string, cred: SavedCredential): string {
  const file = credentialsFile();
  const store = read();
  store[api] = { ...(store[api] ?? {}), [resolve(root)]: cred };
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  return file;
}

/** Every saved credential on this machine: which directory is connected to which project. */
export function listCredentials(api?: string): Array<{ api: string; root: string; cred: SavedCredential }> {
  const store = read();
  const out: Array<{ api: string; root: string; cred: SavedCredential }> = [];
  for (const [a, dirs] of Object.entries(store)) {
    if (api && a !== api) continue;
    for (const [root, cred] of Object.entries(dirs)) out.push({ api: a, root, cred });
  }
  return out.sort((x, y) => y.cred.savedAt.localeCompare(x.cred.savedAt));
}

export function removeCredential(api: string, root = process.cwd()): boolean {
  const store = read();
  const key = resolve(root);
  if (!store[api]?.[key]) return false;
  delete store[api][key];
  writeFileSync(credentialsFile(), JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  return true;
}
