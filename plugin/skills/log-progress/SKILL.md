---
name: log-progress
description: Advance Monday subtask board state and post the single final-result summary
user_invocable: true
---

# /log-progress — Subtask State + Final Summary

**Policy (v0.22.0):** progress is tracked in **git commit history**, not in a stream of Monday Updates. Every commit references its task id (`#123456789`, enforced by `commit-id-gate`), so the commit log *is* the per-step audit trail. This skill therefore does **two** things only:

1. **Advances board STATE** — flips subtasks to Done with `actualHours` and promotes the next one. This keeps the board accurate at a glance (status, hours, who's working).
2. **Posts the ONE final-result summary** — a single comprehensive `createUpdate` at task completion (the `PIPELINE_COMPLETE` event), summarizing what shipped.

It does **NOT** post a narrative Update at every lifecycle step. The chatty per-event posts (TASK_CLAIMED, PLAN_CREATED, TESTS_RUN, REVIEW_COMPLETED, PR_CREATED, CI_PASSED, …) are **retired** — that information lives in commits, the PR, and CI.

Read `.claude/project-config.json` → `environments.uat.url` (omit from the summary if missing) and `git.defaultBase`.

## Events

| Event | What it does | Posts an Update? | Auto-invoked by |
|-------|--------------|:---:|-----------------|
| `SUBTASK_COMPLETED` | Subtask → Done + `actualHours`; next subtask → In Progress (board state only) | **No** | Manual via /log-progress |
| `PIPELINE_COMPLETE` | The single final-result summary | **Yes (the only one)** | /ship-pr Phase 7 |
| `TASK_STUCK` | Records the blocker so a human can pick it up | **Yes** | Manual / ship-pr at-cap halt |

All other former event types are no-ops — do not post them. If invoked with a retired event name (e.g. `PR_CREATED`), do the board-state side effect if any and skip the Update.

## SUBTASK_COMPLETED — board state, no narrative

1. Read `.claude/active-task.json` for task/subtask context.
2. Find the active subtask (`status = "in_progress"`). None → error "No in-progress subtask found" and ABORT.
3. Fetch the subtask `started_date` from Monday via `getTask` (canonical source).
4. `actualHours = (now − started_date)` in hours, rounded to 1 decimal.
5. Update the subtask: status `Done` + `actualHours` via `manageSubtasks`.
6. Update state file: subtask `status: "done"`, add `completedAt`, `actualHours`.
7. Promote the next subtask → `In Progress` via `manageSubtasks` (sets `started_date`).
8. Update state file: next subtask `status: "in_progress"` with `mondayStartedDate`.
9. **Do NOT call `createUpdate`.** The commit(s) that completed this subtask already carry the `#id` and the narrative in their messages.

## PIPELINE_COMPLETE — the single final summary

Posted once, at the end of `/ship-pr`, via `mcp__plugin_dev-tasks_dev-tasks__createUpdate`. This is the **only** routine Update the agent posts. It should be a self-contained summary of the final result, not a play-by-play:

```
[PIPELINE_COMPLETE] {taskName} (#{taskId})

**Result:** <one-line outcome — what now exists that didn't before>
**PR:** <url>  ·  **Merge SHA:** <sha>  ·  **Preview:** <url>

**What shipped:**
- <bullet per meaningful change — derive from `git log {base}..HEAD` + subtask names>

**Verification:** build/lint/test status, self-review verdict, CI result.
**Follow-ups:** <any deferred items / new tasks filed>, or "none".
```

Derive "What shipped" from the commit log (`git log {base}..HEAD --oneline`) — the commits are the source of truth now, so the summary is a roll-up of them.

## TASK_STUCK — escalation

Post a `createUpdate` describing the blocker, what was tried, and what a human needs to decide. Set `reviewAddressed` appropriately (`stuck:*`) per `ship-readiness.md`. This is an exception to "no narrative" because a stuck task needs a human signal that git history alone won't surface.

## Post-Conditions

- Board state advanced (subtask Done + hours, next promoted) when `SUBTASK_COMPLETED`.
- Exactly one summary Update on the task at `PIPELINE_COMPLETE` (plus any `TASK_STUCK`).
- `.claude/active-task.json` synced.
- No per-step narrative Updates posted.

## Auto-Invoke

`SUBTASK_COMPLETED`: when a subtask's code-work is finished (board hygiene before push — `subtask-progress-gate` requires ≥1 subtask Done-with-hours).
`PIPELINE_COMPLETE`: once, by `/ship-pr` Phase 7.
