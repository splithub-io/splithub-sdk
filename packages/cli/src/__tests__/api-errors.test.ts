import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from '../api';

describe('apiErrorMessage', () => {
  it('reads both error formats and tells an unsigned folder to log in', () => {
    expect(apiErrorMessage(404, { error: 'unknown experiment' }, 'x')).toBe('unknown experiment');
    const auth = apiErrorMessage(401, { success: false, error: { code: 'AUTHENTICATION_ERROR', message: 'API key required.' } }, 'x');
    expect(auth).toMatch(/^API key required\. This folder is not signed in: run npx splithub login/);
    expect(apiErrorMessage(500, null, 'fallback')).toBe('fallback');
  });
});

describe('apiError codes', () => {
  it('maps a missing scope to INSUFFICIENT_SCOPE with a hint', async () => {
    const { apiError } = await import('../api');
    const e = apiError(403, { error: "This API key can't change this project.", code: 'insufficient_scope', needed: 'write' }, 'x');
    expect(e.code).toBe('INSUFFICIENT_SCOPE');
    expect(e.hint).toMatch(/"write" scope/);
    expect(apiError(401, {}, 'x').code).toBe('NOT_LOGGED_IN');
  });
});
