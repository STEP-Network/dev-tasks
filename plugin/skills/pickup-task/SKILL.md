---
name: pickup-task
description: Claim a Monday.com task, create feature branch, set up context
user_invocable: true
---

# /pickup-task — Claim and Start a Task

Read `.claude/project-config.json`. Extract `git.defaultBase`, `git.hotfixBase`, `git.branchConvention` (default `feat/<slug>`), `monday.productId`, `monday.v1MilestoneEpicIds`. If `git.defaultBase` or `monday.productId` missing → STOP, tell user to set them.

Source-file edits for a claimed task must happen in a git worktree, not the main checkout (`worktree-required.sh` hard-blocks edits outside a worktree when an active task exists). Steps 1–4 are MCP-only and free to run in the main checkout. Step 4.5 enters the worktree.

## Workflow

### Phase 0: Investigate relevance (smart default — see `/dev-tasks:investigate-request`)

A task ready-to-start today may have been silently superseded by a recently-merged PR; subtask file paths may have moved; the AC may reference deprecated code. Before claiming, run `/dev-tasks:investigate-request --mode=relevance --taskId=<N>`.

**Skip case** (deterministic): if `now - task.updatedAt < 24h` AND `git log origin/$defaultBase --since=task.updatedAt --count` returns 0 — skip. Same semantics as `/refine-task`'s skip; matches the existing Phase 15 trigger logic.

**Handle the recommendation**:
- `DECLINE` (task no longer relevant) → `AskUserQuestion`: "Task #N: <reason>. Decline (task superseded, no work needed), or claim anyway and re-refine?" Wait. If decline → `updateTask({ status: "Declined" })` with rationale; do NOT claim. (Declined is the right terminal state for a superseded task — distinct from Stuck which implies an unresolved blocker on real work.) If claim-anyway → proceed but flag to user that re-refinement is needed mid-flight.
- `REFINE` (task needs scope update before claiming makes sense) → exit `/pickup-task`; invoke `/dev-tasks:refine-task <N>` first, then claim.
- Proceed (no fundamental issues) → continue to existing Phase 1 (Validate task readiness) and onward.

**BLOCKING questions** in the report MUST be resolved via `AskUserQuestion` before `claimTask`. **OPTIONAL** questions are mentioned in the proceed-message.

**Coordinate with Phase 15** (`Conditional claim-time re-plan`): Phase 0 here checks RELEVANCE before claim. Phase 15 re-plans IMPLEMENTATION DETAILS after claim. They're complementary: Phase 0 decides "should we claim at all"; Phase 15 decides "given we claimed, is the plan still current."

### Standard workflow

1. `mcp__plugin_dev-tasks_dev-tasks__getSprint` (current sprint) or `getBacklog` to see work.
2. Display task list (IDs, names, status, estimated hours).
3. User selects task (or specify task ID as argument).
4. **Validate task readiness** (HARD BLOCK):
    - Fetch via `getTask` — read status, epic, dependencies.
    - Status: only `Ready to Start` is claimable.
      - `Needs Refinement` → run `/refine-task <id>` first.
      - `In Progress` owned by current agent → check `.claude/active-task.json`.
      - `In Progress` owned by another agent → STOP, pick different task.
      - `Done`/`Waiting for UAT`/`Pending Deploy to Prod`/`Stuck` → STOP.
    - Epic check: HARD BLOCK if no epic. `listEpics(productId: $productId)`, suggest by keyword match, ask user if uncertain, then `updateTask(itemId, epicId)`. For hotfixes/bugs default to product's Maintenance epic.

4.5. **Enter the worktree** (HARD requirement):
    - If `git rev-parse --git-common-dir` == `git rev-parse --git-dir` you're in main checkout — proceed. Otherwise skip.
    - Derive slug from task name (terse, hyphen-separated, ≤30 chars).
    - Compute: `branch = $branchConvention.replace("<slug>", slug)`; `worktreeName = branch.replace("/", "-")`. Hotfixes use `hotfix/` prefix.
    - Get on the right base: `git checkout $defaultBase && git pull --ff-only` (or `$hotfixBase` for hotfix).
    - `EnterWorktree({ name: worktreeName })` — lands at `.claude/worktrees/$worktreeName/` on branch `worktree-$worktreeName`. Step 10 renames to canonical form.
    - Verify with `pwd`.
    - Skip only if already in a worktree, or user authorized `"allowMainCheckout": true` for emergency.
    - Pre-warm node_modules: `pnpm install --offline --ignore-scripts` (uses store cache, skips lifecycle scripts, no interactive prompts). On failure, fall back to "CI is the gate".
    - Copy `.env*.local` from parent checkout: `PARENT=$(dirname "$(git rev-parse --git-common-dir)")` then copy `.env.local`, `.env.development.local`, `.env.test.local` from `$PARENT` if present. Don't copy `.env` (typically tracked). Project-specific local-only env files belong in the overlay.

