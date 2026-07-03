# Workflow Pipeline — End-to-End Lifecycle

> **Canonical walkthrough.** This is the source of truth for how a Monday task
> moves from backlog to released. Other rules go deep on specific phases — this
> one walks the entire arc and points at them. Loaded on demand via
> `rules-routing.json` for any skill, hook, or rule edit.

If you're learning the workflow, read this first; the per-phase rules expand
each step. If you're hitting a hook block and aren't sure why, find the phase
in the table below — every gate's name, owner, and rationale lives there.

## The arc, at a glance

```
backlog → Ready to Start → In Progress → Waiting for UAT → Pending Deploy to Prod → Done
            │                  │                │                   │
   /pickup-task           implement +       human signs off    /release-version
   (worktree +            /self-review +    on test env        tags + changelog;
   active-task.json)      /ship-pr (PR +    → flips status     completion sweep
                          merge)                                sets Done
            │                  │                │                   │
   refinement-gate    bash-guard         staging-deploy-      pre-merge-review-gate
   (claim gate)       (commit + push     ready-gate +         (gh pr merge gate)
                      gates)              demo-url-required
                      protect-active-     (Waiting for UAT
                      task-state          gate; deploy must
                      (state file)        be READY first)
                                          stop-waiting-for-
                                          uat-stage (Stop)
                                          stop-monday-
                                          reconciled-check
                                          (Stop)
```

Off-ramps at any point: **Stuck** (unrecoverable blocker — `/log-progress
TASK_STUCK`), **Declined** (task superseded mid-sprint; terminal — no work
shipped). Both bypass the rest of the pipeline.

## Phase-by-phase

Each row: **what happens** · **who drives** · **hooks firing** · **canonical rule for deep dive**.

