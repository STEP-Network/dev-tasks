---
name: refine-task
description: Break a Monday.com task into typed subtasks with estimates and Ready-to-Start prereqs
user_invocable: true
---

# /refine-task — Break Task into Subtasks

Use when a task is `Needs Refinement` and lacks prerequisites for `Ready to Start`, OR when an in-flight task needs new/replaced subtasks mid-implementation.

## Workflow

### Phase 0: Investigate relevance (smart default — see `/dev-tasks:investigate-request`)

Tasks decay. A task filed weeks ago may cite functions that have been renamed, an AC may reference a deprecated library, or a related PR may have shipped the work in flight. Before any field-mutating call (`manageSubtasks`, `updateTask` description / AC / subtasks), run `/dev-tasks:investigate-request --mode=relevance --taskId=<N>`.

**Skip case** (deterministic): if `now - task.updatedAt < 24h` AND `git log origin/$defaultBase --since=task.updatedAt --count` returns 0 — no time for drift; skip the invocation. Otherwise it runs.

**Handle the recommendation**:
- `DECLINE` (task superseded or no longer relevant) → confirm via `AskUserQuestion`: "Task #N appears superseded by PR #M (merged YYYY-MM-DD). Mark as Declined, or refine to remaining scope?" Wait. If Declined → `updateTask({ status: "Declined" })` with rationale; do NOT refine. If remaining-scope → continue with reduced scope.
- `SKIP` (the original problem has been shipped) → surface to user, propose moving to Done or Declined as appropriate.
- `REFINE` (proceed) → continue to step 1+ using the report's findings to inform subtask additions / removals.

**BLOCKING questions** MUST be resolved via `AskUserQuestion` before any `manageSubtasks` / `updateTask` field-write. **OPTIONAL** questions are mentioned in the proceed-message.

### Standard workflow

1. **Fetch task**: `getTask` — read type, priority, epic, description, AC, existing subtasks, dependencies.
2. **Verify task-level prereqs** (required by `Ready to Start` gate): `type`, `priority`, `epicId`, `description`, `acceptanceCriteria`. If missing: prompt user or fill via `updateTask` when inference is safe.
3. **Read source files**: Glob/Grep to find related code; ground each subtask in a real code path.
4. **Decompose into 3–7 subtasks** (often: schema → backend → ui → test → docs):
   - Each: `name` + `description` + `type` + `estimatedHours`
   - Types: Backend / Test / Documentation / UX-UI / Database / To Do (see `task-lifecycle.md`)
   - NEVER include a human-test subtask. Human verification = parent's `Waiting for UAT` + auto-generated UAT doc on column `doc_mm3adfdg` (written by `/ship-pr` Phase 4.5).
5. **Apply subtasks**: `manageSubtasks` with `create` per new, `delete`/`update` for obsolete (rescoping is fine).
6. **Optional dependency**: set `dependencyIds` via `updateTask` (column `dependency_mm0pwbxn`).
7. **Promote status** if all prereqs satisfied: `updateTask` with `status: "Ready to Start"`. MCP validates; on rejection lists missing.
8. **No narrative post.** The refined subtasks + the `Ready to Start` status change (steps 5–7) ARE the record (Monday state — kept). Progress is tracked in git commits once work starts (every commit carries the task `#id`); do NOT post a `PLAN_CREATED` Update — the single pipeline summary posts at the end of `/ship-pr`.

9. **Conditional plan depth-check** — invoke `/dev-tasks:holistic-thinking` BEFORE claim if ANY:
    - Plan touches ≥2 unrelated subsystems
    - Nth attempt at same class of issue (check `listRetros` + `getBacklog` for overlapping keywords)
    - Addresses a symptom, unsure if deeper root cause
    - AC mentions "ensure" / "all" / "every", or ≥5 bullets
    - First-draft plan feels off but you can't articulate why

    Otherwise skip — depth-checking a mechanical 30-min refactor is noise.

## Arguments

- `<task-id>`: Monday task ID to refine

## Estimation

| Size | Hours | Criteria |
|------|-------|----------|
| S | 0.25–1h | Single file, mechanical, no new tests |
| M | 1–3h | 2–4 files, moderate logic, tests updated |
| L | 3–8h | 5+ files, complex logic, new tests / migration |
| XL | 8+h | Split further — anything bigger decomposes into multiple subtasks |

Default to slight overestimation; tracked est-vs-actual deltas help future planning.

## Output

```text
Task: [name]
Subtasks (parent promoted to Ready to Start if all prereqs met; subtasks created at Needs Refinement):
  1. [Type] [name] — ~[hours]h — [AC one-liner]
  2. ...
Total estimated: [sum]h
Promoted to Ready to Start: yes/no (reason if no)
```
