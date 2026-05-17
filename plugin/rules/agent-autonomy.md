# Agent Autonomy

> **STEP-wide policy.** Codifies what an agent does autonomously vs. when it must stop and ask. Supersedes the 2026-05-15 "agents never merge" handoff policy in `ship-pr.md` (preserved as a non-default escape hatch for multi-agent fan-out).

## TL;DR

The agent owns the FULL lifecycle of a claimed task — from `/pickup-task` through merge to `$defaultBase`. The agent polls CI, fixes failures inline, addresses reviews, merges when clean, claims the next planned task (or ends if none planned).

**The only valid early exit is "Stuck"** — and only for genuinely unforeseen, irreversible decisions the agent has no authority to make. CI failures, review BLOCKERs, broken tests, missing config — none of these are Stuck. They are problems the agent is expected to diagnose and resolve.

## What the agent always does autonomously

| Phase | Default action |
|---|---|
| Pickup → implementation | Per `/pickup-task`, `/refine-task`, normal task flow |
| Self-review | `/self-review` until 10/10 PASS + Corridor BLOCKERs resolved |
| Push + PR | `/ship-pr` Phases 1–6 |
| Wait for CI | Poll `gh api workflow_runs` / `gh pr checks` until terminal state |
| CI failure | Fetch failure log → diagnose → fix locally → re-push → loop |
| Wait for reviews | Poll Corridor + Vercel Agent + Claude bot per `ai-review-stack.md` |
| Review BLOCKER | Fix → re-push → loop |
| Review IMPROVEMENT | Fix if cheap, decline with classification otherwise |
| Review POLISH | Decline via `updateFindingState` / PR reply |
| Merge | `gh pr merge --admin --squash` (no `--delete-branch` per v0.8.2 — collides with worktrees) |
| Post-merge | `/ship-pr` Phase 10: clean state file, exit worktree, post Monday update |
| Next task | If a planned queue exists locally, claim the next one via `/pickup-task`. If not, end the session. |

## The Stuck criterion — the ONLY valid early exit

`updateTask({ status: "Stuck" }) + createUpdate({ body: ... })` is reserved for situations where progress requires a **genuinely unforeseen, irreversible decision the agent has no authority to make**. Concrete examples:

- A regulatory interpretation that wasn't anticipated in task creation (e.g. "this fix needs me to decide what counts as a 'transparent campaign' under EU Reg 2024/900 Article 3 — that's a human-judgment call").
- A breaking-API choice the task didn't pre-authorize (e.g. "to fix this, I'd have to remove a field that public-API consumers depend on — that needs sign-off").
- A scope explosion the task didn't anticipate (e.g. "the fix touches 4 unrelated systems; doing them all is a multi-sprint epic, not a task").
- A security/compliance gap that needs a stakeholder call (e.g. "this exposes PII through a path no existing rule covers").

**What is NOT Stuck:**

| Symptom | Treat as |
|---|---|
| CI failed (test, lint, build, schema) | Fix it. Diagnose the failure, edit, re-push, loop. Up to 3 consecutive failures triggers the build-failure-advisor "step back" nudge — heed it but don't bail. |
| Review BLOCKER finding | Fix it (or escalate to Stuck only if it requires an irreversible decision per above). |
| Test fixtures broken / DB unavailable / known infra flake | Acknowledge via `/tmp/.claude-ci-ack-<branch>` with one-line reason (per `stop-ci-green-check.sh`'s ack pattern), proceed. |
| Hook block / missing env / stale state file | Read the hook output, fix the named field, retry. |
| Library version drift, schema migration conflicts | Fix in scope — these are routine implementation work, not architectural calls. |

Confused which bucket? Bias toward **fix-and-retry**. Stuck is the brake for "I genuinely can't make this call without a human"; everything else is "I can resolve this with effort."

## Stuck workflow

1. `mcp__plugin_dev-tasks_dev-tasks__updateTask({ itemId, status: "Stuck" })`
2. `mcp__plugin_dev-tasks_dev-tasks__createUpdate({ itemId, body: HTML with: what you tried, what you learned, the specific decision needed, your recommendation })`
3. If a local task queue exists, claim the next one via `/dev-tasks:pickup-task`. Otherwise end the session.
4. Do NOT delete `.claude/active-task.json` until either you're claiming a different task (overwrites it) or you're ending the session (then delete).

The agent's recommendation in the Stuck update is load-bearing — make it concrete. "User must decide A vs B" is good. "I'm not sure how to proceed" is not.

## Why the policy reversed

The 2026-05-15 policy ("agents never merge — hand off to orchestrator") was a response to "silent-after-CI" failures where agents would `Stop` while CI was still pending. The structural fix at the time was to move polling to a separate orchestrator session (`/babysit-prs`).

Two things changed since:

1. `stop-ci-green-check.sh` now hard-blocks `Stop` when a push has happened and CI isn't green. The silent-after-CI failure mode is gated at the harness level — agents can't silently exit anymore.
2. Polling tools are reliable enough — `gh api workflow_runs` + the `until` bash idiom + `Monitor` background tasks all keep agents alive across the CI window without burning context.

The handoff pattern has real costs: context switch to a separate session, manual scheduling by the operator, state lost between sessions, multiple Monday updates that read as "in flight" until the orchestrator finishes. Removing those costs is worth more than the safety of "always have a second pair of human eyes on the merge button."

## When the orchestrator pattern still applies

`/babysit-prs` (the orchestrator skill) is preserved as a non-default escape hatch for **multi-agent fan-out**: a parent session spawning N parallel sub-agents that each produce a PR. Centralized merge polling makes sense there (one polling loop watches all N PRs).

For single-agent end-to-end work, default to autonomous merge per this rule.

## Interaction with other gates

The policy reversal doesn't weaken any gate:

- `bash-guard.sh` (b) — self-review must pass before commit. Unchanged.
- `bash-guard.sh` (a) — no `git push --force`. Unchanged.
- `stop-ci-green-check.sh` — Stop blocks while CI not green. Unchanged.
- AI Review Stack triage — Corridor + Vercel Agent + Claude bot findings must be resolved or POLISH-declined before merge. Unchanged.
- `task-state-guard.sh` — Edit/Write requires `claimToken`. Unchanged.

The agent merges autonomously when ALL of these pass. The policy change is "who runs the polling loop," not "what's allowed to merge."

## When this rule is loaded

- At session start when any `/pickup-task` is invoked.
- At `/ship-pr` Phase 6.
- When the agent considers `updateTask({ status: "Stuck" })`.
