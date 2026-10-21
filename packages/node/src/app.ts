import type { AppInfo } from '@splithub/core';
import type { StoredEvent } from './store';

const APP_OS: Record<AppInfo['platform'], string> = { ios: 'iOS', android: 'Android', macos: 'macOS', windows: 'Windows', linux: 'Linux' };

/** The stored dimensions a batch's `app` block stands for. Same mapping as the cloud ingest. */
export type AppDimensions = Pick<StoredEvent, 'platform' | 'app_version'> & Partial<Pick<StoredEvent, 'device' | 'os' | 'browser' | 'host'>>;

/**
 * `platform` is `web` and `app_version` null for websites. An app batch replaces the user agent:
 * device from `app.device` (default `mobile`), OS from the platform, browser `App`, and the app id
 * stands in for the origin host (apps send no Origin).
 */
export function appDimensions(app: AppInfo | undefined): AppDimensions {
  if (!app) return { platform: 'web', app_version: null };
  return { platform: app.platform, app_version: app.version ?? null, device: app.device ?? 'mobile', os: APP_OS[app.platform], browser: 'App', host: app.id ?? null };
}

/** The batch's events with the app dimensions stamped on (an ingest-supplied host wins over the app id). */
export function withAppDimensions(events: StoredEvent[], app: AppInfo | undefined): StoredEvent[] {
  const d = appDimensions(app);
  return events.map((e) => ({ ...e, ...d, ...(e.host ? { host: e.host } : {}) }));
}
