---
name: pickup-task
description: Claim a Monday.com task, create feature branch, set up context
user_invocable: true
---

# /pickup-task — Claim and Start a Task

> **Source-file edits for a claimed task must happen in a git worktree**, not
> the main checkout. The `worktree-required.sh` PreToolUse hook hard-blocks
> edits to non-`.claude/` paths when an active task exists outside a worktree.
> See `worktree-discipline.md` for the rationale.
>
> Steps 1–4 below (fetch + validate) don't write any files — they're MCP-only,
> so they're free to run in the main checkout. Step 4.5 is where the worktree
> entry happens, after we know the real task name and can derive a meaningful
> slug. By the time step 9 (set first subtask "In Progress") writes anything,
> we're already in the worktree.

## Workflow

1. **Fetch available work**: Use `mcp__plugin_monday-task-flow_monday-tasks__getSprint` to get current sprint, or `mcp__plugin_monday-task-flow_monday-tasks__getBacklog` to see backlog items
2. **Show available tasks**: Display task list with IDs, names, status, and estimated hours
3. **User selects task** (or specify task ID as argument)
4. **Validate task readiness** (HARD BLOCK — must happen before claiming):
    - Fetch full task data via `mcp__plugin_monday-task-flow_monday-tasks__getTask` — read status, epic, dependencies.
    - **Status check** — `claimTask` only accepts tasks in `Ready to Start`:
      - If status is `Needs Refinement`: STOP here. The task lacks one or more of `type`/`priority`/`epicId`/`description`/`acceptanceCriteria`/≥1 typed-estimated subtask. Run `/refine-task <id>` first; the MCP gate will surface what's missing.
      - If status is `In Progress` and the current agent is `Claude Code CLI`: a session may already be active; check `.claude/active-task.json` before continuing.
      - If status is `In Progress` and a different agent owns it: STOP, pick a different task.
      - If status is `Done`/`Waiting for UAT`/`Pending Deploy to Prod`/`Stuck`: STOP, the task is past pickup phase.
    - **Epic check**:
      - **If task has an epic**: note the `epicId` and `epicName`, continue to step 4.5.
      - **If task has NO epic**: HARD BLOCK — do NOT claim until resolved:
        a. Call `mcp__plugin_monday-task-flow_monday-tasks__listEpics(product: "PolAds")` to show available epics.
        b. Try to match by task name/description keywords to an epic.
        c. If confident (>80% match): suggest the epic to user, proceed if confirmed.
        d. If not confident: ask user "This task has no epic. Which epic should it belong to?"
        e. Present epic list with IDs.
        f. After user selects: call `mcp__plugin_monday-task-flow_monday-tasks__updateTask(itemId, epicId: selectedEpicId)`.
        g. For hotfixes/bugs: suggest the product's Maintenance epic by default.
      - **NEVER claim a task without an epic. This is a hard requirement.**

4.5. **Enter the worktree** (HARD requirement — see top of skill for rationale):
    - Detect current location: if `git rev-parse --git-common-dir` equals
      `git rev-parse --git-dir`, you're in the main checkout. Otherwise (you're
      already in a worktree) skip this step.
    - Derive a slug from the task name: terse, hyphen-separated, max ~30 chars.
      e.g. task name "Add publisher sign-off workflow" → slug `publisher-signoff`.
    - Make sure the main checkout HEAD is on the right base (`staging` for
      default flow; `main` for hotfixes). If not, get on it: `git checkout staging
      && git pull --ff-only`.
    - Call `EnterWorktree({ name: "feat-<slug>" })` (or `hotfix-<slug>` for
      hotfixes). The worktree lands at `.claude/worktrees/feat-<slug>/` on
      branch `worktree-feat-<slug>` based off the current HEAD.
    - Verify with `pwd` — you should now be working under
      `.claude/worktrees/feat-<slug>/`.
    - **Skip ONLY if** you're already in a worktree, or the user authorized
      `"allowMainCheckout": true` for an emergency (document the reason in the
      task body).

4.6. **Dependency soft warning** (NON-BLOCKING — claimTask is the actual gate):
    - From the `getTask` response in step 4, read `dependencyIds` (column `dependency_mm0pwbxn`).
    - If empty: continue to step 5.
    - If non-empty: for each dependency, call `mcp__plugin_monday-task-flow_monday-tasks__getTask(dependencyId)` and check its status.
    - **If all dependencies are `Done`**: log "All N dependencies satisfied" and continue.
    - **If any dependency is NOT `Done`**: emit a clear warning naming the blocking task(s) and their statuses, then:
      - If the user accepts the risk and wants to continue: proceed — `claimTask` in step 6 will refuse with the same information, at which point the user can either wait for the blocker to clear or remove the dependency via `updateTask(itemId, dependencyIds: [])` (rare; only when the dependency was misfiled).
      - If the user wants to pick a different task: `ExitWorktree({ action: "remove" })` to clean up the worktree from step 4.5, then loop back to step 1.
    - This is a soft warning so a determined agent can override if context warrants. The MCP's `claimTask` is the hard gate.

