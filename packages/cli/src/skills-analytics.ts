// Skill: analytics properties (pageviews and custom events, read as reports).

export const SKILL_ANALYTICS = `---
name: splithub-analytics
description: Collect and read web analytics with SplitHub: analytics properties (pageviews, events with track(), identified users, sources, channels, pages, goals and conversions), setting one up in the app (analytics connect), funnels, paths, retention, realtime, event props, CSV export, segments, notes and alerts on traffic, sh.js or the SDK, allowed domains. Use when the user wants traffic numbers, page or source reports, event tracking, funnels, or asks to "add analytics" to an app that uses SplitHub or could.
---

# SplitHub analytics

An analytics property is a stream of pageviews and custom events, like a site in Google Analytics. It sits next to the
experiments: same config file, same CLI, same key, same storage choice (SplitHub Cloud or the app's own database).
There are no variants and no verdicts: reports are counts.

## Set it up

1. One step: \`npx splithub analytics connect --json\` (or Analytics → Set up in the \`npx splithub\` menu) picks the project's
   property (or creates one: \`--name "Marketing site"\`; a given id is used, \`connect sh-x1h78w\`) and adds
   \`property="sh-…"\` to the one \`<SplitHubProvider>\` / \`<SplitHubNextProvider>\` in the code. It answers \`wired.status\`:
   added | already | other (another property is named there: ask, then \`--force\`) | none | many (add \`snippets.provider\`
   or \`snippets.script\` yourself), plus \`snippets.track\` and \`next\`.
   By hand: \`npx splithub analytics create --name "Marketing site" --json\` writes \`properties: { 'sh-x1h78w': { name: … } }\`
   into \`splithub.config.ts\` (self-hosted projects keep their properties there). Cloud mode: \`npx splithub push\` after
   either. A property made in the dashboard needs no push; its id is on its page.
2. Send events. Events go only to a property named by its id, never to a guess:
   - SDK: \`<SplitHubProvider config={config} property="sh-x1h78w">\`: a pageview on load and on every client-side route change.
   - Events: one call, \`const track = useTrack(); track('Video Played', { id: 3 })\` (or \`client.track(...)\`). Names: letters,
     digits, spaces and \`_ . : / -\`, up to 64 characters; props: a flat object up to 4 KB. The same call counts for
     experiments whose goal is that event. Only what the app passes to \`track()\` is sent.
   - Users: \`const identify = useIdentify(); identify(user.id, { plan: 'pro' })\` after sign-in (\`identify(null)\` on sign-out;
     sh.js: \`splithub.identify(id, traits)\`) ties visits to the app's user; reports then count \`users\`. No emails or names in traits.
   - No SDK: \`<script src="https://go.splithub.io/sh.js" data-key="pk_…" async></script>\` sends pageviews (SPA navigations
     included) and \`window.splithub.track(name, props)\` once the tag has \`data-property="sh-x1h78w"\`.
   - One install covers analytics and experiments: the provider (or sh.js) with \`property\` collects pageviews and runs
     experiments. Each \`track()\` sends one event row and each page one page row; experiments whose goal is that event or
     page count them from those rows, so nothing extra is sent or billed. Never add sh.js and the SDK for the same
     property: when both run on a page, only the first collects pageviews.
   - Servers and other languages: \`POST /v1/events\` with \`{ type: 'page', prop, url, vid, sid, ts, id, title?, ref? }\` or
     \`{ type: 'event', prop, name, props?, … }\` (splithub-api skill).
3. Development never sends to the cloud (same rule as experiments): check a deploy or \`vite preview\`.
4. Events: any name is recorded, nothing to declare first. A goal is an event marked as one (\`goals\` in the config, the
   goal switch on an event in the dashboard, or simply naming the event as an experiment's goal); goals count as
   conversions in every property (a property's \`goals\` list narrows that). \`value\` is what one conversion is worth
   when the event carries no \`revenue\` prop; \`event: 'Video Played'\` matches an event name that is not a valid key.

## Read it

- \`npx splithub analytics --json\`: every property with visitors, visits, pageviews and bounce for the last 30 days.
- \`npx splithub status --json\` (SplitHub Cloud) also lists every property under \`properties\`: the last 7 days against the 7 before
  (visitors, \`change\`, goal conversions); \`npx splithub report\` adds them as an Analytics table. The digest (Pro, set in the
  dashboard under Alerts) covers properties too: visitors, top sources and pages, goals and events against the period before.
- \`npx splithub analytics site --json\` (\`--days 7\`, or \`--from 2026-10-01 --to 2026-10-31\`): totals, \`users\` (identified),
  goals (conversions = unique visitors who reached the goal in the range, completions, revenue), top pages, top sources, notes.
- \`--by page|source|channel|referrer|utm_source|utm_medium|utm_campaign|country|device|browser|os|entry|exit|event|goal\`; with a
  visit dimension, \`--goal signup\` adds conversions per row; \`--by variant --experiment hero\` splits visits by the
  variant each visitor saw, \`--by trait --key plan\` by an identify() trait. \`--filter country=DE,FR --filter source="(none)"\` narrows any report.
- \`npx splithub analytics events site --json\`: the latest raw pageviews and events, to check tracking right after wiring it.
- More reports (SplitHub Cloud), each with the same \`--days\` / \`--from --to\` / \`--filter\` flags:
  - \`analytics funnel site --steps "page:/,event:Signup,goal:paid" [--within visit|7d|30d] [--by country]\`: visitors per step
    in order, \`conversion\` (share of step 1) and \`dropoff\` (share lost since the step before).
  - \`analytics paths site --page /pricing [--prev]\`: where visits went next (or came from).
  - \`analytics retention site [--start visit|event:<name>|goal:<key>] [--return visit|event:<name>] [--period day|week]\`: cohorts
    and how many came back per period.
  - \`analytics realtime site\`: visitors in the last 5 minutes, top pages and sources.
  - \`analytics props site --event Signup [--key plan]\`: an event's prop names, or one prop's values.
  - \`analytics export site --by page|day [--raw] > report.csv\`: CSV to stdout.
  - \`--compare\` on a report adds the period right before (\`previous\`), \`--compare year\` the same days a year earlier, \`--compare 2026-08-01..2026-08-31\` chosen days; \`--segment "Paid traffic"\` applies a saved segment
    (\`analytics segments\`, \`--save <name> country=DE\`, \`--delete <id|name>\`).
  - Notes mark a day on the charts: \`npx splithub notes add "Launched new pricing" [--kind win] [--property site] [--day 2026-10-05]\`,
    \`notes --property site\` lists them; add one when you ship something that may move traffic.
  - Alerts on a property (SplitHub Cloud, Pro): \`npx splithub alerts add traffic_drop --property site --percent 50\`, \`traffic_spike\`,
    \`goal_silent --property site --goal signup --hours 24\`, \`event_count --property site --event Signup --count 1000 [--repeat]\`.
- Words: a visit (\`sessions\`) ends after 30 minutes without events; a bounce is a visit with one page and no event;
  \`source\` is the UTM source or the referrer's site (Google, Facebook, …), \`(none)\` = direct; \`channel\` groups them (Direct,
  Organic Search, Paid Social, Email, Referral, …); a conversion is a visitor reaching a goal (once per visitor in the range);
  \`duration\` is in milliseconds. Bots are never counted.
- Self-hosted (\`mode: 'self'\`): the same commands give raw counts from the app's database (pageviews, visitors,
  sessions, events by name) for \`--days\` or \`--from --to\` (UTC days). Filters, \`--by\`, \`--compare\` and reports with sources,
  pages, visits and conversions come with SplitHub Cloud: say so.

## Manage it

- \`npx splithub analytics pause site\` / \`resume site\`: live in the cloud within a minute; paused events are dropped and not billed.
- \`npx splithub analytics archive site\` / \`restore site\` (SplitHub Cloud): like Archive in the dashboard, it stops collecting and leaves
  the list (\`archived\` in it), numbers kept; restored comes back paused.
- \`npx splithub analytics remove site\`: out of the config (push next); a dashboard-made property is deleted with its numbers.
- Allowed domains are per experiment and per property: \`npx splithub domains set property site example.com\` (subdomains included),
  \`npx splithub domains clear property site\` (any domain again), \`npx splithub domains\` lists them all. An empty list
  accepts every origin. Add localhost too when testing from it.
- Billing: every pageview and custom event counts like one exposure against the project's allowance.

## Do not

- Put personal data in event props (emails, names, ids from other systems).
- Fire an event in a render loop or on every scroll: each one is stored and billed.
- Read analytics counts as an experiment result: use \`splithub results\` for experiments.
`;
