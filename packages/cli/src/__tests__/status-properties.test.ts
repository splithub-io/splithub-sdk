// `splithub status` prints the analytics properties SplitHub Cloud sends after the experiments.
import { afterEach, expect, it, vi } from 'vitest';
import { printProperties } from '../commands/status';

afterEach(() => vi.restoreAllMocks());

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

it('prints one line per property with the change and goals', () => {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
  printProperties({
    propertiesRange: { from: '2026-10-13', to: '2026-10-19' },
    properties: [
      { property: 'site', name: 'Website', status: 'running', visitors: 1200, previousVisitors: 1000, change: 0.2, pageviews: 3000, conversions: [{ goal: 'signup', conversions: 40, change: 0.1 }] },
      { property: 'docs', name: 'Docs', status: 'paused', visitors: 5, previousVisitors: 0, change: null, pageviews: 9, conversions: [] },
    ],
  });
  const out = strip(lines.join('\n'));
  expect(out).toContain('Analytics · 2026-10-13 to 2026-10-19');
  expect(out).toMatch(/Website\s+running\s+1200\s+\+20%\s+signup 40/);
  expect(out).toMatch(/Docs\s+paused\s+5\s+new/);
});

it('prints nothing without properties (self-hosted, older servers)', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  printProperties({});
  printProperties({ properties: [] });
  expect(log).not.toHaveBeenCalled();
});
