---
name: ship-pr
description: Build, lint, test, validate schema, push, and create/update PR
user_invocable: true
---

# /ship-pr — Ship Changes (Pre-Push + PR)

Read `.claude/project-config.json`. Extract `git.defaultBase`, `git.hotfixBase`, `monday.productId`, `monday.v1MilestoneEpicIds`, `environments.uat.url`. Substitute `$defaultBase` / `$hotfixBase` wherever this skill references `staging` / `main`. Projects without a separate staging branch set both to the same branch; FF-promotion in `/release-version` becomes a no-op.

## Workflow

### Phase 0: Task & Review Verification
1. Read `.claude/active-task.json`. Missing → BLOCK, run `/pickup-task` first.
2. Verify `selfReviewPassed: true`. Missing/false → BLOCK, run `/self-review`.
3. Any subtask `status: "in_progress"` → PROMPT to run `/log-progress SUBTASK_COMPLETED`.
4. All `done` subtasks must have `actualHours`. Missing → PROMPT.

### Phase 1: Validation
1. `pnpm build` — must pass
2. `pnpm lint` — must pass
3. `pnpm test` — must pass
4. `pnpm playwright test` — must pass (if UI/flow changes)
5. `pnpm validate-schema --env testing` (if migration files touched)
6. Migrations: do NOT auto-apply to production. Consult consumer's `.claude/rules/database.md`. Generic pattern: apply locally during dev → ship migration on the PR → CI/CD applies to staging on merge → `/release-version` applies to production at release time.

### Phase 2: Push Gate
5. `touch /tmp/.claude-prepush-$(git rev-parse --abbrev-ref HEAD | tr '/' '-')` — allows `bash-guard.sh` to permit push.
6. Stage and commit if uncommitted changes exist.
7. `git push -u origin {branch}`.

### Phase 3: PR Management
8. `gh pr view --json number,url` — capture PR number/URL if exists.
9. Determine PR base: default `$defaultBase`; if branch's merge-base with `origin/$hotfixBase` is more recent than with `origin/$defaultBase`, use `$hotfixBase` (hotfix exception).
10. If no PR exists: `gh pr create --base <base> --title ... --body ...` with body including `Monday.com Task: #{taskId}` (CI version-check requires this), Epic, Version, pre-push checklist, test plan. `--base` MUST be explicit.
11. If PR exists (re-push): reset `selfReviewPassed: false`; run `/self-review` again; then push.

### Phase 4: Preview URL (hard-enforced by stop hook)

12. Wait for Vercel deployment via `mcp__vercel__list_deployments` filtered by `meta.githubCommitRef`. Retry up to 3× with 30s delay.

13. Post to Monday via `mcp__plugin_dev-tasks_dev-tasks__updateTask` with `itemId`, `demoUrl` (column `link_mm0mtyf4`), `prLink` (column `link_mm0m817p`), `branch` (column `text_mm0pvs3n`), `githubLink` (derive from `git remote get-url origin`, strip `.git`, append `/tree/<branch>` — column `link`). The `Waiting for UAT` gate (Phase 6.5) warns but doesn't block if any are missing.

14. Persist to `.claude/active-task.json`: `previewUrl` + `prUrl`. Stop hook blocks session end if `previewUrl` missing.

### Phase 4.5: UAT Doc Generation (default flow only; hotfix skips)

14a. If PR base is `$hotfixBase` → skip to Phase 5.

14b. Generate UAT doc covering preview URL, AC checklist, edge states, cross-cutting checks (i18n, mobile, empty/error/loading, auth paths if relevant), out-of-scope notes, sign-off checklist.

14c. Persist via `createTaskUatDoc({ taskId, markdown })`. On "already exists" error, call `updateTaskUatDoc({ taskId, markdown, overwrite: true })`. Doc lands on column `doc_mm3adfdg`.

14d. Post `/log-progress UAT_DOC_GENERATED`.

### Phase 5: Monday.com Event Update
15. Post via `/log-progress`: `PR_CREATED` (new PR) or `REVIEW_FEEDBACK_FIXED` (existing PR).

### Phase 6: CI + Review Polling (main session) or Handoff (subagent)

Branch on execution context per `.claude/rules/agent-autonomy.md`. Quick check: is `Monitor` in your tool surface?

**Subagent handoff path** (no `Monitor`):
1. PR pushed (Phases 2–3).
2. Set `reviewAddressed: "handoff-to-orchestrator"` in state file (escape-hatch for `stop-task-check.sh` and `stop-ci-green-check.sh`).
3. SendMessage main session with PR URL + state summary.
4. Trigger Phase 10 cleanup. End.

