const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/** Short, URL-safe, time-prefixed id: sortable like a ULID, 20 chars. */
export function newId(prefix = ''): string {
  const time = Date.now().toString(36).padStart(9, '0');
  const bytes = randomBytes(11);
  let rand = '';
  for (let i = 0; i < bytes.length; i++) rand += ALPHABET[bytes[i]! % 36];
  return `${prefix}${time}${rand}`;
}

export function newVisitorId(): string {
  return newId('v_');
}

export function newSessionId(): string {
  return newId('s_');
}
