---
name: refine-task
description: Break a Monday.com task into typed subtasks with estimates and Ready-to-Start prereqs
user_invocable: true
---

# /refine-task — Break Task into Subtasks

> Use when a task is `Needs Refinement` and lacks the prerequisites for `Ready to Start`,
> OR when an in-flight task needs new/replaced subtasks mid-implementation.

## Workflow

1. **Fetch task**: `mcp__dev-tasks__getTask` — read type, priority, epic, description, acceptance criteria, existing subtasks, dependencies.
2. **Verify task-level prereqs** (required by the `Ready to Start` gate):
   - `type` (`Feature`/`Fix`/`Improvement`/`To Do`)
   - `priority` (`Critical`/`High`/`Medium`/`Low`)
   - `epicId`
   - `description`
   - `acceptanceCriteria`
   - If any are missing: prompt the user (or fill via `mcp__dev-tasks__updateTask` if inference is safe).
3. **Read source files**: Use Glob/Grep to find related code; ground each subtask in a real code path.
4. **Decompose into 3–7 subtasks** with logical ordering (often: schema → backend → ui → test → docs):
   - Each subtask MUST carry `name` + `description` + `type` + `estimatedHours`.
   - Subtask types: `Backend` · `Test` · `Documentation` · `UX-UI` · `Database` · `To Do`. See "Subtask type guidance" below.
   - **Never include a human-test subtask.** Human verification = parent's `Waiting for UAT` status + auto-generated UAT doc (written by `/ship-pr` Phase 4.5). The legacy "Always add a test subitem with owner 48307552" rule is **removed**.
5. **Apply subtasks**: `mcp__dev-tasks__manageSubtasks` with one `create` op per new subtask, and `delete`/`update` ops for any obsolete ones (rescoping is fine).
6. **Optional dependency declaration**: if you discover this task is blocked by another task, set `dependencyIds` via `mcp__dev-tasks__updateTask` (column `dependency_mm0pwbxn`).
7. **Promote status** (if appropriate): if the task was `Needs Refinement` and now satisfies all gate prereqs, call `mcp__dev-tasks__updateTask` with `status: "Ready to Start"`. The MCP validates; on rejection it lists what's still missing.
8. **Post PLAN_CREATED event**: `mcp__dev-tasks__createUpdate` with the subtask list + total estimate.

## Arguments

- `<task-id>`: Monday.com task ID to refine.

## Estimation Guidelines

| Size | Hours | Criteria |
|------|-------|----------|
| S | 0.25–1h | Single file, mechanical change, no new tests |
| M | 1–3h | 2–4 files, moderate logic, tests updated |
| L | 3–8h | 5+ files, complex logic, new tests / migration |
| XL | 8+h | Split further — anything bigger should decompose into multiple subtasks |

Default to slight overestimation; tracked est-vs-actual deltas help future planning.

## Subtask type guidance

| Type | Use for | Common subtask shape |
|------|---------|----------------------|
| **Backend** | API routes, server actions, business logic, hooks, scripts, MCP/AI integrations | "Add POST /api/foo with ownership check" |
| **Test** | Unit / integration / E2E coverage (Jest, Playwright, MCP-driven) | "Add Playwright E2E for the new flow" |
| **Documentation** | CLAUDE.md, `.claude/rules/`, `docs/`, README, user guides, RAG content | "Document new flow in BRUGER-GUIDE-REGISTRERING.md" |
| **UX-UI** | React components, page layouts, styling, a11y, theming | "Build `<FooModal />` with glass-morphism theme" |
| **Database** | Drizzle schema changes, migrations, indexes, query tuning | "Add `bar` column to `foo` table + migration" |
| **To Do** | Catchall — use sparingly when no other type fits | "Coordinate copy review with stakeholder" |

The type should reflect the dominant WORK in the subtask. A subtask that mixes two
types (say a small backend route + its trivial test) stays typed as the dominant one.
Split off a separate `Test` subtask only when test coverage is non-trivial.

## Why no human-test subtasks

Under the new task lifecycle (CLAUDE.md "Task Management Lifecycle"), human verification
is the parent task's `Waiting for UAT` status, not a child subtask. `/ship-pr` Phase 4.5
auto-generates the UAT doc on column `doc_mm3adfdg` from the task's description + AC +
git diff + preview URL. The doc is the regulator-readable WHAT to test; the `Waiting for
UAT` status is the WHO/WHEN. This collapses the previous "implementation subtasks + one
human-test subtask + parent stays In Progress" pattern into "implementation subtasks +
parent flips to Waiting for UAT".

## Output Format

```text
Task: [name]
Subtasks (status → Ready to Start after this run if all prereqs satisfied):
  1. [Type] [name] — ~[hours]h — [acceptance criteria one-liner]
  2. ...
Total estimated: [sum]h
Promoted to Ready to Start: yes/no (reason if no)
```
