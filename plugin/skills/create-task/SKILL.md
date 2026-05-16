---
name: create-task
description: Create a new Monday.com task with duplicate checking and Ready-to-Start gate enforcement
user_invocable: true
---

# /create-task — Create a New Task

> The Monday MCP enforces a server-side gate on every status transition. This skill
> walks through the prerequisites for `Ready to Start` so a task lands ready for
> `/pickup-task` without needing a separate refinement pass.

## Workflow

1. **Check for duplicates**: Use `mcp__plugin_dev-tasks_dev-tasks__getBacklog` to search for similar/related tasks.
   - If similar keywords / overlapping scope: show the existing task and ask whether to update it or create new.

2. **Epic assignment** (MANDATORY — no orphaned tasks):
   - Call `mcp__plugin_dev-tasks_dev-tasks__listEpics(product: "PolAds")` to get available epics.
   - Try to auto-match based on task name/description keywords.
   - If confident: use that `epicId`.
   - If not confident: ask the user which epic this task belongs to.
   - For bugs/hotfixes: default to the product's Maintenance epic ("PolAds: Maintenance & Hotfixes" #2743409388).

3. **Decide on type & priority**:
   - `type`: `Feature` (new functionality) | `Fix` (bugfix) | `Improvement` (tech debt / refactor / small UX) | `To Do` (human task — used sparingly).
   - `priority`: `Critical` (production-blocker / regulator deadline) | `High` (sprint commitment) | `Medium` (planned) | `Low` (nice-to-have).
   - Do NOT leave priority as `Missing` unless you genuinely cannot infer — the `Ready to Start` gate rejects it.

4. **Write description + acceptance criteria**:
   - `description`: free-text WHAT and WHY (1–3 paragraphs).
   - `acceptanceCriteria`: bullet list of definition-of-done items an external party can verify. These are the regulator-readable WHY.
   - Both are REQUIRED for the `Ready to Start` gate.

5. **Plan subtasks** (REQUIRED — at least one, fully refined):
   - Each subtask MUST carry `name` + `description` + `type` + `estimatedHours`.
   - Subtask types: `Backend` · `Test` · `Documentation` · `UX-UI` · `Database` · `To Do`. See "Subtask type guidance" below.
   - **NEVER create a human-testing subtask.** Human verification belongs to the parent task's `Waiting for UAT` status + the auto-generated UAT doc on column `doc_mm3adfdg` (written by `/ship-pr` Phase 4.5). The legacy "Always add a Testing subitem with owner 48307552" rule is **removed**.

6. **Optional dependency declaration**:
   - If this task is blocked by another task: pass `dependencyIds: [<task-id>, ...]`. Stored in column `dependency_mm0pwbxn`. `claimTask` will refuse to start this task until those dependencies are `Done`.

7. **Create task**: call `mcp__plugin_dev-tasks_dev-tasks__createTask`. Recommended fields:
   - `status: "Ready to Start"` — the MCP rejects this if any prereq is missing; treat the rejection as a checklist of what's still missing.
   - `agentId: "Claude Code CLI"` (or whichever agent is creating).
   - `owner: <output of \`whoami\`>`.
   - `epicId`, `type`, `priority`, `description`, `acceptanceCriteria`.
   - `subitems`: the typed+estimated subtask list from step 5.
   - `sprintId: <active sprint>` if `claimTask` will follow immediately (otherwise `/pickup-task` Phase 7 auto-assigns).
   - `dependencyIds` if step 6 produced any.

8. **Output**: show created task ID, epic name, final status (should be `Ready to Start` if the gate passed), and Monday.com link.

## Arguments

- Description of the task to create (natural language).

## Duplicate Detection

Before creating, search the backlog for:

- Similar keywords in task name.
- Related epic / feature area.
- If >70% keyword overlap, warn about potential duplicate and ask before proceeding.

## What the `Ready to Start` gate requires (server-side)

The Monday MCP rejects `Ready to Start` unless ALL of these are present on the task:

- `type` (`Feature`/`Fix`/`Improvement`/`To Do`)
- `priority` (`Critical`/`High`/`Medium`/`Low`)
- `epicId`
- `description`
- `acceptanceCriteria`
- ≥1 subtask, each with `name` + `description` + `type` + `estimatedHours`

`createTask` runs this gate at creation time when you request `status: "Ready to Start"`.
If the gate fails, the task is created at `Needs Refinement` and the missing fields are
surfaced in the response — populate them via `updateTask` / `manageSubtasks`, then flip
the status when complete.

## What the `In Progress` gate requires

`claimTask` refuses to set `In Progress` unless:

- Task status is `Ready to Start`.
- Task is in the active sprint (`/pickup-task` Phase 7 auto-assigns if not).
- All `dependencyIds` are `Done`.
- No other agent currently owns the task.

## Subtask type guidance

| Type | Use for | Example subtask name |
|------|---------|----------------------|
| **Backend** | API routes, server actions, business logic, hooks, scripts, MCP/AI integrations | "Add POST /api/foo with ownership check" |
| **Test** | Unit / integration / E2E coverage (Jest, Playwright, MCP-driven) | "Add Playwright E2E for the new flow" |
| **Documentation** | CLAUDE.md, `.claude/rules/`, `docs/`, README, user guides, RAG content | "Document new flow in BRUGER-GUIDE-REGISTRERING.md" |
| **UX-UI** | React components, page layouts, styling, a11y, theming | "Build `<FooModal />` with glass-morphism theme" |
| **Database** | Drizzle schema changes, migrations, indexes, query tuning | "Add `bar` column to `foo` table + migration" |
| **To Do** | Catchall when no other type fits — use sparingly | "Coordinate copy review with stakeholder" |

Pick the type that dominates the subtask's WORK. A subtask that adds a Backend route
plus a one-line test for it is still primarily `Backend` — split off a separate `Test`
subtask only when test coverage is non-trivial.

## Status flow context

This skill ends with the task at `Ready to Start`. The downstream flow:

1. `Ready to Start` → `/pickup-task` claims → `In Progress`.
2. `In Progress` → all subtasks `Done` + `/ship-pr` generates UAT doc → `Waiting for UAT`.
3. `Waiting for UAT` → human UAT signoff → `Pending Deploy to Prod`.
4. `Pending Deploy to Prod` → `/release-version` → `Done`.

See CLAUDE.md "Task Management Lifecycle" for the full table.
