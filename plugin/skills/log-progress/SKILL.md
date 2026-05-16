---
name: log-progress
description: Post structured Monday.com update and manage subtask lifecycle
user_invocable: true
---

# /log-progress — Post Structured Progress Update

> **Overlay**: if `.claude/skills/log-progress/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific instructions (extend-only — overlay can append checks/steps but cannot replace plugin behavior).

## Project context (read FIRST)

Read `.claude/project-config.json`. Extract:
- `environments.uat.url` — UAT environment URL (used in "Test on" lines below). If missing, omit UAT URL from updates.
- `git.defaultBase` — used in "next step" descriptions.

## Workflow

1. **Determine event type** from argument or context
2. **Read state file**: Read `.claude/active-task.json` for active task/subtask context
3. **Post structured update** to Monday.com via `mcp__plugin_dev-tasks_dev-tasks__createUpdate`
4. **Manage subtask lifecycle** (if SUBTASK_COMPLETED):
   a. Find active subtask (status = "in_progress") in `.claude/active-task.json`.
      **If no subtask has status "in_progress"**: emit error "No in-progress subtask found. Check `.claude/active-task.json`. Did you already complete this subtask?" and ABORT the SUBTASK_COMPLETED flow.
   b. Fetch subtask's `started_date` from Monday.com via `mcp__plugin_dev-tasks_dev-tasks__getTask` (canonical source)
   c. Calculate `actualHours = (now - started_date)` in hours, rounded to 1 decimal
   d. Update Monday.com subtask: set status "Done" + set actual hours via `mcp__plugin_dev-tasks_dev-tasks__manageSubtasks`
   e. Update state file: set subtask `"status": "done"`, add `"completedAt"` and `"actualHours"`
   f. Set NEXT subtask to "In Progress" on Monday.com via `mcp__plugin_dev-tasks_dev-tasks__manageSubtasks` (triggers `started_date`)
   g. Update state file: next subtask becomes `"status": "in_progress"` with `"mondayStartedDate"` from Monday.com
   h. Post structured update via `mcp__plugin_dev-tasks_dev-tasks__createUpdate` (this replaces step 3 for SUBTASK_COMPLETED — do NOT double-post)

## Event Types

| Event | When | Auto-invoked by |
|-------|------|-----------------|
| TASK_CLAIMED | Task picked up | /pickup-task |
| PLAN_CREATED | Plan file written | /pickup-task, /refine-task |
| SUBTASK_COMPLETED | Subtask finished | Manual via /log-progress |
| TESTS_RUN | pnpm test passes | /ship-pr |
| TESTS_FAILED | pnpm test fails | /ship-pr |
| REVIEW_COMPLETED | Self-review passes | /self-review |
| E2E_COMPLETED | Playwright passes | /run-e2e |
| E2E_FAILED | Playwright fails | /run-e2e |
| PR_CREATED | PR created | /ship-pr |
| REVIEW_FEEDBACK_FIXED | PR comments addressed | Manual |
| CI_PASSED | All CI checks green | /ship-pr Phase 5 |
| CI_FAILED | Any CI check fails | /ship-pr Phase 5 |
| REVIEW_ACCEPTED | GitHub review approved | /ship-pr Phase 5 |
| UAT_DOC_GENERATED | UAT testing doc written via `createTaskUatDoc` | /ship-pr Phase 4.5 |
| TASK_WAITING_FOR_UAT | Parent task transitioned to `Waiting for UAT` (default flow) | /ship-pr Phase 6.5 |
| PIPELINE_COMPLETE | Full pipeline done (PR + CI + review + UAT doc + status) | /ship-pr Phase 7 |
| TASK_STUCK | 3+ consecutive failures | Any skill |
| TASK_COMPLETED | Summary + state-file cleanup (does NOT flip status; see TASK_COMPLETED Special Handling) | Manual or /ship-pr Phase 10 |

## Update Format

```
[EVENT_TYPE] Agent Progress Update
Time: {ISO 8601} | Branch: {current branch}
Event: {description}
Details: {structured details relevant to event type}
```

## Arguments

- `<EVENT_TYPE>` (required): One of the event types above
- `<details>` (optional): Additional context

## TASK_COMPLETED Special Handling

> **Status note**: under the task lifecycle effective 2026-05-13, `/log-progress
> TASK_COMPLETED` is a *summary + cleanup* event. It does **NOT** flip the parent
> task to `Done`. Status transitions are owned by `/ship-pr` Phase 6.5 (→ `Waiting
> for UAT`) and `/release-version` (→ `Done` on tag push, for default flow), or by
> `/ship-pr` Phase 10 for hotfixes merged to `main` (→ `Done` directly). The legacy
> step "Set task status to Done via updateTask" was removed because it conflicted
> with the new gate + release ceremony.

When posting TASK_COMPLETED:

1. Read `.claude/active-task.json` — verify all subtasks are `"done"` (warn if any still `"in_progress"` or `"pending"`).
2. Summarize estimated vs actual hours per subtask from the state file.
3. Include PR link, preview URL, and current task status (from `mcp__plugin_dev-tasks_dev-tasks__getTask`) if available.
4. Post summary via `mcp__plugin_dev-tasks_dev-tasks__createUpdate` with full estimate/actual breakdown.
5. **Delete `.claude/active-task.json`** — cleanup for next task.

`/ship-pr` Phase 10 also deletes the state file after merge — whichever runs first wins, the other is a no-op.

## State File Schema

`.claude/active-task.json` tracks the full subtask lifecycle:

```json
{
  "taskId": "monday-id",
  "taskName": "Task name",
  "branch": "feat/branch-name",
  "claimedAt": "ISO 8601",
  "selfReviewPassed": false,
  "selfReviewPassedAt": null,
  "subtasks": [
    {
      "id": "sub-1",
      "name": "Completed subtask",
      "status": "done",
      "mondayStartedDate": "2026-02-24T08:30:00Z",
      "completedAt": "2026-02-24T09:00:00Z",
      "actualHours": 0.5
    },
    {
      "id": "sub-2",
      "name": "Active subtask",
      "status": "in_progress",
      "mondayStartedDate": "2026-02-24T09:00:00Z"
    },
    {
      "id": "sub-3",
      "name": "Future subtask",
      "status": "pending"
    }
  ]
}
```

**Field presence by status**:
- `"done"`: has `mondayStartedDate`, `completedAt`, `actualHours`
- `"in_progress"`: has `mondayStartedDate` only (set when transitioned from pending)
- `"pending"`: no date/hours fields

**Top-level fields**:
- `selfReviewPassed`: set to `true` by `/self-review` when all 10 checks pass
- `selfReviewPassedAt`: ISO 8601 timestamp of when self-review passed

This file is:
- **Created** by `/pickup-task` (with `selfReviewPassed: false`)
- **Updated** by `/log-progress` on each SUBTASK_COMPLETED
- **Updated** by `/self-review` when iterative review passes (sets `selfReviewPassed: true`)
- **Deleted** by `/log-progress` on TASK_COMPLETED
- **Checked** by `task-state-guard.sh` hook (hard blocks edits if missing)
- **Checked** by `stop-task-check.sh` hook (warns about unlogged work + missing self-review)
- **Checked** by `/ship-pr` (hard blocks if `selfReviewPassed` is not true)

## Lifecycle update sequence (full Monday.com Update Protocol)

The canonical sequence of Monday.com updates posted during a task's lifecycle.
Numbered for cross-reference; not every step fires on every task (E2E only for
UI changes, hotfix flow skips UAT doc + Waiting-for-UAT transition, etc.).

1. **Task claimed** → `/pickup-task` posts `TASK_CLAIMED`, sets first subtask "In Progress" via `manageSubtasks`.
2. **Each subtask completed** → `/log-progress SUBTASK_COMPLETED` marks Done + calculates `actualHours` from Monday `started_date` + starts next subtask.
3. **Self-review passes** → `/log-progress REVIEW_COMPLETED` (sets `selfReviewPassed: true` in state file).
4. **E2E done** → `/log-progress E2E_COMPLETED` or `E2E_FAILED` (if UI/flow changes).
5. **PR created** → `/ship-pr` posts `PR_CREATED` with PR link.
6. **Preview URL ready** → `/ship-pr` Phase 4 sets `demoUrl` (column `link_mm0mtyf4`) + `prLink` (column `link_mm0m817p`) + `branch` (column `text_mm0pvs3n`) + `githubLink` (column `link`) via `updateTask`.
7. **UAT doc generated** → `/ship-pr` Phase 4.5 calls `createTaskUatDoc` (column `doc_mm3adfdg`) with markdown built from task description + AC + git diff + preview URL. Posts `UAT_DOC_GENERATED`.
8. **Review comments fixed** (if review iteration runs) → `/log-progress REVIEW_FEEDBACK_FIXED`.
9. **Review loop terminates** → `/ship-pr` Phase 6.5 transitions task to `Waiting for UAT` (default flow only — hotfix stays `In Progress` through merge). Posts `TASK_WAITING_FOR_UAT`.
10. **PR merged**:
    - Default flow: human takes over UAT on `$uatUrl`; task stays at `Waiting for UAT`.
    - Hotfix flow: `/ship-pr` Phase 10 sets `Done` directly.
11. **TASK_COMPLETED** → `/log-progress TASK_COMPLETED` posts est vs actual summary + deletes `.claude/active-task.json`. Does NOT touch parent task status (handled by `/ship-pr` / `/release-version` per the flow above).
12. **Stuck** (3 consecutive failures) → `/log-progress TASK_STUCK` + `createBug` for the underlying defect.
13. **Version linked** → task's epic linked to target version via `updateVersion` (`/pickup-task` Step 5 suggests; `/ship-pr` Phase 8 hard-blocks if missing).
14. **Release** → `/release-version` does FF $hotfixBase from $defaultBase + `pnpm migrate:prod` + tag → GitHub Action flips linked tasks `Pending Deploy to Prod` → `Done`. (For projects without a staging branch, $defaultBase = $hotfixBase and the "FF" step is a no-op.)

Cross-references:

- `task-lifecycle.md` — full status/subtask/gate table.
- `.claude/skills/ship-pr/SKILL.md` — Phase 4 + 4.5 + 6.5 + 10 mechanics.
- `.claude/skills/pickup-task/SKILL.md` — Steps 1–14 + dependency soft warning.
- `.claude/skills/release-version/SKILL.md` — release ceremony that sets `Done`.
