---
name: babysit-prs
description: Orchestrator-side merge-polling loop for any PR the main session didn't push itself — subagent-produced PRs (most common), multi-agent fan-out (parallel subagents), or recovery from a prior session. Single-agent main-session work uses /ship-pr Phase 6.6 autonomous merge instead.
user_invocable: true
---

# /babysit-prs — Orchestrator PR Merge Loop

Read `.claude/project-config.json`. Extract `git.defaultBase` (PRs polled here) and `git.hotfixBase` (PRs here require human merge).

Subagents can't poll CI — they're one-shot. After a subagent runs `/ship-pr` and hands off, someone must handle the merge. That's this skill, run by the main session.

Three use cases per `.claude/rules/agent-autonomy.md`:
1. Subagent-produced PRs (most common): Task() subagent → `/ship-pr` → SendMessage handoff → main session runs `/babysit-prs`.
2. Multi-agent fan-out: N parallel subagents, each producing a PR. One polling loop.
3. Recovery from prior session: previous run ended before push reached merge state.

Single-agent main-session work uses `/ship-pr` Phase 6.6 autonomous merge — no `/babysit-prs` needed.

## When NOT to invoke

- Single-agent main-session work (use Phase 6.6 instead)
- Hotfix PRs targeting `$hotfixBase` (human merge per `release-flow.md`)
- About to end the session (leave open PRs for next orchestrator)

## Workflow

### Phase 1: Survey

1. `gh pr list --base $defaultBase --state open --json number,title,headRefName,updatedAt,mergeStateStatus`
2. Classify each:
   - `state=MERGED` → skip
   - `state=OPEN` + `mergeStateStatus=CLEAN` → ready to merge
   - `OPEN` + `UNSTABLE` → CI/checks in flight; inspect via `gh pr view {N} --json reviews,comments` (often = required-check missing rather than failed)
   - `OPEN` + `BLOCKED` → real CI failure or missing approval
   - `OPEN` + `DIRTY` → merge conflict; needs rebase
   - `OPEN` + `UNKNOWN` → recheck in 30s
3. Report one-line summary per PR.

### Phase 1b: Wait for configured reviewers (reviewer-wait gate)

Before evaluating merge readiness, wait for ALL configured review sources to have posted. This prevents the race condition where merge fires on CI-green before the Claude bot or Corridor even had time to analyze the PR.

1. Read configured sources from `project-config.json` → `review.sources[]` (default: `["claudeBot", "corridor", "selfReview"]`). For each source, define the expected signal:
   - `claudeBot`: a comment by `author.login == "claude"` containing `"## Code Review"`
   - `corridor`: Corridor findings returned by `getFindings` (even if empty — presence of response = posted)
   - `selfReview`: `selfReviewPassed: true` in active-task.json (set by the producing agent)
   - `vercelAgent`: a PR review by `author.login == "vercel[bot]"` or Vercel comment
   - `seer`: a PR or linked PR by `author.login == "sentry-io[bot]"`

2. For each PR at CLEAN: check which configured sources have NOT yet posted.

3. If any source is missing: wait up to `review.reviewerTimeoutSeconds` (default: 600s / 10 min), polling every 60s. Use the transition-only Monitor pattern (emit only on new-source-arrival).

4. **Timeout without all sources posting**: do NOT merge optimistically. Instead:
   - Log which source(s) are still silent
   - File a Retro (type: Improve) noting the reviewer timeout and the PR
   - Mark the PR as "reviewer-timeout — requires manual merge or re-run" in the sweep log
   - Continue to the next PR in the sweep

This gate fires BEFORE Phase 2's verdict check — a positive verdict from one source doesn't override the absence of another configured source.

### Phase 2: Merge sweep

For each PR that passed Phase 1b (all configured reviewers posted):

