import type { RawResults, RawStatusRow } from '@splithub/node';
import { readFileSync } from 'node:fs';
import { loadCredential } from './credentials';
import { CliError, fail } from './errors';
import type { ProjectInfo } from './project';

export interface Target {
  url: string;
  token?: string;
  /** SplitHub Cloud (verdicts computed there); false for a self-hosted endpoint or an explicit --url. */
  cloud?: boolean;
}

export const CLOUD_API = 'https://go.splithub.io/v1';

/** Storage settings from splithub.config.ts, read textually to avoid loading the config. */
function storageFromConfig(project?: ProjectInfo): { mode: 'self' | 'cloud'; endpoint: string } {
  const fallback = { mode: 'self' as const, endpoint: '/api/splithub' };
  if (!project?.configFile) return fallback;
  try {
    const src = readFileSync(project.configFile, 'utf8');
    const mode = /mode\s*:\s*['"](cloud|self)['"]/.exec(src)?.[1] as 'self' | 'cloud' | undefined;
    const endpoint = /endpoint\s*:\s*['"]([^'"]+)['"]/.exec(src)?.[1];
    return { mode: mode ?? 'self', endpoint: endpoint ?? '/api/splithub' };
  } catch {
    return fallback;
  }
}

/** Cloud API base + project API key (sk_...). */
export function cloudTarget(flags: Record<string, unknown>): Target {
  const url = (typeof flags.api === 'string' && flags.api) || process.env.SPLITHUB_API || CLOUD_API;
  const base = url.replace(/\/+$/, '');
  const token = (typeof flags.token === 'string' && flags.token) || process.env.SPLITHUB_API_KEY || loadCredential(base)?.apiKey || undefined;
  return { url: base, token, cloud: true };
}

/**
 * Where to read results from:
 *  - --url / SPLITHUB_URL always win;
 *  - cloud mode → the cloud API with the project API key;
 *  - self mode → the local dev server (3000 for Next.js, 5173 for Vite) + the endpoint from the config.
 */
export function resolveTarget(flags: Record<string, unknown>, project?: ProjectInfo): Target {
  const explicit = (typeof flags.url === 'string' && flags.url) || process.env.SPLITHUB_URL;
  const storage = storageFromConfig(project);
  if (!explicit && storage.mode === 'cloud') return cloudTarget(flags);
  const port = project?.framework === 'next' ? 3000 : 5173;
  const url = explicit || `http://localhost:${port}${storage.endpoint}`;
  const token = (typeof flags.token === 'string' && flags.token) || process.env.SPLITHUB_ADMIN_TOKEN || undefined;
  return { url: url.replace(/\/+$/, ''), token, cloud: false };
}

/**
 * Readable message from an API error body. /v1 answers `{ error: 'text', code, hint? }`; servers before
 * 0.4.0 sent auth errors as `{ success: false, error: { code, message } }`, still read here.
 */
export function apiErrorMessage(status: number, body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | null)?.error;
  const text = typeof error === 'string' ? error : typeof (error as { message?: unknown } | undefined)?.message === 'string' ? (error as { message: string }).message : fallback;
  return status === 401 ? `${text} This folder is not signed in: run npx splithub login (or set SPLITHUB_API_KEY).` : text;
}

/** CliError for a failed API response: 401 → NOT_LOGGED_IN, 404 on an experiment → EXPERIMENT_NOT_FOUND. The server's `hint` wins over ours. */
export function apiError(status: number, body: unknown, fallback: string, experiment?: string): CliError {
  const message = apiErrorMessage(status, body, fallback);
  const b = body as { code?: unknown; needed?: unknown; scope?: unknown; hint?: unknown } | null;
  const serverHint = typeof b?.hint === 'string' && b.hint ? b.hint : undefined;
  if (status === 401) return new CliError('NOT_LOGGED_IN', message, serverHint ?? 'Run npx splithub login (or set SPLITHUB_API_KEY), then retry.');
  if (status === 403 && b?.code === 'insufficient_scope') {
    // Older servers sent only `needed` (read | write); newer ones name the area too (`notes:write`).
    const scope = typeof b.scope === 'string' && b.scope ? b.scope : typeof b.needed === 'string' ? b.needed : 'write';
    return new CliError('INSUFFICIENT_SCOPE', message, serverHint ?? `This API key lacks the "${scope}" scope. Create one with it in the dashboard (Settings, API keys) or run npx splithub login --yes.`, scope);
  }
  if (status === 402 && b?.code === 'pro_required') return new CliError('PRO_REQUIRED', message, serverHint ?? 'Alert rules run on Pro: upgrade in the dashboard (Billing), then turn the rule on.');
  if (status === 404 && experiment) return new CliError('EXPERIMENT_NOT_FOUND', message, serverHint ?? 'Check the id with npx splithub status. In cloud mode, push the config first.');
  return new CliError('API_ERROR', message, serverHint);
}