**Autonomous merge path** (main session, has `Monitor`):
1. Poll CI via a `Monitor` that watches `gh pr checks {prNumber}` and emits terminal transitions. Restart the Monitor on each new push — stale events from previous commit confuse triage. See [`monitor-predicate-pattern.md`](../../rules/monitor-predicate-pattern.md) for transition-only emission + immediate-action-on-success patterns.
2. Poll Corridor findings via `mcp__plugin_corridor_corridor__getFindings({ cwd, branch, state: "open", excludeAIFalsePositives: true })`. Retry up to 3× with 60s delay if empty.
3. Triage findings (GitHub bot review + Corridor) per `ship-readiness.md` (BLOCKER / IMPROVEMENT / POLISH).
4. Record triage decisions to `reviewTriage` in state file.
5. For Corridor declines: call `mcp__plugin_corridor_corridor__updateFindingState({ findingId, state: "closed", closedReasonCategory, closedReason })`.
6. Loop: fix BLOCKERs + cheap IMPROVEMENTs → re-push → restart Monitors → re-poll Corridor → re-triage. No round cap; regression-loop escalation if 3 consecutive rounds introduce new BLOCKERs.
7. Set `reviewAddressed`: `"accepted"` (all POLISH), `"fixed"` (loop terminated), `"stuck:regression-loop"`, or `"timeout:{reason}"`.
8. Merge via `gh pr merge --admin --squash` (NEVER `--delete-branch` — collides with worktrees).

**Hotfix exception (both paths)**: PRs targeting `$hotfixBase` require human merge. Stop at "CI green + reviews addressed" with a final update.

**Stuck is the only valid early exit** (per `agent-autonomy.md`). CI failures / review BLOCKERs / known flakes are NOT Stuck — diagnose and fix.

**CI flake exception**: `Test`/`Playwright E2E: fail` alone can be a pre-existing flake — verify against staging HEAD before treating as BLOCKER.

**Stop hook gates**: `stop-task-check.sh` requires `reviewAddressed` set; `stop-ci-green-check.sh` requires CI green or the escape-hatch value.

### Phase 6.5: Transition task → `Waiting for UAT` (default flow only; hotfix skips)

20a. If PR base is `$hotfixBase` → skip to Phase 7.

20b. Verify gate prereqs (the MCP enforces server-side):
- All subtasks `done` with `actualHours`.
- UAT doc set on `doc_mm3adfdg` (re-run Phase 4.5 if absent).
- `demoUrl`, `prLink`, `branch`, `githubLink` set on task.

20c. `mcp__plugin_dev-tasks_dev-tasks__updateTask({ itemId: taskId, status: "Waiting for UAT" })`. On rejection, fix the named field and retry.

### Phase 6.6: Autonomous merge (default-flow PRs)

20d. Preconditions: base is `$defaultBase`; CI all-green (or failures acked via `/tmp/.claude-ci-ack-<branch>`); review BLOCKERs resolved.

20e. `gh pr merge {N} --admin --squash` — NEVER `--delete-branch` (collides with worktrees + main checkout).

20f. Verify: `gh pr view {N} --json state --jq .state` returns `"MERGED"`. If `"OPEN"`, diagnose via `gh pr view {N} --json mergeStateStatus,mergeable`.

20g. Hotfix exception: skip merge — human merges `$hotfixBase` PRs.

20h. Continue to Phase 10.

20i. `/log-progress TASK_WAITING_FOR_UAT` with UAT doc location, preview URL, test instructions.

### Phase 7: Monday.com Update + Completion

22. Refresh preview URL via `mcp__vercel__list_deployments`; update `previewUrl` in state + `demoUrl` on Monday if changed.

23. Post `[PIPELINE_COMPLETE] Agent Progress Update` via `createUpdate` with PR URL, preview URL, CI status, `reviewAddressed` value.

24. `/log-progress PIPELINE_COMPLETE`.

### Phase 8: Version Linkage Check (informational)

25. Read `taskId` from state file. Call `getTask` and inspect `targetVersion`. If set, log; if unset, `auto-version.ts` writes it server-side on the `Waiting for UAT` transition. Per `versions-lifecycle.md`, versions are historical — no action needed here.

