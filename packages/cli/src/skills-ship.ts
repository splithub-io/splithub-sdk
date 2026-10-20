// Skills: ship the winner (`splithub ship`) and the full agent loop. Installed next
// to the other skills by `splithub init` / `splithub skills`.

export const SKILL_SHIP = `---
name: splithub-ship
description: Ship the winner of an experiment and remove the experiment from the code: keep only the winning value, component or page, delete the losing variants, finish the experiment and clean splithub.config.ts. Use when an experiment has a verdict and the user says ship it, roll out the winner, remove the experiment, or clean up; and whenever an experiment shows status finished and the user agreed on which variant to keep.
---

# Shipping the winner

Goal: the app behaves exactly as the kept variant did, with no experiment left in the code or in the config.

## 1. Decide

\`npx splithub results <id> --json\` (MCP: \`splithub_results\`). Act on \`verdict.status\`:
- \`winner_found\`: keep \`verdict.winner\`.
- \`no_significant_difference\`: keep the control, or the simpler variant if the user agrees.
- \`insufficient_sample\`: do not ship. Say when to look again: \`daysToVerdict\` days at the current traffic.
- \`srm_detected\`: do not ship. The split is broken; fix the setup first.
- \`guardrail_breached\`: do not ship the variant in \`verdict.guardrailBreached\`; it made a guardrail worse. Say what broke.
Ask the user which variant to keep before going on. Never pick from raw rates.

## 2. Preview, then ship

\`\`\`bash
npx splithub ship <id> --keep <variant> --dry-run --json   # diff + leftovers, nothing written
npx splithub ship <id> --keep <variant> --json             # apply
\`\`\`
MCP: \`splithub_ship\` with \`dryRun: true\`, then without. It archives the experiment in the cloud (numbers stay readable), removes it from
\`splithub.config.ts\` (checked by reloading the file) and rewrites the code:
- \`<Experiment id>\` → the kept \`<Variant>\`'s children; the other variants are dropped.
- \`useValue('<id>')\` / \`sh.value('<id>')\` → the kept value as a literal.
- \`useVariant('<id>')\` comparisons, ternaries, \`&&\`, \`if\` and \`switch\` → the kept branch.
- Unused \`Experiment\`, \`Variant\`, \`useVariant\`, \`useValue\` imports go.

## 3. Finish by hand

- \`leftovers[]\`: each \`{ file, line, text, reason }\` still mentions the experiment; rewrite those yourself.
- component kind: delete components and files only the losing variants used (e.g. \`splithub/<id>/\`).
- redirect kind: make the kept URL the real page (move the route or add a permanent redirect), delete the other page.
- Goal: keep \`track('<goal>')\` when another experiment measures it (\`next\` says so); otherwise ask before removing it.
- Cloud mode: \`npx splithub push\`. Then \`npx splithub doctor\` and the project's typecheck and tests.
- \`npx splithub refs <id> --json\` must return \`count: 0\` for the experiment.

Report what changed (files, the kept content) and the verdict in one line with its numbers. Never reuse the id.
`;

export const SKILL_LOOP = `---
name: splithub-loop
description: The whole experiment loop for an agent with SplitHub, step by step with the MCP tools and CLI --json fields: plan, create, implement, check, push, read results, finish, ship. Use when the user asks to run an experiment end to end, or to pick up an experiment where it stands.
---

# The full loop

Each step: MCP tool, or the CLI with \`--json\` (one line of JSON; errors are \`{ error, code, hint }\`, exit 1).

| step | MCP tool | CLI | read |
|---|---|---|---|
| 0. size it | \`splithub_plan\` | \`plan --baseline 0.05 --mde 0.1 [<id>]\` | \`perVariant\`, \`total\`, \`traffic.daysLeft\` |
| 1. create | \`splithub_experiment_create\` | \`create --kind … --id … --goal … --yes\` | \`snippet\`, \`files\`, \`nextStep\`, \`handoff\` |
| 2. implement | (edit code) | | wire \`snippet\`; \`track('<goal>')\` where it converts |
| 3. check | \`splithub_doctor\`, \`splithub_refs\` | \`doctor\`, \`refs <id>\` | \`ok\`, \`checks[]\`; \`refs[]\` shows the wiring |
| 4. push (cloud) | \`splithub_push\` | \`push\` (\`--dry-run\` to preview) | \`adopted\`, \`diff\` |
| 5. results | \`splithub_status\`, \`splithub_results\` | \`status\`, \`results <id>\` | \`verdict.status\`, \`verdict.message\`, \`verdict.notes[]\`, \`daysToVerdict\` |
| 6. finish | \`splithub_experiment_status\` | \`finish <id>\` | \`live\`, \`next\` |
| 7. ship | \`splithub_ship\` | \`ship <id> --keep <v> [--dry-run]\` | \`diff\`, \`leftovers[]\`, \`next\` |

Rules that keep the answer honest:
- Plan before creating: if \`traffic.daysLeft\` is months, try a bigger change or a busier page.
- \`create\` writes a running experiment; it goes live when the code is deployed (and pushed in cloud mode). Tell the user.
- Verdicts are sequential (always-valid): checking any day is safe. Quote \`verdict.message\` and the always-valid
  \`comparisons[].sequential.pValue\`, not the fixed-horizon \`pValue\` (p = 0.01 there can still be not significant).
  Relay \`verdict.notes[]\`. Verdicts depend on sample size, not days. Say \`verdict.sample.quality\` (small | ok | good;
  good = every variant has its share of \`goodSample\`, default 5000 visitors, \`create --good-sample\`) next to the verdict.
- \`daysToVerdict\` is the re-check date: schedule (or tell the user) a look in that many days instead of polling.
- \`srm_detected\`: the split is broken; fix the setup, do not read the numbers.
- \`guardrail_breached\`: don't ship. A variant made a guardrail worse (\`verdict.guardrailBreached[]\`), e.g. "bold wins on
  signups but raises refunds". \`verdict.metrics[]\` has the secondary metrics and guardrails, read like the main table.
- Guard what matters when creating: \`--secondary pricing_view --guardrail refunds:higher\` (MCP: \`secondary\`, \`guardrails\`).
  Experiments that could clash on one page go in one layer: \`--layer checkout:0-50\` and \`checkout:50-100\` never share a visitor.
- \`splithub holdout set 5\` keeps 5% of visitors out of every experiment; the \`__holdout\` row ("Holdout: long-term impact")
  compares them with everyone else.
- Ask the user which variant to keep before \`ship\`; preview with \`dryRun\` and show them the diff.
- Error \`code\` → action: \`NOT_LOGGED_IN\` → \`splithub_login\`, show the link, wait, retry · \`INSUFFICIENT_SCOPE\` → the key
  can only read; ask for a key with write scope · \`NO_CONFIG\` → \`splithub_init\` ·
  \`EXPERIMENT_NOT_FOUND\` → \`splithub_status\` for ids · \`CONFIG_UNSAFE\` → edit the config by hand where the experiment is
  defined · \`CONFIG_WRITE\` → the file was restored; edit by hand, then \`doctor\`.
`;