export async function request<T>(target: Target, path: string, init: RequestInit = {}, experiment?: string): Promise<T> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
  if (target.token) headers.authorization = `Bearer ${target.token}`;
  if (init.body) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${target.url}${path}`, { ...init, headers });
  } catch (error) {
    const hint = target.cloud ? 'Check your connection, or set --api / SPLITHUB_API.' : 'Is your app running? Set --url or SPLITHUB_URL.';
    throw new CliError('UNREACHABLE', `Can't reach ${target.url}: ${error instanceof Error ? error.message : String(error)}.`, hint);
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res.status, body, `${target.url}${path} responded ${res.status}`, experiment);
  return body as T;
}

/** A text answer (CSV exports); errors still arrive as JSON. */
export async function requestText(target: Target, path: string): Promise<string> {
  const headers: Record<string, string> = target.token ? { authorization: `Bearer ${target.token}` } : {};
  let res: Response;
  try {
    res = await fetch(`${target.url}${path}`, { headers });
  } catch (error) {
    throw new CliError('UNREACHABLE', `Can't reach ${target.url}: ${error instanceof Error ? error.message : String(error)}.`, 'Check your connection, or set --api / SPLITHUB_API.');
  }
  const text = await res.text();
  if (!res.ok) {
    let body: unknown = {};
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    throw apiError(res.status, body, `${target.url}${path} responded ${res.status}`);
  }
  return text;
}

/** Cloud target that must carry an API key. */
export function requireCloudToken(flags: Record<string, unknown>): Target & { token: string } {
  const target = cloudTarget(flags);
  if (!target.token) fail('NOT_LOGGED_IN', 'This folder is not connected to SplitHub Cloud.', 'Run npx splithub login, or pass --token sk_... / SPLITHUB_API_KEY.');
  return target as Target & { token: string };
}

/** PUT /overrides/<experiment>: live status, traffic or weights without a deploy. */
export function putOverride(target: Target, experiment: string, body: Record<string, unknown>): Promise<unknown> {
  return request<unknown>(target, `/overrides/${encodeURIComponent(experiment)}`, { method: 'PUT', body: JSON.stringify(body) }, experiment);
}

/**
 * Apply a status live in cloud mode. Never throws: the config file already changed,
 * so a refused or unreachable cloud is reported, not fatal.
 */