5. **Version Suggestion** (proactive, NON-BLOCKING):
    - Call `mcp__plugin_monday-task-flow_monday-tasks__getEpic(epicId)` — check if epic has a Target Version
    - **If linked to a version**: note `versionId` and `versionName`, continue
    - **If NOT linked**:
      a. Call `mcp__plugin_monday-task-flow_monday-tasks__listVersions(group: "upcoming")` to find suitable versions
      b. Prefer "In Development" status, then nearest `expectedReleaseDate`
      c. If a suitable version exists:
         Ask user: "Epic '{epicName}' has no target version. Suggest: {versionName}. Link? (y/n/skip)"
         - If yes → `mcp__plugin_monday-task-flow_monday-tasks__updateVersion(versionId, linkEpicIds: [epicId])`
         - If skip → continue (Phase 8 of `/ship-pr` catches this later)
      d. If NO upcoming versions exist:
         - Compute the suggested next version via `computeBumpSuggestion` from `lib/services/version-bump.ts` (canonical implementation — handles the v1.0 milestone gate). Inputs: latest released (`listVersions(group: "released")` → highest, parsed via `parseSemVer`), the task list classified via `classifyTaskType()`, and `v1MilestoneReady` from `getEpic(2833952138)` + `getEpic(2738006659)`.
         - Ask: "No upcoming versions. Create v{result.next}? ({result.rationale}) (y/n/skip)"
         - If yes → `mcp__plugin_monday-task-flow_monday-tasks__createVersion(name, versionNumber, productId)` + link epic
         - If skip → continue
    - This is NON-BLOCKING: user can always skip
    - Store `versionId` and `versionName` in state file if linked
6. **Sprint auto-assignment** (MUST run before claim — claimTask refuses tasks outside the active sprint):
    - Use `mcp__plugin_monday-task-flow_monday-tasks__getTask` to check if the task already has a Sprint linked (`task_sprint` field)
    - Get the active sprint via `mcp__plugin_monday-task-flow_monday-tasks__getSprint` (no args = active sprint)
    - **If the task has NO sprint assigned:**
      a. Assign the task to the active sprint: `mcp__plugin_monday-task-flow_monday-tasks__updateTask` with `sprintId: <active sprint ID>`
      b. Mark as unplanned: `mcp__plugin_monday-task-flow_monday-tasks__updateTask` with `unplanned: true`
      c. Note in the TASK_CLAIMED event (step 11) that this was an unplanned addition
    - **If the task is already in the ACTIVE sprint:**
      a. Do nothing (planned work)
    - **If the task is in a DIFFERENT sprint (past or future):**
      a. Reassign to the active sprint: `mcp__plugin_monday-task-flow_monday-tasks__updateTask` with `sprintId: <active sprint ID>`
      b. Mark as unplanned: `mcp__plugin_monday-task-flow_monday-tasks__updateTask` with `unplanned: true`
      c. Note in the TASK_CLAIMED event (step 11): "Moved from sprint X to active sprint Y (unplanned)"
7. **Claim the task**: Use `mcp__plugin_monday-task-flow_monday-tasks__claimTask` to assign it. The MCP validates server-side:
    - Task status must be `Ready to Start` (step 4 already checked).
    - Task must be in the active sprint (step 6 above just ensured this).
    - All `dependencyIds` must be `Done` (step 4.6 already warned).
    - No other agent currently owns the task.
    - On rejection, `claimTask` returns a structured error naming the failing precondition — fix the named field via `updateTask`/`manageSubtasks` and retry.
