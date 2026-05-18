# Versioning

Semver math, bump gates, v1.0 milestone gate. See `versions-lifecycle.md` for WHY versions are historical.

## TL;DR

Format `v{major}.{minor}.{patch}`. Every task auto-lands on a patch at `Waiting for UAT`; humans elevate to minor/major by renaming the open version's `versionNumber` before `/release-version`. Hotfixes always patch-bump (auto-detected by `hotfix/*` branch).

**Always call** `${CLAUDE_PLUGIN_ROOT}/src/services/version-bump.ts` → `computeBumpSuggestion(input)` — single source of truth (51 unit tests). Never reimplement in scripts/skill prose.

## Auto-assignment

Fires inside `updateTask` on transition to `Waiting for UAT`: resolves product → finds best open version (In Development beats Planned; lowest semver within each tier) → links task. If none exists, creates one (patch-bump from latest Released). Structured changelog auto-refreshes on link. Service: `plugin/src/services/auto-version.ts`.

## Aggregate state machine

Runs after every status change. Version status auto-flips based on linked tasks:

- All tasks at `Pending Deploy to Prod` or `Done` → `Release Candidate`
- Backward move from RC (any task drops below Pending Deploy) → `In Development`
- `Released` and `Hotfix` are terminal — never auto-modified

**Bounceback** (rare): task moves backward AND its version is `Released` → task unlinks. Released stays Released (frozen). Bounced task re-enters open-version pool on next UAT transition. Fix-forward via separate tasks preferred; bounceback is the safety net.

## Bump rules

- **Major** — Breaking changes (API contract, removed features, schema incompatibilities). Manual or v1.0-milestone.
- **Minor** — New features (Development-type tasks).
- **Patch** — Bug fixes, maintenance, refines, documentation, PM-work.
- **Hotfix** — Always patch (e.g., `v0.8.0` → `v0.8.1`).

## v1.0 milestone gate (HARD)

`v1.0.0` reserved for when **all** epic IDs in `monday.v1MilestoneEpicIds[]` (from `.claude/project-config.json`) hit `Done`. Empty array → gate disabled. Auto-patch never crosses v1.0 from 0.x.y, so the gate is inert on the patch path.

While any milestone epic is incomplete, agents must not auto-suggest `v1.0.0` even when the diff would warrant major. Fall through to highest non-major bump; note "v1.0.0 still gated on milestone epics." User can force `major`.

When the last gate epic flips Done, surface proactively in `/release-version` Step 1: "Milestone epics complete — recommend v1.0.0 (first stable release)."

## Decision algorithm

Helpers in `lib/services/version-bump.ts` (46 tests): `classifyTaskType(rawType)` → `'feature' | 'fix' | 'improvement'`; `computeBumpSuggestion(input)` → `{ next, bumpType, rationale, gatedByMilestone }`; `computeNextPlannedVersion(latest, v1Ready)`; `parseSemVer(s)` / `formatSemVer(v)` / `compareSemVer(a, b)`.

Agent flow (`/release-version` Step 1, `/ship-pr` Phase 8 step 25b):

1. Latest released: `listVersions(group: "released")` → sort → take highest. `parseSemVer()`.
2. Convert each linked task's `task_type` via `classifyTaskType()`.
3. `v1MilestoneReady`: read `monday.v1MilestoneEpicIds`. `getEpic(id)` each. `true` iff all `Done`. Empty array → pass `true`.
4. `computeBumpSuggestion({ latestReleased, tasks, v1MilestoneReady, forceMajor? })`. Agent suggests; user confirms or overrides.

## Version lifecycle

`Planned → In Development → Release Candidate → Released`.

- **Planned** — created, epics linked, no active work
- **In Development** — ≥1 linked task is In Progress / Waiting for UAT / Pending Deploy to Prod
- **Release Candidate** — all linked tasks `Pending Deploy to Prod`, pending `/release-version`
- **Released** — tag created, GH Action triggered, linked tasks → `Done`, Release Summary finalized

### Task status ↔ release ceremony

Task `Done` is reserved for released-to-production (per `task-lifecycle.md` for the full status transitions). The only path where an agent sets `Done` directly is the **hotfix** flow — `/ship-pr` Phase 10 after PR merge to `main`. Hotfixes ship to production at merge time; lifecycle collapses.

Enforced by `mcp__plugin_dev-tasks_dev-tasks__updateTask` server-side gate, `.claude/hooks/dev-tasks-update-guard.sh` (PreToolUse early-warning on `Done` outside hotfix), and `/log-progress TASK_COMPLETED` (emits summary + cleans state; legacy status-touching step removed 2026-05-13).

## Structured Release Summary

Field `long_text_mm0mw7hp` stores JSON between markers:

```
<!-- STRUCTURED_CHANGELOG_V1 -->
{ "summary": "...", "categories": {...}, "progress": {...}, ... }
<!-- /STRUCTURED_CHANGELOG_V1 -->
```

Progressive building: version created → initial summary; each `/ship-pr` Phase 8 → adds shipped task, updates progress; `/release-version` → finalizes (highlights, breaking changes, verify categories).

### Category mapping (3-cat shape, established 2026-05-07)

Categories: **Feature / Improvement / Fix** — chosen for stakeholder readability.

- Development → `feature`
- Bugfix tasks (and bugs) → `fix`
- Maintenance / Refine / Documentation / PM-work → `improvement`

Use task's **Public Task Name** (`text_mm349ah6` on Tasks board 5091706356) as changelog text when filled (same column that gates roadmap visibility).

**Backwards-compat**: Legacy 4-cat data (`added` / `fixed` / `changed` / `documentation`) auto-migrated by `migrateStructuredChangelog` (`lib/validation/monday-schemas.ts`) at parse: `added` → `feature`; `fixed` → `fix`; `changed` + `documentation` → `improvement`. **Never write legacy shape.** New summaries use 3-cat; migration is read-only.

## Task → Version linkage

Tasks (not epics) link to versions, written automatically by `services/auto-version.ts` on transition to `Waiting for UAT`. Resolution: best open "In Development" version for product → best open "Planned" → cold-create fresh patch.

- `/pickup-task` Step 5 is informational only — don't link epics to versions.
- `/ship-pr` Phase 8 logs `task.targetVersion`; doesn't hard-block.
- Epic → version is deprecated. Don't use `updateEpic(versionId)` or `updateVersion(linkEpicIds)`.

## Git tags

Only from `main`, only after explicit user confirmation in `/release-version`. Format: annotated tag `v{X.Y.Z}` with message "Release v{X.Y.Z}: {name}". Tag push triggers GitHub Action → Release + Monday status + ISR revalidation.

## Board configuration

- Board: `5091847257` (Versions)
- Version Number: `text_mm0rea7a`
- Status: `color_mm0m8mp` (Released = index 1)
- Release Date: `date_mm0mj930`
- Release Summary: `long_text_mm0mw7hp`
- Changelog Doc: `doc_mm0m764r`
- Released group: `group_mm0m6bkb`
- Upcoming group: `topics`
