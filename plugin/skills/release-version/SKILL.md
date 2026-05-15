---
name: release-version
description: Manage version releases and generate changelogs
user_invocable: true
---

# /release-version — Manage Releases & Changelogs

## Workflow

### Step 1: Identify Target Version + Semver Suggestion

1. Call `mcp__dev-tasks__listVersions(group: "upcoming")` to show upcoming versions
2. Display: version name, version number, status, linked item counts
3. Ask user which version to work with:
   - **Existing version** → proceed with that versionId
   - **New version** → call `mcp__dev-tasks__createVersion(name, productId, versionNumber, status: "Planned")`
     - Ask for: name, version number, expected release date
     - Optional: release summary, linked epics/tasks

**Semver Suggestion** (when version number is empty or creating new):

> The bump algorithm lives in `lib/services/version-bump.ts` as
> `computeBumpSuggestion(input)` — pure, fully unit-tested (46 tests), single
> source of truth. The steps below cover the data the agent gathers + how to
> interpret the result. All gating (v1.0 milestone, breaking changes,
> force-major) is encoded inside `computeBumpSuggestion`, so this skill stays
> a thin orchestration layer.

1. **Gather inputs:**
   - `latestReleased`: `mcp__dev-tasks__listVersions(group: "released")` → sort by versionNumber → take highest → parse with `parseSemVer()`.
   - `tasks`: from Step 2's `mcp__dev-tasks__getVersion(versionId)` — convert each task's `task_type` to the 3-cat via `classifyTaskType()`. Set `hasBreakingChanges: true` on any task whose description / metadata explicitly flags a breaking change.
   - `v1MilestoneReady`: call `mcp__dev-tasks__getEpic(2833952138)` (Beta) AND `mcp__dev-tasks__getEpic(2738006659)` (Live). True iff BOTH have status `Done`.
   - `forceMajor` (optional): only when the user explicitly asked for a release-defining major moment.

2. **Call `computeBumpSuggestion(input)`** — returns `{ next, bumpType, rationale, gatedByMilestone }`.

3. **Surface to the user**:
   - `gatedByMilestone !== null` AND would-have-been major: "v1.0.0 still gated on Beta+Live epics — bumping {bumpType} instead. Confirm v{next}? ({rationale})"
   - `bumpType === 'major'` AND `next.major === 1` (gate passed, 0.x → 1.0): "🎉 Beta + Live epics complete — recommend v{next} (first stable release). Confirm?"
   - Otherwise: "Recommend v{next}. ({rationale}) Confirm?"

