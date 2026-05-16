# monday-task-flow plugin

Claude Code plugin for Monday-driven task-first development. Ships:

- **MCP server** — 37 stdio tools (Monday task/sprint/epic/bug/version/feedback management)
- **Rules** — 8 universal lifecycle rules, auto-injected on Edit/Write via PreToolUse
- **Skills** — 7 core lifecycle skills (Phase 2b.i): `pickup-task`, `create-task`, `refine-task`, `log-progress`, `self-review`, `ship-pr`, `release-version`. Invoked as `/monday-task-flow:<skill>`.
- **Hooks** — 6 critical blocking hooks (Phase 2b.ii), all opt-in via `project-config.hooks.enabled[]`
- **project-config** — JSON schema for per-consumer config (`hook_enabled` helper in `config-reader.sh` gates each hook)

## Requirements

- Node.js 20+ (LTS)
- `MONDAY_API_KEY` must be exported in the shell that launches Claude Code. The `.mcp.json` cannot interpolate env vars (Claude Code limitation), so the key must come from the parent process environment. Add to your `~/.zshrc` / `~/.bashrc`:
  ```sh
  export MONDAY_API_KEY="..."
  ```

## Install

From any project where you want the tools available:

```sh
/plugin marketplace add /Users/nate/dev-tasks-mcp
/plugin install monday-task-flow@monday-task-flow-marketplace
/reload-plugins
```

## Layout

```
plugin/
├── .claude-plugin/plugin.json     # plugin manifest
├── .mcp.json                      # registers the monday-tasks stdio server
├── package.json                   # @modelcontextprotocol/sdk + zod
├── tsconfig.json
├── src/                           # MCP TypeScript source
│   ├── server.ts                  # stdio MCP entry — registers all 37 tools
│   ├── monday-client.ts           # Monday GraphQL client (reads MONDAY_API_KEY)
│   ├── constants.ts               # board / column / status maps
│   ├── schemas.ts                 # Zod schemas for all 37 tools
│   ├── tools/                     # one file per tool, plus utils + index
│   └── services/
│       ├── version-bump.ts        # pure semver bump-suggestion algorithm + 3-cat task classifier
│       └── __tests__/             # 46 unit tests for version-bump (vitest)
├── scripts/                       # universal helper scripts
│   ├── find-worktree-for-task.sh  # given a Monday task ID, print its worktree path
│   └── worktree-audit.sh          # audit all worktrees for stale / merged / abandoned ones
├── rules/                         # universal lifecycle rules (8 markdown files)
│   ├── task-lifecycle.md
│   ├── ship-readiness.md
│   ├── release-flow.md
│   ├── versioning.md
│   ├── worktree-discipline.md
│   ├── agent-coordination.md
│   ├── meta-workflow.md
│   └── testing.md
├── rules-routing.json             # file-glob → rule-file mapping for auto-load
├── skills/                        # 7 core lifecycle skills (Phase 2b.i, lifted from PolAds)
│   ├── pickup-task/SKILL.md
│   ├── create-task/SKILL.md
│   ├── refine-task/SKILL.md
│   ├── log-progress/SKILL.md
│   ├── self-review/SKILL.md
│   ├── ship-pr/SKILL.md
│   └── release-version/SKILL.md
├── hooks/
│   ├── hooks.json                 # registers all 7 hooks (rule-autoload + 6 critical)
│   ├── rule-autoload.sh           # PreToolUse, always-on, fail-open, session-dedup
│   ├── task-state-guard.sh        # PreToolUse Edit|Write — blocks edits without active-task.json (opt-in)
│   ├── worktree-required.sh       # PreToolUse Edit|Write — blocks source edits outside a worktree (opt-in)
│   ├── worktree-path-boundary.sh  # PreToolUse Edit|Write — blocks edits to main checkout from worktree session (opt-in)
│   ├── bash-guard.sh              # PreToolUse Bash — gated on dangerous commands (opt-in)
│   ├── stop-task-check.sh         # Stop — blocks session exit while pipeline incomplete (opt-in)
│   ├── stop-ci-green-check.sh     # Stop — blocks session exit while CI not green (opt-in)
│   ├── stop-task-logic.py         # python helper used by stop-task-check.sh
│   └── lib/config-reader.sh       # read_project_config + hook_enabled helpers
├── schemas/
│   └── project-config.schema.json # JSON Schema for consumer's .claude/project-config.json
└── templates/
    └── starter-project-config.json
```

## Rules auto-loading (Phase 2a)

The `rule-autoload.sh` PreToolUse hook fires on `Edit|Write|MultiEdit|NotebookEdit`. It reads the target file path from `tool_input`, matches it against `rules-routing.json` globs, and injects the matching rule markdown via `hookSpecificOutput.additionalContext`.

**Session-scoped dedup:** each rule injects at most once per session per file-type match. The hook writes a marker file to `$TMPDIR/monday-task-flow/injected-<session_id>.list` listing already-injected rules. Subsequent edits matching the same rule skip re-injection — keeps context-token cost bounded.

**Default routing (in `rules-routing.json`):**