8. **Set status**: claimTask in step 7 already set status to `In Progress` — this step is only needed if you bypassed claimTask (e.g., agent-id mismatch retry).
9. **Set first subtask to "In Progress"**: Use `mcp__plugin_monday-task-flow_monday-tasks__manageSubtasks` to start first subtask (this triggers `started_date` in Monday.com)
10. **Rename the worktree branch to project convention**:
    - Step 4.5's `EnterWorktree` created branch `worktree-feat-<slug>`. Rename it
      to the canonical `feat/<task-slug>` (or `hotfix/<slug>` for hotfixes — see
      Step 4.5's branching note): `git branch -M feat/<task-slug>`.
    - **If you skipped Step 4.5** (legacy / opt-out flow): `git fetch origin &&
      git checkout staging && git pull origin staging && git checkout -b feat/<task-slug>`.
      Hotfix exception: if the task is a hotfix (Bugfix type tagged
      "production-blocker" or similar), branch from `main` instead and PR to `main`.

10b. **Verify worktree-path ↔ branch convention** (traceability — see `worktree-discipline.md`):
    - Convention: `worktree_path = ".claude/worktrees/" + branch.replace("/", "-")`. The Monday Branch column (set by `/ship-pr` Phase 4) is the canonical link.
    - After the rename in step 10, verify: current worktree path basename equals the branch name with `/` → `-`.
      ```bash
      [ "$(basename "$PWD")" = "$(git branch --show-current | tr '/' '-')" ] && echo "convention OK" || echo "WARNING: worktree path does not match branch slug"
      ```
    - If the check fails, fix one of: rename the worktree directory, or rename the branch. The convention must hold so `${CLAUDE_PLUGIN_ROOT}/scripts/find-worktree-for-task.sh` and `worktree-audit.sh` can locate the worktree from the Monday task.
    - Reverse direction: `bash ${CLAUDE_PLUGIN_ROOT}/scripts/find-worktree-for-task.sh <monday-task-id>` prints the worktree path for any task whose Branch column is populated.
11. **Post TASK_CLAIMED event** (do this BEFORE creating state file — the response provides the `claimToken`):
    Use `mcp__plugin_monday-task-flow_monday-tasks__createUpdate` with structured format:
    ```
    [TASK_CLAIMED] Agent Progress Update
    Time: {ISO 8601} | Branch: feat/<task-slug>
    Event: Task claimed from sprint/backlog
    Sprint: {sprint name} {(UNPLANNED - auto-added to active sprint) if unplanned}
    Version: {versionName or "Not linked (will be resolved at /ship-pr Phase 8)"}
    Details: {subtask count} subtasks, ~{total estimated hours}h estimated
    ```
    **Save the returned update ID** — this becomes the `claimToken` in the state file.
12. **Create state file** (uses `claimToken` from step 11):
    - Fetch full task data via `mcp__plugin_monday-task-flow_monday-tasks__getTask` (includes subtask IDs, names, statuses)
    - Write `.claude/active-task.json` with structure:
      ```json
      {
        "taskId": "<monday-task-id>",
        "taskName": "<task name>",
        "epicId": "<epic-id>",
        "epicName": "<epic name>",
        "versionId": "<version-id or null>",
        "versionName": "<version name or null>",
        "branch": "feat/<task-slug>",
        "claimedAt": "<ISO 8601>",
        "claimToken": "<update-id-from-step-11>",
        "selfReviewPassed": false,
        "selfReviewPassedAt": null,
        "sprintId": "<sprint-id>",
        "unplanned": false,
        "subtasks": [
          {
            "id": "<subtask-id>",
            "name": "<subtask name>",
            "status": "in_progress",
            "mondayStartedDate": "<ISO 8601 from Monday.com started_date>"
          },
          {
            "id": "<subtask-id>",
            "name": "<subtask name>",
            "status": "pending"
          }
        ]
      }
      ```
    - **`claimToken`**: The Monday.com update ID from step 11 — **REQUIRED by task-state-guard.sh**.
      Without this token, the edit guard will HARD BLOCK all file edits. The token proves
      the task was claimed via the MCP tool, not by manually writing the state file.
    - First subtask: `"status": "in_progress"` with `mondayStartedDate` from Monday.com's `started_date`
    - All other subtasks: `"status": "pending"`
    - `versionId`/`versionName`: From Step 5 if epic was linked to a version, else `null`
    - `sprintId`: The active sprint ID the task is now assigned to
    - `unplanned`: true if the task was not already in the active sprint at pickup time
13. **Read related files**: Use Glob/Grep to find files related to the task
14. **Output context summary**: Show task details, related files, subtask plan

## Arguments

- `<task-id>` (optional): Monday.com task ID to claim directly
- If no ID provided, show available tasks for selection

## Post-Conditions

- Task status = "In Progress" in Monday.com
- Task assigned to active sprint (always), with "Unplanned?" checked if it wasn't already there
- First subtask status = "In Progress"
- Feature branch created and checked out
- TASK_CLAIMED event posted to Monday.com (includes sprint/unplanned info)
- `.claude/active-task.json` created with full subtask tracking data and `claimToken` from the TASK_CLAIMED update
