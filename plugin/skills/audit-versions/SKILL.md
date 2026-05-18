---
name: audit-versions
description: Sweep a product's open versions and surface promote-ready candidates, stale Planned versions, orphan tasks, and version-state-machine drift. Read-only — suggests fixes but doesn't apply them.
user_invocable: true
---

# /audit-versions — proactive version state sweep

Versions are historical, not planned. Created on-demand when a task hits `Waiting for UAT` (via auto-version), transition through states reactively. When it drifts (state machine call failed, task orphaned, release ceremony skipped), this sweep catches it.

Use when you suspect drift, before a sprint demo / release window, or as part of a weekly hygiene routine.

## Inputs (interactive)

If invoked without a product, list via `mcp__plugin_dev-tasks_dev-tasks__listProducts` and ask which (or "all" — loop).

## Workflow

### Step 1 — gather state

```
mcp__plugin_dev-tasks_dev-tasks__getVersionTimeline({
  productId: <id>, statusFilter: "open", expandTasks: true
})
```

Returns Planned / In Development / Release Candidate versions with full task list + per-task status.

Also fetch potentially-orphaned tasks:
```
mcp__plugin_dev-tasks_dev-tasks__getBacklog({
  productId: <id>, statuses: ["Waiting for UAT", "Pending Deploy to Prod"], unclaimedOnly: false
})
```

Cross-reference: task with empty `versionId` AND status `Waiting for UAT`+ is an orphan.

### Step 2 — classify findings

| Finding | Definition | Action |
|---|---|---|
| **Promote-ready** | All linked tasks at `Pending Deploy to Prod` or `Done`, status currently `Release Candidate` | Suggest `/dev-tasks:release-version` |
| **Should-be-RC** | All linked tasks at `Pending Deploy to Prod` or `Done`, but version still `In Development` | State machine missed flip — apply via `updateVersion({status: "Release Candidate"})` |
| **Should-be-InDev** | Has tasks at `Waiting for UAT` or earlier, but version still `Planned` | Auto-version's `Planned → In Development` flip missed. Apply `updateVersion({status: "In Development"})` |
| **Stale Planned** | Status `Planned`, 0 linked tasks, created >7 days ago | Likely phantom from pre-auto-version era. Suggest deletion |
| **Empty Open** | Status `In Development` or `RC`, 0 tasks | Anomalous — investigate or delete |
| **Pending Deploy stragglers** | Tasks at `Pending Deploy to Prod` on a version still `In Development` for >3 days | UAT signoff probably stuck — flag for human |
| **Orphan task** | Task at `Waiting for UAT`+ with no `versionId` | Auto-version failed (likely missing product mirror). Suggest manual `updateTask({versionId: <open-version>})` |

### Step 3 — report

```markdown
## Audit — <Product Name>

### Promote-ready (N)
- v0.11.0 (#xxx) — 7/7 at Pending Deploy. Run `/dev-tasks:release-version v0.11.0`?

### Should-be-RC (N)
- v0.12.0 (#xxx) — 5/5 at Pending Deploy, but status `In Development`. Apply RC?

### Stale Planned (N)
- v0.13.0 (#xxx) — Planned, 0 tasks, 14 days old. Suggest deletion.

### Orphan tasks (N)
- Task #1234 "Foo bar" at `Waiting for UAT`, no versionId. Link to v0.12.0?

### All clear
- v0.14.0 — In Development, 3 tasks at UAT, healthy.
```

### Step 4 — propose fixes, wait for confirmation

For each actionable finding, propose the specific tool call but do NOT execute without explicit user confirmation. Informational; human + agent decide whether to act.

## What this skill does NOT do

- Auto-promote versions (release ceremony has too many side effects to fire silently)
- Auto-create new Planned versions (versions are reactive — auto-version handles creation at UAT)
- Modify changelog content (continuous refresh in auto-version handles that)
- Check release-readiness gates beyond aggregate status (CI green, UAT signoff live in `/release-version`)

## Frequency

No schedule. Run:
- After a sprint demo, before declaring sprint "shipped"
- When you notice an "off" version status during normal work
- Periodically as part of `/babysit-prs`-style hygiene

## Related

- `versions-lifecycle.md` — historical-not-planned model
- `versioning.md` — semver math + v1.0 gate
- `release-flow.md` — three release modes
- `/dev-tasks:release-version` — actual release ceremony
