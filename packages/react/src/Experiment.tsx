import { Children, isValidElement, useEffect, type ReactElement, type ReactNode } from 'react';
import { useSplitHub } from './context';
import { useAssignment } from './hooks';
import { getExperiment } from '@splithub/core';

export interface VariantProps {
  name: string;
  children?: ReactNode;
}

/** A variant slot inside <Experiment>. Renders only when assigned. */
export function Variant({ children }: VariantProps): ReactElement | null {
  return <>{children}</>;
}
Variant.displayName = 'SplitHub.Variant';

export interface ExperimentProps {
  id: string;
  children: ReactNode;
  /** Rendered when the assigned variant has no <Variant> child. Defaults to the control. */
  fallback?: ReactNode;
}

/**
 * ```tsx
 * <Experiment id="hero-cta">
 *   <Variant name="control"><Hero /></Variant>
 *   <Variant name="bold"><HeroBold /></Variant>
 * </Experiment>
 * ```
 * The variant is decided before the first paint; nothing flickers.
 */
export function Experiment({ id, children, fallback }: ExperimentProps): ReactElement | null {
  const client = useSplitHub();
  const experiment = getExperiment(client.config, id);
  const assignment = useAssignment(id);
  const controlKey = experiment?.variants[0]?.key ?? 'control';
  const key = assignment.variant?.key ?? controlKey;

  useEffect(() => {
    client.exposure(id);
  }, [client, id]);

  const slots = new Map<string, ReactElement<VariantProps>>();
  Children.forEach(children, (child) => {
    if (isValidElement<VariantProps>(child) && child.type === Variant && child.props.name) {
      slots.set(child.props.name, child);
    }
  });

  if (experiment) {
    for (const v of experiment.variants) {
      if (!slots.has(v.key)) warnOnce(`<Experiment id="${id}"> has no <Variant name="${v.key}">; falling back to control for it.`);
    }
  }

  const chosen = slots.get(key) ?? (fallback !== undefined ? null : slots.get(controlKey));
  if (chosen) return chosen;
  return <>{fallback ?? null}</>;
}
Experiment.displayName = 'SplitHub.Experiment';

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  if (typeof console !== 'undefined') console.warn(`[splithub] ${message}`);
}