1. Verify review state via `gh pr view {N} --json comments` — latest `claude` author comment. Positive verdicts: "ship-ready", "ship as-is", "no BLOCKERs", "all checks pass", "Self-Review PASSED", "verdict: green", or 🟢. If BLOCKERs surfaced → Phase 2b.
2. Read PR body for Monday task ID: `gh pr view {N} --json body | grep "Monday\.com Task"`.
3. Ensure `reviewAddressed` is populated in the PR's worktree active-task.json (structured format preferred — see `/ship-pr` SKILL.md Phase 6 schema). If the producing agent used `"handoff-to-orchestrator"`, the orchestrator must now perform its own triage pass and write the structured `reviewAddressed` before merging. The `pre-merge-review-gate` hook enforces this.
4. Merge: `gh pr merge {N} --admin --squash`. NEVER `--delete-branch` — `gh` tries to delete the local tracking branch by switching cwd's checkout to `$defaultBase`, which fails with `fatal: '$defaultBase' is already used by worktree` and can corrupt the active task's branch state in a worktree session.
5. Local cleanup: `git fetch --prune origin`. Drops the stale ref. Safe from any worktree.
6. Capture merge SHA: `gh pr view {N} --json mergeCommit --jq .mergeCommit.oid`.

### Phase 2b: Handling BLOCKER findings

Triage per finding:

| Finding | Action |
|---|---|
| <10 lines, low-risk, single-file | Inline fix from orchestrator in `.claude/worktrees/feat-<slug>/` |
| Multi-file, requires tests, or > ~30min | Spawn fixup subagent via `Agent({ run_in_background: true })` with surgical brief |
| Genuinely incorrect Claude verdict | Decline via `gh pr comment {N} --body ...` |
| Architectural — needs human input | `TASK_STUCK` + SendMessage user OR file retro |

Inline-fix flow: cd to worktree → edit → quick sanity check → `git add . && git commit -m "fix: address round-N BLOCKER — <summary>"` → `git push` → re-arm Phase 6 Monitor for round N+1.

Fixup subagent: write a surgical prompt naming the worktree path, branch, PR, the BLOCKER excerpt, the fix directive, and standard rules (no `/pickup-task`, no merge, no full `/ship-pr` cycle — just fix + push + report). Spawn with `Agent({ subagent_type: 'general-purpose', run_in_background: true })`. Estimate 5–15 min.

After fixup pushes, re-arm Phase 6 Monitor for round N+1. Loop terminates when round-K is READY.

### Phase 3: Monday reconciliation

For each freshly-merged PR (if MCP up):

1. `getTask({ itemId: taskId, format: "json" })` — read state.
2. If `sprints` lacks active sprint: `updateTask({ itemId, sprintId: <active> })` (via `listSprints({ activeOnly: true })`).
3. Set missing links: `updateTask({ itemId, prLink, branch, githubLink, demoUrl })`.
4. If parent status not `Waiting for UAT`:
   - Missing UAT doc → `createTaskUatDoc({ taskId, markdown })` from PR body + AC
   - Flip subtasks Done via `manageSubtasks({ parentItemId, operations })` with `actualHours`
   - Monday automation auto-flips parent when all subtasks Done
5. Post `createUpdate({ itemId, body: HTML })` summarizing merge.
6. **Record the merge SHA as reconciled** (required when `stop-monday-reconciled-check` is enabled in the orchestrator session — else the hook fires at orchestrator session-end because merges landed without their SHAs appearing in `.claude/active-task.json` `mondayReconciledShas[]`). Emit the marker first, then append:
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/emit-state-marker.sh mondayReconciledShas
   ```
   Then append the SHA captured in Phase 2 step 6 to the orchestrator's own `.claude/active-task.json` `mondayReconciledShas[]` (initialize as `[]` if absent). The marker unlocks `protect-active-task-state` for this append. Subagent-driven worktree sessions don't need this — they're already removed in Phase 4.

MCP down: capture state inline as checklist; defer reconciliation; catch up immediately on recovery.

### Phase 4: Worktree cleanup (mandatory, not optional)

For each merged PR, run the canonical wrapper:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/post-merge-cleanup.sh <PR>
```

Wrapper does:
1. Resolves worktree path from PR's branch (`branch.replace('/', '-')` → `.claude/worktrees/<slug>`).
2. `git worktree remove --force <path>` (--force because remote branch deleted by merge).
3. Prints a checklist of remaining manual steps (createUpdate with merge SHA, verify demoUrl, manageSubtasks Done, SendMessage shutdown — Phase 5).

