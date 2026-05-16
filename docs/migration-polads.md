# PolAds migration — dev-tasks plugin v0.8.0

> Cross-repo migration guide. Run these steps in the `v0-politiske-annoncer` repo after this PR lands and v0.8.0 is installed via `/plugin marketplace add` → `/plugin install`.

## What changed

The plugin moved from "STEP-shaped with PolAds-baked-in" → "STEP-shaped with per-product config". The new contract:

- **`project-config.json`** is now consumed by workflow skills (was previously schema-only). Required fields per product: `git.defaultBase`, `monday.productId`, `monday.v1MilestoneEpicIds`, `environments.uat.url`.
- **People mapping** moved from `constants.ts` hardcode → live lookup against Monday board 1612664689. Owner enum dropped (`z.enum(["nate","naref","krmoj"])` → `z.string()`). New team members get auto-included by being added to the People board.
- **Policy hooks** (`bash-guard`, `stop-ci-green-check`) are now always-on — no opt-in needed. Drop them from `hooks.enabled[]`.
- **Skill overlay convention**: each plugin skill reads `<consumer>/.claude/skills/<name>/SKILL.md.local` and appends its content. Use this to inject PolAds-specific examples (24 locales, BRUGER-GUIDE paths, ThemedInput/glass-morphism, Stack Auth, EU Reg 2024/900) without modifying the plugin.
- **Version linkage** is now task-level only. Epic→version linkage is deprecated. `ship-pr` Phase 8 no longer hard-blocks on it.

## Step 1 — Update `.claude/project-config.json`

Replace the file's content with:

```jsonc
{
  "$schema": "../../dev-tasks/plugin/schemas/project-config.schema.json",
  "version": "1",
  "git": {
    "defaultBase": "staging",
    "hotfixBase": "main",
    "branchConvention": "feat/<slug>",
    "worktreeRoot": ".claude/worktrees",
    "autoMergePolicy": {
      "main": "never"
    }
  },
  "monday": {
    "productId": "2723505568",
    "v1MilestoneEpicIds": ["2833952138", "2738006659"]
  },
  "environments": {
    "uat": { "url": "https://test.polads.eu" },
    "prod": { "url": "https://polads.eu" }
  },
  "i18n": {
    "enabled": true,
    "defaultLocale": "en",
    "locales": ["en", "da", "de", "fr", "es", "it", "nl", "pt", "pl", "cs", "sk", "hu", "ro", "bg", "el", "sv", "no", "fi", "et", "lv", "lt", "sl", "hr", "mt"],
    "messagesGlob": "messages/*.json",
    "parityHookMode": "block"
  },
  "ci": {
    "provider": "github-actions",
    "requiredChecks": ["build", "test", "lint"]
  },
  "rules": {
    "extraRules": []
  },
  "hooks": {
    "enabled": [
      "task-state-guard",
      "worktree-required",
      "worktree-path-boundary",
      "branch-task-match",
      "stop-task-check",
      "protect-sensitive-files",
      "pre-commit-secrets-scan",
      "subtask-reminder",
      "auto-file-followup-nudge",
      "post-merge-postmortem",
      "post-push-track",
      "post-push-review-check",
      "post-self-review",
      "pre-compact-task-snapshot",
      "user-prompt-task-context",
      "subprocess-failure"
    ]
  }
}
```

Note: `bash-guard` and `stop-ci-green-check` are removed from `hooks.enabled[]` because they're now STEP-wide policy hooks — always-on, can't be opted out.

Verify the locales array matches your actual `messages/*.json` files — replace this 24-code example with your project's real list.

## Step 2 — Delete obsolete PolAds-local skill/rule/hook copies

After the plugin v0.8.0 install, the plugin owns these. The polads-local copies in `<polads>/.claude/skills/`, `<polads>/.claude/rules/`, and `<polads>/.claude/hooks/` should be deleted **only if** the plugin version is verified working in a sample workflow first.

**Plugin-owned skills (delete polads-local copies):**

```sh
cd /Users/nate/v0-politiske-annoncer/.claude/skills
rm -rf babysit-prs holistic-thinking production-quality-ownership design-consistency triage-feedback create-task log-progress refine-task self-review audit-versions pickup-task release-version ship-pr
```

Keep polads-local skills the plugin doesn't cover: `migrate-check`, `neon-postgres`, `rollback`, `run-e2e`.

**Plugin-owned rules (delete polads-local copies):**

```sh
cd /Users/nate/v0-politiske-annoncer/.claude/rules
rm agent-coordination.md release-flow.md ship-readiness.md meta-workflow.md task-lifecycle.md testing.md worktree-discipline.md versioning.md versions-lifecycle.md
```

Keep polads-local rules the plugin doesn't cover: `admin.md`, `api.md`, `autonomous-loop.md`, `database.md`, `emails.md`, `i18n.md`, `observability.md`, `registration.md`, `security.md`, `sponsor-amount-model.md`, `ui-design.md`.

**Plugin-owned hooks (delete polads-local copies):**

