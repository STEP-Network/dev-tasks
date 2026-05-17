# Agent Autonomy

> **STEP-wide policy.** Codifies what an agent does autonomously vs. when it must stop and ask. The policy branches on execution context — main-session vs subagent — because the two have fundamentally different tool surfaces.

## Execution context — the load-bearing distinction

**Identify which context you're in BEFORE applying any policy below.**

| Context | What it is | Tool surface | Can it poll CI? |
|---|---|---|---|
| **Main Claude Code session** | The persistent `claude` CLI process the operator launched. | All tools, including `Monitor`, `run_in_background`, `ScheduleWakeup`. Receives notifications across turns. | **Yes** — autonomous merge per this rule. |
| **General-purpose subagent** | Spawned via `Task(subagent_type: "general-purpose")`. | `*` (all tools). Single-turn execution. | Limited — single-turn means no cross-turn polling. Default to handoff unless the subagent's prompt explicitly authorizes inline polling. |
| **Specialized subagent** | Spawned via `Task(subagent_type: "<name>")` for any other type (codebase-researcher, self-reviewer, doc-updater, etc.). | Constrained per the agent's tool list — most lack `Monitor`, `run_in_background`. | **No** — must hand off to main session for any post-push work. |

**Quick self-check**: if `Monitor` is not in your available tools, you are a specialized subagent. Use the handoff pattern. If `Monitor` is available AND you're a persistent session (not a Task() invocation), use autonomous merge.

## TL;DR by context

**Main session** (the default operator workflow):

The agent owns the FULL lifecycle of a claimed task — from `/pickup-task` through merge to `$defaultBase`. Polls CI, fixes failures inline, addresses reviews, merges when clean, claims the next planned task (or ends if none planned).

**Specialized subagent** (Task-spawned, no Monitor):

The subagent does work up to "PR open + pushed" (`/ship-pr` Phases 0–5). It then SendMessages the main session with the PR URL and ends. Main session handles all CI polling, review triage, and merging — either inline (autonomous merge per main-session policy) or via `/babysit-prs` if multiple subagents have open PRs.

**General-purpose subagent**:

Treat as main-session-like only if the parent's prompt explicitly authorized inline polling AND the subagent doesn't actually need `Monitor` (e.g., short CI windows). Otherwise default to the handoff pattern.

**The only valid early exit is "Stuck"** — applies to BOTH contexts. Reserved for genuinely unforeseen, irreversible decisions the agent has no authority to make. CI failures, review BLOCKERs, broken tests, missing config — none of these are Stuck. They are problems the agent is expected to diagnose and resolve. (For subagents that hit Stuck post-push, post the Stuck update + SendMessage main session with context; do not attempt to fix CI inline.)

## What the main session always does autonomously

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

## Main session as orchestrator — be diligent with subagents

The main session isn't just "the one that merges." It's the **orchestrator** — the entity with persistent state, `Monitor`, `Task` spawn, and the full tool surface. Use it. Don't grind through work serially when subagent delegation is the right shape.

Default heuristic: **if a piece of work would flood your context with intermediate results or could plausibly run in parallel with other pieces, spawn a subagent for it.** Specific patterns:

| Work shape | Spawn subagent? | Which one |
|---|---|---|
| Codebase exploration (mapping data flow, finding all usages, "where is X handled") | YES — context-flood guard | `dev-tasks:codebase-researcher` or `general-purpose` |
| Self-review of a diff | YES — explicit anti-anchoring | `dev-tasks:self-reviewer` (via `/self-review` skill) |
| Doc updates triggered by diff | YES — focused, isolated | `dev-tasks:doc-updater` |
| Running Playwright E2E suites | YES — isolated test surface | `dev-tasks:e2e-tester` |
| N independent feature slices that share no state | YES, in parallel | One subagent per slice — main session orchestrates merge order |
| Bulk refactor across N files where each file is independent | YES, in parallel | N subagents, one per file/area |
| Cross-cutting refactor where slices share state (contract changes propagating to consumers) | Consider Agent Teams (see `agent-coordination.md`) | TeamCreate + lead + N teammates |
| Quick single-file edit | NO — just do it inline | — |
| Plan-mode brainstorm | NO — main session decides | Use `Plan` mode or `EnterPlanMode` if available |
| Anything requiring tools the subagent doesn't have (e.g. Monitor for CI) | NO — main session does it | — |

**Concurrency**: when spawning multiple subagents that are genuinely independent, **send all `Agent` tool calls in a single message** (the harness runs them concurrently). Sequential spawning serializes work that could be parallel.

**Worktree discipline**: every subagent doing source edits gets its own worktree. Either explicit (`git worktree add` in the brief), or `Agent({ isolation: "worktree" })`, or an Agent Team where coordination is explicit. Don't let two subagents race on the same `.claude/active-task.json`.

**When in doubt, read `agent-coordination.md`** — it has the subagents-vs-Agent-Teams decision matrix + sizing guidance + anti-patterns (e.g., don't spawn a Team for tightly-coupled work that would collide on the same files).

**Cost discipline**: subagents are not free. Each is a full Claude instance (or Haiku-routed for cheap delegation). Default to subagents for context-flood and parallelism, not for trivial work you could do inline in 2 tool calls.

**End-to-end ownership stays with the main session**: subagents push PRs and hand off; the main session merges (autonomously per `/ship-pr` Phase 6.6, or via `/babysit-prs` when multiple subagent PRs are in flight).

## When the orchestrator pattern (`/babysit-prs`) still applies

`/babysit-prs` is the canonical merge-polling loop for **anything the main session didn't push itself**:

1. **Subagent-produced PRs**: any time the main session spawned a Task(...) subagent that did `/ship-pr` and handed off. The subagent can't poll CI; main session runs `/babysit-prs` to merge once clean.
2. **Multi-agent fan-out**: parent session spawning N parallel subagents, each producing a PR. One polling loop watches all N PRs from the main session.
3. **Recovery from prior session**: if a previous main-session run ended before its push reached merge state (rare under v0.8.9 policy — `stop-ci-green-check.sh` blocks the early Stop — but possible if the operator force-killed).

For single-agent main-session end-to-end work, default to autonomous merge per `/ship-pr` Phase 6.6. No need to invoke `/babysit-prs` separately.

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