Resolves the consumer project root from `$CLAUDE_PROJECT_DIR` (Claude Code sets it at session start) so it works invoked from the plugin path.

Batch mode for retroactive cleanup of multiple DONE worktrees: `bash ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-audit.sh --remove -y`.

The full post-merge contract — what the orchestrator owes the Monday board for each merged PR (createUpdate, manageSubtasks, worktree-remove, SendMessage, demoUrl verify) — lives in [`agent-orchestration.md`](../../rules/agent-orchestration.md) "Orchestrator post-merge checklist". This Phase 4 is the mechanical wrapper; the rule is the spec.

### Phase 5: Agent shutdown

For each subagent whose PR merged: `SendMessage({ to: <agent>, message: { type: "shutdown_request", reason: "PR #{N} merged at {time}. Work complete." } })`.

### Phase 6: Continue or exit

More PRs/subagents pending → stay. Queue empty + no agents working → end session.

## Polling pattern

Use a `Monitor` that evaluates current state on first iteration (so an already-posted verdict is matched immediately) and continues watching for new comments. Match either the ship-ready predicates (READY → orchestrator merges) or BLOCKER predicates (BLOCKER → fix inline or send back). Also break on `state=MERGED`. Set `last_seen=""` on init — seeding it with the current latest makes the Monitor watch for a SECOND comment that may never come.

A wait condition that ignores current state and only watches future events is broken — always evaluate current state on first iteration. Don't wait for `mergeStateStatus=CLEAN` — it can be permanently UNSTABLE from secondary workflow noise.

See [`plugin/rules/monitor-predicate-pattern.md`](../../rules/monitor-predicate-pattern.md) for the two patterns that govern Monitor emission cadence (transition-only) + post-success action timing (act in the same response — don't narrate between Monitor returning and the merge call).

## Anti-patterns

- DO NOT use `gh pr merge --auto` — flaky against this repo's CI (UNSTABLE noise blocks auto-merge). Use `--admin --squash`.
- DO NOT merge PRs targeting `main` — hotfix PRs require human merge.
- DO NOT delete the worktree before merging — git refuses (branch checked out).
- DO NOT skip Monday reconciliation if MCP up — post-merge state is the audit trail.
- DO NOT batch reconciliation across MCP outage windows — catch up immediately on recovery.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `gh pr merge` "branch is checked out" | Worktree still has the branch | Force-remove worktree, then merge with admin |
| "PR already merged" | Status update lag from prior tick | Verify via `gh pr view --json state`; skip to reconciliation if MERGED |
| `updateTask` 404 on subtask IDs | Subtasks on different board | Use `manageSubtasks({ parentItemId, operations })` |
| Monday MCP "Server not found" | OAuth session switched | Defer; capture queue inline; retry on MCP recovery |
| CLEAN but `--admin` fails | Branch protection requires a check the agent didn't see | Check `gh pr checks {N}` for blocker; add via PR body edit |

## Output

Keep status lines short:
```
Sweeping PR queue (N open targeting staging):
  #283 feat/foo — CLEAN → merging
  #285 feat/bar — UNSTABLE (claude-review pending) → skipping
  #286 feat/baz — DIRTY (conflict) → escalating

Merged: #283 at {SHA}, Monday #2915513137 → Waiting for UAT
Next sweep: 5min, or when agent notifies
```

## Dispatching subagents

When the orchestrator spawns a fix-class subagent (the most common `/babysit-prs` precursor), use the canonical dispatch template:

```bash
cat ${CLAUDE_PLUGIN_ROOT}/templates/agent-dispatch-fix.md
```

Fill the placeholders (`<task-ID>`, `<task-name>`, `<branch>`, etc.) — keep the Anti-shortcuts + Hard-rules sections intact. The template enumerates the workflow-enforcement hooks the subagent will encounter so it doesn't discover them mid-implementation.

## Cross-references

- `/ship-pr` Phase 6.6 — main-session autonomous merge
- `.claude/rules/release-flow.md` — branching + merge policy
- `.claude/rules/task-lifecycle.md` — status transitions
- `.claude/scripts/worktree-audit.sh` — batch worktree cleanup
