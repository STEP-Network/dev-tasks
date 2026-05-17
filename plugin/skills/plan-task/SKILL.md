---
name: plan-task
description: Reconcile a claimed task's plan against the current state of the codebase. Surfaces drift between the task's subtask descriptions (written at refinement time, possibly weeks ago) and what the code actually looks like now. Use right after /pickup-task and before implementation.
user_invocable: true
---

# /plan-task — Reconcile claim-time plan against current codebase

> **Overlay**: if `.claude/skills/plan-task/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific instructions (extend-only — overlay can append checks/steps but cannot replace plugin behavior).

## When to apply

Invoke right after `/dev-tasks:pickup-task` claims a task, before starting implementation. The skill is conditional — most claims don't need it.

**Run it when ANY of these are true:**

- The task entered `Ready to Start` ≥72 hours ago (the codebase has likely drifted; subtask descriptions may reference moved/renamed entities)
- ≥3 tasks have merged to `$defaultBase` since this task was last refined (drift risk compounds)
- The task description / subtasks reference specific file paths, function names, or schema fields
- The task is high-stakes (regulatory, schema migration, public-API contract, payment flow)
- This task is a follow-up to one that was Stuck earlier — the original analysis may be stale

**Skip when:**

- The task entered Ready-to-Start <24h ago AND no merges since refinement
- The task is mechanical and self-contained (1 file, no external references)
- You ran `/plan-task` already this session and the codebase hasn't moved

## Why this skill exists

`/refine-task` runs at sprint-prep time. It produces typed subtasks with estimates and acceptance criteria — all grounded in the codebase as it was AT THAT MOMENT. By the time the task is claimed, 10 other tasks may have merged. Functions referenced in subtask descriptions could be renamed, files moved, schema fields removed, dependencies upgraded.

`/pickup-task` does NOT re-plan. It claims, creates a worktree, reads context, but trusts the subtask descriptions as-is. That's a known gap. This skill fills it.

## Workflow

### Step 0 — Project context

Read `.claude/project-config.json`. Extract `git.defaultBase` (to compute "merges since refinement"). Read overlay if present.

### Step 1 — Pull task + subtasks

```
mcp__plugin_dev-tasks_dev-tasks__getTask({ itemId: <task-id>, format: "json" })
```

Capture: name, description, acceptance criteria, subtasks (name + description + type + estimatedHours), the task's history (when refined? when entered Ready-to-Start?).

### Step 2 — Identify stale-risk

Compute the staleness signal. If ALL of these are reassuring, skip to Step 7 with a one-line "no plan-task needed" note:

- Task entered Ready-to-Start <72h ago
- 0–2 merges to `$defaultBase` since the refinement timestamp
- No file paths / function names / schema fields cited in subtask descriptions

Otherwise continue to Step 3.

### Step 3 — Map subtasks to current code

For each subtask description that cites specific code:

- File paths → does the file still exist at that path? If renamed/moved, find the new location.
- Function names → does the function still exist with that name? Check signature changes.
- Schema fields / columns → still present? Renamed? Type changed?
- Dependencies / library versions → still on the version the subtask assumes?

Use Glob/Grep aggressively. This is what an `Explore` agent would do — for routine claims you can do it inline; for large drift surfaces, spawn `dev-tasks:codebase-researcher`:

```
Agent({
  description: "Plan-task drift check",
  subagent_type: "dev-tasks:codebase-researcher",
  prompt: "For task #<id>, the subtask descriptions reference: <list>. Verify each is still present at the claimed location with the assumed signature. Report any drift in 1 sentence per item."
})
```

### Step 4 — Draft the reconciled plan

For each subtask, write a 2–3 line concrete plan grounded in what the code actually looks like NOW:

```
Subtask 1 — Backend: "Add POST /api/foo with ownership check"
  Reconciled: `app/api/foo/route.ts` still exists. Ownership check pattern
  now uses `lib/auth/owner.ts:verifyOwner()` (was `requireOwner()` at refinement —
  renamed in PR #287). Plan: add POST handler, call verifyOwner({ resourceType: "foo" }),
  reject 403 on mismatch. Test: __tests__/api/foo.test.ts already mocks
  verifyOwner — extend with the new POST case.
```

Surface any DISCREPANCIES the original subtask description didn't anticipate. These are the value of this skill — drift the agent would have hit mid-implementation otherwise.

### Step 5 — Decide if Plan mode is warranted

**Default: skip Plan mode.** Most claim-time planning produces a concrete reconciled plan that proceeds without user approval — that's the autonomous workflow.

**Invoke Plan mode (`EnterPlanMode` tool) only when ANY of these:**

- Significant drift detected (≥3 subtasks reference now-renamed/removed entities) — the user might want to re-refine the task before proceeding
- The reconciled plan diverges materially from the subtask descriptions (you'd be implementing something different from what was approved at refinement)
- The task involves an architectural or regulatory decision the agent can't make alone
- The acceptance criteria appear achievable only by violating a project constraint (per `.claude/rules/*.md`)

If Plan mode invoked: write the reconciled plan as the plan-mode plan, surface via `ExitPlanMode`. User reviews + approves (or pushes back). If user pushes back, treat as Stuck → updateTask({status: "Stuck"}) + createUpdate + claim next planned task if any.

If Plan mode NOT invoked: proceed to Step 6 without waiting for approval.

### Step 6 — Post the reconciled plan

If non-trivial drift was found, post the reconciled plan as a Monday update so the next agent / human reviewer sees what changed since refinement:

```
mcp__plugin_dev-tasks_dev-tasks__createUpdate({
  itemId,
  body: HTML with the reconciled plan + drift items + how they were addressed
})
```

Skip the post if zero drift was found (no signal worth recording).

### Step 7 — Continue with implementation

The agent now has a current-codebase-grounded plan. Proceed with subtask 1.

## Trigger summary (quick reference)

| Signal | Run /plan-task? |
|---|---|
| Task entered Ready-to-Start <24h ago, 0 merges since | No — just start |
| Task entered Ready-to-Start 24–72h ago, 1–2 merges since | Maybe — quick Step 3 drift scan inline, skip if clean |
| Task entered Ready-to-Start >72h ago OR ≥3 merges since | Yes — run full workflow |
| Subtask descriptions reference specific code | Yes — drift check is the value |
| Task is regulatory / schema / payment / public-API | Yes — verify acceptance criteria still achievable |
| Mechanical 1-file task | No — overhead exceeds value |

## Anti-patterns

- **Running plan-task on every claim**: token tax for marginal value. Most claims are recent + low-drift; skip the skill.
- **Skipping plan-task when drift is high**: defeats the point. The whole purpose is catching drift before it bites.
- **Invoking Plan mode for routine plans**: user-approval friction without value. Only invoke when the drift is significant enough that the user might want to re-refine the task before proceeding.
- **Letting the reconciled plan silently differ from the subtask descriptions**: if the plan diverged, post the divergence to Monday so reviewers see it. Drift left undocumented is drift that bites the next refactor.
- **Re-refining the task here**: this skill reconciles a claimed task; it doesn't restructure it. If the drift is too large to reconcile, mark Stuck and ask the user to re-run `/refine-task`. Don't silently rewrite the subtasks.

## Reference

- `.claude/skills/pickup-task/SKILL.md` — what runs BEFORE this skill (claim + worktree + initial context read)
- `.claude/skills/refine-task/SKILL.md` — where the original plan came from
- `.claude/rules/critical-thinking.md` — the posture this skill instantiates at claim time (consider alternatives, push back when drift suggests the task itself needs re-refinement)
- `.claude/skills/holistic-thinking/SKILL.md` — depth lens for when the drift hints at a deeper root cause
- `EnterPlanMode` / `ExitPlanMode` — Claude Code's built-in plan mode (user-approval gated)
