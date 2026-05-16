---
name: babysit-prs
description: Persistent orchestrator-side loop that polls open PRs targeting staging, merges them when CLEAN, and reconciles Monday state. Use in main session whenever subagents have open PRs awaiting merge.
user_invocable: true
---

# /babysit-prs — Orchestrator PR Merge Loop

> **Overlay**: if `.claude/skills/babysit-prs/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific instructions (extend-only — overlay can append checks/steps but cannot replace plugin behavior).

## Project context (read FIRST)

Read `.claude/project-config.json`. Extract `git.defaultBase` (integration branch; this skill polls PRs targeting it) and `git.hotfixBase` (production branch; hotfix PRs go there and require human merge). Wherever this skill says `staging` in `gh pr list --base`, substitute `$defaultBase`.

## Why this skill exists

Effective 2026-05-15, agents NEVER call `gh pr merge` (see `/ship-pr` Phase 6.6).
The silent-after-CI failure pattern — agents go idle waiting on CI events their
tool loop can't observe — bit us across ≥6 Sprint 10 agents. The fix: agents
push + open PR + SendMessage orchestrator. Orchestrator (this skill) handles
all merging + Monday reconciliation in one persistent loop.

This skill is the orchestrator-side counterpart to `/ship-pr`. Run it whenever
you have ≥1 subagent with an open PR awaiting merge.

## When to invoke

- After spawning subagents that will produce PRs (run it once they've reported back with PR URLs)
- Periodically during a multi-agent fan-out to keep the merge queue moving
- When you notice `gh pr list --base staging --state open` is non-empty

## When NOT to invoke

- For hotfix PRs targeting `main` — those require human merge per `.claude/rules/release-flow.md`
- If you're about to end the session — leave open PRs for the next orchestrator session to pick up

## Workflow

### Phase 1: Survey

1. `gh pr list --base staging --state open --json number,title,headRefName,updatedAt,mergeStateStatus` — get all open PRs to staging
2. For each PR, classify:
   - `state=MERGED` → already merged (skip)
   - `state=OPEN` + `mergeStateStatus=CLEAN` → ready to merge
   - `state=OPEN` + `mergeStateStatus=UNSTABLE` → CI in flight or pending checks; investigate via `gh pr view {N} --json reviews,comments` to see if it's actually ready (UNSTABLE often = required-check missing rather than failed)
   - `state=OPEN` + `mergeStateStatus=BLOCKED` → real CI failure or missing review approval; needs investigation
   - `state=OPEN` + `mergeStateStatus=DIRTY` → merge conflict; needs the agent to rebase or orchestrator to fix
   - `state=OPEN` + `mergeStateStatus=UNKNOWN` → GitHub hasn't computed yet; recheck in 30s
3. Report the queue to the user with a one-line summary per PR.

### Phase 2: Merge sweep

For each PR at CLEAN (or UNSTABLE-but-actually-ready per the round-N Claude review verdict):

1. **Verify review state** — `gh pr view {N} --json comments` and check the latest `claude` author comment. Expect "ship-ready" or "no BLOCKERs" verdict. If round-N surfaced new BLOCKERs, see **Phase 2b** below (handling BLOCKER findings).
2. **Read PR body for Monday task ID** — `gh pr view {N} --json body | grep "Monday\.com Task"`. Extract task ID.
3. **Merge**: `gh pr merge {N} --admin --squash` (omit `--delete-branch` from main checkout — branch deletion will hit "branch in use" if any worktree still has it checked out; instead delete worktree first via Phase 4, or let the auto-worktree-cleanup handle it later).
4. **Capture merge SHA**: `gh pr view {N} --json mergeCommit --jq .mergeCommit.oid`.

### Phase 2b: Handling BLOCKER findings (review iteration)

Under the new policy, agents push + hand off without waiting for review. ALL review iteration happens here. When the Claude review surfaces a 🔴 BLOCKER, triage and act:

**Decision tree per finding**:

| Finding | Action | Tool |
|---|---|---|
| <10 lines, low-risk, single-file, well-specified | Fix inline from orchestrator session | `Edit` directly in the worktree at `.claude/worktrees/feat-<slug>/` |
| Multi-file, requires tests, or > ~30min work | Spawn fixup subagent | `Agent({ run_in_background: true })` with a surgical brief (see "Fixup subagent template" below) |
| Genuinely incorrect Claude verdict | Decline with PR reply explaining classification | `gh pr comment {N} --body "..."`  |
| Architectural — needs human input | Post `TASK_STUCK` + ping user | SendMessage user OR file a follow-up retro |

The PR #286 BotID-fix is the reference for the fixup-subagent pattern — that agent did 4-line wiring + push in ~8 minutes. Anything that small can be inline-fixed from orchestrator.

**Inline-fix flow** (orchestrator session):
1. `cd .claude/worktrees/feat-<slug>` (the worktree from the agent's prior push)
2. Edit the file(s)
3. `pnpm self-review` is not available cross-worktree — just check the change is sane visually + run any quick tests inline
4. `git add . && git commit -m "fix: address round-N BLOCKER — <summary>"` then `git push`
5. Re-arm the Phase 6 Monitor for round N+1 review

**Fixup subagent template**:
```
You are sa-fixup-pr-{N} addressing one BLOCKER from round-N Claude review.

