import { isDevEnvironment, memoryStorage, type AppInfo, type KeyValueStorage, type PlatformAdapter, type TargetingContext } from '@splithub/core';
import { AppState, Dimensions, Platform, type AppStateStatus } from 'react-native';
import { loadAsyncStorage, loadExpoApplication, loadExpoConstants, loadExpoDevice, loadMMKV, type AsyncStorageLike } from './optional';

export interface AppPlatformOptions {
  /** Bundle id / application id (`com.acme.shop`). Read from Expo when installed. */
  appId?: string;
  /** Marketing version (`2.4.1`), what `app_version` targeting compares. Read from Expo when installed. */
  version?: string;
  /** Build number (`412`). Read from Expo when installed. */
  build?: string;
  /** Default: tablet on an iPad or a screen whose short side is 600 points or more, desktop on macOS and Windows. */
  device?: AppInfo['device'];
  /**
   * Where the visitor id and unsent events live. Default: react-native-mmkv when installed, else
   * AsyncStorage. Pass either one, or any synchronous `getItem` / `setItem` / `removeItem` store.
   */
  storage?: KeyValueStorage | AsyncStorageLike;
  /** Extra targeting context, merged over what the device reports. */
  context?: TargetingContext;
}

/** A platform adapter for React Native. `loaded` is false while AsyncStorage is read into memory. */
export interface AppPlatform extends PlatformAdapter {
  readonly loaded: boolean;
  /** Resolves once the storage can be read synchronously. Never rejects. */
  readonly ready: Promise<void>;
}

// AsyncStorage is shared with the rest of the app: our keys carry a prefix so the preload reads only them.
const PREFIX = 'splithub:';
/** How long the launch waits for AsyncStorage before going on without what it holds. */
export const PRELOAD_TIMEOUT_MS = 3000;

const LIMITS = { id: 128, version: 32, build: 32, os: 32, model: 64 } as const;

const isAsync = (s: KeyValueStorage | AsyncStorageLike): s is AsyncStorageLike =>
  typeof (s as AsyncStorageLike).multiGet === 'function' && typeof (s as AsyncStorageLike).getAllKeys === 'function';

interface Picked {
  storage: KeyValueStorage;
  ready: Promise<void>;
  loaded: () => boolean;
}

const syncStore = (storage: KeyValueStorage): Picked => ({ storage, ready: Promise.resolve(), loaded: () => true });

/** AsyncStorage read once into a map; reads are synchronous, writes go to both. */
function preloaded(store: AsyncStorageLike): Picked {
  const map = new Map<string, string>();
  // A key written before the preload finishes keeps the newer value.
  const touched = new Set<string>();
  let done = false;
  const read = (async () => {
    try {
      const keys = (await store.getAllKeys()).filter((k) => k.startsWith(PREFIX));
      if (keys.length) {
        for (const [k, v] of await store.multiGet(keys)) {
          const key = k.slice(PREFIX.length);
          // Also after a timeout: a late read fills what nothing has written since.
          if (v !== null && !touched.has(key)) map.set(key, v);
        }
      }
    } catch {
      // unreadable storage: start empty, like a first launch
    }
  })();
  // A storage that never answers must not keep the app on the fallback: after PRELOAD_TIMEOUT_MS go
  // on in memory, still writing through.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PRELOAD_TIMEOUT_MS);
  });
  const ready = Promise.race([read, timeout]).then(() => {
    clearTimeout(timer);
    done = true;
  });
  const storage: KeyValueStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      touched.add(k);
      map.set(k, v);
      store.setItem(PREFIX + k, v).catch(() => undefined);
    },
    removeItem: (k) => {
      touched.add(k);
      map.delete(k);
      store.removeItem(PREFIX + k).catch(() => undefined);
    },
  };
  return { storage, ready, loaded: () => done };
}

function pickStorage(given: AppPlatformOptions['storage']): Picked {
  if (given) return isAsync(given) ? preloaded(given) : syncStore(given);
  const mmkv = loadMMKV();
  if (mmkv) {
    return syncStore({
      getItem: (k) => mmkv.getString(k) ?? null,
      setItem: (k, v) => mmkv.set(k, v),
      removeItem: (k) => (mmkv.remove ? mmkv.remove(k) : mmkv.delete?.(k)),
    });
  }
  const async = loadAsyncStorage();
  if (async) return preloaded(async);
  if (isDevEnvironment()) {
    console.warn('[splithub] No storage found, so every launch is a new visitor. Install @react-native-async-storage/async-storage or react-native-mmkv.');
  }
  return syncStore(memoryStorage());
}

