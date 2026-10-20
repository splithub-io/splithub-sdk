import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from '../api';

describe('apiErrorMessage', () => {
  it('reads both error formats and tells an unsigned folder to log in', () => {
    expect(apiErrorMessage(404, { error: 'unknown experiment' }, 'x')).toBe('unknown experiment');
    const auth = apiErrorMessage(401, { success: false, error: { code: 'AUTHENTICATION_ERROR', message: 'API key required.' } }, 'x');
    expect(auth).toMatch(/^API key required\. This folder is not signed in: run npx splithub login/);
    expect(apiErrorMessage(500, null, 'fallback')).toBe('fallback');
  });

  it('reads the raw /v1 auth error and keeps its hint', async () => {
    const { apiError } = await import('../api');
    const body = { error: 'Invalid API key.', code: 'unauthorized', hint: 'This key was revoked or mistyped. Run npx splithub login for a new one.' };
    const e = apiError(401, body, 'x');
    expect(e.code).toBe('NOT_LOGGED_IN');
    expect(e.message).toMatch(/^Invalid API key\. This folder is not signed in/);
    expect(e.hint).toBe(body.hint);
  });
});

describe('apiError codes', () => {
  it('maps a missing scope to INSUFFICIENT_SCOPE with a hint', async () => {
    const { apiError } = await import('../api');
    const e = apiError(403, { error: "This API key can't change this project.", code: 'insufficient_scope', needed: 'write' }, 'x');
    expect(e.code).toBe('INSUFFICIENT_SCOPE');
    expect(e.hint).toMatch(/"write" scope/);
    expect(e.scope).toBe('write');
    expect(apiError(401, {}, 'x').code).toBe('NOT_LOGGED_IN');
  });

  it("keeps the server's scope and hint for an area scope", async () => {
    const { apiError } = await import('../api');
    const { errorJson } = await import('../errors');
    const hint = 'Create a key with the "notes:write" scope in the dashboard (Settings, API keys), or run npx splithub login --yes.';
    const e = apiError(403, { error: `This API key can't change notes. It needs the "notes:write" scope.`, code: 'insufficient_scope', needed: 'write', scope: 'notes:write', hint }, 'x');
    expect(e.code).toBe('INSUFFICIENT_SCOPE');
    expect(e.hint).toBe(hint);
    expect(errorJson(e)).toMatchObject({ code: 'INSUFFICIENT_SCOPE', scope: 'notes:write', hint });
  });
});
