/** Unified diff of two texts (3 lines of context), enough for a human or an agent to review. */
export function unifiedDiff(file: string, a: string, b: string, context = 3): string {
  if (a === b) return '';
  const x = a.split('\n');
  const y = b.split('\n');
  // Common prefix / suffix first, LCS only on the middle: edits are small.
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xm = x.slice(pre, x.length - suf);
  const ym = y.slice(pre, y.length - suf);
  const n = xm.length;
  const m = ym.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = xm[i] === ym[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ t: ' ', s: x[k]!, ai: k, bi: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xm[i] === ym[j]) {
      ops.push({ t: ' ', s: xm[i]!, ai: pre + i, bi: pre + j });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      ops.push({ t: '+', s: ym[j]!, ai: pre + i, bi: pre + j });
      j++;
    } else {
      ops.push({ t: '-', s: xm[i]!, ai: pre + i, bi: pre + j });
      i++;
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ t: ' ', s: x[x.length - suf + k]!, ai: x.length - suf + k, bi: y.length - suf + k });

  const out = [`--- a/${file}`, `+++ b/${file}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.t === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    // Extend the hunk while changes are within 2×context of each other.
    for (;;) {
      while (end < ops.length && ops[end]!.t !== ' ') end++;
      let next = end;
      while (next < ops.length && ops[next]!.t === ' ') next++;
      if (next < ops.length && next - end <= context * 2) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + context);
    const hunk = ops.slice(start, stop);
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${hunk[0]!.ai + 1},${aLen} +${hunk[0]!.bi + 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.t}${o.s}`);
    k = stop;
  }
  return out.join('\n') + '\n';
}