const isAway = (s: AppStateStatus | null): boolean => s === 'background' || s === 'inactive';

/** Calls `cb` when the app goes to the background (`'away'`) or comes back to active (`'active'`). */
function onAppState(to: 'away' | 'active', cb: () => void): () => void {
  let last = AppState.currentState;
  const sub = AppState.addEventListener('change', (next) => {
    const was = isAway(last);
    last = next;
    if (to === 'away' ? !was && isAway(next) : was && next === 'active') cb();
  });
  return () => sub.remove();
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

/** What the app is and runs on: the options first, then Expo modules when installed, then `Platform`. */
export function appInfo(options: AppPlatformOptions = {}): AppInfo | undefined {
  const os = Platform.OS;
  if (os !== 'ios' && os !== 'android' && os !== 'macos' && os !== 'windows') return undefined;
  const constants = (Platform.constants ?? {}) as Record<string, unknown>;
  const application = loadExpoApplication();
  const device = loadExpoDevice();
  const expo = loadExpoConstants();
  const manifest = expo?.expoConfig ?? null;
  const fromConfig = {
    id: os === 'ios' ? manifest?.ios?.bundleIdentifier : manifest?.android?.package,
    version: manifest?.version,
    build: os === 'ios' ? manifest?.ios?.buildNumber : manifest?.android?.versionCode,
  };
  const fromNative = { id: application?.applicationId, version: application?.nativeApplicationVersion, build: application?.nativeBuildVersion };
  // In Expo Go, expo-application describes Expo Go itself; the app's own numbers are in its config.
  const [first, second] = expo?.executionEnvironment === 'storeClient' ? [fromConfig, fromNative] : [fromNative, fromConfig];
  const info: AppInfo = { platform: os };
  const set = (key: keyof typeof LIMITS, ...values: unknown[]): void => {
    const v = values.map(str).find((x) => x !== undefined);
    if (v) info[key] = v.slice(0, LIMITS[key]);
  };
  set('id', options.appId, first.id, second.id);
  set('version', options.version, first.version, second.version);
  set('build', options.build, first.build, second.build);
  set('os', device?.osVersion, os === 'android' ? constants.Release : Platform.Version);
  set('model', device?.modelId, device?.modelName, constants.Model);
  info.device = options.device ?? deviceKind(device?.deviceType, constants);
  return info;
}

function deviceKind(expoType: number | null | undefined, constants: Record<string, unknown>): NonNullable<AppInfo['device']> {
  if (Platform.OS === 'macos' || Platform.OS === 'windows' || expoType === 3) return 'desktop';
  if (expoType === 2 || Platform.isPad || constants.interfaceIdiom === 'pad') return 'tablet';
  if (expoType === 1) return 'mobile';
  try {
    const { width, height } = Dimensions.get('screen');
    return Math.min(width, height) >= 600 ? 'tablet' : 'mobile';
  } catch {
    return 'mobile';
  }
}

function deviceContext(): TargetingContext {
  try {
    const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
    return { ...(locale ? { language: locale } : {}), ...(timeZone ? { timezone: timeZone } : {}) };
  } catch {
    return {};
  }
}

/**
 * The adapter the client runs on in an app: storage (MMKV, or AsyncStorage preloaded into memory),
 * app info, language and time zone, and the background / foreground lifecycle from `AppState`.
 * With AsyncStorage, wait for `ready` before creating a client (the provider does).
 */
export function createAppPlatform(options: AppPlatformOptions = {}): AppPlatform {
  const { storage, ready, loaded } = pickStorage(options.storage);
  const app = appInfo(options);
  return {
    storage,
    ...(app ? { app } : {}),
    context: { ...deviceContext(), ...(options.context ?? {}) },
    onBackground: (cb) => onAppState('away', cb),
    onForeground: (cb) => onAppState('active', cb),
    ready,
    get loaded() {
      return loaded();
    },
  };
}

let shared: AppPlatform | null = null;

/** The adapter the provider uses, made on the first call; options of later calls are ignored. */
export function sharedPlatform(options?: AppPlatformOptions): AppPlatform {
  return (shared ??= createAppPlatform(options));
}

/**
 * Starts reading the stored visitor early (in `index.js`, or before the splash screen hides) so
 * `<SplitHubProvider>` renders its children at once. Optional: the provider does it too.
 */
export async function prepare(options?: AppPlatformOptions): Promise<AppPlatform> {
  const platform = sharedPlatform(options);
  await platform.ready;
  return platform;
}

/** Tests: forget the shared adapter. */
export function resetSharedPlatform(): void {
  shared = null;
}
