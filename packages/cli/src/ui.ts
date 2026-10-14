const enabled = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open: number, close: number) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => strip(r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell + ' '.repeat(widths[i]! - strip(cell).length)).join('  ');
  return [c.dim(line(headers)), ...rows.map(line)].join('\n');
}

export function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[\d+m/g, '');
}

export function pct(x: number | null | undefined, signed = false): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '–';
  const v = (x * 100).toFixed(1);
  return signed && x >= 0 ? `+${v}%` : `${v}%`;
}

export function statusColor(status: string): string {
  switch (status) {
    case 'running':
      return c.green(status);
    case 'paused':
      return c.yellow(status);
    case 'finished':
      return c.blue(status);
    default:
      return c.dim(status);
  }
}

/** One plain glyph per verdict (no emoji: terminals and CI logs render these everywhere). */
export function verdictIcon(status: string | null | undefined): string {
  switch (status) {
    case 'winner_found':
      return '★';
    case 'srm_detected':
      return '!';
    case 'guardrail_breached':
      return '✖';
    case 'insufficient_sample':
      return '…';
    case 'no_significant_difference':
      return '=';
    default:
      return '·';
  }
}

/** A horizontal bar: filled blocks for value / max, dim blocks for the rest. */
export function bar(value: number, max: number, width = 20, paint: (s: string) => string = c.green): string {
  const n = max > 0 ? Math.max(0, Math.min(width, Math.round((value / max) * width))) : 0;
  return paint('█'.repeat(n)) + c.dim('░'.repeat(width - n));
}

export function verdictColor(status: string | null, text: string): string {
  switch (status) {
    case 'winner_found':
      return c.green(text);
    case 'srm_detected':
    case 'guardrail_breached':
      return c.red(text);
    case 'insufficient_sample':
      return c.yellow(text);
    case 'no_significant_difference':
      return c.cyan(text);
    default:
      return c.dim(text);
  }
}

/** "★★★☆☆" for a 0..5 score from the server. */
export function starText(stars: number): string {
  const n = Math.max(0, Math.min(5, Math.round(stars)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}
