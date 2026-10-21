import { useSplitHub } from '@splithub/react';
import { createContext, useCallback, useContext, useEffect, useRef, type Context } from 'react';
import { loadExpoRouter, loadNavigationRefContext } from './optional';

/** What this hook needs from React Navigation's container ref (`useNavigationContainerRef()` / `createNavigationContainerRef()`). */
export interface NavigationRefLike {
  getCurrentRoute(): { name: string } | undefined;
  isReady(): boolean;
  addListener?(type: 'state', callback: () => void): () => void;
}

type RefInput = NavigationRefLike | { current: NavigationRefLike | null };

const resolve = (ref: RefInput): NavigationRefLike | null =>
  'getCurrentRoute' in ref && typeof ref.getCurrentRoute === 'function' ? ref : 'current' in ref ? ref.current : null;

/**
 * React Navigation: reports the focused route as a screen (`/Settings`) when the container is ready
 * and on every change. Spread the returned handlers on the container to be sure the first screen counts:
 *
 * ```tsx
 * const ref = useNavigationContainerRef();
 * const tracking = useNavigationTracking(ref);
 * <NavigationContainer ref={ref} {...tracking}>
 * ```
 */
export function useNavigationTracking(ref: RefInput): { onReady: () => void; onStateChange: () => void } {
  const client = useSplitHub();
  const last = useRef<string | null>(null);
  const report = useCallback(() => {
    const nav = resolve(ref);
    if (!nav?.isReady()) return;
    const name = nav.getCurrentRoute()?.name;
    if (!name || name === last.current) return;
    last.current = name;
    client.screen(name);
  }, [client, ref]);

  useEffect(() => {
    report();
    const off = resolve(ref)?.addListener?.('state', report);
    // Rendered inside the container (<NavigationScreens />), this runs before the container is ready
    // and no state event follows for the first screen: look again once the commit is done.
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = () => {
      if (resolve(ref)?.isReady()) report();
      else if (++tries < 20) timer = setTimeout(retry, 50);
    };
    if (!resolve(ref)?.isReady()) timer = setTimeout(retry, 0);
    return () => {
      off?.();
      if (timer) clearTimeout(timer);
    };
  }, [ref, report]);

  return { onReady: report, onStateChange: report };
}

let warned = false;

/**
 * Expo Router: reports every pathname (`/product/42`) as a screen. Call it once in `app/_layout.tsx`,
 * inside `<SplitHubProvider>`.
 */
export function useExpoRouterTracking(): void {
  const client = useSplitHub();
  // The module is there or not for the whole life of the app, so the hook order never changes.
  const router = loadExpoRouter();
  const pathname = router ? router.usePathname() : null;
  useEffect(() => {
    if (pathname) client.screen(pathname);
    else if (!router && !warned) {
      warned = true;
      console.warn('[splithub] useExpoRouterTracking() needs expo-router. With React Navigation, use useNavigationTracking(ref).');
    }
  }, [client, pathname, router]);
}

const NO_CONTAINER = createContext<NavigationRefLike | null>(null);
let warnedNav = false;

/**
 * React Navigation in one line: `<NavigationScreens />` anywhere inside `<NavigationContainer>` (itself inside
 * `<SplitHubProvider>`). It finds the container through React Navigation's own context
 * (`@react-navigation/native` 6+); pass `navigationRef` to use your container ref instead.
 */
export function NavigationScreens({ navigationRef }: { navigationRef?: RefInput }): null {
  // The module is there or not for the whole life of the app, so the hook order never changes.
  const fromContainer = useContext(loadNavigationRefContext<Context<NavigationRefLike | null>>() ?? NO_CONTAINER);
  const missing = useRef<NavigationRefLike | null>(null);
  useNavigationTracking(navigationRef ?? fromContainer ?? missing);
  useEffect(() => {
    if (navigationRef || fromContainer || warnedNav) return;
    warnedNav = true;
    console.warn('[splithub] <NavigationScreens /> must be inside <NavigationContainer>, or pass navigationRef.');
  }, [navigationRef, fromContainer]);
  return null;
}

/** Expo Router in one line: `<ExpoRouterScreens />` inside `<SplitHubProvider>` in `app/_layout.tsx`. */
export function ExpoRouterScreens(): null {
  useExpoRouterTracking();
  return null;
}
