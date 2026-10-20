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
  // Events go to the same origin the script was loaded from (cloud or self-hosted cloud).
  const origin = /^(https?:\/\/[^/]+)/.exec(src)?.[1];
  const endpoint = el?.dataset.endpoint ?? (origin ? `${origin}/v1/events` : undefined);
  const property = el?.dataset.property;
  void boot({ key, endpoint, ...(property ? { property } : {}), redirects: el?.dataset.redirects !== undefined, noHold: el?.dataset.hold === 'off', holdMs: el?.dataset.hold ? Number(el.dataset.hold) || undefined : undefined });
})();