```sh
cd /Users/nate/v0-politiske-annoncer/.claude/hooks
rm bash-guard.sh stop-ci-green-check.sh task-state-guard.sh worktree-required.sh worktree-path-boundary.sh branch-task-match.sh stop-task-check.sh stop-task-logic.py protect-sensitive-files.sh pre-commit-secrets-scan.sh subtask-reminder.sh auto-file-followup-nudge.sh post-merge-postmortem.sh post-push-track.sh post-push-review-check.sh post-self-review.sh pre-compact-task-snapshot.sh user-prompt-task-context.sh subprocess-failure.sh rule-autoload.sh
```

Keep polads-local hooks the plugin doesn't cover: `build-failure-advisor.sh`, `dev-tasks-update-guard.sh`, `i18n-completeness-check.sh`, `pipeline-reminder.sh`, `rag-sync-reminder.sh`, `snapshot-guard.sh`.

## Step 3 — Add PolAds-specific overlays

For each plugin skill that needs PolAds-specific extension, create a `.local` overlay file. Examples below — adjust to taste:

### `.claude/skills/production-quality-ownership/SKILL.md.local`

```markdown
## PolAds-specific cross-coupling map

When a new field lands on the advertiser registration form, the typical surfaces are:

1. `lib/validation/registration-schemas.ts` — Zod schema
2. `lib/db/registration-schema.ts` — Drizzle column
3. `advertiser_snapshot` JSONB shape — capture at submission
4. Backfill SQL for unconfirmed snapshots (never confirmed — hard rule)
5. Publisher sign-off review page (`/sign-off/[token]`) — display
6. Admin detail view (`/admin/advertisements/[id]`) — display
7. Transparency notice (`/[id]`) — display with GDPR filter
8. Public API serializer (`/api/v1/**`, `/api/public/**`) — pass through `lib/utils/gdpr-filter.ts`
9. 24-locale i18n keys
10. Email templates (advertiser + publisher + admin variants)
11. `ReviewStep` summary
12. `docs/BRUGER-GUIDE-REGISTRERING.md` + `rag/embedded/BRUGER-GUIDE-REGISTRERING.md`
13. Integration test + E2E spec

## Regulatory context

PolAds is governed by EU Reg 2024/900 + 2025/1410. For interpretive decisions, the WHY must trace to the rule, decision, or stakeholder ask. Capture in `docs/founder-decisions.md` (or PR description fallback).
```

### `.claude/skills/design-consistency/SKILL.md.local`

```markdown
## PolAds design system

- **Themed primitives**: `<ThemedInput />`, `<ThemedSelect />` (never raw `<input>` / `<select>`)
- **Card surface**: `bg-white/10 backdrop-blur-xl border border-white/20 rounded-xl`
- **Primary CTA**: `bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700`
- **Tooltip surface**: `bg-gray-900/95 backdrop-blur-sm border-white/20 text-white`
- **Page wrapper**: `<main className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 pt-20 pb-10">`
- **Container**: `<div className="max-w-4xl mx-auto px-4">` (or `max-w-6xl` for admin)
- **Top padding for nav clearance**: `pt-20` is the HARD rule per `.claude/rules/ui-design.md`

## Domain component dirs (grep these first)

- `components/registration/` — advertiser registration flows
- `components/admin/` — admin tables, partner management
- `components/sign-off/` — publisher sign-off review (post-PR-86)
- `components/amendment/` — transparency notice amendments
```

### `.claude/skills/self-review/SKILL.md.local`

```markdown
## PolAds user-facing docs mapping

| What changed | Update these files (BOTH copies) |
|---|---|
| Registration flow, form fields, submission process | `docs/BRUGER-GUIDE-REGISTRERING.md` + `rag/embedded/BRUGER-GUIDE-REGISTRERING.md` |
| Admin dashboard, partner management, complaints | `docs/BRUGER-GUIDE-ADMIN-DASHBOARD.md` + `rag/embedded/BRUGER-GUIDE-ADMIN-DASHBOARD.md` |
| Registration user guide (English) | `docs/USER-GUIDE-REGISTRATION.md` + `rag/embedded/BRUGER-GUIDE-REGISTRERING.md` |
```

## Step 4 — Verify

In the PolAds Claude Code session:

1. `/plugin uninstall dev-tasks@dev-tasks-marketplace`
2. `/plugin install dev-tasks@dev-tasks-marketplace` (forces the v0.8.0 cache)
3. `/reload-plugins`
4. Invoke `/dev-tasks:pickup-task` on a small task — the skill should:
   - Read `project-config.json` and quote `staging` / `2723505568` / your v1 epic IDs
   - Resolve your `whoami` via the People board (not the old hardcoded map)
   - Not block on epic→version linkage (task-level now)
5. Verify `bash-guard` still gates a `git push --force` attempt and a pre-self-review `git commit` even though it's no longer in `hooks.enabled[]`. If it doesn't gate, the always-on promotion didn't take effect — check plugin install path / version.

## Rollback

If something breaks:

```
/plugin uninstall dev-tasks@dev-tasks-marketplace
/plugin install dev-tasks@dev-tasks-marketplace --version 0.7.0
/reload-plugins
```

The 0.7.0 release has the old constants-based people map and opt-in policy hooks. You can roll forward again once issues are resolved.