Worktree (already exists): .claude/worktrees/feat-<slug>
Branch: feat/<slug>
PR: #{N}

The BLOCKER: [verbatim review excerpt]

The fix: [specific 1-3 line directive]

Workflow:
1. cd to the worktree
2. Make the edit
3. /self-review until passed
4. Commit + push (NOT gh pr merge)
5. SendMessage team-lead when pushed

Standard rules apply: no /pickup-task, no merge, no /ship-pr full cycle —
just the fix + push + report.
```

Spawn with `Agent({ subagent_type: 'general-purpose', run_in_background: true, prompt: <template above> })`. Estimate 5-15 min per fixup.

After the fixup pushes, re-arm the Phase 6 Monitor for the round-N+1 review. Loop terminates when round-K is `READY`.

### Phase 3: Monday reconciliation

For each freshly-merged PR (if `mcp__plugin_dev-tasks_dev-tasks__*` MCP is up):

1. `mcp__plugin_dev-tasks_dev-tasks__getTask({ itemId: taskId, format: "json" })` — read current state
2. If `sprints` doesn't include the active sprint, move it: `updateTask({ itemId, sprintId: <active> })` (use `listSprints({ activeOnly: true })` to discover)
3. Set links: `updateTask({ itemId, prLink, branch, githubLink, demoUrl })` if any are missing
4. If parent status is not `Waiting for UAT`:
   - If UAT doc missing → `createTaskUatDoc({ taskId, markdown: ... })` (build from PR body + AC)
   - Flip subtasks to Done via `manageSubtasks({ parentItemId, operations: [...] })` with actualHours
   - Monday automation auto-flips parent to `Waiting for UAT` when all subtasks Done
5. Post update via `createUpdate({ itemId, body: HTML })` summarizing merge

If the MCP is down (user is logged into a different Claude.ai user, etc.):
- Capture all the state inline as a checklist in chat
- Defer reconciliation until MCP recovers — note the queue in a planning doc

### Phase 4: Worktree cleanup

For each merged PR:
1. Identify worktree path from branch convention: `branch.replace('/', '-')` → `.claude/worktrees/feat-<slug>`
2. `git worktree remove --force <path>` — `--force` because the worktree's local branch was deleted by the merge
3. `git branch -D <branch>` (cleans up the orphaned local branch)

Or batch: `bash .claude/scripts/worktree-audit.sh --remove -y` cleans every DONE worktree at once.

### Phase 5: Agent shutdown

For each subagent whose PR just merged (still showing idle pings):
- `SendMessage({ to: <agent>, message: { type: "shutdown_request", reason: "PR #{N} merged at {time}. Work complete. Thanks." } })`
- Don't worry about cleanup beyond that — the harness handles agent process termination

### Phase 6: Continue loop or exit

- If more PRs are pending OR more subagents are still working: stay in main session, check back periodically
- If queue is empty AND no more agent work coming in: end the session normally

## Polling cadence

When actively babysitting (subagents still working):
- Don't `sleep` between calls — use a Monitor that emits on every new Claude review comment, OR just respond to teammate notifications as they arrive

### CORRECT wait pattern (single-PR, after agent reports "PR pushed")

```bash
# Monitor evaluates CURRENT state on first iteration, then continues to watch
# for new review comments. Exits on first match of the verdict predicates —
# whether the review is already there at startup OR lands later.
Monitor(
  description: "PR #{N} review state on {branch}",
  timeout_ms: 1800000,
  command: 'PR={N}
    # last_seen=""  on purpose — first iteration will always evaluate the
    # current latest comment. If a ship-ready verdict is ALREADY posted at
    # Monitor-arm time, we exit immediately rather than sitting forever
    # waiting for a future event that never comes.
    last_seen=""
    while true; do
      cur=$(gh pr view "$PR" --json comments --jq "[.comments[] | select(.author.login==\"claude\")] | last | .createdAt // \"\"")
      if [ -n "$cur" ] && [ "$cur" != "$last_seen" ]; then
        body=$(gh pr view "$PR" --json comments --jq "[.comments[] | select(.author.login==\"claude\")] | last | .body")
        if echo "$body" | grep -qiE "ship-ready|no BLOCKERs|verdict.*green|🟢"; then
          echo "READY: $cur"
          break
        elif echo "$body" | grep -qiE "🔴 BLOCKER|BLOCKER —"; then
          echo "BLOCKER: $cur"
          break
        fi
        last_seen=$cur
      fi
      state=$(gh pr view "$PR" --json state --jq .state 2>/dev/null || echo "")
      if [ "$state" = "MERGED" ]; then
        echo "MERGED"
        break
      fi
      sleep 30
    done'
)
```

The monitor exits cleanly on either signal — `READY` (orchestrator merges) or `BLOCKER` (orchestrator either fixes inline or sends agent back). No "wait for CLEAN" — that condition never fires on this repo due to persistent `ci.yml`/`release.yml` UNSTABLE noise.

**Why `last_seen=""` instead of seeding it with the current latest**: if the Claude review verdict has ALREADY posted between agent push and orchestrator Monitor-arm (often the case — review takes ~3-5 min, agent's UAT/Monday flow takes ~5-10 min), seeding `last_seen` to the existing review makes the Monitor watch for a SECOND review that will never come. With `last_seen=""`, the first loop iteration always evaluates the current latest body — matches the predicate and exits in ≤30s.

### Anti-patterns (DO NOT do these)

```bash
# ❌ WRONG #1 — waits forever because mergeStateStatus is permanently UNSTABLE
until [ "$(gh pr view {N} --json mergeStateStatus -q .mergeStateStatus)" = "CLEAN" ]; do
  sleep 60
