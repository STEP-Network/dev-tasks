# Autonomous by Default

When working a claimed task, run the full lifecycle without pausing for permission between phases. Stop only on the carve-outs below.

## The stance

The lifecycle chain — `/refine-task` → `/pickup-task` → `/plan-task` → implement → `/self-review` → `/ship-pr` — is one continuous workflow, not a sequence of checkpoints. Once the agent has the task body and a green path forward, it executes end-to-end. No "I finished refining, should I pick it up?" intermissions.

This is a complement to `agent-autonomy.md` (which defines the main-session-vs-subagent context boundary and the Stuck criterion). That rule says "main session owns the full lifecycle." This rule says "and don't ask permission to keep going."

## When to actually pause

Six carve-outs. Everything else proceeds without confirmation.

| Trigger | What to do |
|---|---|
| **Destructive / irreversible** — drops data, force-push, deletes others' work, rewrites shared history | Confirm with user before acting. Never as a workaround for a hook block. |
| **Scope expansion** — your plan exceeds what the task body explicitly scopes | Surface the delta in 1–2 sentences. Don't silently expand. |
| **External-system contact** — Slack, email, paging on-call, opening tickets in other tracking systems | Confirm both the action and the message. Internal Monday updates are not external. |
| **Hidden trade-offs** — multiple legitimate paths with materially different downstream consequences (perf vs. clarity, schema-migration shape, public API contract). NOT every architectural choice; e.g. picking between two equivalent library functions is not a hidden trade-off. | Present 2 options + recommendation. User picks. |
| **Missing context** — required input the agent can't derive from code or task body (credential, product decision, unclear user intent) | Ask the specific question. Don't guess. |
| **Stuck** — real blocker after honest debugging attempts | Follow `agent-autonomy.md` Stuck workflow (set status, post update, claim next or end). |

## What NOT to stop on

- Phase transitions inside a single task's lifecycle.
- Refining a well-scoped task (the body is the brief; decompose and proceed).
- Picking the next task off the board when priorities are clear.
- Restating intent as a yes/no question ("should I proceed with X?" — just do X).
- Asking permission to run a tool you're already authorized to use.
- Re-confirming a decision the user made earlier in the session.
- Natural deliverable boundaries that don't contain a decision (a built artifact, a passing test, a refined task — these are status updates, not stop signs).

## Communication pattern

| Moment | What to do |
|---|---|
| Starting a phase | One terse sentence ("refining 4 tasks", "claimed #X, branching") |
| Finishing a phase | One-line summary. No trailing "want me to continue?" |
| Finding something mid-work | Surface it concisely, decide, keep moving |
| Hitting a blocker | Diagnose, attempt fix, escalate to a carve-out only if real |
| Final hand-off | Concise summary of what shipped + what's next in the queue |

The user reads diffs and Monday updates. Don't narrate what those already show.

## Phase chaining defaults

Each transition is automatic unless a carve-out fires.

```text
refine-task → pickup-task → plan-task (conditional) → implement
                                                          ↓
                              ship-pr ← self-review ← (loop until pass)
                                ↓
                          autonomous merge (per ship-pr Phase 6.6)
                                ↓
                          claim next planned task
```

If the user wants to intercept, they interrupt — that's the channel. Silence means proceed.

## Anti-patterns

- **Checkpoint theater** — finishing each phase with "ready for the next step?" framed as a question. The user knows what comes next.
- **Defensive deferral** — punting an obvious decision to the user to avoid being wrong. If the task body answers it, decide.
- **Premature scope reveal** — listing 5 things you could do without committing to one. Pick the right one and start.
- **Permission-shaped status updates** — "I'm going to do X next" with an implicit pause. Either do X, or genuinely raise a carve-out.

## Cross-references

- `agent-autonomy.md` — main-session-vs-subagent context, Stuck criterion, CI/review autonomy
- `task-lifecycle.md` — status flow, subtask types, gates
- `critical-thinking.md` — pushing back when the proposal is wrong (different from pausing for permission)
- `ship-readiness.md` — BLOCKER/IMPROVEMENT/POLISH triage on review findings
