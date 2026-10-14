import { describe, expect, it } from 'vitest';
import { assign, parseForceParam } from '../assignment';
import { createClient } from '../client';
import { defineConfig } from '../config';
import { matchPath, normalizePath, redirectTarget } from '../paths';
import { decideRedirect } from '../redirect';
import { contextValue, isBot, isCrawler } from '../targeting';
import type { EventBatch } from '../types';

describe('matchPath', () => {
  it('ignores a trailing slash except on the root, prefixes with *', () => {
    expect(normalizePath('/pricing/')).toBe('/pricing');
    expect(normalizePath('/')).toBe('/');
    expect(matchPath('/', '/')).toBe(true);
    expect(matchPath('/pricing', '/pricing/')).toBe(true);
    expect(matchPath('/pricing/', '/pricing')).toBe(true);
    expect(matchPath('/pricing', '/pricing/x')).toBe(false);
    expect(matchPath('/blog/*', '/blog/a/b')).toBe(true);
    expect(matchPath('/blog/*', '/about')).toBe(false);
  });
});

describe('redirectTarget', () => {
  it('merges the current query (the target wins), keeps the hash', () => {
    expect(redirectTarget('/b?v=2', 'https://x.test/a?utm_source=g&v=1#top').toString()).toBe('https://x.test/b?v=2&utm_source=g#top');
    expect(redirectTarget('/b#own', 'https://x.test/a?a=1&a=2#top').toString()).toBe('https://x.test/b?a=1&a=2#own');
    expect(redirectTarget('https://other.test/p', 'https://x.test/a?q=1').toString()).toBe('https://other.test/p?q=1');
  });
});

describe('parseForceParam', () => {
  it('survives malformed escapes', () => {
    expect(parseForceParam('?sh_force=%E0%A4%A')).toEqual({});
    expect(parseForceParam('?sh_force=hero%3Abold')).toEqual({ hero: 'bold' });
  });
});

const config = defineConfig({
  project: 'p',
  storage: { mode: 'self', endpoint: '/api/splithub' },
  goals: { signup: { type: 'event' } },
  experiments: {
    hero: { kind: 'component', status: 'running', variants: { control: 0, bold: 1 } },
    home: { kind: 'redirect', status: 'running', match: '/', variants: { control: { weight: 0, to: '/' }, b: { weight: 1, to: '/b?x=1' } } },
  },
});

describe('bots', () => {
  const ua = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  it('isBot', () => {
    expect(isBot(ua)).toBe(true);
    expect(isBot('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36')).toBe(false);
    expect(isBot('')).toBe(false);
    expect(isBot(null)).toBe(false);
  });

  it('isCrawler lets plain HTTP clients through to ingest', () => {
    expect(isCrawler(ua)).toBe(true);
    expect(isBot('curl/8.4.0')).toBe(true);
    expect(isCrawler('curl/8.4.0')).toBe(false);
    expect(isCrawler('python-requests/2.31')).toBe(false);
    expect(isCrawler('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36')).toBe(false);
  });

  it('get the control, no redirect, no events; sh_force still works', async () => {
    expect(assign(config, 'hero', 'v1', { context: { device: 'bot' } })).toMatchObject({ variant: null, reason: 'bot' });
    expect(assign(config, 'hero', 'v1', { context: { device: 'bot' }, overrides: { hero: 'bold' } }).reason).toBe('override');
    expect(decideRedirect(config, '/', 'v1', { device: 'bot' })).toBeNull();
    const batches: EventBatch[] = [];
    const client = createClient(config, { visitorId: 'v1', context: { device: 'bot' }, transport: { send: (b) => void batches.push(b) } });
    expect(client.variant('hero')).toBe('control');
    client.track('signup');
    await client.flush();
    expect(batches).toHaveLength(0);
  });
});

describe('decideRedirect', () => {
  it('stays when the target is this path, moves otherwise, explains', () => {
    const seen: string[] = [];
    expect(decideRedirect(config, '/', 'v1', {}, {}, (e, a) => seen.push(`${e.key}:${a.reason}`))).toEqual({ experiment: 'home', variant: 'b', to: '/b?x=1', reason: 'assigned' });
    expect(seen).toEqual(['home:assigned']);
    expect(decideRedirect(config, '/', 'v1', {}, { home: 'control' })).toEqual({ experiment: 'home', variant: 'control', to: null, reason: 'override' });
  });
});

describe('hour and weekday', () => {
  const now = Date.UTC(2026, 9, 12, 23, 30); // Monday 23:30 UTC
  it('UTC without a time zone, local with one', () => {
    expect(contextValue('hour', undefined, { now })).toBe('23');
    expect(contextValue('weekday', undefined, { now })).toBe('mon');
    expect(contextValue('hour', undefined, { now, timezone: 'Europe/Berlin' })).toBe('1');
    expect(contextValue('weekday', undefined, { now, timezone: 'Europe/Berlin' })).toBe('tue');
    expect(contextValue('hour', undefined, { now, timezone: 'Not/AZone' })).toBe('23');
  });
});

describe('server without a visitor id', () => {
  it('renders the control', () => {
    const client = createClient(config, { transport: { send: () => undefined } });
    expect(client.variant('hero')).toBe('control');
    expect(client.assignment('hero').reason).toBe('no_visitor');
  });
});