done
```

```bash
# ❌ WRONG #2 — seeds last_seen with current latest comment, then waits for a
# NEW comment that never comes if the verdict was already posted at startup.
last_seen=$(gh pr view "$PR" --json comments --jq "[.comments[] | select(.author.login==\"claude\")] | last | .createdAt // \"\"")
while true; do
  cur=$(...)
  if [ "$cur" != "$last_seen" ]; then ...
```

Both bugs bit the orchestrator on PRs #286 + #288 (2026-05-15) — anti-pattern #1 hit first (waiting on CLEAN that never fires), then anti-pattern #2 (seeded last_seen, missed the already-posted verdict). General principle: **a wait condition that ignores the current state and only watches future events is broken** — always evaluate current state on first iteration.

### When agent reports "PR opened, awaiting CI"
- The agent already did all the work it can. Don't ping them again.
- Arm the Monitor pattern above (or just check `gh pr view {N} --json comments` directly after ~3-5 min for CI + Claude review to settle).
- Inspect the latest Claude review body. If "ship-ready" / "no BLOCKERs" → merge with `gh pr merge {N} --admin --squash`. If new BLOCKER → fix inline OR SendMessage agent (if alive) OR spawn a small fixup subagent.

## Anti-patterns

- DO NOT use `gh pr merge --auto`. It's flaky against the repo's CI workflow setup — `mergeStateStatus: UNSTABLE` from secondary workflow noise keeps auto-merge from firing. Use `--admin --squash` explicitly.
- DO NOT merge PRs targeting `main`. Hotfix PRs need human merge (`.claude/rules/release-flow.md`).
- DO NOT delete the worktree before merging the PR — git refuses (branch is checked out). Merge first, then clean.
- DO NOT skip the Monday reconciliation if the MCP is up. The post-merge state — sprint, links, UAT doc, status — is the audit trail. Reconcile every time.
- DO NOT batch reconciliation across MCP outage windows by waiting hours. Once MCP recovers, immediately catch up on every merged-but-not-reconciled PR.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `gh pr merge` exits non-zero with "branch is checked out" | Worktree still has the branch | Force-remove worktree first, then merge with admin flag |
| `gh pr merge` says "PR already merged" | Successful merge from prior tick, just status updates lagged | Verify via `gh pr view --json state` — if MERGED, skip to reconciliation |
| `updateTask` 404 on subtask IDs | Subtasks live on a different Monday board than parent | Use `manageSubtasks({ parentItemId, operations })` instead — the subtask MCP knows the layout |
| Monday MCP returns "Server not found" | User OAuth session for claude.ai switched | Defer reconciliation, capture queue inline, retry on MCP recovery |
| PR at CLEAN but `gh pr merge --admin` fails | Branch protection requires status checks the agent didn't see (e.g. version-check.yml requires Monday task ID in PR body) | Check `gh pr checks {N}` for actual blocking check; add missing input via PR body edit |

## Output format

When sweeping, log to chat:

```
Sweeping PR queue (N open targeting staging):
  #283 feat/target-signoff-date — CLEAN → merging
  #285 feat/publisher-in-app-signoff — UNSTABLE (claude-review pending) → skipping this tick
  #286 feat/some-other-work — DIRTY (merge conflict) → escalating to agent

Merged: #283 at {SHA}, Monday #2915513137 → Waiting for UAT
Worktree cleaned: .claude/worktrees/feat-target-signoff-date

Next sweep: 5min, or when agent notifies
```

Keep status lines short. The user runs Opus 4.7 with max thinking — they don't want walls of text.

## Cross-references

- `/ship-pr` Phase 6.6 — the agent-side counterpart (push + handoff, NO merge)
- `.claude/rules/release-flow.md` — branching + merge policy (staging-as-base, hotfix exception)
- `.claude/rules/task-lifecycle.md` — Monday status transitions (Waiting for UAT requires UAT doc + all subtasks Done)
- `.claude/scripts/worktree-audit.sh` — batch worktree cleanup helper
- Memory `[[concise-responses]]` — user wants short status updates, not exhaustive summaries
- Memory `[[silent-after-ci-pattern]]` — the root cause this skill exists to solve
