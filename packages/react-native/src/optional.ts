// Modules an app may or may not have. Metro treats a require() as optional (a missing module is
// skipped, not a bundling error) only when it is written with a literal name directly inside a
// try block, so every load below is its own inline try { m = require('x') } catch {}: no helper,
// no callback. The CommonJS build that Metro reads keeps them that way (checked by a test).

export interface AsyncStorageLike {
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface MMKVLike {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete?(key: string): void;
  remove?(key: string): void;
}

interface MMKVModule {
  MMKV?: new (options?: { id: string }) => MMKVLike;
  createMMKV?: (options?: { id: string }) => MMKVLike;
}

export interface ExpoApplication {
  applicationId?: string | null;
  nativeApplicationVersion?: string | null;
  nativeBuildVersion?: string | null;
}

export interface ExpoDevice {
  modelId?: string | null;
  modelName?: string | null;
  osVersion?: string | null;
  /** DeviceType: 0 unknown, 1 phone, 2 tablet, 3 desktop, 4 tv. */
  deviceType?: number | null;
}

export interface ExpoConstants {
  /** `storeClient` in Expo Go, where expo-application describes Expo Go itself. */
  executionEnvironment?: string;
  expoConfig?: {
    version?: string;
    ios?: { bundleIdentifier?: string; buildNumber?: string };
    android?: { package?: string; versionCode?: number };
  } | null;
}

export interface ExpoRouter {
  usePathname(): string;
}

type Mod = Record<string, unknown> | null | undefined;
const pick = <T>(m: Mod, key?: string): T | null => (m ? (((key ? m[key] : (m.default ?? m)) as T | undefined) ?? null) : null);

/** MMKV (v2 / v3 `new MMKV()`, v4 `createMMKV()`) in a store of its own. */
export function loadMMKV(): MMKVLike | null {
  let mod: MMKVModule | null = null;
  try {
    mod = require('react-native-mmkv') as MMKVModule;
  } catch {
    return null;
  }
  try {
    if (mod?.createMMKV) return mod.createMMKV({ id: 'splithub' });
    if (mod?.MMKV) return new mod.MMKV({ id: 'splithub' });
  } catch {
    // installed but not available here (Expo Go has no MMKV)
  }
  return null;
}

export function loadAsyncStorage(): AsyncStorageLike | null {
  let m: Mod;
  try {
    m = require('@react-native-async-storage/async-storage') as Mod;
  } catch {
    return null;
  }
  return pick<AsyncStorageLike>(m);
}

export function loadExpoApplication(): ExpoApplication | null {
  let m: Mod;
  try {
    m = require('expo-application') as Mod;
  } catch {
    return null;
  }
  return m ? (m as ExpoApplication) : null;
}

export function loadExpoDevice(): ExpoDevice | null {
  let m: Mod;
  try {
    m = require('expo-device') as Mod;
  } catch {
    return null;
  }
  return m ? (m as ExpoDevice) : null;
}

export function loadExpoConstants(): ExpoConstants | null {
  let m: Mod;
  try {
    m = require('expo-constants') as Mod;
  } catch {
    return null;
  }
  return pick<ExpoConstants>(m);
}

export function loadExpoRouter(): ExpoRouter | null {
  let m: Mod;
  try {
    m = require('expo-router') as Mod;
  } catch {
    return null;
  }
  return m ? (m as unknown as ExpoRouter) : null;
}

/** React Navigation's context holding the container ref (`@react-navigation/native` 6+), read once. */
let navigationRefContext: unknown;
export function loadNavigationRefContext<T>(): T | null {
  if (navigationRefContext !== undefined) return navigationRefContext as T | null;
  let m: Mod;
  try {
    m = require('@react-navigation/native') as Mod;
  } catch {
    m = null;
  }
  navigationRefContext = pick<unknown>(m, 'NavigationContainerRefContext');
  return navigationRefContext as T | null;
}
