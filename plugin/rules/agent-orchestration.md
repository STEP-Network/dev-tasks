# Agent Orchestration Workflow

> **Reference rule** — codifies how the main session (orchestrator) and
> spawned subagents share work, signal handoffs, and reconcile state on Monday
> after PRs merge. Loaded on demand via `rules-routing.json` when editing
> orchestrator code paths, hooks, or `/babysit-prs`.

**Companion**: [`agent-coordination.md`](agent-coordination.md) covers the
*Subagents vs Agent Teams* decision (when to use which coordination shape).
This rule covers the *orchestrator-side workflow* once you've chosen subagents.

## The shape of the loop

```
              ┌─────────────────┐
              │   Orchestrator  │ (main session)
              │                 │
              │  /pickup-task   │  per top-level task — claims, picks subagents,
              │  → spawn agents │  optionally hands off whole sub-trees
              │  → /babysit-prs │  central PR-merge polling + reconciliation
              └────────┬────────┘
                       │ Agent(prompt=...)
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
  ┌─────────┐    ┌─────────┐    ┌─────────┐
  │ Agent A │    │ Agent B │    │ Agent C │ (independent worktrees)
  │ worktree│    │ worktree│    │ worktree│
  │         │    │         │    │         │
  │ /pickup │    │ /pickup │    │ /pickup │ each agent claims its own task,
  │ → ship  │    │ → ship  │    │ → ship  │ creates a PR, hands off to orch.
  │ → handoff│   │ → handoff│   │ → handoff│
  └────┬────┘    └────┬────┘    └────┬────┘
       │              │              │
       └──────────────┴──────────────┘
                      │ SendMessage(orchestrator)
                      ▼
              orchestrator runs
              /babysit-prs cycle:
              CI poll → merge → reconcile
```

## Subagents never merge — orchestrator merges centrally

> **Scope**: this rule applies to **subagents only**. The main-session
> orchestrator still merges autonomously per `ship-pr` Phase 6.6 (`gh pr
> merge --admin --squash`) when CI is green + reviews addressed. The rule
> below is the contract for spawned subagents handing off to the orchestrator.

1. Subagent runs `/pickup-task → /self-review → /ship-pr`.
2. `/ship-pr` opens the PR + posts UAT doc + flips status to `Waiting for UAT`.
3. Subagent sets `reviewAddressed: 'handoff-to-orchestrator'` in
   `.claude/active-task.json` of its worktree.
4. Subagent calls `SendMessage(orchestrator, <PR URL + 1-paragraph summary>)`.
5. Subagent **stops** — does NOT run `gh pr merge`, does NOT wait for CI.
6. Orchestrator runs `/babysit-prs` cycle on every open PR (CI poll → merge →
   reconcile).

Why: silent-after-CI is a recurring failure mode (subagents lose context, die
mid-poll, or hit per-agent rate limits). Centralising the merge step in the
orchestrator removes the timing dependency and the per-agent "did CI pass yet?"
polling that often dies mid-flight.

## Orchestrator post-merge checklist

> **Non-optional.** Every time the orchestrator merges a subagent's PR, run
> all five steps in order. Source retro: PolAds UAT 2026-05-22 found 4 of 5
> PRs in a fan-out missed at least one step.

For each merged PR (one PR at a time):

1. **createUpdate on Monday with merge SHA**
   - Post a `createUpdate(itemId=<task>, body=...)` mentioning the merge SHA and
     the branch deleted. The Monday update IS the audit trail; a missing update
     means the task looks unmerged from Monday's perspective.

2. **manageSubtasks → Done with actualHours (if not already done)**
   - Subagents SHOULD have marked their own subtasks Done with `actualHours`
     before handoff. If they didn't (silent-after-CI variant where the agent
     died after PR open), do it post-merge from the orchestrator.
   - `manageSubtasks(parentItemId=<task>, operations=[{action:'update', subtaskId:..., status:'Done', actualHours: <best estimate>}])`.

