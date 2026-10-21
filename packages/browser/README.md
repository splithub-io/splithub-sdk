# @splithub/browser

SplitHub for sites without a build step: one script tag counts pages and events and runs redirect experiments. Works on any site: plain HTML, WordPress, Webflow, a landing page builder.

```html
<script src="https://go.splithub.io/sh.js" data-key="pk_..." data-property="sh-x1h78w"></script>
```

- `data-key`: your project's public key (`pk_...`, safe in the browser: it only sends events).
- `data-property`: the analytics property that receives pageviews and events. Leave it out to run experiments only.

`npx splithub analytics connect` prints the tag with your ids, or copy it from the dashboard (Install).

## What it does

- **Analytics:** a pageview on load and on every client-side navigation, time on page and scroll depth. Sources, pages, funnels, paths and retention read them in SplitHub Cloud.
- **Events:** `splithub.track(name, props?)`, any name. It counts in analytics and converts every experiment whose goal it is.
- **Users:** `splithub.identify('user_42', { plan: 'pro' })` ties the visitor to your user; `identify(null)` on sign-out.
- **Redirect experiments:** sends each visitor to their variant's page before the page paints, with the same assignment, targeting, layers and holdout as the SDK.
- **Goals from the dashboard:** pageview and click goals set up there fire without code.

```html
<script>
  splithub.track('Video Played', { id: 3 });
  splithub.track('checkout', { revenue: 49 });
</script>
```

`window.splithub` exists as soon as the tag runs, so inline scripts can call it right away.

## No flash on redirect pages

The script hides the page while it decides only where a redirect can happen. On a page with a redirect experiment, add `data-redirects` to the tag (or `<meta name="splithub-redirects">`) so even a first visit waits for the decision instead of showing the original page for a moment. `data-hold="off"` never hides the page; `data-hold="800"` sets the longest wait in ms (default 1500). Crawlers are never held or redirected.

Component and value experiments change your markup, so they need the SDK: [`@splithub/react`](https://www.npmjs.com/package/@splithub/react) or [`@splithub/next`](https://www.npmjs.com/package/@splithub/next).

## From npm

The same code as a module, for bundlers:

```ts
import { boot } from '@splithub/browser';

await boot({ key: 'pk_...', property: 'sh-x1h78w' });
```

## License

MIT
