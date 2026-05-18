---
name: log-progress
description: Post structured Monday.com update and manage subtask lifecycle
user_invocable: true
---

# /log-progress — Post Structured Progress Update

Read `.claude/project-config.json`. Extract `environments.uat.url` (omit UAT URL from updates if missing) and `git.defaultBase`.

## Workflow

1. Determine event type from argument or context.
2. Read `.claude/active-task.json` for task/subtask context.
3. Post structured update via `mcp__plugin_dev-tasks_dev-tasks__createUpdate`.
4. **For SUBTASK_COMPLETED, manage subtask lifecycle**:
   a. Find active subtask (`status = "in_progress"`). If none: error "No in-progress subtask found" and ABORT.
   b. Fetch subtask `started_date` from Monday via `getTask` (canonical source).
   c. `actualHours = (now - started_date)` in hours, rounded to 1 decimal.
   d. Update subtask: status `Done` + actual hours via `manageSubtasks`.
   e. Update state file: subtask `status: "done"`, add `completedAt`, `actualHours`.
   f. Set next subtask `In Progress` via `manageSubtasks` (triggers `started_date`).
   g. Update state file: next subtask `status: "in_progress"` with `mondayStartedDate`.
   h. Post structured update via `createUpdate` (replaces step 3 — do NOT double-post).

## Event Types

| Event | When | Auto-invoked by |
|-------|------|-----------------|
| TASK_CLAIMED | Task picked up | /pickup-task |
| PLAN_CREATED | Plan file written | /pickup-task, /refine-task |
| SUBTASK_COMPLETED | Subtask finished | Manual via /log-progress |
| TESTS_RUN / TESTS_FAILED | pnpm test result | /ship-pr |
| REVIEW_COMPLETED | Self-review passes | /self-review |
| E2E_COMPLETED / E2E_FAILED | Playwright result | /run-e2e |
| PR_CREATED | PR created | /ship-pr |
| REVIEW_FEEDBACK_FIXED | PR comments addressed | Manual |
| CI_PASSED / CI_FAILED | CI verdict | /ship-pr Phase 5 |
| REVIEW_ACCEPTED | GitHub review approved | /ship-pr Phase 5 |
| UAT_DOC_GENERATED | UAT doc via `createTaskUatDoc` | /ship-pr Phase 4.5 |
| TASK_WAITING_FOR_UAT | Parent → Waiting for UAT (default flow) | /ship-pr Phase 6.5 |
| PIPELINE_COMPLETE | Full pipeline done | /ship-pr Phase 7 |
| TASK_STUCK | 3+ consecutive failures | Any skill |
| TASK_COMPLETED | Summary + state-file cleanup (no status flip) | Manual or /ship-pr Phase 10 |

## Update Format

```
[EVENT_TYPE] Agent Progress Update
Time: {ISO 8601} | Branch: {current branch}
Event: {description}
Details: {structured details relevant to event type}
```

## Arguments

- `<EVENT_TYPE>` (required)
- `<details>` (optional)

## TASK_COMPLETED handling

TASK_COMPLETED is summary + cleanup. It does NOT flip parent status. Status transitions are owned by `/ship-pr` Phase 6.5 (→ `Waiting for UAT`) and `/release-version` (→ `Done` on tag push) for default flow, or `/ship-pr` Phase 10 (→ `Done`) for hotfixes merged to `$hotfixBase`.

1. Verify all subtasks `done` (warn on `in_progress`/`pending`).
2. Summarize estimated vs actual hours per subtask.
3. Include PR link, preview URL, current task status (from `getTask`).
4. Post via `createUpdate` with full breakdown.
5. Delete `.claude/active-task.json`.

`/ship-pr` Phase 10 also deletes the state file — whichever runs first wins.

## State File Schema

`.claude/active-task.json`:

```json
{
  "taskId": "monday-id",
  "taskName": "...",
  "branch": "feat/<slug>",
  "claimedAt": "ISO 8601",
  "selfReviewPassed": false,
  "selfReviewPassedAt": null,
  "subtasks": [
    {"id": "sub-1", "name": "...", "status": "done", "mondayStartedDate": "...", "completedAt": "...", "actualHours": 0.5},
    {"id": "sub-2", "name": "...", "status": "in_progress", "mondayStartedDate": "..."},
    {"id": "sub-3", "name": "...", "status": "pending"}
  ]
}
```

Field presence by status:
- `done`: has `mondayStartedDate`, `completedAt`, `actualHours`
- `in_progress`: has `mondayStartedDate`
- `pending`: no date/hours

File is:
- Created by `/pickup-task` (with `selfReviewPassed: false`)
- Updated by `/log-progress` on SUBTASK_COMPLETED
- Updated by `/self-review` when iterative review passes
- Deleted by `/log-progress` on TASK_COMPLETED
- Checked by `task-state-guard.sh` (hard-blocks edits if missing)
- Checked by `stop-task-check.sh` (warns on unlogged work + missing self-review)
- Checked by `/ship-pr` (hard-blocks if `selfReviewPassed` not true)

## Lifecycle update sequence

Canonical sequence (not every step fires on every task — E2E only for UI changes, hotfix flow skips UAT doc + Waiting-for-UAT):

1. **Task claimed** → `/pickup-task` posts TASK_CLAIMED, sets first subtask "In Progress" via `manageSubtasks`.
2. **Each subtask completed** → `/log-progress SUBTASK_COMPLETED` marks Done + calculates `actualHours` + starts next.
3. **Self-review passes** → `/log-progress REVIEW_COMPLETED` (sets `selfReviewPassed: true`).
4. **E2E done** → `/log-progress E2E_COMPLETED` or `E2E_FAILED` (UI/flow only).
5. **PR created** → `/ship-pr` posts PR_CREATED with PR link.
6. **Preview URL** → `/ship-pr` Phase 4 sets `demoUrl` (column `link_mm0mtyf4`), `prLink` (`link_mm0m817p`), `branch` (`text_mm0pvs3n`), `githubLink` (`link`) via `updateTask`.
7. **UAT doc generated** → `/ship-pr` Phase 4.5 → `createTaskUatDoc` (column `doc_mm3adfdg`). Posts UAT_DOC_GENERATED.
8. **Review fixed** → `/log-progress REVIEW_FEEDBACK_FIXED`.
9. **Review loop terminates** → `/ship-pr` Phase 6.5 transitions task → `Waiting for UAT` (default flow only). Posts TASK_WAITING_FOR_UAT.
10. **PR merged**: default → human takes over UAT, task stays `Waiting for UAT`. Hotfix → `/ship-pr` Phase 10 sets `Done`.
11. **TASK_COMPLETED** → posts est vs actual + deletes state file. Does NOT touch parent status.
12. **Stuck** (3 consecutive failures) → TASK_STUCK + `createBug`.
13. **Version linked** → `auto-version.ts` writes at Waiting for UAT.
14. **Release** → `/release-version` FFs `$hotfixBase` from `$defaultBase` + `pnpm migrate:prod` + tag → GitHub Action flips linked tasks `Pending Deploy to Prod` → `Done`.

Cross-references: `task-lifecycle.md`, `.claude/skills/ship-pr/SKILL.md` Phases 4/4.5/6.5/10, `.claude/skills/pickup-task/SKILL.md`, `.claude/skills/release-version/SKILL.md`.
