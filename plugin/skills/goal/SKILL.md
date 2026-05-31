---
name: goal
description: Set, show, or clear a PERSISTENT session goal (a natural-language completion condition). The stop-goal-persistence Stop hook then refuses to let the agent stop while the goal is unmet — killing premature "I think the session is too long/laggy" halts. Mirrors Claude Code's built-in /goal, but persistent across the whole session via a marker the plugin hook reads.
user_invocable: true
---

# /goal — Persistent session completion condition

## What this is

A project-agnostic, **persistent** version of Claude Code's built-in `/goal`
(v2.1.139+, https://code.claude.com/docs/en/goal). The built-in `/goal` sets a
completion CONDITION; after each turn a fast model evaluates it against the
transcript; if not met the agent keeps working (the reason is fed back as
guidance) instead of returning control; when met the goal clears. Mechanically
it is a session-scoped, prompt-based Stop hook.

This skill is the plugin's durable analogue. It writes the condition to a
marker file (`.claude/active-goal.json`); the registered Stop hook
`stop-goal-persistence` reads that marker on **every** Stop and:

- **unmet** → BLOCKS the stop (exit 2) and feeds back a "keep working — `<next
  step>`" message, so the agent continues;
- **met** → clears the marker and allows the stop.

### Why it exists — the failure mode it kills

Agents in autonomous mode sometimes stop PREMATURELY because they *think* the
session is "too long", "context-bloated", or "laggy" while real session-scoped
work still remains. **That is never a valid reason to stop.** Context
auto-compacts (pre/post-compaction hooks preserve state across summarization),
and durable state lives in Monday + memory + the open PR + git history. A long
or laggy-feeling session is not a finished session.

The only legitimate reasons to stop are the **3 pause reasons** (see
`autonomous-by-default.md`):

1. **External blocker** — waiting on a system/person you cannot unblock.
2. **Irreversible human decision needed** — a choice you have no authority to make.
3. **Session-scoped queue exhausted** — no claimable work left in scope.

`/goal` + `stop-goal-persistence` make "keep going until the goal is met" the
enforced default, with safe escapes for all three pause reasons.

## When to use

- At the start of an autonomous run / `/loop` / multi-task batch: set a goal
  that names the session's done-state ("all Sprint 9 Ready-to-Start tasks
  shipped to staging", "PR #123 merged and reconciled", "the 3 bugs in this
  batch fixed + PRs opened").
- Any time you want the session held to a concrete finish line rather than the
  agent's subjective sense of "enough".

Don't set a goal for a single trivial edit — the pipeline Stop hooks
(`stop-task-check`, `stop-ci-green-check`) already gate that. `/goal` is for
**multi-step / long-horizon** work where fake-tiredness is the risk.

## The marker — `.claude/active-goal.json`

Session-scoped, gitignored, worktree-local (lives next to `active-task.json`).

```json
{
  "goal": "All Ready-to-Start tasks in Sprint 9 shipped to staging (PR open + CI green).",
  "setAt": "2026-05-31T10:00:00Z",
  "consecutiveBlocks": 0,
  "maxBlocks": 3
}
```

| Field | Meaning |
|---|---|
| `goal` | The natural-language completion condition. Required. Be concrete and verifiable — name the artifact/state, not a vibe. |
| `setAt` | ISO 8601 timestamp the goal was set (informational). |
| `consecutiveBlocks` | Bumped by the hook on every block. The safety escape hatch fires once it reaches `maxBlocks`. **You don't edit this** — the hook owns it. |
| `maxBlocks` | After this many consecutive blocks the hook ALLOWS the stop and warns, so a bug or unsatisfiable goal can't trap the session forever. Default `3`. Raise it for genuinely long runs; keep it ≥1. |

## Verbs

You (the agent) perform these by reading/writing the marker with the standard
file tools. There is no MCP call — the marker IS the interface.

### `set` — `/goal <condition>` (or `/goal set <condition>`)

Write `.claude/active-goal.json` with the condition. Resolve the path relative
to the **worktree** when one is active (same directory as `active-task.json`),
NOT `$CLAUDE_PROJECT_DIR`.

```jsonc
// Write .claude/active-goal.json
{
  "goal": "<the condition, verbatim from the user or distilled from the batch plan>",
  "setAt": "<now, ISO 8601>",
  "consecutiveBlocks": 0,
  "maxBlocks": 3
}
```

Reset `consecutiveBlocks` to `0` whenever you (re)set the goal. Confirm in one
line: `Goal set: "<condition>" (releases when met; max <N> blocks).`

### `show` — `/goal` (no args) or `/goal show`

Read the marker and report the current goal + `consecutiveBlocks`/`maxBlocks`.
If no marker exists, say "No active goal." Don't create one on `show`.

### `clear` — `/goal clear`

Delete `.claude/active-goal.json`. This releases the Stop hook cleanly — the
next stop is allowed. Use when the goal is genuinely satisfied or no longer
applies. Confirm: `Goal cleared.`

## How the hook releases you (so you're never trapped)

`stop-goal-persistence` is designed to NEVER trap the agent. It releases (allows
the stop) in all of these cases:

- **Goal met** — the hook's evaluator (model when an `ANTHROPIC_API_KEY` is
  exported; otherwise a deterministic check: active-task pipeline complete AND
  no claimable Ready-to-Start tasks left in the active sprint) judges the goal
  satisfied → it clears the marker for you.
- **`/goal clear`** — you removed the marker.
- **A legit pause reason** — set `reviewAddressed` in `.claude/active-task.json`
  to one of the existing escape values and the hook releases + clears the goal:
  - `handoff-to-orchestrator` — you pushed + opened the PR and handed off (per
    the agents-never-merge policy).
  - `stuck:<reason>` — a real, unrecoverable blocker (also do the
    `/log-progress TASK_STUCK` flow).
  - `timeout:<reason>` — you deliberately halted (regression loop, max rounds).
- **Max consecutive blocks** — after `maxBlocks` consecutive blocks the hook
  allows the stop anyway and warns. This is the bug-guard, not an invitation to
  spam stops.

If the hook blocks you and you believe the goal IS met, re-read the marker and
the hook's stderr message: it names the concrete reason it thinks work remains.
Either finish that work, or `/goal clear` if it's genuinely done.

## Relationship to the built-in `/goal`

| | Built-in `/goal` | This skill + `stop-goal-persistence` |
|---|---|---|
| Scope | One session, in-memory | Persisted in a marker file (survives compaction) |
| Evaluation | Always model-evaluated | Model when `ANTHROPIC_API_KEY` is set; deterministic fallback otherwise |
| Registration | Built into Claude Code | Plugin Stop hook, opt-in via `project-config.json` `hooks.enabled[]` |
| Loop guard | Built-in | `maxBlocks` counter + honors `stop_hook_active` |

Use the built-in `/goal` for quick ad-hoc conditions; use this when you want the
condition to survive the whole autonomous run and be enforced by the same
opt-in machinery as the other workflow Stop hooks.

## Cross-references

- `autonomous-by-default.md` — the 3 legitimate pause reasons + autonomous stance.
- `agent-autonomy.md` — the Stuck criterion + escape vocabulary.
- `plugin/hooks/stop-goal-persistence.sh` + `stop-goal-persistence-logic.py` — the enforcing hook.