4. User confirms or overrides. The user can pass `forceMajor: true` to force a major moment, but the v1.0 gate **also applies to forced majors** — the gate beats force-overrides intentionally (an EU regulator going live shouldn't bypass our own readiness check).

### Step 2: Review Version Contents

1. Call `mcp__dev-tasks__getVersion(versionId)` to get full details:
   - Linked tasks (with status and type)
   - Linked epics (with status)
   - Fixed bugs (with status)
   - Changelog doc (if already exists)
2. Show summary to user:
   ```
   Version: {name} ({versionNumber})
   Status: {status}
   Items: {X} tasks, {Y} bugs, {Z} epics
   Completion: {done}/{total} tasks done, {fixed}/{total} bugs fixed
   Missing: {list any in-progress or unclaimed items}
   ```
3. If items are incomplete, warn user

**Re-verify semver**: If version already has a number, check against all linked tasks:
- If a feature was added to a patch release → warn user
- If only fixes in what's marked as a minor release → note it's fine

### Step 3: Pre-Release Checklist

Before generating changelog, verify:
- [ ] All linked tasks are `Pending Deploy to Prod` (or already `Done` from a prior release pass)
- [ ] All linked bugs are Fixed
- [ ] No items are in `In Progress` or `Waiting for UAT` (those need UAT signoff before they can ship)
- If any checks fail: warn user, ask whether to proceed anyway or wait

### Step 4: Generate Changelog + Structured Release Summary

1. Ask user for optional additions:
   - `highlights`: key features to emphasize (array of strings)
   - `breakingChanges`: any breaking changes (array of strings)
   - `knownIssues`: known issues to document (array of strings)
2. Call `mcp__dev-tasks__generateChangelog(versionId)` with optional params
3. The tool auto-categorizes linked items into a Monday Doc:
   - Development tasks → **Added**
   - Bugfix tasks → **Fixed**
   - Maintenance/Refine tasks → **Changed**
   - Documentation tasks → **Documentation**
4. A Monday Doc is created and attached to the version (internal/team use)
5. Show generated changelog summary to user

**Build Structured Release Summary** (for website) — 3-category shape:

The canonical Release Summary JSON uses 3 categories (Feature / Improvement / Fix) — established 2026-05-07. Legacy 4-cat data on already-released versions is auto-migrated by the parser, so reading old data is transparent; **everything written from this skill must be in the canonical 3-cat shape.**

1. Read task details from version (already available from Step 2).
2. Build structured JSON with categories from task types:
   - Development → `feature`
   - Bugfix → `fix`
   - Maintenance / Refine / Documentation / PM-work → `improvement`
   - Use the task's `Public Task Name` (column `text_mm349ah6`) when filled; otherwise fall back to the internal task name.
3. Include `highlights`, `breakingChanges` from user input.
4. Build progress object from task/bug counts.
5. Wrap in `STRUCTURED_CHANGELOG_V1` markers:
   ```
   <!-- STRUCTURED_CHANGELOG_V1 -->
   {
     "summary": "{user-provided or auto-generated summary}",
     "categories": { "feature": [...], "improvement": [...], "fix": [...] },
     "highlights": [...],
     "breakingChanges": [...],
     "progress": { "totalTasks": N, "doneTasks": N, "totalBugs": N, "fixedBugs": N },
     "versionNumber": "{X.Y.Z}"
   }
   <!-- /STRUCTURED_CHANGELOG_V1 -->
   ```
6. Write to Release Summary: `mcp__dev-tasks__updateVersion(versionId, releaseSummary: structuredContent)`.

### Step 5: Confirm Release (User Decision)

1. Show final summary: version name, changelog categories, all linked items
2. Ask user: "Ready to mark version {name} as Released?"
3. **If yes** → proceed to Step 6
4. **If no**:
   - Leave as Planned/In Development, user can revisit later
   - Suggest: "Run `/release-version` again when ready"

### Step 6: Promote staging → main + create git tag

> Under the new branching flow (per `.claude/rules/release-flow.md`), `staging` is the integration branch — features land there first via PR. A release is the act of **fast-forwarding `main` from `staging`**, applying production migrations, and tagging. The git tag is the single trigger for the rest of the automation: GitHub Release + Monday.com status update + ISR cache revalidation.

**Pre-flight verification** — refuse to release if any of these fail:

1. Working tree clean: `git status --porcelain` returns empty.
2. On `staging` branch with latest pull: `git checkout staging && git pull origin staging`.
3. All linked Monday tasks are status=`Pending Deploy to Prod` with `actualHours` recorded (per Step 3). Tasks already at `Done` from a prior release pass count too. Under the staging-as-base lifecycle, `Done` is set by the tag-triggered GitHub Action — so tasks must still be at `Pending Deploy to Prod` when `/release-version` starts.
4. CI on `staging` is green: `gh run list --branch staging --workflow ci.yml --limit 1` shows `success`.
5. `main` is an ancestor of `staging` (FF will work): `git merge-base --is-ancestor origin/main origin/staging` succeeds.

If any pre-flight fails: stop, report the failure to the user, do NOT proceed.

**Promote main from staging** (the actual release):

6. Verify tag doesn't exist: `git tag -l v{versionNumber}` returns empty.
7. Fetch latest main: `git fetch origin main`.
8. Fast-forward main from staging: `git push origin staging:main` (this is a remote-only FF — does NOT require a local checkout of main).
   - **If this fails** with non-fast-forward error: main has diverged from staging (likely a hotfix landed on main that wasn't merged back to staging). Stop and ask user — DO NOT force-push.
9. Apply migrations to **production** Neon: `pnpm migrate:prod` against `DATABASE_URL_UNPOOLED` set to the prod Neon connection string.
   - Use the env-aware migrate script that already handles "production" confirmation prompts (CI=true to auto-confirm in agentic flow, with explicit `--yes` flag if the script supports it).
   - **If migration fails**: prod schema is now out-of-sync with main HEAD. Consider rolling main back via `git push origin <prev-main-sha>:main --force-with-lease` (only if no other commits landed in between) OR fix forward immediately. Escalate to user.
10. Tag the release on main HEAD: `git tag -a v{versionNumber} -m "Release v{versionNumber}: {name}"` then `git push origin v{versionNumber}`.
11. The tag push triggers `.github/workflows/release.yml`:
    - Monday.com status → Released, release date → today, move to Released group
    - GitHub Release creation with commit-based notes
    - ISR cache revalidation for immediate changelog page update
12. **Do NOT update Monday.com status manually** — the tag push is the single trigger.

### Step 7: Verify Release

1. Check GitHub Actions: `gh run list --workflow=release.yml --limit 1`
2. Verify GitHub Release exists: `gh release view v{versionNumber}`
3. Report status to user:
   ```
   Release v{versionNumber} complete:
   ✓ Git tag created and pushed
   ✓ GitHub Action triggered
   ✓ GitHub Release: {url}
   ✓ Monday.com will be updated automatically
   ✓ Changelog page will refresh within 5 minutes (or immediately if revalidation endpoint is configured)
   ```

### Step 8: Auto-create the next "In Development" version

> Goal: the roadmap page should always show what's coming next. After every release we proactively create a placeholder version so PRs landing on staging immediately have somewhere to attach (and `/ship-pr` Phase 8 doesn't HARD BLOCK on a missing version).

> The placeholder algorithm lives in `lib/services/version-bump.ts` as
> `computeNextPlannedVersion(latestReleased, v1MilestoneReady)` — same v1.0
> gate as `computeBumpSuggestion`, same testable surface.

1. Compute the next placeholder via `computeNextPlannedVersion(justReleased, v1MilestoneReady)`. The function returns the suggested SemVer:
   - X.Y.Z (Z > 0) just released → X.Y.(Z+1) placeholder (next patch).
   - X.Y.0 (Y > 0) just released → X.(Y+1).0 placeholder (next minor).
   - X.0.0 (X > 0) just released → (X+1).0.0 placeholder (next major).
   - Cold start at 0.0.0 with `v1MilestoneReady=false` → 0.1.0 (NOT 1.0.0 — gate beats default).
   - Cold start at 0.0.0 with `v1MilestoneReady=true` → 1.0.0.
2. Check `mcp__dev-tasks__listVersions(group: "upcoming")` to see if a version with that number already exists. If yes → skip creation, just report.
3. If not → call `mcp__dev-tasks__createVersion`:
   - `name`: `v{X.Y.Z} — {placeholder}` (e.g., `v0.8.0 — Next Release`). User can rename later.
   - `versionNumber`: `{X.Y.Z}`
   - `productId`: same as the just-released version
   - `status`: `In Development`
4. Report: "Auto-created v{X.Y.Z} as the next In Development version. Rename it on Monday.com when scope is clearer."

## Arguments

- `<version-id>` (optional): Monday.com version ID to work with directly
- If no ID provided, show upcoming versions for selection

## Post-Conditions

- Version has changelog doc attached (Monday Doc — internal)
- Version has structured Release Summary (website — public) in 3-category shape (Feature / Improvement / Fix)
- **`main` fast-forwarded from `staging`** (the actual release)
- **Production Neon migrations applied** before the tag push
- Git tag created and pushed (triggers automation)
- GitHub Action triggered → Monday.com status = "Released", GitHub Release created
- ISR cache revalidated for immediate changelog/roadmap page refresh
- **Next In Development version auto-created** so PRs have a ship-target (Step 8)