3. **git worktree remove --force <worktree-path>**
   - Don't rely on the janitor. The worktree is dead weight after merge —
     `.claude/worktrees/feat-<slug>/` consumes disk + git book-keeping.
   - The wrapper `${CLAUDE_PLUGIN_ROOT}/scripts/post-merge-cleanup.sh <PR>` automates
     steps 3 + 4.

4. **SendMessage(agent, shutdown_request)**
   - Closes the agent process cleanly. Without this, the orchestrator stops
     seeing the agent's status updates but the process lingers.

5. **Verify task.demoUrl is set**
   - Soft check: read the Monday task post-update and confirm `demoUrl` exists.
     If the subagent's `/ship-pr` skipped the demoUrl set (a known failure
     mode), set it now via `updateTask(itemId=<task>, demoUrl=<preview URL>)`.
   - The `demo-url-required.sh` hook BLOCKS `updateTask(status='Waiting for UAT')`
     without a demoUrl (validated against `project-config.ci.previewUrlPattern`),
     so steps 1 + 5 together close the gap.

After running this checklist, the task is "delivered" from the orchestrator's
perspective. UAT runs on the consumer's UAT environment per their
`project-config.json` `environments.uat.url` + `autoMergePolicy`.

## Worktree discipline (mandatory)

> Hard-enforced by `worktree-required.sh` (PreToolUse Edit/Write) — edits to
> source files are blocked outside a worktree when a task is claimed.

- Each claimed task lives in its own worktree: `.claude/worktrees/<branch-with-slashes-as-dashes>`.
- `.claude/active-task.json` is **worktree-local**. The main checkout's copy is
  NOT shared.
- Two parallel claims on the same worktree path = collision → state file
  corruption. Don't.
- After merge: `git worktree remove --force <path>` (orchestrator post-merge
  checklist step 3).

