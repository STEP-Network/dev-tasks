# Getting started with dev-tasks

A 10-minute walkthrough to install the plugin in a fresh project and verify it works.

## What this plugin does

`dev-tasks` packages a Monday-driven task-first development workflow as a Claude Code plugin. After install, your sessions get:

- **37 MCP tools** for Monday.com: backlog, tasks, sprints, epics, bugs, versions, products, feedback, retros, changelogs, UAT docs
- **7 lifecycle skills** invoked as `/dev-tasks:<name>`: `pickup-task`, `create-task`, `refine-task`, `log-progress`, `self-review`, `ship-pr`, `release-version`
- **8 universal rules** auto-injected into context on Edit/Write when contextually relevant (task-lifecycle, ship-readiness, release-flow, etc.)
- **6 opt-in blocking hooks** that enforce the task-first workflow: no edits without a claimed task, no commits without self-review, no pushes without validation, no session-exit while pipeline is incomplete

## Prerequisites

- Claude Code 2.1.0+ (`claude --version` to check)
- Node.js 20+ (LTS)
- A Monday.com API key with read+write access to your boards
- (Optional) A repo using the STEP Monday board ecosystem if you want the boards to align with the plugin's tool semantics

## Step 1 — Add the marketplace

In any Claude Code session:

```
/plugin marketplace add /Users/nate/dev-tasks-mcp
```

Marketplaces are user-global once added — you only do this once per machine.

## Step 2 — Install the plugin

```
/plugin install dev-tasks@dev-tasks-marketplace
```

Pick the scope you want:

| Scope | When |
|---|---|
| **user** | You want it available in every project on this machine |
| **project** | The repo's whole team should get it — commits a `.claude/settings.json` entry |
| **local** | Just for testing — picks `.claude/settings.local.json` (gitignored) |

## Step 3 — Set the API key in your shell

The plugin's `.mcp.json` does **not** interpolate env vars at runtime, so `MONDAY_API_KEY` must be exported in the shell that launches Claude Code. Add to `~/.zshrc` (or `~/.bashrc`):

```sh
export MONDAY_API_KEY="..."
```

Reload the shell, restart Claude Code, then confirm:

```
/reload-plugins
```

## Step 4 — Verify the MCP works

Ask Claude:

> Call listSprints.

You should see active sprint metadata returned from your Monday workspace. If you get an error mentioning `MONDAY_API_KEY`, the env var didn't propagate — check your shell setup.

The tool name in the trace will be `mcp__plugin_dev-tasks_dev-tasks__listSprints` — that's the plugin namespacing format.

## Step 5 — Create project-config.json (optional — needed for hooks + i18n)

Without `.claude/project-config.json`, only `rule-autoload` (the always-on hook) runs. All blocking hooks (task-state-guard, worktree-required, bash-guard, etc.) stay dormant. That's safe for projects that don't follow this workflow.

To **opt into** the blocking hooks, create `.claude/project-config.json` from the template:

```sh
mkdir -p .claude
cp $CLAUDE_PLUGIN_ROOT/templates/starter-project-config.json .claude/project-config.json
```

Then edit:

```jsonc
{
  "$schema": "https://stepnetwork.dk/dev-tasks/project-config.schema.json",
  "version": "1",
  "git": {
    "defaultBase": "main"        // or "staging" if you use staging-as-base flow
  },
  "i18n": {
    "enabled": false             // set true if your repo has messages/<locale>.json files
  },
  "hooks": {
    "enabled": [
      "task-state-guard",        // no edits without an active Monday task
      "worktree-required",       // source edits must be in a git worktree
      "worktree-path-boundary",  // can't edit main checkout from a worktree
      "branch-task-match",       // current branch must equal active-task.json.branch
      "bash-guard",              // gates destructive commands + commits + pushes
      "stop-task-check",         // can't end session while pipeline incomplete
      "stop-ci-green-check"      // can't end session until CI is green or acked
    ]
  }
}
```

