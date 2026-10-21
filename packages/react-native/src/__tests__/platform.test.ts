import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rn, Platform, screen } from './mocks/react-native';
import type { AsyncStorageLike, MMKVLike } from '../optional';

const optional = vi.hoisted(() => ({
  mmkv: null as MMKVLike | null,
  async: null as AsyncStorageLike | null,
  application: null as Record<string, unknown> | null,
  device: null as Record<string, unknown> | null,
  constants: null as Record<string, unknown> | null,
}));

vi.mock('../optional', () => ({
  loadMMKV: () => optional.mmkv,
  loadAsyncStorage: () => optional.async,
  loadExpoApplication: () => optional.application,
  loadExpoDevice: () => optional.device,
  loadExpoConstants: () => optional.constants,
  loadExpoRouter: () => null,
}));

import { appInfo, createAppPlatform } from '../platform';

function fakeAsyncStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const store = {
    data,
    release,
    getAllKeys: vi.fn(async () => [...data.keys()]),
    multiGet: vi.fn(async (keys: readonly string[]) => {
      await gate;
      return keys.map((k) => [k, data.get(k) ?? null] as const);
    }),
    setItem: vi.fn(async (k: string, v: string) => void data.set(k, v)),
    removeItem: vi.fn(async (k: string) => void data.delete(k)),
  };
  return store;
}

beforeEach(() => {
  rn.reset();
  Object.assign(optional, { mmkv: null, async: null, application: null, device: null, constants: null });
});
afterEach(() => vi.restoreAllMocks());

describe('storage', () => {
  it('preloads only its own AsyncStorage keys, then reads synchronously and writes through', async () => {
    const store = fakeAsyncStorage({ 'splithub:sh_vid': 'v_1', 'splithub:sh_queue': '[]', 'app:theme': 'dark' });
    const platform = createAppPlatform({ storage: store });
    expect(platform.loaded).toBe(false);
    expect(platform.storage.getItem('sh_vid')).toBeNull();
    store.release();
    await platform.ready;
    expect(platform.loaded).toBe(true);
    expect(store.multiGet).toHaveBeenCalledWith(['splithub:sh_vid', 'splithub:sh_queue']);
    expect(platform.storage.getItem('sh_vid')).toBe('v_1');
    expect(platform.storage.getItem('theme')).toBeNull();

    platform.storage.setItem('sh_uid', 'u_9');
    platform.storage.removeItem('sh_queue');
    await Promise.resolve();
    expect(store.data.get('splithub:sh_uid')).toBe('u_9');
    expect(store.data.has('splithub:sh_queue')).toBe(false);
    expect(platform.storage.getItem('sh_uid')).toBe('u_9');
  });

  it('keeps a value written while the preload is still reading', async () => {
    const store = fakeAsyncStorage({ 'splithub:sh_vid': 'old' });
    const platform = createAppPlatform({ storage: store });
    await Promise.resolve();
    platform.storage.setItem('sh_vid', 'new');
    store.release();
    await platform.ready;
    expect(platform.storage.getItem('sh_vid')).toBe('new');
  });

  it('goes on in memory after 3 s when AsyncStorage never answers, still writing through', async () => {
    vi.useFakeTimers();
    try {
      const store = { ...fakeAsyncStorage({}), getAllKeys: vi.fn(() => new Promise<readonly string[]>(() => undefined)) };
      const platform = createAppPlatform({ storage: store });
      await vi.advanceTimersByTimeAsync(2_900);
      expect(platform.loaded).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await platform.ready;
      expect(platform.loaded).toBe(true);
      platform.storage.setItem('sh_vid', 'v_new');
      expect(platform.storage.getItem('sh_vid')).toBe('v_new');
      expect(store.setItem).toHaveBeenCalledWith('splithub:sh_vid', 'v_new');
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds AsyncStorage by itself and prefers MMKV when installed', async () => {
    const store = fakeAsyncStorage({ 'splithub:sh_vid': 'v_a' });
    store.release();
    optional.async = store;
    const viaAsync = createAppPlatform();
    await viaAsync.ready;
    expect(viaAsync.storage.getItem('sh_vid')).toBe('v_a');

    const kv = new Map<string, string>([['sh_vid', 'v_m']]);
    optional.mmkv = { getString: (k) => kv.get(k), set: (k, v) => void kv.set(k, v), delete: (k) => void kv.delete(k) };
    const viaMMKV = createAppPlatform();
    expect(viaMMKV.loaded).toBe(true);
    expect(viaMMKV.storage.getItem('sh_vid')).toBe('v_m');
    viaMMKV.storage.setItem('sh_uid', 'u');
    viaMMKV.storage.removeItem('sh_vid');
    expect([...kv]).toEqual([['sh_uid', 'u']]);
  });

  it('takes a synchronous store as is, and falls back to memory with nothing installed', () => {
    const map = new Map<string, string>();
    const given = createAppPlatform({ storage: { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) } });
    expect(given.loaded).toBe(true);
    given.storage.setItem('a', '1');
    expect(map.get('a')).toBe('1');

    const memory = createAppPlatform();
    expect(memory.loaded).toBe(true);
    memory.storage.setItem('a', '2');
    expect(memory.storage.getItem('a')).toBe('2');
  });
});

