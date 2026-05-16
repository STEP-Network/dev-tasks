# Versioning Rules

> Sibling rule: **[versions-lifecycle.md](versions-lifecycle.md)** explains
> WHY versions are historical (not planned) and the per-product invariants.
> This rule covers the semver math, bump gates, and v1.0 milestone gate.

## TL;DR

**Semver:** `v{major}.{minor}.{patch}` (e.g., `v0.9.0`).

- **Patch (auto)** ← every task lands on a patch by default. Auto-assigned at the `Waiting for UAT` transition. Fix, Improvement, AND Feature all become patches in the auto path.
- **Minor / Major (human)** ← agents do NOT auto-bump beyond patch. Humans elevate a patch version to minor or major by renaming the open version's `versionNumber` (e.g., `v0.9.5` → `v0.10.0`) **before** running `/release-version`.
- **Hotfixes** ← always a fresh patch-bump version with status `Hotfix`, created automatically when the task's branch matches `hotfix/*`.

**Auto-assignment fires inside `updateTask`** when status transitions to `Waiting for UAT`: resolves product → finds the best open version (In Development beats Planned; lowest semver within each tier) → links the task. If no open version exists, creates one (patch-bump from latest Released). The structured changelog auto-refreshes on link. Service: `plugin/src/services/auto-version.ts`.

**Aggregate state machine** runs after every status change. The version's status auto-flips based on its linked tasks:
- All tasks at `Pending Deploy to Prod` or `Done` → version → `Release Candidate`
- Backward move from RC (any task drops below Pending Deploy) → version → `In Development`
- `Released` and `Hotfix` are terminal — never auto-modified

**Bounceback** (rare): if a task moves backward AND its version is `Released`, the task unlinks. Released stays Released (the released content is historically frozen). The bounced task re-enters the open-version pool on its next UAT transition. By design, your team's "fix forward" preference is supported via separate tasks; the bounceback path is the safety net for the rare direct-regression case.

**v1.0.0 is a HARD GATE.** Reserved for the moment **all** epic IDs in `monday.v1MilestoneEpicIds[]` (from `.claude/project-config.json`) hit `Done`. Agents must NOT auto-suggest `v1.0.0` while any is incomplete — fall through to the highest non-major bump and note the gate. If the array is empty, the gate is disabled (effectively `true`). Auto-patch never crosses v1.0 from 0.x.y, so the gate is inert on the patch path.

**Always call the helper.** `${CLAUDE_PLUGIN_ROOT}/src/services/version-bump.ts` exports `computeBumpSuggestion(input)` — single source of truth with 51 unit tests including the `forcePatch` auto-path. Never reimplement the algorithm in scripts or skill prose.

## Semver Convention

Format: `v{major}.{minor}.{patch}` (e.g., `v0.9.0`)

### Bump Rules
- **Major**: Breaking changes (API contract changes, removed features, schema incompatibilities). Manual or v1.0-milestone trigger.
- **Minor**: New features (Development-type tasks)
- **Patch**: Bug fixes, maintenance, refines, documentation, PM-work (Bugfix / Maintenance / Refine / Documentation / PM-work tasks)
- **Hotfix**: Always patch (e.g., `v0.8.0` → `v0.8.1`)

### v1.0 Milestone (HARD GATE)