export async function applyLiveStatus(flags: Record<string, unknown>, experiment: string, status: string): Promise<string> {
  const target = cloudTarget(flags);
  if (!target.token) return 'no API key (run npx splithub login or set SPLITHUB_API_KEY to apply it without a deploy)';
  try {
    await putOverride(target, experiment, { status });
    return 'applied';
  } catch (error) {
    return `cloud refused: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Archive an experiment in the cloud (PUT /archive/<id>): it stops, keeps its numbers and leaves the
 * active list. Older servers without the route get it finished instead. Never throws.
 */
export async function archiveLive(flags: Record<string, unknown>, experiment: string): Promise<string> {
  const target = cloudTarget(flags);
  if (!target.token) return 'no API key (run npx splithub login or set SPLITHUB_API_KEY to archive it in the cloud)';
  try {
    await request<unknown>(target, `/archive/${encodeURIComponent(experiment)}`, { method: 'PUT', body: '{}' });
    return 'archived';
  } catch (error) {
    // 404 from a server without the route (or any non-auth refusal): finishing still stops the test.
    if (error instanceof CliError && (error.code === 'EXPERIMENT_NOT_FOUND' || error.code === 'API_ERROR')) {
      const finished = await applyLiveStatus(flags, experiment, 'finished');
      return finished === 'applied' ? 'finished' : finished;
    }
    return `cloud refused: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Response shapes. Cloud answers carry the verdict and ready-to-print words; a self-hosted endpoint
// (@splithub/node) answers raw counts with `analysis: { available: false }`. Only what the CLI reads is typed.

export interface Voice {
  scenario: string;
  line: string;
  advice: string;
}

/** Ready-to-print verdict label and lines, computed by the server. */
export interface Display {
  label: string;
  lines: string[];
  next?: string;
}

export interface VariantCounts {
  variant: string;
  exposures: number;
  conversions: number;
  revenue?: number;
}

export interface Interval {
  low: number;
  high: number;
}

export interface Comparison {
  variant: string;
  relativeLift: number | null;
  probabilityToBeat: number;
  pValue: number;
  ci: Interval;
  sequential?: { pValue: number; ci: Interval };
}

export interface MetricResult {
  metric: string;
  role: 'secondary' | 'guardrail';
  worse?: 'lower' | 'higher';
  variants: VariantCounts[];
  comparisons: Comparison[];
}

export interface Verdict {
  status: string;
  message: string;
  winner: string | null;
  notes?: string[];
  comparisons: Comparison[];
  sample: { variants: VariantCounts[]; stars?: number; checks?: Array<{ met: boolean; label: string }> };
  metrics?: MetricResult[];
  guardrailBreached?: Array<{ metric: string; variant: string }>;
}

export interface FactorResult {
  key: string;
  best: string | null;
  levels: Array<{ level: string; exposures: number; conversions: number; rate: number; relativeLift: number | null; pValue: number | null }>;
}

/** Cloud results. `display`, `voice` and `daysToVerdict` are optional: older servers omit them. */
export interface CloudResults {
  experiment: string;
  kind: string;
  status: string;
  goal: string | null;
  description: string | null;
  verdict: Verdict;
  daysToVerdict?: number | null;
  voice?: Voice | null;
  display?: Display;
  factors?: FactorResult[];
  /** Present when the results are a slice: first-exposure days and visitor filters. */
  scope?: { filtered: boolean; range: { from: string; to: string } | null; filters: Record<string, string | string[]>; note?: string };
  analysis?: undefined;
}

export interface CloudStatusRow {
  experiment: string;
  kind: string;
  status: string;
  goal: string | null;
  visitors: number;
  days: number;
  verdict: string | null;
  headline: string | null;
  sample?: string | null;
  stars?: number | null;
  daysToVerdict?: number | null;
  voice?: Voice | null;
  display?: Display;
}

export type { RawResults, RawStatusRow };
export type Analysis = RawResults['analysis'];
export type Results = CloudResults | RawResults;
export type StatusRow = CloudStatusRow | (RawStatusRow & { headline?: undefined; verdict?: undefined; sample?: undefined; stars?: undefined; daysToVerdict?: undefined; display?: undefined });
/** One analytics property in `GET /v1/status` (SplitHub Cloud): its last 7 days against the 7 before. */
export interface StatusProperty {
  property: string;
  name: string;
  status: string;
  visitors: number;
  previousVisitors: number;
  /** Relative change; null when the 7 days before had no visitors. */
  change: number | null;
  pageviews: number;
  conversions: Array<{ goal: string; conversions: number; change: number | null }>;
}

export interface StatusData {
  project: string;
  experiments: StatusRow[];
  /** SplitHub Cloud: analytics properties (archived left out); older servers and self-hosted omit it. */
  properties?: StatusProperty[];
  propertiesRange?: { from: string; to: string };
  /** Present (available: false) on self-hosted endpoints. */
  analysis?: Analysis;
}

/** Self-hosted answers: counts only, the verdict comes with SplitHub Cloud. */
export const isRawResults = (r: Results): r is RawResults => (r as { analysis?: { available?: boolean } }).analysis?.available === false;

export const fetchStatus = (t: Target) => request<StatusData>(t, '/status');
export const fetchResults = (t: Target, key: string) => request<Results>(t, `/results/${encodeURIComponent(key)}`, {}, key);
export const fetchReport = (t: Target) => request<{ project: string; markdown: string }>(t, '/report');

export interface PlanResult {
  baseline: number;
  mde: number;
  variants: number;
  confidence: number;
  perVariant: number;
  total: number;
}

/** GET /plan on SplitHub Cloud: public, no API key needed. */
export const fetchPlan = (t: Target, q: { baseline: number; mde: number; variants: number }) =>
  request<PlanResult>({ url: t.url, cloud: true }, `/plan?${new URLSearchParams({ baseline: String(q.baseline), mde: String(q.mde), variants: String(q.variants) }).toString()}`);

export interface SkillFile {
  /** Relative to the project root. `AGENTS.md` is a section to append, not a whole file. */
  path: string;
  body: string;
}

/** GET /skills on SplitHub Cloud; null on any error or after `timeoutMs`, so the caller uses the bundled copies. */
export async function fetchSkills(flags: Record<string, unknown>, timeoutMs = 1500): Promise<SkillFile[] | null> {
  try {
    const res = await fetch(`${cloudTarget(flags).url}/skills`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { files?: unknown };
    if (!Array.isArray(body.files)) return null;
    const files = body.files.filter((f): f is SkillFile => typeof (f as SkillFile | null)?.path === 'string' && typeof (f as SkillFile).body === 'string');
    return files.length ? files : null;
  } catch {
    return null;
  }
}