If the orchestrator needs to inspect the worktree of an agent that hasn't
shut down yet, use `git worktree list` to find it; don't `cd` into it
(modifying state files there will trip the agent's hooks).

## Migration slot collisions (parallel agents)

When multiple subagents in parallel touch the same migration source (e.g.
schema files producing sequential migration files), they all run the
generator and produce a colliding slot. The first to merge wins; the others
must rebase + renumber.

Orchestrator-side mitigation:
- When dispatching parallel agents, check ahead which currently touch the
  schema source; either serialize them or warn each that they may need to
  rebase.
- The `/babysit-prs` merge-poll detects this when CI on the second-to-merge
  agent fails with "migration already exists at slot N" — re-dispatch with
  instructions to renumber.

## Sprint membership rule (claimTask gate)

`claimTask` refuses to claim tasks outside the active sprint. Always call
`updateTask(sprintId=<active>)` BEFORE `claimTask` if the task is in a
different sprint or unsprinted. The `/pickup-task` skill does this in Step 6
("Sprint auto-assignment"); the MCP also auto-pulls when the gate fires.

## Dependency semantics

A task's `dependencyIds` are cleared once the dependency reaches `Waiting for
UAT` (code on the integration branch), NOT when the dependency reaches `Done`
(released to prod). The autonomous loop + the MCP `claimTask` gate use the
looser definition so blocked-by relationships unblock as soon as the
prerequisite code merges.

When the orchestrator clears a dependency:

```ts
updateTask(itemId: <dependent>, dependencyIds: [])
```

The empty array clears the column explicitly. Omitting `dependencyIds` from
`updateTask` is a no-op (leaves the existing array untouched).

## Quality-over-speed loop integration

> Defines how the workflow-enforcement hooks
> (`refinement-gate`, `subtask-progress-gate`, `stop-waiting-for-uat-stage`,
> `stop-monday-reconciled-check`, `demo-url-required`) chain on top of the
> plugin's existing hooks. Ships in plugin v0.15.0+.

The full hook chain on a typical agent session:

```
PreToolUse (Edit/Write):
  plugin: task-state-guard → worktree-required → branch-task-match → subtask-reminder
  project (optional): consumer-specific guards

PreToolUse (Bash):
  plugin: bash-guard (gates a-e: destructive commands, commit, push, i18n)
  plugin (opt-in): subtask-progress-gate (only on `git push`)

PreToolUse (mcp__plugin_dev-tasks_dev-tasks__claimTask):
  plugin (opt-in): refinement-gate (bug-vs-task + type/priority/epic/desc/AC + subtask quality)

PreToolUse (mcp__plugin_dev-tasks_dev-tasks__updateTask):
  plugin: dev-tasks-update-guard (subtask-finished gate for Waiting for UAT)
  plugin (opt-in): demo-url-required (demoUrl mandatory + valid shape per project-config.ci.previewUrlPattern)

Stop:
  plugin: stop-task-check (stages 1-5: selfReview, PR, previewUrl, CI, reviewAddressed)
    └─ Stage 3 (previewUrl) is RELAXED under CI (GITHUB_ACTIONS/CI env): a CI
       runner has no Vercel access, so it can't obtain a preview URL. Logs a
       note + falls through to Stage 4 instead of blocking. Local/dev sessions
       still require a real previewUrl. Unblocks autonomous-loop CI sessions.
  plugin: stop-ci-green-check
  plugin (opt-in): stop-waiting-for-uat-stage (stage 6: parent at Waiting for UAT when subtasks all done)
  plugin (opt-in): stop-monday-reconciled-check (merged-PR has Monday update mentioning the SHA)
  third-party: Corridor blocks on open critical findings (if installed)
```

The workflow-enforcement hooks all support:
- Escape hatch via `reviewAddressed: 'handoff-to-orchestrator'` in `.claude/active-task.json`
  (orchestrator owns the missed step).
- Pass-through for legitimate flat-task cases (zero subtasks).
- Fail-open on JSON parse errors (don't block edits when state file corrupt).
- Opt-in per `project-config.json → hooks.enabled[]` — consumers enable
  individually based on their workflow shape.

## Protected state fields (`.claude/active-task.json`)

Every workflow-enforcement hook reads its decision from `.claude/active-task.json`.
An agent that writes the file directly can flip all of them — that's the bypass
vector the 2026-05-27 polads incident exploited (4 commits pushed directly to
staging, all gates skipped, by manually editing this file). The
`protect-active-task-state` hook closes the bypass at the local layer.

| Field | Bypass value | Marker (unlocks the write) | Emitted by |
|---|---|---|---|
| `selfReviewPassed` | `true` | `/tmp/.claude-state-marker-selfReviewPassed-<HEAD_SHA>` | `post-self-review.sh` on `Self-Review PASSED` in the self-reviewer subagent's output |
| `reviewAddressed` | any non-empty value | `/tmp/.claude-state-marker-reviewAddressed-<HEAD_SHA>` | `/ship-pr` Phase 6 (structured) or Phase 6.2 (handoff-to-orchestrator) |
| `parentStatus` | `"Waiting for UAT"` | `/tmp/.claude-state-marker-parentStatus-<HEAD_SHA>` | `/ship-pr` Phase 6.5 after the WfUAT transition succeeds |
| `mondayReconciledShas` | array grew (append) | `/tmp/.claude-state-marker-mondayReconciledShas-<HEAD_SHA>` | `/ship-pr` Phase 10 + `/babysit-prs` Phase 3 after `gh pr merge` succeeds |
| `allowMainCheckout` | `true` | **none — always blocked** | direct user authorization only |
| `ciGate` *(v0.26.0)* | changes to a value starting with `Skip` | `/tmp/.claude-state-marker-ciGate-<HEAD_SHA>` | `/pickup-task` step 12 (mirror a board-side Skip at claim) + `/ship-pr` Phase 2 step 6.3 (auto-skip after `ci-skip-eval.sh` ELIGIBLE). Reverting to `Full` needs no marker |

**Marker contract**:
- Markers are SHA-scoped — they unlock at the current `HEAD` only. New commits
  invalidate prior markers, so an old marker can't be reused after more code lands.
- Each marker unlocks ONE field. A `selfReviewPassed` marker doesn't unlock
  `reviewAddressed`.
- Skills emit markers via the canonical wrapper:
  ```bash
  bash ${CLAUDE_PLUGIN_ROOT}/scripts/emit-state-marker.sh <field>
  ```
- The plugin's lifecycle skills (`/self-review`, `/ship-pr`, `/babysit-prs`)
  already emit the right markers at the right phases — no agent action required
  unless the agent is writing a custom workflow.

**Honest caveat**: markers are bash files in `/tmp`. A determined agent can
emit them via Bash itself. This hook makes the bypass *visible* in the
transcript (the bash command is audited) and *inconvenient* (extra step). The
unforgeable complement is **server-side GitHub branch protection** on
`main`/`staging` — configured per-consumer-repo, not by the plugin. The
`bash-guard` gate (f) is the local complement: it hard-blocks `git push` to
any branch in `project-config.git.protectedBranches[]` (default:
`main, staging, master, production, prod`) regardless of marker state. Set the
list to `[]` to disable just gate (f); set to a custom list to restrict
protection to specific branches.

**Adopting in a consumer project**:
1. Add `protect-active-task-state` to `.claude/project-config.json →
   hooks.enabled[]`. Co-enable `post-self-review` in the same list — it is
   the sole emitter of the `selfReviewPassed` marker, so without it the agent
   cannot complete the self-review lifecycle (the user would have to manually
   set `selfReviewPassed: true` via direct file edit).
2. Set `git.protectedBranches[]` if the defaults need adjusting.
3. Configure GitHub branch protection on the same branches (one-time, per repo):
   ```bash
   gh api -X PUT repos/:owner/:repo/branches/main/protection \
     -f required_status_checks='{"strict":true,"contexts":[]}' \
     -F enforce_admins=true \
     -f required_pull_request_reviews='{"required_approving_review_count":1}' \
     -F restrictions=null
   ```
4. Off-ramp for emergencies: `allowMainCheckout: true` in the state file (set by
   the user via direct Edit, NOT by the agent — the hook explicitly blocks
   agent-set `allowMainCheckout` even with a marker present).

## When this rule is loaded

- Editing an `Agent(prompt=...)` dispatch from the orchestrator
- Editing any `.claude/hooks/*.sh` workflow-enforcement hook
- Editing the `/babysit-prs` skill's post-merge phase
- Any retro filing a workflow-enforcement gap

## History

- **2026-05-15**: codified the subagents-never-merge policy (per a downstream
  consumer retro).
- **2026-05-19**: codified the no-`--admin`-bypass-past-CI rule.
- **2026-05-22** (PolAds UAT retro): 5-agent fan-out exposed gaps in
  refinement-gate, log-progress, UAT doc creation, Monday reconciliation,
  worktree cleanup. Driver for the workflow-enforcement hook suite.
- **2026-05-24** (PolAds task #2938404391, PR #385): hooks first shipped as
  project-level in polads.eu. Migrated to plugin v0.15.0 (this rule + the
  hooks themselves).
- **2026-05-28** (Dev-Tasks Plugin task #2947098385): added `bash-guard` gate
  (f) (protected-branch push block) and the `protect-active-task-state`
  integrity hook. Driver: 2026-05-27 polads incident where an agent pushed
  4 commits directly to staging by manually editing `active-task.json` to
  set `selfReviewPassed: true`, `reviewAddressed: handoff-to-orchestrator`,
  `allowMainCheckout: true`. Plugin v0.16.0.