describe('lifecycle', () => {
  it('calls back once per trip to the background and back', () => {
    const platform = createAppPlatform({ storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } });
    const away = vi.fn();
    const back = vi.fn();
    const offAway = platform.onBackground!(away);
    const offBack = platform.onForeground!(back);
    // iOS goes through inactive on the way out.
    rn.setAppState('inactive');
    rn.setAppState('background');
    expect(away).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    rn.setAppState('active');
    expect(back).toHaveBeenCalledTimes(1);
    rn.setAppState('background');
    rn.setAppState('active');
    expect(away).toHaveBeenCalledTimes(2);
    expect(back).toHaveBeenCalledTimes(2);
    offAway();
    offBack();
    expect(rn.listenerCount()).toBe(0);
  });
});

describe('app info', () => {
  it('reads Expo modules when installed', () => {
    optional.application = { applicationId: 'com.acme.shop', nativeApplicationVersion: '2.4.1', nativeBuildVersion: '412' };
    optional.device = { modelId: 'iPhone15,2', modelName: 'iPhone 14 Pro', osVersion: '18.1', deviceType: 1 };
    expect(appInfo()).toEqual({ platform: 'ios', id: 'com.acme.shop', version: '2.4.1', build: '412', os: '18.1', model: 'iPhone15,2', device: 'mobile' });
  });

  it('in Expo Go takes the app config over Expo Go itself, and options over both', () => {
    optional.application = { applicationId: 'host.exp.Exponent', nativeApplicationVersion: '2.32.0', nativeBuildVersion: '1' };
    optional.constants = { executionEnvironment: 'storeClient', expoConfig: { version: '1.2.0', ios: { bundleIdentifier: 'com.acme.shop', buildNumber: '7' } } };
    expect(appInfo()).toMatchObject({ id: 'com.acme.shop', version: '1.2.0', build: '7' });
    expect(appInfo({ version: '9.9.9' })).toMatchObject({ version: '9.9.9' });
  });

  it('falls back to Platform on bare React Native', () => {
    Object.assign(Platform, { OS: 'android', Version: 34, constants: { Release: '14', Model: 'Pixel 8' } });
    expect(appInfo({ appId: 'com.acme.shop', version: '3.0.0', build: '30' })).toEqual({
      platform: 'android',
      id: 'com.acme.shop',
      version: '3.0.0',
      build: '30',
      os: '14',
      model: 'Pixel 8',
      device: 'mobile',
    });
  });

  it('tells tablets and desktops apart', () => {
    Platform.isPad = true;
    expect(appInfo()?.device).toBe('tablet');
    Platform.isPad = false;
    Object.assign(screen, { width: 800, height: 1280 });
    expect(appInfo()?.device).toBe('tablet');
    Platform.OS = 'macos';
    expect(appInfo()?.device).toBe('desktop');
    expect(appInfo({ device: 'mobile' })?.device).toBe('mobile');
  });

  it('is not an app on the web', () => {
    Platform.OS = 'web';
    expect(appInfo()).toBeUndefined();
  });

  it('cuts values to the wire limits', () => {
    const info = appInfo({ appId: 'a'.repeat(200), version: '1'.repeat(40) });
    expect(info?.id).toHaveLength(128);
    expect(info?.version).toHaveLength(32);
  });

  it('puts language and time zone in the context', () => {
    const platform = createAppPlatform({ context: { country: 'DE' } });
    const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
    expect(platform.context).toEqual({ language: locale, timezone: timeZone, country: 'DE' });
  });
});
