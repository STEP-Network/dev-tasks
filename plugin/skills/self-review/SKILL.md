---
name: self-review
description: Run iterative 10-point code review until all checks pass
user_invocable: true
---

# /self-review — Iterative Post-Implementation Code Review

You MUST invoke `/self-review` automatically after finishing implementation. Mandatory gate before `/ship-pr`.

## Ship-readiness principle

Mark FAIL only when concrete production/user/maintainer harm. Style preferences, speculative defensive code, premature optimization, missing docstrings on self-documenting code, pattern nits → PASS. Auth bypass, wrong logic, dropped writes, PII leaks, missing i18n keys in configured locales, missing required tests, stale user-facing docs after behavior change → FAIL. Full triage in `ship-readiness.md`.

## Workflow (iterative)

0. Read `.claude/active-task.json`; set `selfReviewPassed: false`.
1. Get diff: `git diff $defaultBase...HEAD` (use `$hotfixBase` for hotfix branches) AND `git diff HEAD` (uncommitted).
2. Fetch Corridor findings: `mcp__plugin_corridor_corridor__getFindings({ cwd, state: "open", excludeAIFalsePositives: true })`.
3. Spawn `Task` with `subagent_type: "self-reviewer"` to run the checklist. Agent reports only — does NOT edit. Pass Corridor findings for correlation.
4. If all 10 PASS AND zero Corridor BLOCKERs → step 6. Otherwise step 5.
5. Fix FAILs + Corridor BLOCKERs. For Corridor POLISH being declined, call `updateFindingState({ findingId, state: "closed", closedReasonCategory: "risk_accepted", closedReason })`. Re-run from step 1 — no skip; fixes can introduce new issues.
6. Set `selfReviewPassed: true` + `selfReviewPassedAt` in state file.
7. `/log-progress REVIEW_COMPLETED`.

No hard iteration cap. Regression-loop escalation: 3 consecutive iterations each introducing a NEW BLOCKER → `/log-progress TASK_STUCK`.

## 10-Point Checklist

| # | Category | Check |
|---|----------|-------|
| 1 | Types | No `any`, proper TypeScript annotations |
| 2 | Security + Visual | Auth on routes, no exposed secrets, input validation. UI/UX diff → `/dev-tasks:visual-diff` required |
| 3 | Snapshots | No mutations to Confirmed snapshots, proper two-stage creation |
| 4 | GDPR | No PII on public pages, `gdpr-filter.ts` used correctly |
| 5 | Optimistic Updates | Proper `onMutate`/`onError`/`onSettled`, matching `queryKeys` |
| 6 | UI | Themed wrappers over raw HTML. Every UI label must be human-readable, not a variable identifier |
| 7 | i18n | If `project-config.i18n.enabled = true`: `t()`/`t.rich()`, no hardcoded strings, ALL configured locales updated with proper native translations (spot-check 3+). Else N/A |
| 8 | Tests | Tier rules below — FAIL if any violated |
| 9 | Docs | Rules below — FAIL if any violated |
| 10 | Database | Migration generated if schema changed, cascade deletes intact, indexes added |
| 11 | Corridor | Zero open BLOCKER findings (or POLISH closed via `updateFindingState`) |

## Check #8 — Tests (rules)

Mark FAIL if ANY violated:
- New API route → unit test in `__tests__/lib/` AND integration test in `__tests__/api/`
- New hook in `lib/hooks/*.ts` → test in `__tests__/hooks/`
- New/changed UI flow → E2E test in `e2e/` (`e2e/critical/` for cross-browser)
- New/changed user-facing page → a11y entry in `e2e/accessibility.spec.ts` `PAGES_UNDER_TEST`
- UI/email template changes → `/dev-tasks:visual-diff` run (see Check #2)
- Bug fix → regression test
- Modified business logic → existing tests updated
- New schema field → integration test covering storage/update/retrieval
- Performance-sensitive change → `e2e/performance.spec.ts` budgets verified

"N/A" only valid for: pure config/infra (`.claude/`, `CLAUDE.md`), docs-only, locale-only. Reviewer must cite the exemption category.

Delegate full E2E/cross-browser/a11y/perf runs to `dev-tasks:e2e-tester`. Self-review passes Check #8 only on zero failures across required projects.

## Check #2 — Visual verification

Use `/dev-tasks:visual-diff` for the full Before/After workflow. Mark FAIL if diff touches UI files but no visual verification was performed, OR After shows unintended deltas in surrounding components, OR Before couldn't be captured without documented reason.

## Check #6 — UI (rules)

**6a. Themed wrappers.** Grep diff for raw primitives:
```bash
git diff $defaultBase...HEAD -- '*.tsx' '*.jsx' | grep -nE '<(input|select|textarea)[^>]'
```
Each hit is a candidate — project's themed wrapper required unless documented exception.

**6b. No variable names as labels.** Every UI label must be human-readable, not a programming identifier. If i18n enabled, use `t('namespace.key')` with translation in `messages/{locale}.json`. If off, string literal must be natural human text (capitalized, no underscores/camelCase). Visual verification in Check #2 catches what greps miss.

## Check #11 — Corridor (rules)

Triage per `ship-readiness.md`:
- BLOCKER (critical/high; security/correctness) → FAIL, fix
- IMPROVEMENT (medium; small fix, real win) → FAIL only if worth fixing
- POLISH (low; speculative/stylistic) → close via `updateFindingState` with `risk_accepted` or `false_positive`, PASS with note

Zero findings → PASS "no findings". MCP error → PASS "Corridor unavailable: <error>" (Corridor's own Stop hook gates if `CORRIDOR_BLOCKING_STOP_HOOKS=true`).

## Check #9 — Docs (rules)

FAIL if ANY violated:
- New/changed API endpoint → update `docs/API_DOCUMENTATION.md`
- Schema changes → update `docs/ARCHITECTURE.md` (entity section)
- Changed auth/security → update `docs/ARCHITECTURE.md` (security section)
- Changed skill/workflow → update matching `.claude/skills/*.md`
- Changed domain pattern → update matching `.claude/rules/*.md`

"N/A" valid only for: internal refactors with no behavior change, test-only changes. Reviewer must cite category.

Consumer-specific user-guide/RAG mappings belong in `.claude/skills/self-review/SKILL.md.local`.

## Output (per iteration)

```
Self-Review Iteration N:
  ✅ Types — PASS
  ❌ i18n — FAIL: components/.../NewStep.tsx:42 — hardcoded "Submit"
  ...
Overall: 9/10 PASS, 1 FAIL
```

On clean:
```
Self-Review PASSED (iteration N): selfReviewPassed = true → /log-progress REVIEW_COMPLETED
```

## After PASS — conditional ownership pass

If ANY match, invoke `/dev-tasks:production-quality-ownership` BEFORE setting `selfReviewPassed: true`:
- Diff touches ≥3 system surfaces
- Schema migration included
- Multi-role UI change
- Multi-locale email template change
- Nth attempt at same surface
- AC mentions "ensure"/"all"/"every", or ≥5 bullets

Otherwise skip — overhead for marginal value on small mechanical diffs.

## Auto-chain

After PASS + REVIEW_COMPLETED, auto-invoke `/ship-pr`. Do NOT wait for user.

## Auto-Invoke

Run automatically when: implementation finished AND source files modified AND `/ship-pr` not yet run. Skip only for purely read-only sessions or `.claude/`-only edits.

## Post-Conditions

- `selfReviewPassed: true` in `.claude/active-task.json`
- `/log-progress REVIEW_COMPLETED` posted
- `/ship-pr` auto-invoked