Run `/reload-plugins` after writing. From the next Edit/Write onward, the listed hooks will fire.

To opt **out** of a specific hook, remove its name from `hooks.enabled[]`. To disable all hooks while keeping rule-autoload, set `hooks.enabled: []`.

## Step 6 — Try the lifecycle skills

Ask Claude:

> /dev-tasks:pickup-task

The skill walks the agent through:

1. Calling `getBacklog(unclaimedOnly: true)` to find available work
2. Reading task context via `getTask`
3. Calling `claimTask` (atomic — sets owner, agent ID, In Progress)
4. Writing `.claude/active-task.json` so other hooks can find the task state
5. Creating a git worktree (`EnterWorktree`) so the work is isolated

After implementation, follow with:

- `/dev-tasks:log-progress` after each subtask
- `/dev-tasks:self-review` before commit
- `/dev-tasks:ship-pr` to push + open PR

## Configuration reference

`schemas/project-config.schema.json` documents every field. Notable ones:

| Section | Field | Purpose |
|---|---|---|
| `git` | `defaultBase` | branch new PRs target (default: `main`) |
| `git` | `hotfixBase` | branch hotfix PRs target (default: `main`) |
| `git` | `worktreeRoot` | where new worktrees go (default: `.claude/worktrees`) |
| `i18n` | `enabled` | whether i18n parity checks run on commit (default: `false`) |
| `i18n` | `locales` | array of all supported locale codes |
| `i18n` | `defaultLocale` | source-of-truth locale (default: `en`) |
| `i18n` | `messagesGlob` | glob for locale catalogs (default: `messages/*.json`) |
| `i18n` | `parityHookMode` | `"block"` / `"warn"` / `"off"` (default: `"block"`) |
| `ci` | `requiredChecks` | CI check names that must be green |
| `hooks` | `enabled` | array of plugin hooks to activate (default: empty) |

## Troubleshooting

**Plugin install fails with "source type your Claude Code version does not support"** — your marketplace.json has an invalid plugin entry. Run Claude Code with `claude --debug` and look for `Stubbing unparseable marketplace plugin entry` in stderr. Most common cause: relative `source` path doesn't start with `./`, or contains `..`.

**Tools missing from session** — `/reload-plugins` doesn't fully restart MCP servers; if you modify plugin source code, fully restart Claude Code to pick up changes. Skills, rules, and hooks **are** reloaded by `/reload-plugins`.

**Hook blocks every edit, even harmless ones** — check `.claude/project-config.json` doesn't include the blocking hook you want disabled. To turn off all blocking hooks while keeping rule-autoload: `{"hooks": {"enabled": []}}`.

**`mcp__plugin_dev-tasks_dev-tasks__listSprints` returns "MONDAY_API_KEY environment variable is not set"** — the var isn't reaching the MCP child process. Make sure it's exported in the shell that launches Claude Code, then fully restart Claude Code (`/reload-plugins` doesn't re-spawn MCP processes — see also the related cache caveat above).

**`bash-guard` fires on a commit and complains about missing locale keys** — i18n parity check is active. Either add the missing keys, set `i18n.parityHookMode: "warn"` to convert blocks to warnings, or set `i18n.enabled: false` to skip the check entirely.

**Rule injection is huge (>10KB) on every edit** — rules auto-inject once per session per rule file (marker in `$TMPDIR/dev-tasks/`). If you see persistent re-injection, the session ID may be changing — check Claude Code's session handling or clear `$TMPDIR/dev-tasks/` between sessions.

## Uninstall

```
/plugin uninstall dev-tasks
```

Then optionally remove `.claude/project-config.json` from your project. The plugin owns nothing else in your repo.

## Reporting issues

File against this repo's `Bugs Queue` board, or open a GitHub issue. Include:

- Claude Code version (`claude --version`)
- Node version (`node --version`)
- Plugin version (top of `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json`)
- A minimal repro
