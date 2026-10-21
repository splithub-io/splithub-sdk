# @splithub/mcp

MCP server for SplitHub. Lets Claude Code, Cursor, Codex or any MCP client run experiments
(create, start, pause, finish, read verdicts, ship the winner) and read analytics (traffic,
sources, funnels, paths, retention, realtime) through tools, on websites and in apps (React
Native, Expo, iOS, Android), with the same config file and credentials as the `splithub` CLI.

```bash
npx splithub skills --mcp      # writes .mcp.json (Claude Code) and .cursor/mcp.json (Cursor)
# or by hand:
claude mcp add splithub -- npx -y @splithub/mcp
```

```json
{ "mcpServers": { "splithub": { "command": "npx", "args": ["-y", "@splithub/mcp"] } } }
```

Tools:

| Area | Tools |
|---|---|
| Experiments | `splithub_status`, `splithub_results`, `splithub_experiment_events`, `splithub_plan`, `splithub_experiment_create`, `splithub_experiment_status`, `splithub_refs`, `splithub_ship`, `splithub_remove`, `splithub_review` |
| Analytics | `splithub_analytics`, `splithub_analytics_connect`, `splithub_analytics_events`, `splithub_analytics_funnel`, `splithub_analytics_funnels` (saved funnels), `splithub_analytics_paths`, `splithub_analytics_retention`, `splithub_analytics_realtime`, `splithub_segments`, `splithub_property_create`, `splithub_property_status` |
| Around them | `splithub_notes`, `splithub_links`, `splithub_alerts`, `splithub_domains` |
| Project | `splithub_init`, `splithub_push`, `splithub_pull`, `splithub_doctor`, `splithub_login`, `splithub_whoami`, `splithub_projects` |

Apps:

- `splithub_init` knows React Native and Expo: it installs `@splithub/react-native` and wraps the app entry
  with screen tracking. In a native iOS or Android project it returns the install lines and a quick start.
- `splithub_doctor` checks the app package and its storage module (or the native SDK in the build files).
- `splithub_property_create` takes `kind: site | app` (app by default in an app project).
- Experiment results, breakdowns and every analytics report take `platform` (`ios`, `android`, `web`…)
  and `app_version` as a filter or a `by` dimension.
- `splithub_analytics_retention` gives daily or weekly cohorts: who comes back after the first open.

The old names `splithub_create_experiment`, `splithub_set_status`, `splithub_create_property` and
`splithub_set_property_status` still work for one release.

With SplitHub Cloud, results carry the verdict (`verdict.message`), a friendly line (`voice.line`)
and ready-to-show text (`display`). Self-hosted projects get raw numbers only
(`analysis.available: false`): the agent reports them and says verdicts come with SplitHub Cloud.
`splithub_plan` asks SplitHub Cloud for the sample size; no account needed.

Env: `SPLITHUB_PROJECT_DIR` (defaults to the client's cwd), `SPLITHUB_API` (staging / self-hosted cloud),
`SPLITHUB_API_KEY` (CI), `SPLITHUB_CLI` (path to a specific CLI build).

The skill `.claude/skills/splithub-mcp/SKILL.md` (installed by `npx splithub skills`) tells the agent
how and when to use each tool.