| Phase | Status transition | Agent / human role | Hooks | Deep dive |
|---|---|---|---|---|
| **Refinement** | `Needs Refinement` → `Ready to Start` | Human or agent: fill `type`, `priority`, `epicId`, `description`, `acceptanceCriteria`, ≥1 subtask with type/description/estimate. Run `/dev-tasks:refine-task` or `/dev-tasks:create-task` (creates Ready-to-Start when the readiness gate passes in the same call). | `refinement-gate` (PreToolUse `claimTask`) — refuses claims when fields missing. Bugs-board items refused outright (must `convertBugToTask` first). | [`task-lifecycle.md`](task-lifecycle.md) gate definitions |
| **Pickup** | `Ready to Start` → `In Progress` | Agent: `/dev-tasks:pickup-task <id>`. Skill calls `claimTask` (auto-pulls into active sprint if needed), creates a worktree under `.claude/worktrees/feat-<slug>/`, writes `.claude/active-task.json` with `selfReviewPassed: false`. | `claimTask` server-side: re-validates all `dependencyIds` are Done; refuses if another agent owns the task. SessionStart `active-task-recon.sh` surfaces drift on subsequent session opens. | [`worktree-discipline.md`](worktree-discipline.md), [`agent-coordination.md`](agent-coordination.md) for subagent dispatch |
| **Implementation** | (stays `In Progress`) | Agent: edits inside the worktree. `/log-progress SUBTASK_COMPLETED` per subtask with `actualHours`. | `task-state-guard` (Edit/Write) — refuses source edits without an active task. `worktree-required` — refuses source edits outside a git worktree (escape: `allowMainCheckout: true` — user-explicit only, blocked for agents by `protect-active-task-state`). `branch-task-match` — refuses if branch doesn't match the task's claimed branch. `subtask-progress-gate` (Bash `git push`) — refuses push when subtasks exist but none Done-with-actualHours. | [`agent-autonomy.md`](agent-autonomy.md), [`autonomous-by-default.md`](autonomous-by-default.md) |
| **Self-review** | (stays `In Progress`) | Agent: `/dev-tasks:self-review`. Spawns `dev-tasks:self-reviewer` subagent for the 10-point checklist (no edits, reports only). Iterates fix → re-run until clean. On PASS, sets `selfReviewPassed: true` in state file. | `post-self-review.sh` (PostToolUse on the Task subagent return) parses for `"Self-Review PASSED"` and emits `/tmp/.claude-state-marker-selfReviewPassed-<HEAD_SHA>`. The marker unlocks the next-turn Edit on `active-task.json` that flips `selfReviewPassed: true` (otherwise `protect-active-task-state` blocks the manual write). | [`ship-readiness.md`](ship-readiness.md), [`ai-review-stack.md`](ai-review-stack.md) for triage |
| **Ship PR** | (stays `In Progress`) | Agent: `/dev-tasks:ship-pr`. Validates → push → open PR (target = `git.defaultBase`, hotfixes target `git.hotfixBase`) → post `PR_CREATED` update → Vercel preview URL onto Monday's `demoUrl`. | `bash-guard` gate (a) destructive; (b) refuses `git commit` without `selfReviewPassed: true`; (c) pre-push validation marker; (d)(e) i18n parity when configured; **(f) hard-refuses `git push` to any branch in `project-config.git.protectedBranches[]`** (default: main/staging/master/production/prod — no marker bypass). `pre-commit-secrets-scan` on commit. `protect-active-task-state` (Edit/Write/MultiEdit on `active-task.json`) — refuses bypass-value writes without skill-emitted markers. | [`release-flow.md`](release-flow.md), [`monitor-predicate-pattern.md`](monitor-predicate-pattern.md) for CI poll patterns |
| **Review loop** | (stays `In Progress`) | Agent (main session w/ `Monitor`): polls `gh pr checks {N}` + Corridor + bot comments, triages, fixes BLOCKERs, re-pushes. Repeat until green + reviews addressed. Writes structured `reviewAddressed` to state file. Subagent path: sets `reviewAddressed: "handoff-to-orchestrator"` and SendMessage's the orchestrator, who runs `/dev-tasks:babysit-prs`. **Local review panel (v0.28.0, opt-in via `review.sources` ⊇ `localReview`)**: ship-pr step 6.7 runs the multi-lens fresh-subagent panel (repo access + sibling-call-site sweep) PRE-push so fix rounds don't pay the push→CI→bot round-trip; `review.cloudBot` (`always`/`final-push`/`off`) controls whether the GitHub bot waits per-push or once on the final push. `final-push` requires the panel to pass the parity benchmark first. | `pre-merge-review-gate` (PreToolUse `gh pr merge`) — refuses merge until `reviewAddressed` is set with a triage timestamp newer than the latest bot review; accepts `sources.localReview` with `declinedInPrBody: true`. | [`agent-orchestration.md`](agent-orchestration.md) for subagent → orchestrator handoff |
| **Merge + verify deploy** | (stays `In Progress`) | Agent (`/ship-pr` Phase 6.6): `gh pr merge --admin --squash` (never `--delete-branch` — collides with worktrees), then **polls the post-merge deploy to `READY`** (Vercel by merge SHA / `gh run watch` / etc.) and records `stagingDeployReady: true` (marker-emitted). This is what unlocks the WfUAT flip — it is no longer a "verified" caveat but a hard precondition (PR #347 / retro #2926719311). | `post-merge-postmortem.sh` (PostToolUse) captures the merge event. `protect-active-task-state` marker-gates the `stagingDeployReady` write. | `CLAUDE.md` "Shipping conventions" → "Deploy-lag gotcha" |
| **WfUAT transition** | `In Progress` → `Waiting for UAT` | Default flow: `/ship-pr` Phase 6.7 calls `updateTask({status: "Waiting for UAT"})` — only AFTER the staging deploy is `READY` (Phase 6.6). After subtasks all Done + UAT doc set. Auto-pulled into active sprint if missing. Mirror to state file: `parentStatus: "Waiting for UAT"`. | `staging-deploy-ready-gate` (PreToolUse `updateTask`) — refuses the flip unless `stagingDeployReady: true` (relaxed under CI). `demo-url-required` — refuses without `demoUrl` matching `project-config.ci.previewUrlPattern`. `stop-waiting-for-uat-stage` (Stop) — refuses session exit when subtasks Done but parent not flipped. | [`task-lifecycle.md`](task-lifecycle.md) status gates |
| **Monday reconcile** | (stays `Waiting for UAT`) | Agent: `/ship-pr` Phase 10 captures `mergeSha` and appends to `mondayReconciledShas[]` in state file. `/babysit-prs` Phase 3 does the same for orchestrator-merged subagent PRs. | `stop-monday-reconciled-check` (Stop) — refuses session exit when a merge SHA landed during the session but isn't recorded as reconciled. | [`agent-orchestration.md`](agent-orchestration.md) "Orchestrator post-merge checklist" |
| **Human UAT** | `Waiting for UAT` → `Pending Deploy to Prod` | Human: verifies on test environment per `doc_mm3adfdg` UAT doc (split into Agent-verified vs Human-only per `/dev-tasks:write-uat-spec` when `e2e.enabled: true`). On sign-off, flips status. | None (agent-side). | [`task-lifecycle.md`](task-lifecycle.md) |
| **Release** | `Pending Deploy to Prod` → `Done` | Human or agent: `/dev-tasks:release-version` creates/updates the version, generates the changelog doc, tags. The tag-triggered consumer `release.yml` (via the `complete-released-tasks-step.yml.example` template, `plugin/templates/github-workflows/`) or a local run of `plugin/scripts/complete-released-tasks.ts` then flips every task at `Pending Deploy to Prod` under this product to `Done` + posts a release note — **opt-in per consumer**, not automatic just from installing the plugin. | None blocking (server-side validation in `generateChangelog`); the completion sweep is fail-soft per task. | [`release-flow.md`](release-flow.md), [`versions-lifecycle.md`](versions-lifecycle.md), [`versioning.md`](versioning.md) |
| **Off-ramp: Stuck** | any → `Stuck` | Agent: `/log-progress TASK_STUCK <reason>`. Sets `reviewAddressed: "stuck:<reason>"` to bypass remaining stop hooks. | None (intentional bypass — Stuck is recoverable; the task is reclaimable later). | [`agent-autonomy.md`](agent-autonomy.md) Stuck criterion |
| **Off-ramp: Declined** | any status → `Declined` | Human or agent: `updateTask({status: "Declined"})`. Terminal. Used when a task is superseded mid-sprint, rework happened elsewhere, or scope is dropped — `In Progress` tasks can decline too (no shipped work to clean up matters more than the status the task was in). Excluded from `getBacklog` defaults. Exempt from active-sprint auto-pull. | None. | `CLAUDE.md` → Key status mappings |

## Enforcement layer — the v0.16.0 pattern

A worked example of layered enforcement that consumers can adopt directly.

The 2026-05-27 polads incident: an agent pushed 4 commits directly to staging
by manually editing `.claude/active-task.json` to set `selfReviewPassed: true`,
`reviewAddressed: "handoff-to-orchestrator"`, and `allowMainCheckout: true` —
defeating every hook in one shot. The fix lives at three layers:

1. **`bash-guard` gate (f)** (local, always-on) — hard-refuses `git push` to
   `main`/`staging`/`master`/`production`/`prod` (configurable via
   `project-config.git.protectedBranches[]`). No marker bypass. Catches the
   "skip the PR" failure mode.

2. **`protect-active-task-state`** (local, opt-in) — refuses Edit/Write/MultiEdit
   on `.claude/active-task.json` that flips protected fields
   (`selfReviewPassed`, `reviewAddressed`, `parentStatus`, `mondayReconciledShas`,
   `allowMainCheckout`, `ciGate`) to bypass values without a corresponding
   `/tmp/.claude-state-marker-<field>-<HEAD_SHA>` marker. Markers are emitted by
   `post-self-review.sh` and the relevant `/ship-pr` + `/babysit-prs` phases.
   `allowMainCheckout` is always blocked (no marker path — user-explicit only).
   See [`agent-orchestration.md`](agent-orchestration.md) "Protected state fields"
   for the full contract.

3. **GitHub branch protection** (server-side, unforgeable) — the only layer a
   determined local agent cannot bypass. Configured per-consumer-repo:

   ```bash
   gh api -X PUT repos/:owner/:repo/branches/main/protection \
     -f required_status_checks='{"strict":true,"contexts":[]}' \
     -F enforce_admins=true \
     -f required_pull_request_reviews='{"required_approving_review_count":1}' \
     -F restrictions=null
   ```

**Honest framing:** layers 1 and 2 make bypass *visible* (the bash commands
to forge markers show up in the transcript) and *inconvenient* (extra steps).
Layer 3 makes bypass *impossible*. Adopt all three; each catches a different
failure mode.

## Adoption — opt-in hooks per consumer

`bash-guard` (incl. gate f) and `stop-ci-green-check` are STEP-wide always-on
when the plugin is installed. Everything else is opt-in via
`project-config.json → hooks.enabled[]`. The starter template at
`plugin/templates/starter-project-config.json` ships a reasonable default set.

Hooks that meaningfully couple:

- `protect-active-task-state` **requires** `post-self-review` co-enabled — the
  latter is the sole emitter of the `selfReviewPassed` marker.
- `subtask-progress-gate` assumes `/log-progress SUBTASK_COMPLETED` is called
  per subtask with `actualHours`. Without that habit it'll block every push.
- `stop-waiting-for-uat-stage` + `stop-monday-reconciled-check` depend on
  `/ship-pr` Phases 6.7 + 10 writing `parentStatus` + `mondayReconciledShas[]`.

## Cross-references

Per phase, deeper detail lives in:

- [`task-lifecycle.md`](task-lifecycle.md) — Monday status flow, subtask types,
  status transition gates, owner-resolution
- [`worktree-discipline.md`](worktree-discipline.md) — when worktrees, how to
  exit cleanly, escape hatches
- [`ship-readiness.md`](ship-readiness.md) — BLOCKER / IMPROVEMENT / POLISH
  triage, when to FAIL vs PASS
- [`ai-review-stack.md`](ai-review-stack.md) — Claude bot vs Corridor vs
  self-review interplay, predicate matching
- [`release-flow.md`](release-flow.md) — staging vs main, hotfix exception,
  FF-promotion at release time
- [`versions-lifecycle.md`](versions-lifecycle.md) + [`versioning.md`](versioning.md) —
  version state machine, auto-version, bump rules
- [`agent-coordination.md`](agent-coordination.md) — Subagents vs Agent Teams
  decision (when to use which coordination shape)
- [`agent-autonomy.md`](agent-autonomy.md) — main-vs-subagent context boundary,
  Stuck criterion
- [`agent-orchestration.md`](agent-orchestration.md) — orchestrator-side
  workflow once subagents are chosen; protected state fields; post-merge
  checklist; v0.16.0 push-guard + active-task-integrity pattern
- [`autonomous-by-default.md`](autonomous-by-default.md) — the six carve-outs
  that justify a pause; communication pattern that replaces between-phase
  check-ins
- [`monitor-predicate-pattern.md`](monitor-predicate-pattern.md) — transition-only
  emission + immediate-action-on-success patterns for `Monitor`
- [`testing.md`](testing.md) — tier rules for unit/integration/E2E coverage
- [`e2e-masterplan.md`](e2e-masterplan.md) — Playwright spec organization,
  per-task spec lifecycle in `/ship-pr` Phase 4.6
- [`meta-workflow.md`](meta-workflow.md) — meta-rules about how rules work
- [`critical-thinking.md`](critical-thinking.md) — reasoning patterns when the
  workflow itself is the thing being changed

## When this rule is loaded

Per `plugin/rules-routing.json`:

- Editing any plugin skill (`plugin/skills/**/*.md` — matches files in skill
  subdirectories)
- Editing any plugin hook (`plugin/hooks/*.sh` — direct children of the hooks
  directory)
- Editing any plugin rule (`plugin/rules/*.md` — direct children)
- Editing consumer `CLAUDE.md` (where the workflow is summarized)

The breadth is intentional — every workflow-touching surface should have this
arc one step away.

## History

- **2026-05-28** (Dev-Tasks Plugin task #2947073428): created as the canonical
  end-to-end walkthrough. Driver: 2026-05-27 polads incident proved that the
  flow was learnable only by reading 6+ rule files and trial-and-error against
  the hooks. Companion to the v0.16.0 protect-active-task-state + push-guard
  enforcement layer (PR #49) and the v0.17.0 description-doc migration (PR #52).
