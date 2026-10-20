// Pure helpers behind the menu: the top level, Analytics, Allowed domains, Links, Alerts and Notes.
import { describe, expect, it } from 'vitest';
import { analyticsOptions, funnelStepsError, parseHosts, propertyChoices, propertySnippets, REPORT_BREAKDOWNS, REPORT_SPANS } from '../commands/menu-analytics';
import { ANALYTICS_BY } from '../commands/analytics';
import { ALERT_CONDITIONS } from '../commands/alerts';
import { experimentOptions, menuOptions } from '../commands/menu';
import { ALERT_PRESETS, alertsOptions, CLOUD_ONLY_ITEM, linksOptions, notesOptions, USAGE_STEPS } from '../commands/menu-more';

describe('menu: analytics', () => {
  it('reads property choices from the cloud and from a self-hosted endpoint', () => {
    const cloud = propertyChoices({ properties: [{ key: 'sh-x1h78w', name: 'Site', status: 'running', last30: { visitors: 1234 } }, { key: 'sh-empty', name: null, status: 'paused', last30: null }] });
    expect(cloud).toEqual([
      { value: 'sh-x1h78w', label: 'Site (sh-x1h78w)', hint: 'running · 1,234 visitors', status: 'running' },
      { value: 'sh-empty', label: 'sh-empty', hint: 'paused', status: 'paused' },
    ]);
    const self = propertyChoices({ properties: [{ property: 'site', name: null, status: 'running', counts: { visitors: 5 } }, { name: 'no key' }] });
    expect(self).toEqual([{ value: 'site', label: 'site', hint: 'running · 5 visitors', status: 'running' }]);
  });

  it('names the property in both snippets', () => {
    const s = propertySnippets('sh-abc123');
    expect(s.provider).toBe('<SplitHubProvider config={config} property="sh-abc123">');
    expect(s.script).toContain('src="https://go.splithub.io/sh.js"');
    expect(s.script).toContain('data-property="sh-abc123"');
  });

  it('parses typed domains', () => {
    expect(parseHosts('example.com, App.Example.com  https://shop.example.com/cart?x=1 example.com')).toEqual(['example.com', 'app.example.com', 'shop.example.com']);
    expect(parseHosts(' , ')).toEqual([]);
  });

  it('offers only breakdowns and spans the CLI accepts', () => {
    for (const b of REPORT_BREAKDOWNS) expect(ANALYTICS_BY).toContain(b);
    expect([...REPORT_SPANS]).toEqual([7, 30, 90]);
    expect(analyticsOptions().map((o) => o.value)).toEqual(['connect', 'list', 'report', 'realtime', 'funnel', 'paths', 'retention', 'events', 'create', 'toggle', 'back']);
    expect(analyticsOptions('self').map((o) => o.value)).toEqual(['connect', 'list', 'report', 'events', 'create', 'toggle', 'back']);
  });

  it('checks typed funnel steps', () => {
    expect(funnelStepsError('page:/, event:Signup, goal:paid')).toBeUndefined();
    expect(funnelStepsError('page:/')).toMatch(/Two steps/);
    expect(funnelStepsError('page:/, signup')).toMatch(/"signup"/);
  });
});

describe('menu: top level and the cloud areas', () => {
  it('keeps the top level short and groups experiments', () => {
    expect(menuOptions({ hasConfig: false, mode: null, connected: false, signedIn: false }).map((o) => o.value)).toEqual(['init', 'exit']);
    expect(menuOptions({ hasConfig: true, mode: 'cloud', connected: true, signedIn: true }).map((o) => o.value)).toEqual(['experiments', 'analytics', 'links', 'alerts', 'notes', 'domains', 'sync', 'dev', 'doctor', 'skills', 'logout', 'exit']);
    expect(menuOptions({ hasConfig: true, mode: 'cloud', connected: false, signedIn: false })[0]!.value).toBe('login');
    const self = menuOptions({ hasConfig: true, mode: 'self', connected: false, signedIn: false });
    expect(self.map((o) => o.value)).toEqual(['experiments', 'analytics', 'links', 'alerts', 'notes', 'domains', 'dev', 'doctor', 'skills', 'exit']);
    for (const v of ['links', 'alerts', 'notes', 'domains']) expect(self.find((o) => o.value === v)!.hint).toBe('with SplitHub Cloud');
    expect(experimentOptions('self').map((o) => o.value)).toEqual(['create', 'status', 'results', 'start', 'pause', 'finish', 'back']);
  });

  it('offers alert presets the CLI accepts, usage steps first', () => {
    for (const preset of ALERT_PRESETS) expect(ALERT_CONDITIONS).toContain(preset.value);
    expect(ALERT_PRESETS[0]).toMatchObject({ value: 'usage', label: 'Every N events used' });
    expect([...USAGE_STEPS]).toEqual([100, 1000, 10000, 100000]);
    expect(alertsOptions().map((o) => o.value)).toEqual(['list', 'add', 'toggle', 'test', 'delete', 'back']);
    expect(linksOptions().map((o) => o.value)).toEqual(['list', 'stats', 'create', 'toggle', 'delete', 'back']);
    expect(notesOptions().map((o) => o.value)).toEqual(['list', 'add', 'edit', 'delete', 'back']);
    expect(CLOUD_ONLY_ITEM('Alerts')).toMatch(/^Alerts come with SplitHub Cloud/);
  });
});
