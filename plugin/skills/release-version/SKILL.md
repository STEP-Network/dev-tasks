---
name: release-version
description: Manage version releases and generate changelogs
user_invocable: true
---

# /release-version — Manage Releases & Changelogs

Read `.claude/project-config.json`. Extract `git.defaultBase`, `git.hotfixBase`, `monday.v1MilestoneEpicIds`. If `$defaultBase === $hotfixBase` (no separate staging), Step 6 FF-promotion becomes a no-op — skip the `git push $defaultBase:$hotfixBase` line and tag directly on `$hotfixBase`.

## Workflow

### Step 1: Identify version + semver suggestion

1. `listVersions(group: "upcoming")` — show upcoming versions.
2. Ask which version, or create new via `createVersion(name, productId, versionNumber, status: "Planned")`.

**Semver Suggestion** (when number empty or creating new):

Bump algorithm lives at `${CLAUDE_PLUGIN_ROOT}/src/services/version-bump.ts` → `computeBumpSuggestion(input)`. Pure, unit-tested (46 tests in `src/services/__tests__/version-bump.test.ts`). All gating (v1.0 milestone, breaking changes, force-major) is encoded inside.

1. Gather inputs:
   - `latestReleased`: `listVersions(group: "released")` → sort by versionNumber → highest → `parseSemVer()`
   - `tasks`: from Step 2's `getVersion(versionId)` — convert each task's `task_type` via `classifyTaskType()`. Set `hasBreakingChanges: true` on tasks explicitly flagging one.
   - `v1MilestoneReady`: for each epic in `$v1MilestoneEpicIds`, call `getEpic(id)`. True iff ALL `Done`. Empty array → true.
   - `forceMajor` (optional): only when user explicitly asked.

2. Call `computeBumpSuggestion(input)` → returns `{ next, bumpType, rationale, gatedByMilestone }`.

3. Surface to user. `gatedByMilestone !== null` AND would-be major → "v1.0.0 still gated — bumping {bumpType} instead". `bumpType === 'major'` AND `next.major === 1` → "🎉 first stable release". Otherwise → "Recommend v{next}".

4. User confirms or overrides. `forceMajor` still subject to v1.0 gate intentionally.

### Step 2: Review version contents

1. `getVersion(versionId)` for: linked tasks (status, type), epics (status), bugs (status), changelog doc.
2. Show summary: version, status, item counts, done/total, in-progress items.
3. Warn if incomplete.
4. Re-verify semver: feature in a patch → warn; fixes only in a minor → note fine.

### Step 3: Pre-release checklist

- All linked tasks `Pending Deploy to Prod` (or already `Done` from prior pass)
- All linked bugs Fixed
- Nothing `In Progress` or `Waiting for UAT` (need UAT signoff first)

If any fail: warn, ask whether to proceed.

### Step 4: Generate changelog + structured Release Summary

1. Ask user for optional `highlights`, `breakingChanges`, `knownIssues`.
2. `generateChangelog(versionId)` auto-categorizes into a Monday Doc (Development → Added; Bugfix → Fixed; Maintenance/Refine → Changed; Documentation → Documentation).
3. Doc attached to version (internal/team use).

**Build Structured Release Summary** (canonical 3-cat — established 2026-05-07):
- Development → `feature`
- Bugfix → `fix`
- Maintenance / Refine / Documentation / PM-work → `improvement`
- Use `Public Task Name` (column `text_mm349ah6`) if filled, else internal task name.
- Include `highlights`, `breakingChanges`, `progress`.
- Wrap in `STRUCTURED_CHANGELOG_V1` markers.
- Write via `updateVersion(versionId, releaseSummary: structuredContent)`.

Legacy 4-cat data is auto-migrated by the parser on read; writes from this skill must be 3-cat.

### Step 5: Confirm release

Show final summary. Ask "Ready to mark version {name} as Released?" Yes → Step 6. No → leave as Planned/In Development.

### Step 6: Promote $defaultBase → $hotfixBase + tag

The release ceremony FFs `$hotfixBase` from `$defaultBase`, applies prod migrations, tags. The git tag is the single trigger for GitHub Release + Monday status update + ISR revalidation.

**Pre-flight verification** — refuse if any fail:
1. Working tree clean: `git status --porcelain` empty.
2. On `$defaultBase` with latest pull: `git checkout $defaultBase && git pull origin $defaultBase`.
3. All linked tasks `Pending Deploy to Prod` (or `Done` from prior pass) with `actualHours`. Under staging-as-base, `Done` is set by the `complete-released-tasks` step if the consumer has adopted it (opt-in — see Step 6 below, not automatic just from installing the plugin).
4. CI on `$defaultBase` green: `gh run list --branch $defaultBase --workflow ci.yml --limit 1`.
5. `$hotfixBase` ancestor of `$defaultBase`: `git merge-base --is-ancestor origin/$hotfixBase origin/$defaultBase`.

If any pre-flight fails: stop, report, do NOT proceed.

**Promote**:
6. Verify tag doesn't exist: `git tag -l v{versionNumber}` empty.
7. `git fetch origin $hotfixBase`.
8. FF `$hotfixBase` from `$defaultBase`: `git push origin $defaultBase:$hotfixBase` (remote-only FF). If `$defaultBase === $hotfixBase`, skip. On non-fast-forward error: `$hotfixBase` diverged (hotfix landed there but not merged back) — stop, ask user, do NOT force-push.
9. Apply migrations to production: `pnpm migrate:prod` against `DATABASE_URL_UNPOOLED` set to prod Neon. If fails: prod schema out-of-sync with `$hotfixBase` HEAD — roll back via `git push origin <prev-sha>:$hotfixBase --force-with-lease` (only if no intervening commits) OR fix forward. Escalate.
10. `git tag -a v{versionNumber} -m "Release v{versionNumber}: {name}" && git push origin v{versionNumber}`.
11. Tag push triggers `.github/workflows/release.yml`: Monday status → Released, GitHub Release, ISR revalidation. If the consumer has adopted `plugin/templates/github-workflows/complete-released-tasks-step.yml.example`, the same tag push also flips every task at `Pending Deploy to Prod` under this product to `Done` + posts a release note (same logic, runnable locally, at `plugin/scripts/complete-released-tasks.ts`). This is opt-in per consumer — it does not happen just because the plugin is installed.
12. Do NOT update Monday status manually — tag push is the single trigger.

### Step 7: Verify release

1. `gh run list --workflow=release.yml --limit 1`
2. `gh release view v{versionNumber}`
3. Report: tag pushed, action triggered, GitHub Release URL, Monday will update automatically, changelog page refreshes within 5 min (or instantly if revalidation endpoint configured).

### Step 8: (removed — versions are reactive)

Under the historical-versions model, `auto-version.ts` creates fresh versions on demand at `Waiting for UAT`. No manual pre-creation. For "what's planned next" use epics + sprints (`getPublicRoadmap` / `listEpics`); for shipping state use `getVersionTimeline`.

## Arguments

- `<version-id>` (optional): version ID to work with directly.

## Post-Conditions

- Changelog Doc attached (internal)
- Release Summary in 3-cat shape (public, on website)
- `$hotfixBase` fast-forwarded from `$defaultBase`
- Production migrations applied
- Git tag pushed (triggers automation)
- GitHub Release created; Monday status `Released`; ISR revalidated