4.6. **Dependency soft warning** (non-blocking; `claimTask` is the hard gate):
    - From `getTask` read `dependencyIds` (column `dependency_mm0pwbxn`).
    - Empty → continue. Non-empty → for each, call `getTask` and check status.
    - All `Done` → log "All N dependencies satisfied".
    - Any not `Done` → warn naming blockers; user can accept (then `claimTask` will refuse with same info — wait for blocker or clear via `updateTask(itemId, dependencyIds: [])` only if misfiled), or pick different task (then `ExitWorktree({ action: "remove" })` and loop to step 1).

5. **Version context** (informational only — versions are historical):
    - Tasks join the open version at the Waiting-for-UAT transition (server-side via `auto-version.ts`). Per `versions-lifecycle.md`, versions are historical containers, not planning artifacts. Epics plan futures.
    - Optional: `listVersions(status: "In Development", productId: $productId)` to surface what's currently open. Do NOT link the epic to a version here.

6. **Sprint auto-assignment** (must run before claim — `claimTask` refuses tasks outside active sprint):
    - Get active sprint via `getSprint`.
    - No sprint: `updateTask(itemId, sprintId: <active>)` + `updateTask(itemId, unplanned: true)`. Note in TASK_CLAIMED.
    - Already in active sprint: do nothing.
    - Different sprint: reassign to active + `unplanned: true`. Note "Moved from sprint X to Y (unplanned)".

7. **Claim**: `claimTask`. MCP validates: status `Ready to Start`, in active sprint, all `dependencyIds` Done, no other agent owns. On rejection, fix the named field and retry.
8. Status set to `In Progress` by `claimTask` — only needed manually if bypassed.
9. Set first subtask "In Progress" via `manageSubtasks` (triggers `started_date`).
10. Rename worktree branch to canonical: `git branch -M feat/<task-slug>` (or `hotfix/<slug>`). If Step 4.5 skipped: `git fetch origin && git checkout $defaultBase && git pull && git checkout -b feat/<task-slug>`.

11. **Post TASK_CLAIMED event** (do this BEFORE creating state file — response provides `claimToken`):
    `createUpdate` with structured format including branch, sprint (note if unplanned), version (or "Not linked"), subtask count + estimated hours.
    Save returned update ID — this is the `claimToken`.

12. **Create state file** (uses `claimToken` from step 11):
    - Write target is WORKTREE-LOCAL: `$PWD/.claude/active-task.json`. Do NOT prefix with `$CLAUDE_PROJECT_DIR` — that variable was frozen at session start and points at the main checkout. The `resolve-project-root.sh` helper reads from the worktree's `.claude/`.
    - Schema:
      ```json
      {
        "taskId": "...", "taskName": "...",
        "epicId": "...", "epicName": "...",
        "versionId": null, "versionName": null,
        "branch": "feat/<slug>",
        "claimedAt": "ISO 8601",
        "claimToken": "<update-id from step 11>",
        "selfReviewPassed": false,
        "selfReviewPassedAt": null,
        "sprintId": "...", "unplanned": false,
        "subtasks": [
          {"id": "...", "name": "...", "status": "in_progress", "mondayStartedDate": "..."},
          {"id": "...", "name": "...", "status": "pending"}
        ]
      }
      ```
    - `claimToken` is REQUIRED by `task-state-guard.sh` — without it, the edit guard HARD BLOCKS all file edits. The token proves the task was claimed via MCP, not manually.
    - Optional fields written by later skills (do NOT initialize here; absence is the correct default state):
      - `parentStatus` — mirror of Monday parent status. Written by `/ship-pr` Phase 6.5 after the `Waiting for UAT` transition. Read by `stop-waiting-for-uat-stage` to avoid false-positives.
      - `mondayReconciledShas: []` — merge SHAs that have been reconciled to Monday. Appended by `/ship-pr` Phase 10 + `/babysit-prs` Phase 3 after `gh pr merge`. Read by `stop-monday-reconciled-check`.

13. Glob/Grep for related files.
14. Output context summary: task details, related files, subtask plan.

15. **Conditional claim-time re-plan** — invoke `/dev-tasks:plan-task` if ANY signal that subtask descriptions may have drifted:
    - Task entered `Ready to Start` ≥72h ago
    - ≥3 tasks have merged to `$defaultBase` since refinement
    - Subtask descriptions cite specific file paths / function names / schema fields
    - Task is regulatory / schema migration / public-API / payment flow
    - Follow-up to a previously-Stuck task

    Otherwise skip — re-planning is overhead for recently-refined mechanical tasks.

## Arguments

- `<task-id>` (optional): Monday task ID to claim directly. Otherwise show available tasks.

## Post-Conditions

- Task `In Progress` in Monday
- Task in active sprint (Unplanned? set if wasn't already there)
- First subtask `In Progress`
- Feature branch created, worktree entered
- TASK_CLAIMED posted (with sprint/unplanned info)
- `.claude/active-task.json` created with subtasks + `claimToken`
