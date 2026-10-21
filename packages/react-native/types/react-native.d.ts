// The parts of react-native this package uses, so it typechecks and builds without installing
// React Native (tests replace the module with src/__tests__/mocks/react-native.ts). The published
// types never reference this file.
declare module 'react-native' {
  export type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';
  export const AppState: {
    currentState: AppStateStatus | null;
    addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void };
  };
  export const Platform: {
    OS: 'ios' | 'android' | 'macos' | 'windows' | 'web' | 'native';
    Version: number | string;
    isPad?: boolean;
    constants?: Record<string, unknown>;
  };
  export const Dimensions: {
    get(dim: 'window' | 'screen'): { width: number; height: number };
  };
}

/** The package version, set by tsup and vitest. */
declare const __SDK_VERSION__: string;

/** Metro's (and CommonJS's) require. Absent in an ES module, so every call sits in a try/catch. */
declare const require: (id: string) => unknown;
