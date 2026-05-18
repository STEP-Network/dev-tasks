# Agent Autonomy

Codifies what an agent does autonomously vs. when it must stop. Branches on execution context.

## Execution context

Identify which context you're in before applying any policy.

| Context | Tool surface | Can poll CI? |
|---|---|---|
| **Main session** (persistent `claude` CLI) | All tools incl. `Monitor`, `run_in_background`. Cross-turn notifications. | Yes — autonomous merge. |
| **General-purpose subagent** (`Task(subagent_type: "general-purpose")`) | `*` (all tools). Single-turn. | Default to handoff unless prompt authorizes inline polling. |
| **Specialized subagent** (any other `Task(subagent_type: ...)`) | Constrained per agent's tool list; most lack `Monitor`. | No — hand off to main session. |

Self-check: if `Monitor` is not available, you are a specialized subagent — use handoff pattern.

## TL;DR by context

- **Main session**: owns full lifecycle from `/pickup-task` through merge to `$defaultBase`. Polls CI, fixes failures inline, addresses reviews, merges when clean, claims next planned task.
- **Specialized subagent**: works up to `/ship-pr` Phases 0–5 (PR open + pushed), then SendMessages main session with PR URL and ends.
- **General-purpose subagent**: main-session-like only if prompt explicitly authorized inline polling AND short CI window.

The only valid early exit is **Stuck** — for both contexts.

## What the main session always does autonomously

| Phase | Action |
|---|---|
| Pickup → implementation | `/pickup-task`, `/refine-task`, normal task flow |
| Self-review | `/self-review` until 10/10 PASS + Corridor BLOCKERs resolved |
| Push + PR | `/ship-pr` Phases 1–6 |
| Wait for CI | Poll `gh api workflow_runs` / `gh pr checks` until terminal |
| CI failure | Fetch log → diagnose → fix locally → re-push → loop |
| Wait for reviews | Poll Corridor + Vercel Agent + Claude bot per `ai-review-stack.md` |
| Review findings | Triage per `ship-readiness.md` (BLOCKER fix, IMPROVEMENT optional, POLISH decline) |
| Merge | `gh pr merge --admin --squash` (no `--delete-branch` per v0.8.2 — collides with worktrees) |
| Post-merge | `/ship-pr` Phase 10: clean state file, exit worktree, post Monday update |
| Next task | Claim next planned via `/pickup-task` if queued; else end session. |

## The Stuck criterion

`updateTask({ status: "Stuck" }) + createUpdate({ body: ... })` is reserved for situations requiring a **genuinely unforeseen, irreversible decision the agent has no authority to make** — regulatory interpretation, breaking-API choice the task didn't pre-authorize, scope explosion, security/compliance gap.

**Not Stuck** — resolve inline:

| Symptom | Treat as |
|---|---|
| CI failed (test, lint, build, schema) | Fix. 3 consecutive failures triggers build-failure-advisor "step back" nudge — heed but don't bail. |
| Review BLOCKER finding | Fix (escalate to Stuck only if irreversible decision required). |
| Test fixtures broken / DB unavailable / known infra flake | Acknowledge via `/tmp/.claude-ci-ack-<branch>` with one-line reason (per `stop-ci-green-check.sh`), proceed. |
| Hook block / missing env / stale state file | Read hook output, fix named field, retry. |
| Library version drift, schema migration conflicts | Fix in scope. |

When in doubt: **fix-and-retry**.

## Stuck workflow

1. `mcp__plugin_dev-tasks_dev-tasks__updateTask({ itemId, status: "Stuck" })`
2. `mcp__plugin_dev-tasks_dev-tasks__createUpdate({ itemId, body })` — what you tried, what you learned, specific decision needed, your concrete recommendation ("User must decide A vs B", not "I'm not sure").
3. If local queue exists, claim next via `/dev-tasks:pickup-task`; else end session.
4. Do NOT delete `.claude/active-task.json` until claiming a different task (overwrites) or ending session (then delete).

## Main session as orchestrator — delegate to subagents

The main session is the orchestrator with persistent state, `Monitor`, `Task` spawn. Heuristic: if work would flood context with intermediate results or could run in parallel, spawn a subagent.

| Work shape | Spawn subagent? | Which one |
|---|---|---|
| Codebase exploration | YES — context-flood guard | `dev-tasks:codebase-researcher` or `general-purpose` |
| Self-review of a diff | YES — anti-anchoring | `dev-tasks:self-reviewer` (via `/self-review`) |
| Doc updates triggered by diff | YES — focused, isolated | `dev-tasks:doc-updater` |
| Playwright E2E suites | YES — isolated test surface | `dev-tasks:e2e-tester` |
| N independent feature slices (no shared state) | YES, parallel | One subagent per slice |
| Bulk refactor across N independent files | YES, parallel | N subagents |
| Cross-cutting refactor (slices share state) | Consider Agent Teams — see `agent-coordination.md` | `TeamCreate` + lead + teammates |
| Quick single-file edit | NO — inline | — |
| Plan-mode brainstorm | NO — main session decides | — |
| Anything needing tools subagent lacks (Monitor for CI) | NO | — |

Concurrency: send all `Agent` tool calls in a single message for true parallelism. Worktree discipline: every source-editing subagent gets its own worktree (explicit `git worktree add`, `Agent({ isolation: "worktree" })`, or Team coordination). Cost discipline: subagents are not free — default to them for context-flood + parallelism, not trivial work. End-to-end ownership stays with the main session: subagents push and hand off; main session merges.

## When `/babysit-prs` applies

`/babysit-prs` is the canonical merge-polling loop for **anything the main session didn't push itself**: subagent-produced PRs, multi-agent fan-out, recovery from prior sessions. Single-agent main-session work uses `/ship-pr` Phase 6.6 autonomous merge instead.

## Interaction with other gates

The autonomy policy doesn't weaken any gate:

- `bash-guard.sh` (a) — no `git push --force`.
- `bash-guard.sh` (b) — self-review must pass before commit.
- `stop-ci-green-check.sh` — Stop blocks while CI not green.
- AI Review Stack — Corridor + Vercel Agent + Claude bot BLOCKERs must be resolved or POLISH-declined.
- `task-state-guard.sh` — Edit/Write requires `claimToken`.

Agent merges autonomously when ALL pass.
