---
name: plan-task
description: Reconcile a claimed task's plan against the current state of the codebase. Surfaces drift between the task's subtask descriptions (written at refinement time, possibly weeks ago) and what the code actually looks like now. Use right after /pickup-task and before implementation.
user_invocable: true
---

# /plan-task — Reconcile claim-time plan against current codebase

## When to apply

Invoke right after `/dev-tasks:pickup-task` claims, before implementation. Conditional — most claims don't need it.

**Run when ANY:**
- Task entered `Ready to Start` ≥72h ago
- ≥3 tasks merged to `$defaultBase` since last refined
- Subtask descriptions cite specific file paths / function names / schema fields
- High-stakes: regulatory / schema migration / public-API / payment
- Follow-up to a previously-Stuck task

**Skip when:**
- Task entered Ready-to-Start <24h ago AND no merges since
- Mechanical, self-contained (1 file, no external references)
- Already ran `/plan-task` this session, codebase hasn't moved

## Workflow

### Step 0 — Project context

Read `.claude/project-config.json` for `git.defaultBase`. Read overlay if present.

### Step 1 — Pull task + subtasks

`mcp__plugin_dev-tasks_dev-tasks__getTask({ itemId: <task-id>, format: "json" })`. Capture: name, description, AC, subtasks (name + description + type + estimatedHours), history.

### Step 2 — Identify stale-risk

If ALL reassuring → skip to Step 7 with "no plan-task needed":
- Entered Ready-to-Start <72h ago
- 0–2 merges to `$defaultBase` since refinement
- No file paths / function names / schema fields cited

Otherwise → Step 3.

### Step 3 — Map subtasks to current code

For each subtask description that cites specific code, verify via Glob/Grep:
- File paths → still exist? If renamed/moved, find new location
- Function names → still exist? Signature changed?
- Schema fields → present? Renamed? Type changed?
- Dependencies → still on assumed version?

For large drift surfaces, spawn `dev-tasks:codebase-researcher`:
```
Agent({
  description: "Plan-task drift check",
  subagent_type: "dev-tasks:codebase-researcher",
  prompt: "For task #<id>, subtask descriptions reference: <list>. Verify each is still present at claimed location with assumed signature. Report drift in 1 sentence per item."
})
```

### Step 4 — Draft the reconciled plan

For each subtask, 2–3 lines grounded in current code. Surface DISCREPANCIES the original didn't anticipate — that's the value.

### Step 5 — Decide if Plan mode is warranted

Default: skip Plan mode.

Invoke `EnterPlanMode` only when ANY:
- Significant drift (≥3 subtasks reference now-renamed/removed entities)
- Reconciled plan diverges materially from subtask descriptions
- Task involves architectural / regulatory decision agent can't make alone
- AC appears achievable only by violating a project constraint

If invoked: write reconciled plan, `ExitPlanMode` for review. Pushback → Stuck → `updateTask({status: "Stuck"})` + `createUpdate` + claim next planned task.

If NOT invoked → Step 6 without waiting for approval.

### Step 6 — Post the reconciled plan

If non-trivial drift found, post via `createUpdate` with reconciled plan + drift items + how addressed. Skip if zero drift (no signal worth recording).

### Step 7 — Continue with implementation

Agent now has current-codebase-grounded plan. Proceed with subtask 1.

## Trigger quick reference

| Signal | Run? |
|---|---|
| <24h ago, 0 merges | No — just start |
| 24–72h ago, 1–2 merges | Maybe — quick Step 3 scan, skip if clean |
| >72h ago OR ≥3 merges | Yes — full workflow |
| Subtask descriptions cite specific code | Yes — drift check is the value |
| Regulatory / schema / payment / public-API | Yes — verify AC still achievable |
| Mechanical 1-file task | No — overhead exceeds value |

## Reference

- `.claude/skills/pickup-task/SKILL.md` — runs BEFORE this skill
- `.claude/skills/refine-task/SKILL.md` — where original plan came from
- `.claude/rules/critical-thinking.md` — posture this skill instantiates
- `.claude/skills/holistic-thinking/SKILL.md` — depth lens
- `EnterPlanMode` / `ExitPlanMode` — built-in plan mode (user-approval gated)
