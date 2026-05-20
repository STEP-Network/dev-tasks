# CLAUDE.md — dev-tasks

This repo is a Claude Code plugin marketplace + plugin source. The plugin (`dev-tasks`) packages a Monday.com MCP server, lifecycle rules, skills, and hooks for autonomous coding agents driving development work from a Monday.com board ecosystem.

**The plugin is dogfooded here** — this repo is a consumer of its own plugin. Monday product: **Dev-Tasks Plugin** (#2924964797). Default catch-all epic: **Dev-Tasks Plugin — Maintenance & Hotfixes** (#2924897116). Project-config: `.claude/project-config.json` (committed). All edits to `plugin/src/` go through the full Monday task lifecycle (claim → work → ship → release). Edits to `.claude/`, `memory/`, `CLAUDE.md`, `.gitignore` are exempt from `task-state-guard` for fast infra work.

## Repo layout

```
.
├── .claude-plugin/marketplace.json   # marketplace registry → ./plugin
├── plugin/                           # the plugin itself (see plugin/README.md for full layout)
│   ├── .claude-plugin/plugin.json    # plugin manifest
│   ├── .mcp.json                     # registers the stdio MCP server
│   ├── package.json + tsconfig.json  # plugin deps (@modelcontextprotocol/sdk + zod) + TS build
│   ├── src/                          # MCP TypeScript source (37 tools)
│   ├── dist/                         # tsc output (gitignored)
│   ├── rules/                        # 8 universal lifecycle rules
│   ├── rules-routing.json
│   ├── skills/                       # 7 core lifecycle skills
│   ├── hooks/                        # 7 hooks (rule-autoload + 6 critical, opt-in)
│   ├── schemas/                      # project-config.schema.json
│   └── templates/                    # starter-project-config.json
├── .claude/                          # project-local Claude Code config
│   ├── project-config.json           # dev-tasks plugin config (committed)
│   ├── active-task.json              # current task state (gitignored, per-session)
│   ├── worktrees/                    # per-task git worktrees (gitignored)
│   └── skills/                       # per-user local skills (gitignored)
├── CLAUDE.md                         # this file
└── .env.example                      # MONDAY_API_KEY example
```

## Commands

```bash
cd plugin
npm install          # also runs `tsc` via prepare hook → produces dist/
npm run build        # rebuild dist/
npm run typecheck    # tsc --noEmit
npm start            # run the stdio MCP server (responds on stdin/stdout)
```

## Install the plugin in a consumer project

```sh
export MONDAY_API_KEY="..."  # add to ~/.zshrc; .mcp.json doesn't interpolate
cd <consumer-project>
claude
```

Then in the Claude Code session:

```
/plugin marketplace add /Users/nate/dev-tasks
/plugin install dev-tasks@dev-tasks-marketplace
/reload-plugins
```

To activate the blocking hooks (task-state-guard, worktree-required, worktree-path-boundary, bash-guard, stop-task-check, stop-ci-green-check), copy `plugin/templates/starter-project-config.json` to `<consumer-project>/.claude/project-config.json` and trim it to what you want enabled. Without that file, only `rule-autoload` runs; all blocking hooks are dormant.

## Board ecosystem (what the MCP wraps)

```
Products (5091839409) [read-only]
  └→ Epics (5091706354) [read-write]
       ├→ Tasks (5091706356) [read-write] ←→ Sprints (5091706352) [read-only]
       │    └→ Product (mirror via Epic)
       ├→ Bugs (5091706353) [read-write] ←→ Epics (two-way relation)
       └→ Versions (5091847257) [read-write]
       Feedback (5091852801) [read-write] ←→ Tasks (two-way relation)
```

**Mirror columns:** Tasks has a Product mirror column (`lookup_mm0vsq7f`) mirrored through the Epic relation (`task_epic`). Mirror columns are read-only and cannot be filtered server-side — `getBacklog` resolves product → epics → tasks instead.

Subtasks board: 5091706366 (linked from Tasks).

## Tools (37)

The plugin's MCP server registers 37 tools in `plugin/src/server.ts`. See that file for current names, descriptions, and Zod schemas. High-level phases:

| Phase | Tools |
|---|---|
| Discovery | `getBacklog`, `getBugs`, `listFeedback` |
| Context | `getTask`, `getSprint`, `listSprints`, `getEpic`, `listEpics`, `listProducts`, `getFeedback`, `listVersions`, `getVersion`, `getUpdates`, `getTaskUatDoc`, `getStructuredChangelog`, `getPublicRoadmap`, `listRetros` |
| Execution | `claimTask`, `updateTask`, `manageSubtasks`, `updateEpic`, `updateFeedback`, `updateVersion`, `updateRetro`, `setPublicTaskName`, `updateStructuredChangelog`, `createTaskUatDoc`, `updateTaskUatDoc` |
| Creation | `createTask`, `convertBugToTask`, `createBug`, `createEpic`, `createFeedback`, `convertFeedbackToTask`, `createRetro`, `createVersion` |
| Shipping | `generateChangelog`, `migrateStructuredChangelog` |
| Communication | `createUpdate` |

After plugin install, tools are namespaced as `mcp__plugin_dev-tasks_dev-tasks__<tool>`.

## Agent workflow

```
1. getBacklog(unclaimedOnly: true)     → find available work
2. getTask(itemId)                      → read full context
3. listEpics()                          → find epic to assign (if needed)
4. claimTask(itemId, agentId, planId)   → claim it (auto-assigns owner)
5. manageSubtasks(parentItemId, ops)    → create/update subtasks as you work
6. updateTask(itemId, prLink, status)   → set PR link, update status
7. listVersions()                       → find or create target version
8. updateVersion(versionId, linkTaskIds) → link to release version
9. generateChangelog(versionId)         → auto-generate changelog doc
```

The 7 plugin skills (`/dev-tasks:pickup-task`, `create-task`, `refine-task`, `log-progress`, `self-review`, `ship-pr`, `release-version`) wrap most of this flow.

**Default stance: autonomous-by-default.** The lifecycle chain runs end-to-end without permission checks between phases. The rule `plugin/rules/autonomous-by-default.md` defines the six carve-outs that justify a pause (destructive actions, scope expansion, external-system contact, hidden trade-offs, missing context, stuck) and the communication pattern that replaces check-ins (terse status updates, no trailing "want me to continue?" questions). Complements `agent-autonomy.md` (which covers the main-vs-subagent context boundary and the Stuck criterion).

## Claiming protocol

- Agent calls `claimTask` → server validates:
  - Status is "Ready to Start" (tasks in "Needs Refinement" must be refined and sprint-assigned first)
  - Agent ID dropdown is empty
  - All blocked-by dependencies (column `dependency_mm0pwbxn`) are Done
- Sprint membership is no longer a hard block. If the task isn't in the active sprint, `claimTask` **auto-pulls** it into the active sprint and sets `unplanned: true`, surfacing the action in the response. Hard-block only when there is no active sprint at all.
- Success → sets In Progress + Agent ID + Plan ID + Started Date + Owner (auto-assigned)
- Conflict → returns error with current owner

## Owner assignment

Pass your system username (`whoami`) as the `owner` field. The plugin resolves it to a Monday person ID via a live lookup on the People board (`1612664689`), match priority:

1. `text_mm3ffcjd` column — registered whoami username (authoritative, highest priority — set this for each team member)
2. Email local-part (`naref@stepnetwork.dk` → `naref`)
3. `person` column display name
4. `name` column first word

Records with status `Past` are excluded. Lookup is cached per `(boardId, apiKey)` with a 5-min TTL.

Used in `claimTask` (required), `createTask`, `createEpic`, `updateEpic`, `createVersion`, `updateVersion` (all optional). `doctor` Check #6 verifies your `whoami` resolves correctly.

## Key status mappings

**Task Status:** Needs Refinement → Ready to Start → In Progress → Waiting for UAT → Pending Deploy to Prod → Done (+ Stuck)
**Task Priority:** Critical, High, Medium, Low, Missing
**Task Type:** Feature, Fix, Improvement, To Do, Not Set
**Subtask Status:** Needs Refinement → In Progress → Done (+ Stuck) — note: subtasks have no "Ready to Start" intermediate state (the Subtasks board doesn't have that label configured)
**Subtask Type:** To Do, Database, Backend, Documentation, Test, UX-UI
**Epic Status:** Backlog, Planned, Refining, In Progress, Review, On Hold, Done
**Epic Priority:** Critical, High, Medium, Low, Minimal, Not Prioritized
**Version Status:** Planned, In Development, Release Candidate, Released, Hotfix
**Feedback Status:** New → Under Review → Accepted → Converted / Declined / Done
**Feedback Type:** Request, Feedback
**Feedback Priority:** Critical, High, Medium, Low
**Feedback Source:** User, Internal, Support, Partner
**Bug Status (Option C, v0.12.0):** Awaiting Review (default) → Triaged → (Converted to Task | Declined | Cannot Reproduce | Duplicated | Missing Info | Known Bug). Bugs are **intake-only** — once `Converted to Task`, all dev work happens on the linked Task (type: Fix). `convertBugToTask` sets `Converted to Task` automatically. **DO NOT write legacy values (Ready for Dev, Fixing, Fixed, Pending Deploy, Move to Sprints) via the plugin going forward** — they remain readable for historical items but new transitions belong in the intake-only set. `getBugs` filtering on the new statuses (Triaged, Converted to Task, Declined, Cannot Reproduce) returns 0 results until Monday has actually registered each label (first write via `updateBug` or `convertBugToTask` registers them).
**Bug Priority:** Critical, High, Medium, Low
**Retro Type:** Discussion, Keep, Improve (existing — separate from workflow status)
**Retro Status (v0.12.0):** New (default) → Accepted (team agreed, owner assigned) → Implemented (PR merged, `implementedBy` + `resolvedInVersionId` populated) → Validated. Off-ramp: Declined (terminal).
**Agent ID:** Claude Code CLI, Claude Desktop Cloud, Codex Local, Claude Desktop Local, Codex Cloud

## Status transition gates

`updateTask` enforces preconditions before letting status advance:

- **Ready to Start** requires:
  - `type` is set (not "Not Set")
  - `priority` is set (not "Missing")
  - linked to an epic
  - `description` is non-empty
  - acceptance criteria (`long_text_mm0pqaxy`) is non-empty
  - ≥1 subtask with name, description, type (not "Missing Status"), positive estimate

  Same-call args count. `createTask` honors the same gate — if you pass `status: "Ready to Start"`, the task is created at Needs Refinement and promoted to Ready to Start after subitems exist, only if the gate passes.

- **Waiting for UAT** hard-blocks unless:
  - all subtasks are Done
  - UAT testing doc column (`doc_mm3adfdg`) is set (use `createTaskUatDoc` first)

  …and warns (but doesn't block) when missing GitHub link, branch (`text_mm0pvs3n`), demo URL, or PR link.

- **Sprint auto-pull (any status leaving the refinement phase):** any transition to a status other than "Ready to Start" or "Needs Refinement" requires active-sprint membership. That includes `In Progress`, `Waiting for UAT`, `Pending Deploy to Prod`, `Done`, and `Stuck`. If the task isn't in the active sprint AND the same `updateTask`/`claimTask` call didn't explicitly pass `sprintId`, the plugin auto-pulls the task into the active sprint and sets the `unplanned` checkbox to `true`. Both column writes land atomically in the same `change_multiple_column_values` mutation as the status change. The tool response surfaces the action so the agent is aware. Hard error only when no active sprint exists.
  - Note on `Done`: usually fires via Monday automation when subtasks complete (no auto-pull involved). A direct `updateTask({status:"Done"})` call DOES trigger auto-pull if the task is out-of-sprint — same rule as every other non-refinement status.

Subtasks should describe work-on-code, not human verification (testing belongs in the UAT doc) — otherwise the "all subtasks Done" gate can't ever be satisfied.

## UAT doc tools

`text_mm3adfdg` *(`doc_mm3adfdg`)* is a Monday Doc on each task that describes what a human should verify. Three tools manage it:

- `getTaskUatDoc(taskId)` — returns the doc's markdown (via `export_markdown_from_doc`)
- `createTaskUatDoc(taskId, markdown)` — creates a fresh doc (refuses if one already exists)
- `updateTaskUatDoc(taskId, markdown, overwrite?)` — overwrite (default) or append to an existing doc

## Task dependencies

Tasks can declare blocked-by relationships via the `dependency_mm0pwbxn` column. Pass `dependencyIds: number[]` to `createTask` or `updateTask` (empty array clears). `claimTask` refuses to start a task whose dependencies are not all Done.

## Maintenance epics

Every product should have a permanent "Maintenance & Hotfixes" epic (Status: In Progress, no deadline). This ensures all tasks have an epic — and therefore Product context via the Task mirror column.

- `createBug`, `convertBugToTask`, and `convertFeedbackToTask` auto-assign the maintenance epic when no explicit `epicId` is provided
- The resolver matches epics whose name contains "maintenance" (case-insensitive)
- Convention: name the epic "{Product Name} — Maintenance & Hotfixes"
- Hotfix tasks, tech debt, and miscellaneous work go here

## Product inheritance

Product flows through the hierarchy: **Product → Epic → Task** (mirror column). Bugs, Feedback, and Versions keep direct Product connections because they exist at different lifecycle stages (intake/output) before tasks or epics are assigned.

## Task completion

Monday.com automation auto-completes the parent task when all subtasks are Done:

- Do NOT set task status to `Done` directly
- Mark all subtasks `Done` instead (automation triggers when the last subtask flips Done)
- Delete unwanted subtasks before marking the last one Done

## Environment variables

- `MONDAY_API_KEY` — Monday.com API key (required). Must be exported in the parent shell that launches Claude Code; `.mcp.json` does not interpolate env values.

## Migration history (Phase 1–3a, May 2026)

This repo was previously a Next.js app exposing the MCP as an HTTP route (`app/api/mcp/route.ts`). Phase 1 migrated all 37 tools to a stdio MCP inside the plugin; Phases 2a/2b lifted universal rules, lifecycle skills, and the 6 critical blocking hooks from `v0-politiske-annoncer/.claude/`. Phase 3a (this commit) deleted the Next.js scaffolding — the repo is plugin-only now. Branch: `feat/plugin-migration`. Phase 3b/3c open: see tasks #7/#8.
