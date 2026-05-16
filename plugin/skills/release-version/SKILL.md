---
name: release-version
description: Manage version releases and generate changelogs
user_invocable: true
---

# /release-version — Manage Releases & Changelogs

> **Overlay**: if `.claude/skills/release-version/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific instructions (extend-only — overlay can append checks/steps but cannot replace plugin behavior).

## Project context (read FIRST)

Read `.claude/project-config.json`. Extract:
- `git.defaultBase` — integration branch (e.g. `staging`). Steps 6+ reference this.
- `git.hotfixBase` — production branch (e.g. `main`). The release ceremony FFs $hotfixBase from $defaultBase.
- `monday.v1MilestoneEpicIds` — epics gating v1.0 bumps. Step 1 reads all of these.

If `$defaultBase === $hotfixBase` (project has no separate staging branch), the FF-promotion step in Step 6 becomes a no-op — skip the `git push $defaultBase:$hotfixBase` line and tag directly on $hotfixBase.

## Workflow

### Step 1: Identify Target Version + Semver Suggestion

1. Call `mcp__plugin_dev-tasks_dev-tasks__listVersions(group: "upcoming")` to show upcoming versions
2. Display: version name, version number, status, linked item counts
3. Ask user which version to work with:
   - **Existing version** → proceed with that versionId
   - **New version** → call `mcp__plugin_dev-tasks_dev-tasks__createVersion(name, productId, versionNumber, status: "Planned")`
     - Ask for: name, version number, expected release date
     - Optional: release summary, linked epics/tasks

**Semver Suggestion** (when version number is empty or creating new):

> The bump algorithm lives in the plugin at `${CLAUDE_PLUGIN_ROOT}/src/services/version-bump.ts` (compiled to `dist/services/version-bump.js`) as
> `computeBumpSuggestion(input)` — pure, fully unit-tested (46 tests in `src/services/__tests__/version-bump.test.ts`), single
> source of truth. The steps below cover the data the agent gathers + how to
> interpret the result. All gating (v1.0 milestone, breaking changes,
> force-major) is encoded inside `computeBumpSuggestion`, so this skill stays
> a thin orchestration layer.

1. **Gather inputs:**
   - `latestReleased`: `mcp__plugin_dev-tasks_dev-tasks__listVersions(group: "released")` → sort by versionNumber → take highest → parse with `parseSemVer()`.
   - `tasks`: from Step 2's `mcp__plugin_dev-tasks_dev-tasks__getVersion(versionId)` — convert each task's `task_type` to the 3-cat via `classifyTaskType()`. Set `hasBreakingChanges: true` on any task whose description / metadata explicitly flags a breaking change.
   - `v1MilestoneReady`: for each epic ID in `$v1MilestoneEpicIds`, call `mcp__plugin_dev-tasks_dev-tasks__getEpic(id)`. True iff ALL have status `Done`. (If `$v1MilestoneEpicIds` is empty, treat as `true` — no gate configured.)
   - `forceMajor` (optional): only when the user explicitly asked for a release-defining major moment.

2. **Call `computeBumpSuggestion(input)`** — returns `{ next, bumpType, rationale, gatedByMilestone }`.

3. **Surface to the user**:
   - `gatedByMilestone !== null` AND would-have-been major: "v1.0.0 still gated on Beta+Live epics — bumping {bumpType} instead. Confirm v{next}? ({rationale})"
   - `bumpType === 'major'` AND `next.major === 1` (gate passed, 0.x → 1.0): "🎉 Beta + Live epics complete — recommend v{next} (first stable release). Confirm?"
   - Otherwise: "Recommend v{next}. ({rationale}) Confirm?"

4. User confirms or overrides. The user can pass `forceMajor: true` to force a major moment, but the v1.0 gate **also applies to forced majors** — the gate beats force-overrides intentionally (an EU regulator going live shouldn't bypass our own readiness check).

### Step 2: Review Version Contents

1. Call `mcp__plugin_dev-tasks_dev-tasks__getVersion(versionId)` to get full details:
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
2. Call `mcp__plugin_dev-tasks_dev-tasks__generateChangelog(versionId)` with optional params
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
6. Write to Release Summary: `mcp__plugin_dev-tasks_dev-tasks__updateVersion(versionId, releaseSummary: structuredContent)`.

### Step 5: Confirm Release (User Decision)

1. Show final summary: version name, changelog categories, all linked items
2. Ask user: "Ready to mark version {name} as Released?"
3. **If yes** → proceed to Step 6
4. **If no**:
   - Leave as Planned/In Development, user can revisit later
   - Suggest: "Run `/release-version` again when ready"

### Step 6: Promote staging → main + create git tag

> Under the new branching flow (per `release-flow.md`), `staging` is the integration branch — features land there first via PR. A release is the act of **fast-forwarding `main` from `staging`**, applying production migrations, and tagging. The git tag is the single trigger for the rest of the automation: GitHub Release + Monday.com status update + ISR cache revalidation.

**Pre-flight verification** — refuse to release if any of these fail:

1. Working tree clean: `git status --porcelain` returns empty.
2. On `$defaultBase` branch with latest pull: `git checkout $defaultBase && git pull origin $defaultBase`.
3. All linked Monday tasks are status=`Pending Deploy to Prod` with `actualHours` recorded (per Step 3). Tasks already at `Done` from a prior release pass count too. Under the staging-as-base lifecycle, `Done` is set by the tag-triggered GitHub Action — so tasks must still be at `Pending Deploy to Prod` when `/release-version` starts.
4. CI on `staging` is green: `gh run list --branch staging --workflow ci.yml --limit 1` shows `success`.
5. `main` is an ancestor of `staging` (FF will work): `git merge-base --is-ancestor origin/main origin/staging` succeeds.

If any pre-flight fails: stop, report the failure to the user, do NOT proceed.

**Promote main from staging** (the actual release):

6. Verify tag doesn't exist: `git tag -l v{versionNumber}` returns empty.
7. Fetch latest main: `git fetch origin main`.
8. Fast-forward $hotfixBase from $defaultBase: `git push origin $defaultBase:$hotfixBase` (remote-only FF — does NOT require a local checkout). If `$defaultBase === $hotfixBase` (project has no separate staging), skip this step.
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

### Step 8: (removed) — versions are now reactive, not pre-planned

> **Previously**: this skill proactively created a placeholder version for "next release" so PRs landing on staging would have a target.
>
> **Now**: under the historical-versions model ([`versions-lifecycle.md`](../../rules/versions-lifecycle.md)), versions are **created on demand** by the auto-version side-effect when the first task hits `Waiting for UAT`. There's no need to pre-create — the next time a task crosses UAT, a fresh version auto-appears with the right semver bump.
>
> If you want the team to *see* what's planned next, point at epics + sprints (use `getPublicRoadmap` or `listEpics`). If you want to see what's recently shipped + currently shipping, use `getVersionTimeline`. Either way, no manual placeholder creation step is needed.

No action required at this step. Continue to post-conditions.

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
