/**
 * MurmurHash3 (32-bit, x86). Deterministic across browser, Node and edge
 * runtimes, with a uniform distribution suitable for bucketing.
 */
export function murmur3(input: string, seed = 0): number {
  let h = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const bytes = utf8(input);
  const n = bytes.length;
  const blocks = n >>> 2;

  for (let i = 0; i < blocks; i++) {
    const o = i * 4;
    let k = bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }

  let k = 0;
  const tail = blocks * 4;
  switch (n & 3) {
    case 3:
      k ^= bytes[tail + 2]! << 16;
    // falls through
    case 2:
      k ^= bytes[tail + 1]! << 8;
    // falls through
    case 1:
      k ^= bytes[tail]!;
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }

  h ^= n;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash to a float in [0, 1). */
export function hashToUnit(input: string, seed = 0): number {
  return murmur3(input, seed) / 4294967296;
}

function utf8(str: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      c = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}
