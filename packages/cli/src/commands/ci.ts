// `splithub ci init` (also `init --github-action`): write a GitHub workflow that
// checks experiments on pull requests and posts results on a schedule.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { printJson } from '../errors';
import { detectProject } from '../project';
import { c } from '../ui';
import type { Flags } from './init';

/** The CLI as the workflow runs it: always the published package, never a private action. */
export const CLI = 'npx -y splithub@latest';

/** The repository root: the closest folder with .git, else the project itself. */
function gitRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return from;
    dir = up;
  }
}

/**
 * A self-contained workflow: plain `run:` steps with the published CLI and the `gh`
 * that every GitHub runner has, plus actions/checkout and actions/setup-node only.
 * One sticky comment per mode, found again by its hidden marker and edited in place.
 */
export function workflowTemplate(workingDirectory: string): string {
  const wd = workingDirectory === '' ? '.' : workingDirectory;
  const configGlob = wd === '.' ? 'splithub.config.*' : `${wd}/splithub.config.*`;
  return `# SplitHub: checks experiments on pull requests that touch the config, and keeps
# a results comment up to date on weekday mornings. Needs the SPLITHUB_API_KEY
# secret (dashboard, Settings, API keys) for results and cloud comparisons.
name: SplitHub

on:
  pull_request:
    paths:
      - '${configGlob}'
  schedule:
    - cron: '0 8 * * 1-5'
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  splithub:
    runs-on: ubuntu-latest
    defaults:
      run:
        shell: bash
        working-directory: ${wd}
    env:
      SPLITHUB_API_KEY: \${{ secrets.SPLITHUB_API_KEY }}
      GH_TOKEN: \${{ github.token }}
      NO_COLOR: '1'
      # check on a pull request (doctor + push --dry-run), report otherwise (results tables)
      MODE: \${{ github.event_name == 'pull_request' && 'check' || 'report' }}
      PR_NUMBER: \${{ github.event.pull_request.number }}
      ISSUE_TITLE: SplitHub results
      OUT: \${{ runner.temp }}/splithub
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: |
          # The config imports @splithub/core; the lockfile may live at the repository root.
          dir="$PWD"
          while [ "$dir" != "/" ] && [ ! -f "$dir/pnpm-lock.yaml" ] && [ ! -f "$dir/yarn.lock" ] && [ ! -f "$dir/package-lock.json" ] && [ ! -f "$dir/bun.lockb" ] && [ ! -f "$dir/bun.lock" ]; do dir="$(dirname "$dir")"; done
          cd "$dir"
          if [ -f pnpm-lock.yaml ]; then corepack enable && pnpm install --frozen-lockfile
          elif [ -f yarn.lock ]; then corepack enable && (yarn install --frozen-lockfile || yarn install --immutable)
          elif [ -f bun.lockb ] || [ -f bun.lock ]; then npm i -g bun && bun install --frozen-lockfile
          elif [ -f package-lock.json ]; then npm ci
          else npm install; fi

      - name: Run SplitHub
        id: run
        run: |
          mkdir -p "$OUT"
          ok=true
          if [ "$MODE" = "check" ]; then
            ${CLI} doctor --json > "$OUT/doctor.json" || ok=false
            ${CLI} push --dry-run --json > "$OUT/push.json" || ok=false
          elif [ -z "$SPLITHUB_API_KEY" ]; then
            echo '{"error":"Add the SPLITHUB_API_KEY secret (dashboard, Settings, API keys) to post results."}' > "$OUT/report.json"
          else
            ${CLI} report --json > "$OUT/report.json" || ok=false
          fi
          echo "ok=$ok" >> "$GITHUB_OUTPUT"

      - name: Write the comment
        run: |
          node - <<'JS'
          const fs = require('fs');
          const path = require('path');
          const out = process.env.OUT;
          const read = (name) => {
            try {
              const lines = fs.readFileSync(path.join(out, name), 'utf8').trim().split('\\n');
              return JSON.parse(lines[lines.length - 1]);
            } catch {
              return null;
            }
          };
          const hint = (r) => (r.hint ? ' ' + r.hint : '');
          const lines = [];
          if (process.env.MODE === 'check') {
            const doctor = read('doctor.json');
            const push = read('push.json');
            lines.push('### SplitHub check', '');
            if (!doctor) lines.push('Doctor did not run.');
            else if (doctor.error) lines.push('✖ ' + doctor.error + hint(doctor));
            else {
              lines.push(doctor.ok ? '✔ No problems found.' : '✖ ' + doctor.errors + ' problem(s) to fix.', '');
              for (const c of doctor.checks.filter((c) => c.level !== 'ok')) lines.push('- ' + (c.level === 'error' ? '✖' : '!') + ' ' + c.message);
            }
            lines.push('');
            if (!push) lines.push('The config check did not run.');
            else if (push.error) lines.push('✖ Config: ' + push.error + hint(push));
            else if (!push.diff) lines.push('Config loads: ' + push.experiments.length + ' experiment(s). ' + (push.cloud === 'self mode' ? 'Self-hosted, nothing to push.' : 'Add the SPLITHUB_API_KEY secret to compare it with the cloud.'));
            else {
              const d = push.diff;
              if (!d.added.length && !d.removed.length && !d.changed.length) lines.push('The cloud already has this config.');
              else {
                lines.push('After merge, \`npx splithub push\` changes:', '');
                for (const k of d.added) lines.push('- added \`' + k + '\`');
                for (const k of d.removed) lines.push('- removed \`' + k + '\`');
                for (const c of d.changed) lines.push('- \`' + c.experiment + '\`: ' + c.fields.join(', '));
              }
            }
          } else {
            const report = read('report.json');
            lines.push(!report ? 'SplitHub report did not run.' : report.error ? '### SplitHub\\n\\n' + report.error : report.markdown);
            lines.push('', '<sub>Updated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC</sub>');
          }
          fs.writeFileSync(path.join(out, 'body.md'), '<!-- splithub:' + process.env.MODE + ' -->\\n' + lines.join('\\n') + '\\n');
          JS

      - name: Post the sticky comment
        run: |
          marker="<!-- splithub:$MODE -->"
          number="$PR_NUMBER"
          if [ -z "$number" ]; then
            number="$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --search "$ISSUE_TITLE in:title" --json number,title --jq '.[] | [.number, .title] | @tsv' | awk -F '\\t' -v t="$ISSUE_TITLE" '$2 == t { print $1; exit }')"
          fi
          if [ -z "$number" ]; then
            url="$(gh issue create --repo "$GITHUB_REPOSITORY" --title "$ISSUE_TITLE" --body 'A/B test results from SplitHub, refreshed by the SplitHub workflow.')"
            number="\${url##*/}"
          fi
          id="$(gh api --paginate "repos/$GITHUB_REPOSITORY/issues/$number/comments" --jq '.[] | [.id, (.body | split("\\n") | .[0])] | @tsv' | awk -F '\\t' -v m="$marker" '$2 == m { print $1; exit }')"
          if [ -n "$id" ]; then
            gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -F body=@"$OUT/body.md" > /dev/null
          else
            gh api "repos/$GITHUB_REPOSITORY/issues/$number/comments" -F body=@"$OUT/body.md" > /dev/null
          fi

      - name: Fail on problems
        if: steps.run.outputs.ok != 'true' && env.MODE == 'check'
        run: |
          echo "SplitHub found problems: see the comment on the pull request."
          exit 1
`;
}

export interface CiResult {
  file: string;
  written: boolean;
  workingDirectory: string;
  secret: string;
}

export function writeWorkflow(root: string, force = false): CiResult {
  const repo = gitRoot(root);
  const file = join(repo, '.github', 'workflows', 'splithub.yml');
  const workingDirectory = relative(repo, root).replace(/\\/g, '/') || '.';
  const written = force || !existsSync(file);
  if (written) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, workflowTemplate(workingDirectory), 'utf8');
  }
  return { file: relative(root, file).replace(/\\/g, '/'), written, workingDirectory, secret: 'SPLITHUB_API_KEY' };
}

export async function ciInit(flags: Flags): Promise<void> {
  const project = detectProject();
  const result = writeWorkflow(project.root, Boolean(flags.force));
  const next = 'Add the SPLITHUB_API_KEY secret in GitHub (Settings, Secrets and variables, Actions), then commit the workflow.';
  if (flags.json) {
    printJson({ ...result, next });
    return;
  }
  console.log(result.written ? `${c.green('✔')} wrote ${result.file}` : c.dim(`${result.file} is already there; --force replaces it`));
  console.log(c.dim(next));
}