25b. Update structured Release Summary on the linked version (after version is confirmed). Read current via `getVersion(versionId)`. Map task type to 3-cat: Development → `feature`; Bugfix → `fix`; Maintenance / Refine / Documentation / PM-work → `improvement`. Use `Public Task Name` (column `text_mm349ah6`) if set, else internal name. Parse existing JSON via `parseStructuredChangelog` (auto-migrates legacy 4-cat). Add task to bucket. Update `progress`. Wrap in `STRUCTURED_CHANGELOG_V1` markers. Write via `updateVersion(versionId, releaseSummary)`.

**Auto-bump check** (non-blocking): if `versionNumber` empty AND ≥1 task linked, gather inputs (latest released, tasks classified via `classifyTaskType()`, `v1MilestoneReady` = all `$v1MilestoneEpicIds` epics `Done`), call `computeBumpSuggestion(input)`, log `result.next` + `result.rationale` + `result.gatedByMilestone`. Actual assignment happens at `/release-version`.

### Phase 9: User Acceptance Testing Handoff

26. Generate acceptance testing checklist from git diff (`git diff <base>...HEAD --stat`) + subtask names. Group by feature area; each item is specific, complete, actionable, with URLs.

27. Present to user as `## Acceptance Testing Checklist — PR #{N}` with grouped checkboxes and preview URL.

28. Post the same (HTML-formatted) via `createUpdate` on the task.

### Phase 10: Post-Merge Task Completion

Default flow: parent already at `Waiting for UAT` from Phase 6.5. Phase 10 cleans up; `Done` is set by the release ceremony.
Hotfix flow: parent still at `In Progress`. Phase 10 sets `Done` directly.

30. Post-merge sequence (order matters for `allowMainCheckout: true` — `gh pr merge` switches to `$defaultBase` and deletes local branch):
    1. Mark remaining subtasks `Done` via `manageSubtasks` (MCP call — no Edit/Write hook).
    2. `gh pr merge --admin --squash` (no `--delete-branch`).
    3. Immediately `rm .claude/active-task.json` — BEFORE any Edit/Write.
    4. Post final updates via `createUpdate`.
    
    In worktree sessions, `ExitWorktree({ action: "remove" })` in step 31 deletes the state file implicitly.
    
    Read PR base via `gh pr view --json baseRefName --jq .baseRefName`:
    - `$defaultBase`: leave task at `Waiting for UAT`. Post `[TASK_COMPLETED]` update noting next transitions (Waiting for UAT → Pending Deploy to Prod by human; Pending Deploy to Prod → Done by `/release-version`).
    - `$hotfixBase`: `updateTask({status: "Done"})`. Post `[TASK_COMPLETED]` noting hotfix verified on prod.

31. Worktree cleanup: if `git rev-parse --git-common-dir` differs from `git rev-parse --git-dir`, call `ExitWorktree({ action: "remove" })`. If refused (uncommitted/unreachable), inspect leftovers, commit/stash, then `ExitWorktree({ action: "remove", discard_changes: true })` only with user confirmation.

### Phase 11: Claim next planned task

Per `agent-autonomy.md`, after merge + cleanup the agent does NOT stop unless: no planned next task, OR Stuck condition + no follow-up queued, OR operator said "end after this one". Otherwise invoke `/dev-tasks:pickup-task <next-task-id>`.

## Failure Handling

- Build/lint/test fails → show error, do NOT push, do NOT set marker.
- CI fails → fix and re-push.
- Regression loop (3 consecutive rounds introducing new BLOCKERs) → `TASK_STUCK`, `reviewAddressed: "stuck:regression-loop"`, alert user.
- 3 consecutive failures any stage → `/log-progress TASK_STUCK`.
- Vercel deployment not found after 3 retries → warn but post PR URL to Monday.

## Post-Conditions

- Pre-push marker at `/tmp/.claude-prepush-{branch}`.
- Push, PR created/updated.
- Preview URL on Monday (`demoUrl` / `link_mm0mtyf4`) and in `.claude/active-task.json` (`previewUrl`) — hard-enforced by stop hook.
- `reviewAddressed` persisted — hard-enforced.
- CI at terminal state.
- UAT doc on `doc_mm3adfdg` (default flow).
- Task at `Waiting for UAT` (default) or `Done` (hotfix).
- Autonomous merge done (default; hotfix awaits human).
- State file removed; worktree removed.

## Stop Hook Enforcement

`stop-task-logic.py` 4-stage gate when source files changed:
1. `selfReviewPassed: true`
2. PR exists
3. `previewUrl` exists in state file
4. `reviewAddressed` exists in state file

Valid `reviewAddressed`: `"accepted"`, `"fixed"`, `"stuck:regression-loop"`, `"timeout:{reason}"`.
