---
name: self-review
description: Run iterative 10-point code review until all checks pass
user_invocable: true
---

# /self-review — Iterative Post-Implementation Code Review

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
   - `git diff main...HEAD` — captures all branch changes (committed)
   - `git diff HEAD` — captures uncommitted/unstaged changes
   Combine these for the full picture of what this branch introduces.
2. **Fetch Corridor findings (external security scan)**: Call `mcp__corridor__getFindings({ cwd: "<project root>", state: "open", excludeAIFalsePositives: true })`. These are findings from Corridor's PR scanner / static analysis on this branch. Treat them as a parallel input to the self-reviewer agent — see Check #11 below for triage rules.
3. **Spawn self-reviewer agent**: Use `Task` tool with `subagent_type: "self-reviewer"` to run the 10-point checklist against all changed files. The agent must NOT edit files — it only reports findings. Remind the agent of the ship-readiness principle in the prompt. Pass the Corridor findings list (file paths + severity) so the agent can correlate.
4. **Evaluate results**:
   - If **all 10 PASS** AND Corridor has zero open BLOCKER findings on this branch: proceed to step 6
   - If **any FAIL** OR any Corridor BLOCKER remains: proceed to step 5
5. **Fix all findings classified as FAIL**: Apply fixes for self-reviewer FAILs and Corridor BLOCKERs. For Corridor POLISH findings being declined, call `mcp__corridor__updateFindingState({ findingId, state: "closed", closedReasonCategory: "risk_accepted", closedReason: "<one-line rationale>" })` — this keeps the dashboard clean. Then **go back to step 1** (re-run the full review on the updated diff). Do NOT skip re-review — fixes can introduce new issues.
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
| 2 | **Security** | Auth checks on API routes, no exposed secrets, input validation |
| 3 | **Snapshots** | No mutations to Confirmed snapshots, proper two-stage creation |
| 4 | **GDPR** | No PII exposure on public pages, gdpr-filter.ts used correctly |
| 5 | **Optimistic Updates** | Proper onMutate/onError/onSettled, matching queryKeys |
| 6 | **UI** | ThemedInput/ThemedSelect used, glass-morphism patterns, no raw inputs |
| 7 | **i18n** | t()/t.rich() used, no hardcoded strings, ALL 24 locale files with PROPER NATIVE TRANSLATIONS (not English fallback — spot-check 3+ non-EN locales to verify native text) |
| 8 | **Tests** | Concrete rules — mark FAIL if ANY violated (see details below) |
| 9 | **Docs** | Concrete rules — mark FAIL if ANY violated (see details below) |
| 10 | **Database** | Migration generated if schema changed, cascade deletes intact, indexes added |
| 11 | **Corridor findings** | Zero open BLOCKER findings on this branch (see detailed rules below) |

### Check #8 — Tests (Detailed Rules)

**All three tiers are MANDATORY** for any feature or bug fix:

1. **Unit tests** (`__tests__/lib/`): Validation schemas, utility functions, data transforms
2. **Integration tests** (`__tests__/api/`): API routes with real database operations
3. **E2E Playwright tests** (`e2e/`): User-facing flows exercised through the browser
4. **Claude-in-Chrome MCP tests** (optional): Browser automation for complex UI interactions

Mark FAIL if ANY of these are violated:
- New API route (`app/api/**/*.ts`) → MUST have unit test AND integration test in `__tests__/api/`
- New hook (`lib/hooks/*.ts`) → MUST have test in `__tests__/hooks/`
- New/changed UI flow → MUST have E2E test in `e2e/`
- UI/email template changes → MUST have Playwright screenshot test that captures rendered output (see `testing.md` Visual Validation section)
- Agent MUST read screenshot files (Read tool supports images) to visually validate rendered output before marking Tests as PASS — do NOT rely solely on string-matching unit tests for visual output
- Bug fix → MUST have regression test covering the fixed behavior (at the appropriate tier)
- Modified business logic (validation, data transforms, auth) → existing tests MUST be updated
- New schema field → MUST have integration test verifying storage, update, and retrieval
- Claude-in-Chrome MCP testing (optional but recommended) for complex UI interactions: multi-step forms, modals, drag-and-drop, hover states
- **"N/A" only valid for**: pure CSS/styling, i18n-only (locale file additions), config/infra changes (`.claude/`, `CLAUDE.md`), documentation-only
- If claiming "N/A", the reviewer MUST state WHY with the specific exemption category

### Check #11 — Corridor Findings (Detailed Rules)

Corridor's static-analysis scanner posts security findings on every PR. They're a separate input from the self-reviewer agent — same triage framework applies (`ship-readiness.md`):

- **BLOCKER (severity: critical/high; security/correctness)**: must fix before merge. Mark Check #11 as FAIL and apply the fix.
- **IMPROVEMENT (severity: medium; small fix, real win)**: fix if cheap. Mark FAIL only if explicitly worth fixing in this PR.
- **POLISH (severity: low; speculative or stylistic)**: decline via `updateFindingState` with category `"risk_accepted"` (or `"false_positive"` if it doesn't apply). Mark Check #11 PASS with a note listing declined IDs.

If Corridor returns zero open findings on this branch, mark PASS with note "no findings".

If `mcp__corridor__getFindings` errors (e.g. project not yet scanned, MCP unreachable, network error), do NOT block the self-review — mark Check #11 PASS with note "Corridor unavailable: <error>". Corridor's own Stop hook will still gate session exit if `CORRIDOR_BLOCKING_STOP_HOOKS=true`.

### Check #9 — Docs (Detailed Rules)

Mark FAIL if ANY of these are violated:
- New/changed API endpoint → update `docs/API_DOCUMENTATION.md`
- Schema changes → update `docs/ARCHITECTURE.md` (entity section)
- Changed auth/security pattern → update `docs/ARCHITECTURE.md` (security section)
- Changed skill or workflow → update the matching `.claude/skills/*.md` file
- Changed domain pattern → update matching `.claude/rules/*.md` file
- **"N/A" only valid for**: internal refactors with no behavior change, test-only changes
- If claiming "N/A", the reviewer MUST state WHY with the specific exemption category

**MANDATORY — User Guides & RAG Knowledge Base** (NO exceptions, NO "N/A"):

Any change that affects user-facing behavior MUST update BOTH the docs version AND the RAG embedded copy:

| What changed | Update these files (BOTH copies) |
|---|---|
| Registration flow, form fields, submission process | `docs/BRUGER-GUIDE-REGISTRERING.md` + `rag/embedded/BRUGER-GUIDE-REGISTRERING.md` |
| Admin dashboard, partner management, complaints | `docs/BRUGER-GUIDE-ADMIN-DASHBOARD.md` + `rag/embedded/BRUGER-GUIDE-ADMIN-DASHBOARD.md` |
| Registration user guide (English) | `docs/USER-GUIDE-REGISTRATION.md` + `rag/embedded/BRUGER-GUIDE-REGISTRERING.md` |

The `rag/embedded/` copies are what the chatbot embeds into its knowledge base. If these are stale, users get wrong answers from the chatbot. This is a **critical user experience issue** — mark FAIL if user-facing behavior changed but these files weren't updated.

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
