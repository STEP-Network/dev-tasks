---
name: self-review
description: Run iterative 10-point code review until all checks pass
user_invocable: true
---

# /self-review — Iterative Post-Implementation Code Review

> **Overlay**: if `.claude/skills/self-review/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific instructions (extend-only — overlay can append checks/steps but cannot replace plugin behavior).

## IMPORTANT: This skill MUST run automatically

You MUST invoke `/self-review` automatically after finishing implementation work — do NOT wait for the user to ask. This is a mandatory gate before `/ship-pr`.

## Ship-readiness principle (read this before running)

The goal of self-review is to catch **real issues that would harm production, users, or future maintainers** — not to polish every line until it's perfect. The 10-point checklist below has hard rules for things that genuinely matter (security, correctness, data integrity, i18n completeness). Everything beyond that is a judgment call.

**Before marking anything FAIL, ask:**
1. **What concretely goes wrong if this ships unchanged?** If the answer is "nothing" or "hypothetical scenario with no evidence of occurrence" → do NOT FAIL the check.
2. **Is this something a careful engineer would write as follow-up work, or something that genuinely blocks merge?** Follow-up work → PASS; merge-blocker → FAIL.

**Categories of findings that should PASS, not FAIL:**
- Style preferences not enforced by lint (variable naming, test organization, comment wording)
- Speculative defensive code for scenarios that can't happen given upstream validation
- Premature optimization (memoization, caching) without profiling evidence
- Missing docstrings on self-documenting code
- Pattern consistency nitpicks on code that works and is understandable

**Categories of findings that MUST FAIL:**
- Auth bypass, secret exposure, client-controlled auth data
- Wrong logic that produces incorrect output for a real input
- Mutation of immutable state, dropped writes, race conditions with evidence
- PII/GDPR exposure on public pages
- Missing i18n keys in the 23 non-EN locales (hard rule, hook-enforced)
- Missing required tests (per the tier rules below)
- Stale user-facing docs after behavior change

See `ship-readiness.md` for the full principle.

## Workflow (Iterative — repeat until clean)

0. **Reset review flag**: Read `.claude/active-task.json` and set `"selfReviewPassed": false` to clear any stale value from a prior pass.
1. **Get diff**: Run BOTH:
   - `git diff $defaultBase...HEAD` — captures all branch changes (committed). For hotfix branches off `$hotfixBase`, use `git diff $hotfixBase...HEAD` instead.
   - `git diff HEAD` — captures uncommitted/unstaged changes
   Combine these for the full picture of what this branch introduces.
2. **Fetch Corridor findings (external security scan)**: Call `mcp__plugin_corridor_corridor__getFindings({ cwd: "<project root>", state: "open", excludeAIFalsePositives: true })`. These are findings from Corridor's PR scanner / static analysis on this branch. Treat them as a parallel input to the self-reviewer agent — see Check #11 below for triage rules.
3. **Spawn self-reviewer agent**: Use `Task` tool with `subagent_type: "self-reviewer"` to run the 10-point checklist against all changed files. The agent must NOT edit files — it only reports findings. Remind the agent of the ship-readiness principle in the prompt. Pass the Corridor findings list (file paths + severity) so the agent can correlate.
4. **Evaluate results**:
   - If **all 10 PASS** AND Corridor has zero open BLOCKER findings on this branch: proceed to step 6
   - If **any FAIL** OR any Corridor BLOCKER remains: proceed to step 5
5. **Fix all findings classified as FAIL**: Apply fixes for self-reviewer FAILs and Corridor BLOCKERs. For Corridor POLISH findings being declined, call `mcp__plugin_corridor_corridor__updateFindingState({ findingId, state: "closed", closedReasonCategory: "risk_accepted", closedReason: "<one-line rationale>" })` — this keeps the dashboard clean. Then **go back to step 1** (re-run the full review on the updated diff). Do NOT skip re-review — fixes can introduce new issues.
6. **Mark self-review passed in state file**: Read `.claude/active-task.json` and set `"selfReviewPassed": true` with `"selfReviewPassedAt": "<ISO 8601>"`.
7. **Post REVIEW_COMPLETED event** via `/log-progress REVIEW_COMPLETED`

**No hard iteration cap.** The loop terminates when the self-reviewer reports zero FAILs (i.e. no BLOCKERs remaining per the ship-readiness triage). A late iteration can legitimately catch a BLOCKER introduced by an earlier fix — we always want to fix that.

**Each iteration must be critical, not mechanical.** When evaluating the self-reviewer's report:
- Apply the BLOCKER / IMPROVEMENT / POLISH triage from `ship-readiness.md`
- Mark as FAIL only genuine BLOCKERs (security, correctness, data integrity, missing tests/i18n/docs)
- Non-blocker findings (style, speculative, premature optimization) are PASS with a note
- If uncertain between BLOCKER and POLISH: lean BLOCKER when security/correctness is plausibly at stake; lean POLISH when the concern is aesthetic

**Regression-loop escalation (not a cap)**: if three consecutive iterations each introduce a NEW BLOCKER that wasn't present in the previous iteration, the implementation may be architecturally wrong. Stop iterating, post `/log-progress TASK_STUCK`, and ask the user for direction. Good loops fixing real issues continue freely.

## 10-Point Checklist

| # | Category | Check |
|---|----------|-------|
| 1 | **Types** | No `any` types, proper TypeScript annotations |
| 2 | **Security + Visual** | Auth checks on API routes, no exposed secrets, input validation. **For UI/UX changes**: before/after visual verification — see Check #2 detailed rules below + `.claude/rules/testing.md` Visual Validation section. Mark FAIL on any UI diff that wasn't visually verified end-to-end. |
| 3 | **Snapshots** | No mutations to Confirmed snapshots, proper two-stage creation |
| 4 | **GDPR** | No PII exposure on public pages, gdpr-filter.ts used correctly |
| 5 | **Optimistic Updates** | Proper onMutate/onError/onSettled, matching queryKeys |
| 6 | **UI** | Themed wrappers used over raw HTML primitives. **No variable names as user-facing labels** — every button text, heading, placeholder, error message, and link label is human-readable language, NOT a programming identifier. See Check #6 detailed rules below. |
| 7 | **i18n** | If `project-config.i18n.enabled = true`: t()/t.rich() used, no hardcoded strings, ALL configured locales updated with PROPER NATIVE TRANSLATIONS (spot-check 3+ non-default locales to verify native text). If i18n is off, mark N/A. |
| 8 | **Tests** | Concrete rules — mark FAIL if ANY violated (see details below) |
| 9 | **Docs** | Concrete rules — mark FAIL if ANY violated (see details below) |
| 10 | **Database** | Migration generated if schema changed, cascade deletes intact, indexes added |
| 11 | **Corridor findings** | Zero open BLOCKER findings on this branch (see detailed rules below) |

### Check #8 — Tests (Detailed Rules)

**All applicable tiers are MANDATORY** for any feature or bug fix:

1. **Unit tests** (`__tests__/lib/`): Validation schemas, utility functions, data transforms
2. **Integration tests** (`__tests__/api/`): API routes with real database operations
3. **E2E Playwright tests** (`e2e/`): User-facing flows exercised through the browser
4. **Accessibility tests** (`e2e/accessibility.spec.ts`): WCAG-A + WCAG-AA via `@axe-core/playwright`. STEP-wide policy per `testing.md` Accessibility Testing section.
5. **Cross-browser** (Chromium + Firefox + WebKit) for tests under `e2e/critical/`. Mobile viewports (Pixel 7 + iPhone 14) for tests under `e2e/mobile/`. Configured via `playwright.config.ts` projects.
6. **Performance budgets** (`e2e/performance.spec.ts`): Web Vitals (LCP, CLS, INP) within configured budgets on user-facing pages.
7. **Claude-in-Chrome MCP tests** (optional): Browser automation for complex UI interactions.

Mark FAIL if ANY of these are violated:
- New API route (`app/api/**/*.ts`) → MUST have unit test AND integration test in `__tests__/api/`
- New hook (`lib/hooks/*.ts`) → MUST have test in `__tests__/hooks/`
- New/changed UI flow → MUST have E2E test in `e2e/` (place in `e2e/critical/` if cross-browser coverage warranted)
- New/changed user-facing page → MUST have a11y test entry in `e2e/accessibility.spec.ts` `PAGES_UNDER_TEST` array
- UI/email template changes → MUST have run `/dev-tasks:visual-diff` (see Check #2)
- Bug fix → MUST have regression test covering the fixed behavior
- Modified business logic (validation, data transforms, auth) → existing tests MUST be updated
- New schema field → MUST have integration test verifying storage, update, and retrieval
- Performance-sensitive change (route changes, new dependencies, bundle additions) → MUST verify `e2e/performance.spec.ts` budgets still pass
- **"N/A" only valid for**: pure config/infra changes (`.claude/`, `CLAUDE.md`), documentation-only, i18n-only locale additions
- If claiming "N/A", the reviewer MUST state WHY with the specific exemption category

### Running the tests — delegate to e2e-tester subagent

For non-trivial test runs (full E2E suite, cross-browser sweep, a11y suite, perf suite), delegate to `dev-tasks:e2e-tester` instead of running inline:

```
Agent({
  description: "Run E2E suite for self-review",
  subagent_type: "dev-tasks:e2e-tester",
  prompt: "Run the full e2e suite via the project's pnpm test:e2e script. Report pass/fail counts per project (chromium/firefox/webkit/mobile-*). Surface failures with stack traces. Don't edit any files."
})
```

The subagent reads `playwright.config.ts` + `package.json` to find the right invocation, runs against `environments.uat.url` or a passed-in URL, and returns structured results. Self-review marks Check #8 PASS only if the subagent reports zero failures across all required projects.

For Phase 3 of `e2e-masterplan.md` (auto-promote past UAT), the e2e-tester subagent's output feeds the confidence score.

### Check #2 — Visual Verification (Detailed Rules)

For any UI/UX diff (changes under `components/**`, `app/**/page.tsx`, `app/**/layout.tsx`, `lib/email/*-templates.tsx`, or any styling file):

1. **Before snapshot**: capture the affected page/component in its current state. Use whichever is available, in this order of preference:
   - `mcp__claude-in-chrome__*` browser MCP — open the page, take a screenshot
   - Vercel preview URL from the PREVIOUS PR / staging deploy — `gh pr view {prev} --json …` or hit the public staging URL directly
   - Playwright via Bash against a local dev server (if one is running)
   - Skip with documented reason if none reachable

2. **Apply the change** (your edits already in the diff)

3. **After snapshot**: capture the same page/component, same viewport, same login state. Same tooling as step 1.

4. **Read both screenshots with the `Read` tool** (it supports images natively). Compare them in plain language:
   - **Intended changes present?** — every acceptance-criterion bullet that has a visual component must be visible in the After.
   - **Unintended changes?** — anything that changed visually that the diff doesn't justify (e.g. spacing on adjacent components, padding regressions, text overflow, color drift). These are regressions in scope and MUST be addressed.

5. **For multi-state surfaces** (forms with empty/filled/error states, modals with open/closed, lists with empty/populated): capture each state, not just the happy path.

6. **For multi-viewport / multi-theme** (mobile/desktop, dark/light): if the change touches viewport-conditional or theme-conditional code, verify at least 2 viewport widths AND both themes.

Mark FAIL if:
- The diff touches UI files AND no visual verification was performed
- The After shows the intended changes but ALSO shows unintended visual deltas in surrounding components
- The Before couldn't be captured (e.g. no reachable preview / dev server) AND the agent didn't document why

Mark PASS with note if visual verification was skipped for documented reasons (e.g. "build-time-only change — no rendered surface affected").

The `/dev-tasks:visual-diff` skill (v0.8.11+) orchestrates this workflow if you want to invoke it explicitly.

### Check #6 — UI (Detailed Rules)

Two distinct sub-checks:

**6a. Themed wrappers over raw HTML primitives.** Project's themed component (per `.claude/rules/ui-design.md`) used over raw `<input>` / `<select>` / `<button>` / etc. Grep the diff:

```bash
git diff $defaultBase...HEAD -- '*.tsx' '*.jsx' | grep -nE '<(input|select|textarea)[^>]'
```

Each hit is a candidate raw-HTML primitive — the project's themed wrapper (e.g. `<ThemedInput />`) should be used unless documented exception applies.

**6b. NO VARIABLE NAMES AS USER-FACING LABELS.** This is a recurring failure mode worth its own subcheck. Every button text, heading, placeholder, error message, link label, tooltip, and modal title must be HUMAN-READABLE LANGUAGE, not a programming identifier.

Mark FAIL on any of these patterns:

| Anti-pattern | Why it's wrong | Fix |
|---|---|---|
| `<button>submitForm</button>` | camelCase variable name | `<button>Submit</button>` or `t('common.submit')` |
| `<label>first_name</label>` | snake_case schema key | `<label>First name</label>` or `t('registration.firstName')` |
| `<h1>user-profile-page</h1>` | kebab-case route name | `<h1>Your profile</h1>` or `t('profile.title')` |
| `placeholder="userEmail"` | camelCase as placeholder | `placeholder="you@example.com"` |
| `<Toast>{errorCode}</Toast>` | raw error-code constant | localized error message via t() with the code as context |
| `{user.email_verified ? 'true' : 'false'}` | raw boolean as user text | `{user.email_verified ? 'Verified' : 'Not verified'}` (or via t()) |
| `aria-label="btn-submit"` | identifier in a11y label | `aria-label="Submit form"` (still localized if i18n on) |

Triage when found:
- If i18n is enabled (`project-config.i18n.enabled = true`): the label should be `t('namespace.key')` with the human translation in `messages/{locale}.json`. Adding the hardcoded English is acceptable as a SCAFFOLD only if the locale keys are added in the SAME commit.
- If i18n is off: the label is a string literal, but it MUST read as natural human text — capitalized appropriately, no underscores/camelCase, full words.

Grep helper:

```bash
# Find suspicious labels — quoted strings inside JSX tags or label props
git diff $defaultBase...HEAD -- '*.tsx' '*.jsx' | grep -nE '(label|placeholder|title|aria-label)=["\047][a-z]+([_-][a-z]+|[A-Z][a-z]+)+["\047]'
git diff $defaultBase...HEAD -- '*.tsx' '*.jsx' | grep -nE '>[a-z]+[A-Z][a-z]+<'
```

The greps catch most cases. Visual verification in Check #2 catches the rest (the strings render as gibberish in the screenshot, immediately visible).

### Check #11 — Corridor Findings (Detailed Rules)

Corridor's static-analysis scanner posts security findings on every PR. They're a separate input from the self-reviewer agent — same triage framework applies (`ship-readiness.md`):

- **BLOCKER (severity: critical/high; security/correctness)**: must fix before merge. Mark Check #11 as FAIL and apply the fix.
- **IMPROVEMENT (severity: medium; small fix, real win)**: fix if cheap. Mark FAIL only if explicitly worth fixing in this PR.
- **POLISH (severity: low; speculative or stylistic)**: decline via `updateFindingState` with category `"risk_accepted"` (or `"false_positive"` if it doesn't apply). Mark Check #11 PASS with a note listing declined IDs.

If Corridor returns zero open findings on this branch, mark PASS with note "no findings".

If `mcp__plugin_corridor_corridor__getFindings` errors (e.g. project not yet scanned, MCP unreachable, network error), do NOT block the self-review — mark Check #11 PASS with note "Corridor unavailable: <error>". Corridor's own Stop hook will still gate session exit if `CORRIDOR_BLOCKING_STOP_HOOKS=true`.

### Check #9 — Docs (Detailed Rules)

Mark FAIL if ANY of these are violated:
- New/changed API endpoint → update `docs/API_DOCUMENTATION.md`
- Schema changes → update `docs/ARCHITECTURE.md` (entity section)
- Changed auth/security pattern → update `docs/ARCHITECTURE.md` (security section)
- Changed skill or workflow → update the matching `.claude/skills/*.md` file
- Changed domain pattern → update matching `.claude/rules/*.md` file
- **"N/A" only valid for**: internal refactors with no behavior change, test-only changes
- If claiming "N/A", the reviewer MUST state WHY with the specific exemption category

**User Guides & RAG Knowledge Base** (project-specific):

If the consumer maintains user-facing docs and/or a RAG knowledge base, the project should declare which files must be updated when user-facing behavior changes. List them in `.claude/skills/self-review/SKILL.md.local` (overlay) under a "User-facing docs mapping" section. The plugin enforces no specific paths — that's product-specific.

Generic rule: any change that affects user-facing behavior MUST update the matching user-facing documentation (and any embedded copies the project uses for chat/search). Mark FAIL if user-facing behavior changed but these files weren't updated.

## Output Format (per iteration)

```
Self-Review Iteration N:
  ✅ Types — PASS
  ✅ Security — PASS
  ❌ i18n — FAIL: components/registration/steps/NewStep.tsx:42 — hardcoded string "Submit"
  ...

Overall: 9/10 PASS, 1 FAIL
Action: Fixing i18n issue, then re-reviewing...
```

Final output when clean:
```
Self-Review PASSED (iteration N):
  ✅ All 10 checks pass
  State file updated: selfReviewPassed = true
  Proceeding to /log-progress REVIEW_COMPLETED
```

## Step 7: Auto-chain to /ship-pr

After self-review passes and REVIEW_COMPLETED is posted, **automatically invoke `/ship-pr`**.
Do NOT wait for user instruction. The enforced pipeline is: self-review → ship-pr → review loop.
This is MANDATORY for any session with source file changes.

## After PASS — conditional ownership pass

If ANY of these criteria match the diff, invoke `/dev-tasks:production-quality-ownership` as a second-pass ownership check BEFORE setting `selfReviewPassed: true`:

- Diff touches ≥3 system surfaces (e.g. component + API + schema + email template + locale keys)
- Schema migration is included (any file under `lib/db/**` schema, `drizzle/**`, `prisma/**`, or equivalent)
- Multi-role UI change (the same data is shown to ≥2 audience roles — admin/user/public/partner — and any of those views was edited)
- Multi-locale email template change
- The task is the Nth attempt at the same surface (recurring class — look at git log + Monday history)
- Acceptance criteria mention "ensure", "all", "every", or list ≥5 bullets

Otherwise (small, single-surface, mechanical diffs): skip the ownership pass — running it adds ~500 tokens for marginal value on a Bugfix that touched one file.

The ownership pass is a 7-question checklist. Its purpose is catching "compiles but incomplete" — work that passes the 10-point review but missed a cross-surface or stakeholder-readability dimension. Run only when those dimensions are actually at risk.

## Post-Conditions

- `selfReviewPassed: true` set in `.claude/active-task.json`
- `/log-progress REVIEW_COMPLETED` posted to Monday.com
- `/ship-pr` auto-invoked (enforced pipeline)

## When to Auto-Invoke

You MUST automatically run `/self-review` when ALL of these are true:
1. You have finished implementing the current piece of work (subtask or full task)
2. You have made changes to project files (any `.ts`, `.tsx`, `.js`, `.jsx`, locale files, or other source files — NOT limited to just "code")
3. You have NOT yet run `/ship-pr`

Skip ONLY if the session was purely read-only (no file modifications at all) or only touched `.claude/` infrastructure files.

**Do NOT wait for the user to say "review your code" — this runs automatically as part of the autonomous workflow.**
