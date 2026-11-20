// Self-running entry for <script src=".../sh.js" data-key="pk_...">.
import { boot } from './index';

(() => {
  const el = (document.currentScript as HTMLScriptElement | null) ?? (Array.from(document.querySelectorAll('script[src*="sh.js"]')).pop() as HTMLScriptElement | undefined) ?? null;
  const src = el?.src ?? '';
  const fromQuery = /[?&]key=([^&]+)/.exec(src)?.[1];
  const key = el?.dataset.key ?? (fromQuery ? decodeURIComponent(fromQuery) : '');
  if (!key) {
    console.warn('[splithub] sh.js: missing data-key="pk_..."');
    return;
  }
  // Events go where the script came from: `https://go.sh2.uk/sh.js` → `https://go.sh2.uk/v1/events`,
  // and through a first-party proxy `https://shop.com/sh/sh.js` → `https://shop.com/sh/v1/events`.
  const base = /^(https?:\/\/[^?#]*?)\/(?:v1\/)?sh\.js(?:[?#].*)?$/.exec(src)?.[1] ?? /^(https?:\/\/[^/]+)/.exec(src)?.[1];
  const endpoint = el?.dataset.endpoint ?? (base ? `${base}/v1/events` : undefined);
  const property = el?.dataset.property;
  void boot({ key, endpoint, ...(property ? { property } : {}), redirects: el?.dataset.redirects !== undefined, noHold: el?.dataset.hold === 'off', holdMs: el?.dataset.hold ? Number(el.dataset.hold) || undefined : undefined });
})();
