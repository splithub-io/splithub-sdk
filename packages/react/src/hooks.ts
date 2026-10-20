import { getExperiment, type Assignment, type SplitHubClient } from '@splithub/core';
import { useCallback, useEffect, useMemo } from 'react';
import { useSplitHub, useSplitHubPending } from './context';

/**
 * The client's visitor, overrides and context are fixed for its lifetime, so one
 * assignment per client and experiment is enough: re-renders do not re-hash, and a
 * variant never changes under the visitor mid-page (a schedule or hour boundary
 * applies on the next page load). The one exception is a pending first visit: control is
 * served uncached until the client decides, then the decided assignment is cached.
 */
const cache = new WeakMap<SplitHubClient, Map<string, Assignment>>();

/** Assignment for an experiment, computed once per client. */
export function useAssignment(experimentKey: string): Assignment {
  const client = useSplitHub();
  const pending = useSplitHubPending();
  return useMemo(() => {
    if (pending) return client.assignment(experimentKey);
    let byKey = cache.get(client);
    if (!byKey) cache.set(client, (byKey = new Map()));
    let a = byKey.get(experimentKey);
    if (!a) byKey.set(experimentKey, (a = client.assignment(experimentKey)));
    return a;
  }, [client, experimentKey, pending]);
}

/**
 * Variant key for an experiment. Same key everywhere on the page for the
 * same visitor. Returns "control" when the experiment is not running.
 * Records an exposure after mount.
 */
export function useVariant(experimentKey: string): string {
  const client = useSplitHub();
  const experiment = getExperiment(client.config, experimentKey);
  const assignment = useAssignment(experimentKey);
  const key = assignment.variant?.key ?? experiment?.variants[0]?.key ?? 'control';

  useEffect(() => {
    client.exposure(experimentKey);
  }, [client, experimentKey]);

  return key;
}

/**
 * Payload of a `value` experiment: a headline, an image URL, a price, any JSON.
 * Returns the control value when not in the experiment.
 */
export function useValue<T = unknown>(experimentKey: string): T {
  const client = useSplitHub();
  const experiment = getExperiment(client.config, experimentKey);
  const assignment = useAssignment(experimentKey);
  const value = (assignment.variant ?? experiment?.variants[0])?.value as T;

  useEffect(() => {
    client.exposure(experimentKey);
  }, [client, experimentKey]);

  return value;
}

/**
 * `track('signup')`, `track('Video Played', { id: 3 })`, `track('checkout', { revenue: 49 })`: an event,
 * any name. It reaches the analytics property and converts experiments whose goal it is.
 */
export function useTrack(): (name: string, props?: Record<string, unknown>) => void {
  const client = useSplitHub();
  return useCallback((name, props) => client.track(name, props), [client]);
}

/** Call on route change in SPAs so pageview goals fire and the analytics property records the page. */
export function usePageview(path: string): void {
  const client = useSplitHub();
  useEffect(() => {
    client.pageview(path);
  }, [client, path]);
}

/**
 * `identify('user_42', { plan: 'pro' })`: ties this visitor to your user id for the analytics
 * property. Remembered in the browser and re-sent once per session; `identify(null)` on sign-out.
 */
export function useIdentify(): (uid: string | null, traits?: Record<string, unknown>) => void {
  const client = useSplitHub();
  return useCallback((uid, traits) => client.identify(uid, traits), [client]);
}
