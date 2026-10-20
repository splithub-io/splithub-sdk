// Errors with a stable code. With --json the CLI prints `{ error, code, hint?, scope? }` on one
// line to stdout, so agents and the MCP server branch on `code`, never on the wording.

export const ERROR_CODES = [
  'USAGE',
  'INVALID_FLAG',
  'NO_CONFIG',
  'CONFIG_PARSE',
  'CONFIG_WRITE',
  'CONFIG_UNSAFE',
  'EXPERIMENT_EXISTS',
  'EXPERIMENT_NOT_FOUND',
  'PROPERTY_EXISTS',
  'PROPERTY_NOT_FOUND',
  'KEY_CONFLICT',
  'KEY_DELETED',
  'VARIANT_NOT_FOUND',
  'GOAL_NOT_FOUND',
  'NOT_FOUND',
  'PRO_REQUIRED',
  'NOT_CLOUD',
  'NOT_LOGGED_IN',
  'INSUFFICIENT_SCOPE',
  'API_ERROR',
  'UNREACHABLE',
  'TYPESCRIPT_MISSING',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  /** INSUFFICIENT_SCOPE: the scope the API key lacks, as the server named it (e.g. `notes:write`). */
  readonly scope?: string;
  constructor(code: ErrorCode, message: string, hint?: string, scope?: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    if (hint) this.hint = hint;
    if (scope) this.scope = scope;
  }
}

export function fail(code: ErrorCode, message: string, hint?: string): never {
  throw new CliError(code, message, hint);
}

/** The one-line JSON body for an error (unknown errors become INTERNAL, or USAGE for parseArgs). */
export function errorJson(error: unknown): { error: string; code: ErrorCode; hint?: string; scope?: string } {
  if (error instanceof CliError) return { error: error.message, code: error.code, ...(error.hint ? { hint: error.hint } : {}), ...(error.scope ? { scope: error.scope } : {}) };
  const message = error instanceof Error ? error.message : String(error);
  const code: ErrorCode = (error as { code?: unknown } | null)?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || (error as { code?: unknown } | null)?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? 'USAGE' : 'INTERNAL';
  return { error: message, code };
}

/** Machine output: always one line. */
export function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}
