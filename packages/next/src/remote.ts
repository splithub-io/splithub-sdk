import { CLOUD_ENDPOINT, fetchRemoteOverrides, resolveOverridesUrl, REMOTE_TTL_MS, type RemoteOverrides, type SplitHubConfig } from '@splithub/core';

interface MemoEntry {
  at: number;
  value: RemoteOverrides | null;
  pending: Promise<RemoteOverrides | null> | null;
}

// Module-level memo: edge isolates and Node servers keep it across requests,
// so at most one fetch per TTL per public key.
const memo = new Map<string, MemoEntry>();

export interface RemoteOptions {
  ttlMs?: number;
  /** Override the fetch implementation (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Live overrides for a cloud-mode config, cached in memory for `ttlMs`
 * (default 60s). Returns null in self mode or when the cloud is unreachable
 * (the config file then applies as-is).
 */
export async function getRemoteOverrides(config: SplitHubConfig, options: RemoteOptions = {}): Promise<RemoteOverrides | null> {
  if (config.storage.mode !== 'cloud' || !config.storage.key) return null;
  const ttl = options.ttlMs ?? REMOTE_TTL_MS;
  const url = resolveOverridesUrl(config.storage.endpoint ?? CLOUD_ENDPOINT, config.storage.key);
  const entry = memo.get(url);
  const now = Date.now();
  if (entry && now - entry.at < ttl) return entry.value;
  if (entry?.pending) return entry.value ?? entry.pending;

  const pending = fetchRemoteOverrides(url, options.fetchImpl).then((value) => {
    memo.set(url, { at: Date.now(), value: value ?? entry?.value ?? null, pending: null });
    return value ?? entry?.value ?? null;
  });
  memo.set(url, { at: entry?.at ?? 0, value: entry?.value ?? null, pending });
  // Serve stale while revalidating; first call waits.
  return entry ? entry.value : pending;
}

/** Tests only. */
export function clearRemoteMemo(): void {
  memo.clear();
}