| Rule file | Triggers on |
|---|---|
| `task-lifecycle.md` | most source-code edits (.ts/.tsx/.js/.py/.sh/.sql/.css/.html/.md) |
| `worktree-discipline.md` | source-code edits (same set minus .md) |
| `testing.md` | test files (`*.test.*`, `*.spec.*`, `tests/**`, `__tests__/**`, `e2e/**`) |
| `release-flow.md` | `CHANGELOG.md`, `package.json`, `version.txt` |
| `versioning.md` | same as release-flow |

The other 3 rules (`ship-readiness`, `agent-coordination`, `meta-workflow`) live in `rules/` but don't auto-inject — they're invoked via skill prose / agent references when contextually needed.

**Fail-open:** any error in the hook (missing config, jq failure, unreadable file) → exits 0 with no output. The Edit/Write proceeds normally. Errors log to stderr.

## Dev

```sh
cd plugin && npm install     # install deps
npm run typecheck            # tsc --noEmit
npm start                    # run the stdio server (responds on stdin/stdout)
```

After editing **MCP code**, you must fully restart Claude Code — `/reload-plugins` does not kill the MCP process. Skills / hooks / rules are filesystem-rescanned on `/reload-plugins`.

## Tools

37 tools across these phases: Discovery, Context, Execution, Creation, Shipping, Communication, Epic Management, Feedback & Requests, Retrospectives, Public Roadmap, Structured Changelog, UAT Docs. See `src/server.ts` for the full registration list with descriptions.

## Skills (Phase 2b.i)

7 core lifecycle skills, invoked as `/monday-task-flow:<name>`. Lifted from `v0-politiske-annoncer/.claude/skills/` as-is. Each skill carries PolAds-specific references (branch names, deploy URLs, package manager) that Phase 3 will genericize via project-config.

| Skill | Purpose |
|---|---|
| `pickup-task` | Claim a Monday.com task, create feature branch / worktree, write `.claude/active-task.json` |
| `create-task` | Create a new task with duplicate-check + Ready-to-Start gate enforcement |
| `refine-task` | Break a task into typed subtasks with estimates and Ready-to-Start prereqs |
| `log-progress` | Post structured Monday update and manage subtask lifecycle |
| `self-review` | Iterative 10-point code review until all checks pass |
| `ship-pr` | Build → lint → test → validate-schema → push → PR → preview URL → UAT doc → `Waiting for UAT` |
| `release-version` | Cut a release: FF main from staging + apply prod migrations + tag |

**Known references to clean up (Phase 3 genericization):** `polads.eu`, `pnpm`, `staging` (branch), `PolAds` (product), `Neon`, `Drizzle`, `v0-politiske-annoncer`, `mcp__dev-tasks__*` (63 tool-name references — these break when the Next.js MCP route is deleted; rewrite to `mcp__plugin_monday-task-flow_monday-tasks__*` during cutover).

## Critical hooks (Phase 2b.ii) — opt-in only

The plugin ships 6 lifecycle-enforcement hooks copied from PolAds. **All are opt-in**: each hook checks `project-config.hooks.enabled[]` at the top of its script and exits 0 silently if not listed. This keeps the plugin safe to install in projects that don't follow the Monday task-first workflow.

| Hook | Event | Blocks when |
|---|---|---|
| `task-state-guard` | PreToolUse Edit/Write | no `.claude/active-task.json` with valid taskId+claimToken |
| `worktree-required` | PreToolUse Edit/Write | source edit outside a git worktree |
| `worktree-path-boundary` | PreToolUse Edit/Write | edit targets main checkout while session is in a worktree |
| `branch-task-match` | PreToolUse Edit/Write | current git branch doesn't match `active-task.json.branch` (closes the drift gap between Monday Branch column and actual working branch) |
| `bash-guard` | PreToolUse Bash (gated by `if` matcher on dangerous commands) | --no-verify / --force / rm -rf / git reset --hard / unguarded git operations. Also runs i18n parity + completeness checks on `git commit` when `project-config.i18n.enabled = true` — reads `messagesGlob`, `defaultLocale`, `locales`, `parityHookMode` from config. |
| `stop-task-check` | Stop | session has source changes but pipeline incomplete (no PR / preview URL / review) |
| `stop-ci-green-check` | Stop | CI checks not green or failures unacknowledged |

**Enable for your project:** add to `.claude/project-config.json`:

```json
{
  "version": "1",
  "hooks": {
    "enabled": [
      "task-state-guard",
      "worktree-required",
      "worktree-path-boundary",
      "bash-guard",
      "stop-task-check",
      "stop-ci-green-check"
    ]
  }
}
```

Omit a hook from the array to keep it inert. Without `project-config.json` at all, every hook is dormant — only `rule-autoload.sh` (always-on) runs.

## project-config

Consumers add `.claude/project-config.json` validated against `schemas/project-config.schema.json`. Covers `git`, `i18n`, `ci`, `monday`, `rules`, and `hooks.enabled[]` fields. A starter at `templates/starter-project-config.json` shows the minimum shape.
