// Stand-in for react-native in tests (aliased in vitest.config.ts). Tests change it through `rn`.
type State = 'active' | 'background' | 'inactive' | 'unknown';

const listeners = new Set<(s: State) => void>();

export const AppState = {
  currentState: 'active' as State | null,
  addEventListener(_type: 'change', listener: (s: State) => void) {
    listeners.add(listener);
    return { remove: () => void listeners.delete(listener) };
  },
};

export const Platform: { OS: string; Version: number | string; isPad?: boolean; constants: Record<string, unknown> } = {
  OS: 'ios',
  Version: '18.1',
  isPad: false,
  constants: {},
};

export const screen = { width: 390, height: 844 };

export const Dimensions = {
  get: () => screen,
};

export const rn = {
  /** Moves the app to a state and tells the listeners, like the OS does. */
  setAppState(next: State) {
    AppState.currentState = next;
    for (const l of [...listeners]) l(next);
  },
  listenerCount: () => listeners.size,
  reset() {
    listeners.clear();
    AppState.currentState = 'active';
    Object.assign(Platform, { OS: 'ios', Version: '18.1', isPad: false, constants: {} });
    Object.assign(screen, { width: 390, height: 844 });
  },
};
