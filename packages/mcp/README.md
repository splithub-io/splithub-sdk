# @splithub/mcp

MCP server for SplitHub. Lets Claude Code, Cursor, Codex or any MCP client create
experiments, read verdicts, start/pause/finish tests and push config — through tools,
with the same config file and credentials as the `splithub` CLI.

```bash
npx splithub skills --mcp      # writes .mcp.json (Claude Code) and .cursor/mcp.json (Cursor)
# or by hand:
claude mcp add splithub -- npx -y @splithub/mcp
```

```json
{ "mcpServers": { "splithub": { "command": "npx", "args": ["-y", "@splithub/mcp"] } } }
```

Tools: `splithub_status`, `splithub_results`, `splithub_plan`, `splithub_create_experiment`, `splithub_set_status`,
`splithub_refs`, `splithub_ship`, `splithub_remove`, `splithub_review`, `splithub_push`, `splithub_pull`,
`splithub_doctor`, `splithub_login`, `splithub_whoami`, `splithub_projects`, `splithub_init`.

With SplitHub Cloud, results carry the verdict (`verdict.message`), a friendly line (`voice.line`)
and ready-to-show text (`display`). Self-hosted projects get raw numbers only
(`analysis.available: false`): the agent reports them and says verdicts come with SplitHub Cloud.
`splithub_plan` asks SplitHub Cloud for the sample size; no account needed.

Env: `SPLITHUB_PROJECT_DIR` (defaults to the client's cwd), `SPLITHUB_API` (staging / self-hosted cloud),
`SPLITHUB_API_KEY` (CI), `SPLITHUB_CLI` (path to a specific CLI build).

The skill `.claude/skills/splithub-mcp/SKILL.md` (installed by `npx splithub skills`) tells the agent
how and when to use each tool.
