# monday-task-flow plugin

Claude Code plugin for Monday-driven task-first development. Ships:

- **MCP server** — 37 stdio tools (Monday task/sprint/epic/bug/version/feedback management)
- **Rules** — 8 universal lifecycle rules, auto-injected on Edit/Write via PreToolUse
- **Skills** — 7 core lifecycle skills (Phase 2b.i): `pickup-task`, `create-task`, `refine-task`, `log-progress`, `self-review`, `ship-pr`, `release-version`. Invoked as `/monday-task-flow:<skill>`.
- **project-config** — JSON schema for per-consumer config (no skills/hooks read it yet — Phase 2b.ii)

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
│   └── tools/                     # one file per tool, plus utils + index
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
│   ├── hooks.json                 # PreToolUse rule-autoload registration
│   ├── rule-autoload.sh           # the hook script (fail-open, session-dedup)
│   └── lib/config-reader.sh       # shared project-config reader for future hooks
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

## project-config (Phase 2a defines, Phase 2b.ii consumes)

Consumers may add `.claude/project-config.json` validated against `schemas/project-config.schema.json`. The schema covers `git`, `i18n`, `ci`, `monday`, and `rules` fields. **Phase 2a ships only the schema** — no plugin code currently reads it. Phase 2b.ii's hooks (i18n parity, worktree-required, etc.) will use `hooks/lib/config-reader.sh` to load values.

A starter at `templates/starter-project-config.json` shows the minimum shape.
