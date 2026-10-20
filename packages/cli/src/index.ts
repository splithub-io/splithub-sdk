import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { errorJson, fail } from './errors';
import { c } from './ui';
import { offerUpdateAfterCommand, startUpdateCheck } from './update';

// Started before the command so the registry answer is usually in by the time it ends.
const updateCheck = startUpdateCheck({ argv: process.argv.slice(2), env: process.env, stdinTTY: process.stdin.isTTY, stdoutTTY: process.stdout.isTTY });

const HELP = `
${c.bold('splithub')} — experiments and analytics for agent-built apps

Usage
  splithub                        the menu: experiments, analytics, links, alerts, notes, domains — pick what you need

Experiments
  splithub init                   set up config, framework files, agent docs
  splithub create                 add an experiment (wizard, or flags for agents); its goal can be any event you track()
  splithub start|pause|finish <id>
  splithub status                 all experiments with a verdict headline
  splithub results <id>           full verdict for one experiment
                                  a slice: --from --to (first-exposure days) --filter country=DE (country, region, city, device, os, browser,
                                  language, host, source, channel, utm_*, landing); one view: --by <dimension> (lift per segment),
                                  --timeline (per day), --engagement (bounce, visit length per variant), --events (every goal and event
                                  per variant, lift vs control); --export with --by <dimension> or --events writes CSV
  splithub events --experiment <id>   latest raw events of an experiment (--type exposure|goal, --limit 50, --before <ms>, --from --to, --filter)
  splithub plan                   visitors an experiment needs (asks SplitHub Cloud, no account needed): --baseline 0.05 --mde 0.1 [--variants 2] [<id> for days at its traffic]
  splithub refs <id>              files and lines that use the experiment and its goal
  splithub ship <id> --keep <v>   finish, remove from the config and rewrite the code to the kept variant (--dry-run shows the diff)
  splithub remove <id>            remove an experiment from the config (archived in the cloud when connected)
  splithub holdout set <percent>  keep a share of visitors out of every experiment to measure the long-term impact (0-50; --goal); holdout off removes it
  splithub review [<id>]          AI reviews stored in the cloud (Pro: at start, on verdict changes, on finish, or on demand)

Analytics
  splithub analytics connect      pick or create a property and name it on the app's provider (or get the sh.js tag); [<id>] [--name "Site"] [--force]
  splithub analytics [<id>]       every property, or one: visitors, pages, sources, events, goals (--by page|source|channel|country|event|goal|variant --experiment <key>|trait --key <name>, --days 7, --from --to, --filter country=DE, --compare [year|<from>..<to>])
  splithub analytics create --name "Site"   add a property (id generated, like sh-x1h78w); pause|resume|archive|restore|remove|events <id>
  splithub analytics funnel <id> --steps "page:/,event:Signup,goal:paid"   visitors per step, conversion, drop-off (--within visit|7d|30d, --by <dimension>)
  splithub analytics paths <id> --page /pricing [--prev]   where visitors go next (or came from)
  splithub analytics retention <id>   who comes back, per weekly cohort (--start visit|event:<name>|goal:<key>, --return visit|event:<name>, --period day|week)
  splithub analytics realtime|props|export <id>   visitors now; an event's props (--event <name> [--key <prop>]); CSV to stdout (--by <dimension>|day, --raw)
  splithub analytics segments     saved filters: --save <name> country=DE ..., --delete <id|name>; any report takes --segment <name>

Notes, links, alerts, domains (SplitHub Cloud)
  splithub notes                  what happened on a day (--experiment <key> | --property <id>, --kind note|issue|win, --days 30)
  splithub notes add "<text>"     [--kind issue|win] [--experiment <key> | --property <id>] [--day YYYY-MM-DD]; notes edit <id> "<text>", notes delete <id>
  splithub links                  short links and their clicks; links <id|slug> for one link's clicks
  splithub links create <url> [<url> ...]   [--slug spring] [--name "Spring sale"] [--weights 70,30]; links edit|pause|resume|delete <id|slug>
  splithub alerts                 alert rules (they run on Pro) and recent alerts; alerts enable|disable|delete|test <id>
  splithub alerts add <condition> srm | winner | loser --lift 10 | exposures --visitors N | conversions --conversions N | duration --days N | no_events --hours 24
                                  | quota --percent 80 | usage --every 1000 | traffic_drop|traffic_spike --property <id> --percent 50
                                  | goal_silent --property <id> --goal <key> --hours 24 | event_count --property <id> [--event <name>] --count N [--repeat]
                                  (--experiment <key>, --name, --cooldown <hours>, --disabled, --pause, --finish, --drop-loser)
  splithub domains                which domains may send events, per experiment and property; domains set experiment|property <id> <domain...>, domains clear experiment|property <id>

Project
  splithub push [--dry-run]       upload splithub.config.ts to SplitHub Cloud (--dry-run: check and show what would change)
                                  a key that already belonged to another experiment stops the push: --replace <keys> (new experiment, old numbers cleared) or --same <keys> (same experiment, numbers stay)
  splithub pull                   show the config stored in the cloud
  splithub report                 status and verdicts as Markdown, raw numbers when self-hosted (used by the GitHub workflow)
  splithub ci init                write .github/workflows/splithub.yml (checks on PRs, results comment on a schedule)
  splithub dev [--url] [--hold]   open the app with ?sh_debug=1 (console + panel: variants, reasons, events) and watch results
  splithub doctor                 check the installation
  splithub update [--yes]         update splithub (and the project's @splithub/* packages) to the latest release; --json only reports
  splithub skills [--mcp]         install / refresh agent skills (library, A/B testing, analytics, API, MCP, self-hosting, ship the winner, full loop); --mcp registers the MCP server
  splithub login [--project <name|id>]   connect this directory to a SplitHub Cloud project (sign-in link, no secrets typed)
  splithub projects               every directory connected on this machine and its project
  splithub whoami                 the project this directory is connected to
  splithub logout                 disconnect this directory

create flags
  --kind value|component|redirect|mvt  --id <key>  --goal <goal>  --status running|draft  --name "Hero headline"  --description "..."  --yes
  value / component / redirect: --variants control,b  --weights 50,50
  value:     --value control="Old text" --value b="New text" (repeatable)
  redirect:  --match /path  --to control=/ --to b=/new (repeatable)
  mvt:       --factor headline=old:Old,new:New --factor button=blue:#2563eb,green:#16a34a (repeatable; first level = control)
  limits:    --traffic 50 (percent of visitors)  --max-visitors 10000  --min-days 3 (opt-in days before a verdict, 0-30, default 0)  --good-sample 5000 (visitors for a good sample)  --start / --end <ISO date>
  metrics:   --secondary pricing_view,signup  --guardrail refunds:higher,errors (must not get worse; :higher when a rise is bad)
  layers:    --layer checkout:0-50 (experiments in one layer never share a visitor; ranges must not overlap)

init flags
  --mode self|cloud  --db sqlite|postgres|mysql|custom (self mode)  --key pk_...  --no-install  --no-login  --no-mcp  --github-action  --yes
  (cloud mode without a saved login prints a link; approve it in the browser and init continues)

Global
  --url <url>      results endpoint (default: $SPLITHUB_URL, the cloud API in cloud mode, else the local dev server)
  --token <token>  admin token (self: $SPLITHUB_ADMIN_TOKEN) or project API key (cloud: $SPLITHUB_API_KEY, else the key saved by "splithub login")
  --api <url>      cloud API base (default: https://go.splithub.io/v1 or $SPLITHUB_API)
  --json           one line of JSON (for agents); errors are { error, code, hint? } and exit 1
  -v, --version
  -h, --help
`;