`v1.0.0` is reserved for the moment **all** epic IDs listed in `monday.v1MilestoneEpicIds[]` (in the consumer's `.claude/project-config.json`) reach status `Done`. Each product chooses which epics define its v1.0. If the array is empty, the gate is disabled.

While any configured milestone epic is incomplete, agents **must not** auto-suggest `v1.0.0` even when the diff would otherwise warrant a major. Fall through to the highest non-major bump and explicitly note "v1.0.0 still gated on milestone epics" in the suggestion. The user can still force `major` for a release-defining moment, but the agent should not propose it unprompted.

When the last gate epic flips to Done, surface this proactively in `/release-version` Step 1 as a celebratory option: "Milestone epics complete — recommend v1.0.0 (first stable release)."

### Decision Algorithm

**Canonical implementation**: `lib/services/version-bump.ts` — pure, fully unit-tested (46 tests covering every branch including the v1.0 gate). Always call the helper; never reimplement the algorithm in scripts/SKILL.md prose. Single source of truth.

Helper functions:
- `classifyTaskType(rawType)` → maps Monday `task_type` to 3-cat (`'feature' | 'fix' | 'improvement'`)
- `computeBumpSuggestion(input)` → returns `{ next, bumpType, rationale, gatedByMilestone }` with v1.0 gate baked in
- `computeNextPlannedVersion(latest, v1Ready)` → next placeholder version after a release (used by `/release-version` Step 8)
- `parseSemVer(s)` / `formatSemVer(v)` / `compareSemVer(a, b)` → utilities

Agent flow (in `/release-version` Step 1, `/ship-pr` Phase 8 step 25b):

1. Get latest released version: `listVersions(group: "released")` → sort → take highest. Parse with `parseSemVer()`.
2. Convert each linked task's `task_type` via `classifyTaskType()`.
3. Determine `v1MilestoneReady`: read `monday.v1MilestoneEpicIds` from `.claude/project-config.json`. Call `getEpic(id)` for each entry. `v1MilestoneReady = true` iff all statuses are `Done`. If the array is empty, pass `true` (no gate configured).
4. Call `computeBumpSuggestion({ latestReleased, tasks, v1MilestoneReady, forceMajor? })`. Read `next`, `bumpType`, `rationale`, `gatedByMilestone`.
5. Agent suggests; user confirms or overrides.

## Version Lifecycle

```text
Planned → In Development → Release Candidate → Released
```

- **Planned**: Version created, epics linked, no active work yet
- **In Development**: At least one linked task is In Progress / Waiting for UAT / Pending Deploy to Prod
- **Release Candidate**: All linked tasks `Pending Deploy to Prod`, pending `/release-version` ceremony
- **Released**: Git tag created, GitHub Action triggered, linked tasks transitioned `Pending Deploy to Prod` → `Done`, Monday.com Release Summary finalized

### Relationship between task status and release ceremony

Under the staging-as-base flow (per `.claude/rules/release-flow.md`), task `Done` is
NOT set at implementation completion. It is reserved for **released-to-production**.
The full task transition path is:

```text
Implementation done   → Waiting for UAT  (set by /ship-pr Phase 6.5 after review loop)
UAT signed off        → Pending Deploy to Prod  (set by human after test.polads.eu UAT)
Release cut           → Done  (set by GitHub Action on tag push, triggered by /release-version)
```

The only path where an agent sets `Done` directly is the **hotfix** flow — `/ship-pr`
Phase 10 after a PR merge to `main`. Hotfixes ship to production at merge time, so
the lifecycle collapses (no UAT-on-staging step). All other flows go through the
release ceremony for `Done`.

This coupling is enforced by:

- `mcp__plugin_dev-tasks_dev-tasks__updateTask`'s server-side gate (rejects ill-formed transitions).
- `.claude/hooks/dev-tasks-update-guard.sh` (PreToolUse — early-warns on agent attempts to set `Done` outside hotfix mode).
- `/log-progress` TASK_COMPLETED — emits the summary + cleans the state file but does NOT touch status (legacy step removed 2026-05-13).

## Structured Release Summary

The Release Summary field (`long_text_mm0mw7hp`) stores structured JSON between markers:

```
<!-- STRUCTURED_CHANGELOG_V1 -->
{ "summary": "...", "categories": {...}, "progress": {...}, ... }
<!-- /STRUCTURED_CHANGELOG_V1 -->
```

### Progressive Building
- **Version created** → Initial summary
- **Each `/ship-pr`** Phase 8 → Add shipped task to categories, update progress
- **`/release-version`** → Finalize: add highlights, breaking changes, verify categories

### Category Mapping (canonical 3-cat shape, established 2026-05-07)

The structured Release Summary uses 3 categories — **Feature / Improvement / Fix** — chosen for stakeholder readability over engineering granularity.

- Development tasks → `feature`
- Bugfix tasks (and bugs) → `fix`
- Maintenance / Refine / Documentation / PM-work tasks → `improvement`

Use the task's **Public Task Name** (`text_mm349ah6` on Tasks board 5091706356) as the changelog entry text when filled. This is the same column that gates roadmap visibility — its purpose is to give stakeholders a regulator/board-level reading of what shipped, separate from engineering-jargon internal task names.

**Backwards-compat**: Legacy 4-cat data (`added` / `fixed` / `changed` / `documentation`) on already-released versions is auto-migrated by `migrateStructuredChangelog` (`lib/validation/monday-schemas.ts`) at parse time:
- `added` → `feature`
- `fixed` → `fix`
- `changed` + `documentation` → `improvement`

**Never write the legacy shape.** All new structured Release Summaries must use the 3-cat shape; migration is read-only.

## Task → Version linkage (task-level, automatic)

**Tasks** (not epics) link to versions, and the link is written **automatically** by `services/auto-version.ts` when a task transitions to `Waiting for UAT`. Resolution order: best open "In Development" version for the product → best open "Planned" version → cold-create a fresh patch. See `versions-lifecycle.md` for the rationale.

- `/pickup-task` Step 5 is informational only — don't link epics to versions there.
- `/ship-pr` Phase 8 logs the current `task.targetVersion` (set by `auto-version`); it does not hard-block.
- Epic → version was the old model and is deprecated. Don't use `updateEpic(versionId)` or `updateVersion(linkEpicIds)` to drive the lifecycle.

## Git Tags

- Only create from `main` branch
- Only after explicit user confirmation in `/release-version`
- Format: annotated tag `v{X.Y.Z}` with message "Release v{X.Y.Z}: {name}"
- Tag push triggers GitHub Action → GitHub Release + Monday.com status update + ISR revalidation

## Board Configuration

- Board: `5091847257` (Versions)
- Version Number column: `text_mm0rea7a`
- Status column: `color_mm0m8mp` (Released = index 1)
- Release Date column: `date_mm0mj930`
- Release Summary column: `long_text_mm0mw7hp`
- Changelog Doc column: `doc_mm0m764r`
- Released group: `group_mm0m6bkb`
- Upcoming group: `topics`
