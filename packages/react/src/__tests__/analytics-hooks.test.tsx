import { createClient, defineConfig, type EventBatch, type IdentifyEvent, type TrackEvent } from '@splithub/core';
import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SplitHubProvider, useIdentify, useTrack } from '../index';

const config = defineConfig({ project: 'p', storage: { mode: 'self', endpoint: '/api/splithub' }, experiments: {}, properties: { site: {} } });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

function Account() {
  const identify = useIdentify();
  useEffect(() => identify('user_7', { plan: 'team' }), [identify]);
  return null;
}
function Player() {
  const track = useTrack();
  useEffect(() => track('Video Played', { id: 3 }), [track]);
  return null;
}

describe('analytics hooks', () => {
  it('identify the user', async () => {
    const batches: EventBatch[] = [];
    const client = createClient(config, { visitorId: 'v1', property: 'site', transport: { send: (b) => void batches.push(b) } });
    render(
      <SplitHubProvider config={config} client={client} pageviews={false}>
        <Account />
      </SplitHubProvider>
    );
    await act(() => client.flush());
    const events = batches.flatMap((b) => b.events);
    expect(events.find((e): e is IdentifyEvent => e.type === 'identify')).toMatchObject({ uid: 'user_7', traits: { plan: 'team' } });
    expect(events.some((e) => e.type === 'event')).toBe(false);
  });

  it('track() sends one event row; the ingest derives the goal from it', async () => {
    const batches: EventBatch[] = [];
    const client = createClient(config, { visitorId: 'v1', property: 'site', transport: { send: (b) => void batches.push(b) } });
    render(
      <SplitHubProvider config={config} client={client} pageviews={false}>
        <Player />
      </SplitHubProvider>
    );
    await act(() => client.flush());
    const events = batches.flatMap((b) => b.events);
    expect(events.some((e) => e.type === 'goal')).toBe(false);
    expect(events.find((e): e is TrackEvent => e.type === 'event')).toMatchObject({ name: 'Video Played', props: { id: 3 } });
  });
});