async function main(): Promise<void> {
  // `--compare` alone means the period right before; it takes a value only when one follows (year, previous, from..to).
  const args = process.argv.slice(2).map((a, i, all) => (a === '--compare' && !/^(previous|year)$|\.\./.test(all[i + 1] ?? '') ? '--compare=previous' : a));
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      api: { type: 'string' },
      token: { type: 'string' },
      json: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      mode: { type: 'string' },
      db: { type: 'string' },
      key: { type: 'string' },
      'no-install': { type: 'boolean', default: false },
      'no-login': { type: 'boolean', default: false },
      'no-mcp': { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      hold: { type: 'boolean', default: false },
      mcp: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      kind: { type: 'string' },
      id: { type: 'string' },
      variants: { type: 'string' },
      weights: { type: 'string' },
      goal: { type: 'string' },
      value: { type: 'string', multiple: true },
      match: { type: 'string' },
      to: { type: 'string', multiple: true },
      factor: { type: 'string', multiple: true },
      status: { type: 'string' },
      description: { type: 'string' },
      name: { type: 'string' },
      replace: { type: 'string' },
      same: { type: 'string' },
      traffic: { type: 'string' },
      'max-visitors': { type: 'string' },
      'min-days': { type: 'string' },
      'good-sample': { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      project: { type: 'string' },
      keep: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      baseline: { type: 'string' },
      mde: { type: 'string' },
      'github-action': { type: 'boolean', default: false },
      secondary: { type: 'string', multiple: true },
      guardrail: { type: 'string', multiple: true },
      layer: { type: 'string' },
      goals: { type: 'string' },
      by: { type: 'string' },
      days: { type: 'string' },
      from: { type: 'string' },
      filter: { type: 'string', multiple: true },
      limit: { type: 'string' },
      compare: { type: 'string' },
      segment: { type: 'string' },
      steps: { type: 'string' },
      within: { type: 'string' },
      page: { type: 'string' },
      prev: { type: 'boolean', default: false },
      return: { type: 'string' },
      period: { type: 'string' },
      event: { type: 'string' },
      raw: { type: 'boolean', default: false },
      save: { type: 'string' },
      delete: { type: 'string' },
      day: { type: 'string' },
      property: { type: 'string' },
      experiment: { type: 'string' },
      slug: { type: 'string' },
      every: { type: 'string' },
      count: { type: 'string' },
      percent: { type: 'string' },
      hours: { type: 'string' },
      visitors: { type: 'string' },
      conversions: { type: 'string' },
      lift: { type: 'string' },
      'min-visitors': { type: 'string' },
      cooldown: { type: 'string' },
      repeat: { type: 'boolean', default: false },
      disabled: { type: 'boolean', default: false },
      pause: { type: 'boolean', default: false },
      finish: { type: 'boolean', default: false },
      'drop-loser': { type: 'boolean', default: false },
      timeline: { type: 'boolean', default: false },
      engagement: { type: 'boolean', default: false },
      events: { type: 'boolean', default: false },
      export: { type: 'boolean', default: false },
      type: { type: 'string' },
      before: { type: 'string' },
    },
  });
  const [command, arg, third] = positionals;
  if (values.help) {
    console.log(HELP.trimEnd());
    return;
  }
  if (values.version) {
    // dist/index.js sits next to the package.json that npm installed.
    const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
    console.log(values.json ? JSON.stringify({ version }) : version);
    return;
  }
  if (!command) {
    // A terminal → the interactive menu; a pipe or an agent → the help text.
    if (process.stdin.isTTY && process.stdout.isTTY && !values.json) return (await import('./commands/menu')).menu(values);
    console.log(HELP.trimEnd());
    return;
  }
  // Each command loads on demand: `splithub status` never pays for the wizard or the TypeScript compiler.
  switch (command) {
    case 'init':
      return (await import('./commands/init')).init(values);
    case 'create':
      return (await import('./commands/create')).create(values);
    case 'start':
    case 'pause':
    case 'finish':
      return (await import('./commands/lifecycle')).lifecycle(command, arg, values);
    case 'status':
      return (await import('./commands/status')).status(values);
    case 'results':
      return (await import('./commands/results')).results(arg, values);
    case 'events':
      return (await import('./commands/experiment-reports')).experimentEvents(typeof values.experiment === 'string' ? values.experiment : arg, values);
    case 'plan':
      return (await import('./commands/plan')).plan(arg, values);
    case 'refs':
      return (await import('./commands/refs')).refs(arg, values);
    case 'remove':
      return (await import('./commands/remove')).remove(arg, values);
    case 'ship':
      return (await import('./commands/ship')).ship(arg, values);
    case 'report':
      return (await import('./commands/report')).report(values);
    case 'ci':
      if (arg !== 'init') fail('USAGE', `Unknown "ci ${arg ?? ''}".`, 'Run npx splithub ci init.');
      return (await import('./commands/ci')).ciInit(values);
    case 'holdout':
      return (await import('./commands/holdout')).holdout(arg, third, values);
    case 'analytics':
    case 'properties':
      return (await import('./commands/analytics')).analytics(positionals.slice(1), values);
    case 'notes':
      return (await import('./commands/notes')).notes(positionals.slice(1), values);
    case 'links':
      return (await import('./commands/links')).links(positionals.slice(1), values);
    case 'alerts':
      return (await import('./commands/alerts')).alerts(positionals.slice(1), values);
    case 'domains':
      return (await import('./commands/domains')).domains(positionals.slice(1), values);
    case 'review':
      return (await import('./commands/review')).review(arg, values);
    case 'dev':
      return (await import('./commands/dev')).dev(values);
    case 'doctor':
      return (await import('./commands/doctor')).doctor(values);
    case 'update':
      return (await import('./commands/update')).update(values);
    case 'skills':
      return (await import('./commands/skills')).skills(values);
    case 'push':
      return (await import('./commands/push')).push(values);
    case 'pull':
      return (await import('./commands/push')).pull(values);
    case 'login':
      return (await import('./commands/login')).login(values);
    case 'logout':
      return (await import('./commands/login')).logout(values);
    case 'whoami':
      return (await import('./commands/login')).whoami(values);
    case 'projects':
      return (await import('./commands/login')).projects(values);
    default:
      fail('USAGE', `Unknown command "${command}".`, 'Run npx splithub --help for the list.');
  }
}

main()
  .then(() => offerUpdateAfterCommand(updateCheck))
  .catch((error: unknown) => {
    const body = errorJson(error);
    if (process.argv.includes('--json')) console.log(JSON.stringify(body));
    else {
      console.error(c.red(`error: ${body.error}`));
      if (body.scope && !body.error.includes(body.scope)) console.error(c.dim(`Missing scope: ${body.scope}`));
      if (body.hint) console.error(c.dim(body.hint));
    }
    process.exit(1);
  });
