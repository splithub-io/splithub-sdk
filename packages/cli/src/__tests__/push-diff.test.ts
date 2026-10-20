// configDiff: an experiment the cloud has from an earlier push that the file lacks is kept
// unless the push prunes; one made in the dashboard is neither removed nor listed as kept.
import { describe, expect, it } from 'vitest';
import { configDiff, type CloudExperiment } from '../commands/push';

type Local = Parameters<typeof configDiff>[0][number];

const variants = [
  { key: 'control', weight: 50 },
  { key: 'b', weight: 50 },
];
const local = [{ key: 'hero', kind: 'component', status: 'running', goal: 'signup', variants, traffic: 1 } as unknown as Local];
const cloudOf = (key: string, origin: string): CloudExperiment & { origin?: string } =>
  ({ key, kind: 'component', status: 'running', goal: 'signup', match: null, description: null, variants, traffic: 1, origin }) as CloudExperiment & { origin?: string };
const cloud = [cloudOf('hero', 'config'), cloudOf('legacy', 'config'), cloudOf('made', 'dashboard')];

describe('configDiff', () => {
  it('keeps what the file lacks unless prune', () => {
    expect(configDiff(local, cloud)).toEqual({ added: [], removed: [], kept: ['legacy'], changed: [] });
    expect(configDiff(local, cloud, true)).toEqual({ added: [], removed: ['legacy'], kept: [], changed: [] });
  });

  it('never removes or lists a dashboard-made experiment', () => {
    for (const prune of [false, true]) {
      const diff = configDiff(local, cloud, prune);
      expect(diff.removed).not.toContain('made');
      expect(diff.kept).not.toContain('made');
    }
  });
});
