import { fail, printJson } from '../errors';
import { buildUpdateCommands, commandText, currentVersion, detectInstall, fetchLatest, isNewer, updateFlow } from '../update';
import type { Flags } from './init';

/** `splithub update`: check npm now and update the way this CLI was installed. */
export async function update(flags: Flags): Promise<void> {
  const current = currentVersion();
  const latest = await fetchLatest('splithub', { timeoutMs: 5000 });
  if (!latest) fail('UNREACHABLE', "Couldn't reach the npm registry.", 'Check your connection and try again.');
  const outdated = isNewer(latest, current);
  const install = detectInstall({ scriptPath: process.argv[1] ?? '', cwd: process.cwd() });
  if (flags.json) {
    const command = install.mode === 'npx' ? 'npx splithub@latest' : buildUpdateCommands(install).map(commandText).join(' && ');
    printJson({ current, latest, outdated, command: outdated ? command : null });
    return;
  }
  if (!outdated) {
    console.log(`You're on the latest splithub (${current}).`);
    return;
  }
  await updateFlow({ current, latest, yes: flags.yes === true, install });
}
