# Versions Lifecycle

## TL;DR

**Versions are HISTORICAL containers, not future-planning artifacts.**

- Future planning lives in **epics** (open-ended) + **sprints** (time-boxed).
- Versions catch what *actually shipped* + what's *currently shipping* (one open version per product).
- Versions are created **reactively** by the auto-version side-effect when the first task hits `Waiting for UAT` — never created proactively as a roadmap placeholder.

**Lifecycle (per product, single chain):**

```
[no open version]
       │
       │ first task transitions to Waiting for UAT
       ▼
[auto-create]  →  In Development  →  Release Candidate  →  Released
                  (tasks at UAT)    (all at PendingDeploy)  (release ceremony)
                                          │
                                          └─→ backwards: any task drops below
                                              PendingDeploy → revert to In Dev
```

**Anti-patterns** (don't do these):

- ❌ Manually create a "Planned" version for a future date or sprint
- ❌ Move tasks from version to version to "re-plan" (versions reflect what shipped, not what was intended)
- ❌ Maintain multiple `In Development` versions per product (split-brain shipping)
- ❌ Set a version `Released` while tasks are still at UAT (use the release ceremony)

## Why historical-not-planned

| Property | If versions plan the future | If versions are historical |
|---|---|---|
| Maintenance epic ("ongoing 24/7") | Has to point at a version, drift bait | Points at no version; tasks join open version at UAT |
| Concurrent epics shipping in parallel | Can pull tasks into different versions, ambiguity | All tasks ship in the currently-open version, regardless of epic |
| Bug bounceback from `Released` | Either drag a release back or duplicate the work | Released stays Released; the bounced task unlinks + re-enters open version |
| "What's coming next?" | Read `listVersions` → list of intended versions | Read `listEpics` + `getPublicRoadmap` → planned epics |
| "What shipped recently?" | Mixed historical + planned versions, confusing | Released versions in chronological order via `getVersionTimeline` |
| Bump-type semantics | Coupled to whatever planning was done | Decoupled: every task is a patch by default, humans elevate to minor/major before release |

The historical model decouples PLANNING (epics, sprints — what we *intend* to ship) from RELEASING (versions — what *actually* shipped). Each axis stays simple and reliable.

## Where versions interact with the workflow

| Workflow moment | Version action |
|---|---|
| `createTask` / `updateTask`(status: Ready to Start) | No version action |
| `claimTask` / `updateTask`(status: In Progress) | No version action |
| **`updateTask`(status: Waiting for UAT)** | Auto-version fires: link to open version (create if none) |
| `updateTask`(status: Pending Deploy to Prod) | State machine recomputes aggregate; flip to RC if all done |
| `/release-version` | Promote RC → Released, apply prod migrations, tag |
| Bug bounceback (status backwards from Released-linked task) | Unlink from Released version; rejoins open on next UAT |

## Per-product invariants

A healthy product board has at any given time:

- **≤ 1 open version** (In Development OR Release Candidate, not both — RC is a transient state about to release)
- **0 Planned versions** (Planned should be near-instantaneous; auto-version flips it to In Dev as the first task lands)
- **≥ 0 Hotfix versions** (separate chain, may exist in parallel to the main open version)
- **N Released versions** (immutable history)

`/audit-versions` checks these invariants. Drift cases:

| Drift | Cause | Fix |
|---|---|---|
| Multiple open versions | Stale Planned never got flipped, OR race condition between simultaneous UAT transitions | Delete the empty one, OR merge tasks into one |
| Long-lived Planned | Auto-version's state flip failed (Monday API error, missing label) | Manually flip to In Development |
| Orphan task at UAT | Auto-version failed at the moment (product mirror missing) | Manually link via `updateTask(versionId: <id>)` |
| `Released` with bounced task still linked | State machine bounceback handler failed | Manually unlink |

## How agents reason about "what version does this task ship in?"

The answer is **"whatever the open version is at the time the task lands on staging."** Not predetermined. Not bound to the epic.

When asked "when will X feature ship?":

1. If the task is `Done` or `Pending Deploy to Prod`: it's on the currently-open version. Look at version status + expected release date.
2. If the task is `Waiting for UAT`: same — already linked to the open version (auto-version fired).
3. If the task is in earlier states: **no version yet**. The closest answer is "the next release after the open one ships and the new auto-created version receives this task." But that's speculation; the agent should say "no version assigned yet — will join the current open version when work reaches UAT."

For multi-task forecasting ("what will land in v0.12.0?"), the truth is: whatever happens to be at UAT or past when the release ceremony runs. The version's task list is a *consequence* of work, not a *plan* of work.

## Cross-references

- `versioning.md` — semver math, v1.0 gate, bump suggestion algorithm
- `release-flow.md` — the three release modes (Default / Promote / Hotfix)
- `task-lifecycle.md` — the 7-status flow that drives version side-effects
- `worktree-discipline.md` — branch ↔ task ↔ version traceability

## In one sentence

**Plan futures in epics; capture shipping in versions.**
