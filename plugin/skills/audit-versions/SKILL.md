---
name: audit-versions
description: Sweep a product's open versions and surface promote-ready candidates, stale Planned versions, orphan tasks, and version-state-machine drift. Read-only — suggests fixes but doesn't apply them.
user_invocable: true
---

# /audit-versions — proactive version state sweep

> **Overlay**: if `.claude/skills/audit-versions/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific instructions (extend-only — overlay can append checks/steps but cannot replace plugin behavior).

## Why this exists

Versions are **historical, not planned**. They get created on-demand when a
task hits `Waiting for UAT` (via auto-version) and transition through
states reactively (via the aggregate state machine). When this works, no
sweep is needed. When it drifts — a state machine call failed, a task got
orphaned, a release ceremony was skipped — a periodic audit catches it.

Use this skill when you suspect drift, before a sprint demo / release
window, or as part of a weekly hygiene routine.

## Inputs (interactive)

If the user invokes `/audit-versions` without a product, list products
first via `mcp__plugin_dev-tasks_dev-tasks__listProducts` and ask
which one to audit (or "all" — loop).

## Workflow

### Step 1 — gather state

For the target product:

```
mcp__plugin_dev-tasks_dev-tasks__getVersionTimeline({
  productId: <id>,
  statusFilter: "open",
  expandTasks: true,
})
```

This returns Planned / In Development / Release Candidate versions with their full task list and per-task status.

Also fetch open Maintenance + workflow tasks that might be orphaned (at `Waiting for UAT` or later but with no version):

```
mcp__plugin_dev-tasks_dev-tasks__getBacklog({
  productId: <id>,
  statuses: ["Waiting for UAT", "Pending Deploy to Prod"],
  unclaimedOnly: false,
})
```

(Same product item ID as Step 1's `getVersionTimeline` call. Use `listProducts` to resolve a name → ID if you don't have it yet.)

Cross-reference: a task in `getBacklog` whose `versionId` is empty AND status is `Waiting for UAT`+ is an **orphan**.

### Step 2 — classify findings

For each open version, compute:

| Finding | Definition | Action |
|---|---|---|
| **Promote-ready** | All linked tasks at `Pending Deploy to Prod` or `Done`, status currently `Release Candidate` | Suggest `/dev-tasks:release-version` |
| **Should-be-RC** | All linked tasks at `Pending Deploy to Prod` or `Done`, but version status is still `In Development` | State machine missed a flip — apply via `updateVersion({status: "Release Candidate"})` |
| **Should-be-InDev** | Has tasks at `Waiting for UAT` or earlier, but version status is `Planned` | Auto-version's "Planned → In Development" flip missed. Apply via `updateVersion({status: "In Development"})` |
| **Stale Planned** | Status `Planned`, 0 linked tasks, created >7 days ago | Likely a phantom from a pre-auto-version era. Suggest deletion |
| **Empty Open** | Status `In Development` or `RC`, 0 tasks | Anomalous — investigate or delete |
| **Pending Deploy stragglers** | Tasks at `Pending Deploy to Prod` on a version still `In Development` for >3 days | UAT signoff probably stuck — flag for human |
| **Orphan task** | Task at `Waiting for UAT`+ with no `versionId` | Auto-version failed at the time (likely missing product mirror). Suggest manual `updateTask({versionId: <open-version>})` |

### Step 3 — report

Emit a structured report:

```markdown
## Audit — <Product Name>

### Promote-ready (N)
- v0.11.0 (#xxx) — 7/7 at Pending Deploy. Run `/dev-tasks:release-version v0.11.0`?

### Should-be-RC (N)
- v0.12.0 (#xxx) — 5/5 at Pending Deploy, but status is `In Development`. Apply RC?

### Stale Planned (N)
- v0.13.0 (#xxx) — Planned, 0 tasks, 14 days old. Suggest deletion.

### Orphan tasks (N)
- Task #1234 "Foo bar" at `Waiting for UAT`, no versionId. Link to v0.12.0?

### All clear (no findings)
- v0.14.0 — In Development, 3 tasks at UAT, healthy.
```

### Step 4 — propose fixes, wait for confirmation

For each actionable finding, propose the specific tool call but **do not execute** without explicit user confirmation. This skill is informational; the human + agent decide whether to act.

## What this skill does NOT do

- It does not auto-promote versions (release ceremony has too many side effects to fire silently)
- It does not auto-create new Planned versions (the model says versions are reactive — auto-version handles creation at UAT-time)
- It does not modify the changelog content (continuous refresh in auto-version handles that)
- It does not check release-readiness gates other than aggregate status (CI green, UAT signoff, etc. live in `/release-version`)

## Frequency

There is no schedule. Run it:
- After a sprint demo, before declaring the sprint "shipped"
- When you notice an "off" version status during normal work
- Periodically as part of `/babysit-prs`-style hygiene routines

## Related

- `versions-lifecycle.md` — the rule explaining the historical-not-planned model
- `versioning.md` — semver math + v1.0 gate
- `release-flow.md` — the three release modes
- `/dev-tasks:release-version` — the actual release ceremony
