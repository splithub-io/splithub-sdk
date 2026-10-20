import { debugMode, holdoutGroup, layerBucket, onDebug, type DebugEntry, type SplitHubClient } from '@splithub/core';
import { useEffect, useState } from 'react';

/**
 * Floating panel for `?sh_debug=1`: every experiment with its variant and the
 * reason, a switch to force another variant (reloads with ?sh_force), the live
 * log of exposures and goals, a "new visitor" button, and the redirect hold.
 * Mounted by SplitHubProvider when debug mode is on; never in production bundles
 * without the flag.
 */
export function SplitHubDevtools({ client }: { client: SplitHubClient }) {
  const [open, setOpen] = useState(true);
  const [log, setLog] = useState<DebugEntry[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => onDebug((e) => setLog((prev) => [e, ...prev].slice(0, 100))), []);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, []);
  const hold = debugMode() === 'hold';
  const force = (experiment: string, variant: string) => {
    const u = new URL(location.href);
    u.searchParams.set('sh_force', `${experiment}:${variant}`);
    u.searchParams.set('sh_debug', hold ? 'hold' : '1');
    location.assign(u.toString());
  };
  const newVisitor = () => {
    document.cookie = `${client.config.visitorKey}=; Max-Age=0; Path=/`;
    try {
      sessionStorage.removeItem('sh_sid');
      sessionStorage.removeItem('sh_exposed');
    } catch {
      // ignore
    }
    const u = new URL(location.href);
    u.searchParams.delete('sh_force');
    location.assign(u.toString());
  };
  const toggleHold = () => {
    const u = new URL(location.href);
    u.searchParams.set('sh_debug', hold ? '1' : 'hold');
    location.assign(u.toString());
  };
  const off = () => {
    const u = new URL(location.href);
    u.searchParams.set('sh_debug', '0');
    u.searchParams.delete('sh_force');
    location.assign(u.toString());
  };
  const box: React.CSSProperties = { position: 'fixed', right: 12, bottom: 12, zIndex: 2147483000, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, color: '#e4e4e7' };
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ ...box, background: '#18181b', border: '1px solid #3f3f46', borderRadius: 999, padding: '6px 10px', cursor: 'pointer' }} title="SplitHub debug">
        SH · {client.config.experiments.length}
      </button>
    );
  }
  return (
    <div style={{ ...box, width: 360, maxHeight: '70vh', overflow: 'auto', background: '#09090b', border: '1px solid #3f3f46', borderRadius: 12, boxShadow: '0 10px 40px rgba(0,0,0,.5)' }} data-tick={tick}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid #27272a', position: 'sticky', top: 0, background: '#09090b' }}>
        <strong style={{ color: '#34d399' }}>SplitHub debug</strong>
        <span style={{ color: '#71717a' }}>visitor {client.visitorId.slice(0, 8)}…</span>
        {holdoutGroup(client.config, client.visitorId) === 'holdout' && <span style={{ color: '#fb923c' }} title={REASONS.holdout}>holdout</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" onClick={newVisitor} style={btn} title="Drop the visitor cookie and reload">
            new visitor
          </button>
          <button type="button" onClick={toggleHold} style={{ ...btn, color: hold ? '#fb923c' : '#e4e4e7' }} title="Redirect experiments log the target instead of navigating">
            {hold ? 'hold: on' : 'hold'}
          </button>
          <button type="button" onClick={off} style={btn} title="Turn debug mode off">
            off
          </button>
          <button type="button" onClick={() => setOpen(false)} style={btn}>
            –
          </button>
        </span>
      </div>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #27272a' }}>
        {client.config.experiments.map((e) => {
          const a = client.assignment(e.key);
          return (
            <div key={e.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <span style={{ color: e.status === 'running' ? '#34d399' : '#71717a', minWidth: 8 }}>●</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${e.kind} · ${e.status}`}>
                {e.key}
              </span>
              <span style={{ color: '#71717a' }} title={REASONS[a.reason] ?? undefined}>
                {a.reason === 'layer' && e.layer ? `layer ${e.layer.key} ${e.layer.range[0]}–${e.layer.range[1]} (bucket ${layerBucket(client.config, e.layer.key, client.visitorId)})` : a.reason}
              </span>
              <select value={a.variant?.key ?? ''} onChange={(ev) => force(e.key, ev.target.value)} style={{ background: '#18181b', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 6, padding: '2px 4px', fontSize: 12 }}>
                {!a.variant && <option value="">(none)</option>}
                {e.variants.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.key}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
        {client.config.experiments.length === 0 && <div style={{ color: '#71717a' }}>No experiments in the config.</div>}
      </div>
      <div style={{ padding: '6px 10px' }}>
        {log.length === 0 && <div style={{ color: '#71717a' }}>Waiting for events… exposures and goals appear here.</div>}
        {log.map((l, i) => (
          <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid #18181b' }}>
            <span style={{ color: COLORS[l.kind] ?? '#a1a1aa' }}>{l.kind}</span> <span>{l.message}</span>
            {l.data && <div style={{ color: '#71717a', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(l.data)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = { background: '#18181b', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 6, padding: '2px 6px', cursor: 'pointer', fontSize: 11 };
const REASONS: Partial<Record<string, string>> = {
  holdout: 'This visitor is in the holdout: every experiment shows its control.',
  layer: "Another experiment of the same layer owns this visitor's bucket.",
  outside_traffic: 'Outside the share of traffic the experiment takes.',
  targeting: 'The targeting flow skipped this visitor.',
};
const COLORS: Record<string, string> = { assign: '#34d399', exposure: '#60a5fa', goal: '#fbbf24', pageview: '#a78bfa', remote: '#f472b6', redirect: '#fb923c', info: '#a1a1aa' };
