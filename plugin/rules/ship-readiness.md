# Ship-Readiness Principle

Governs how to respond to findings from self-review or PR code review. Canonical home for BLOCKER / IMPROVEMENT / POLISH definitions.

## The bar

A PR is **ship-ready when it is correct, safe, and tested** — NOT polished to perfection.

**YES bar:**
- **Correctness**: change does what it claims for all realistic inputs
- **Safety**: no auth bypass, secret exposure, PII leak, immutable-state mutation
- **Tests**: required tiers per `testing.md`, happy path + realistic edge cases
- **i18n completeness**: all locale files updated when keys added (hook-enforced)
- **Docs**: user-facing docs updated when user-facing behavior changed (incl. RAG copies)
- **No regressions**: existing tests pass, lint clean, build passes
- **Reviewable**: commits, PR description, acceptance testing checklist clear for a human

**NO bar:** style perfection, line-by-line rationale, speculative defensive code, every-pattern consistency, every AI-reviewer suggestion, optimization without profiling evidence, exhaustive permutation tests when core behavior is covered.

## Triage classification

Every review finding falls into one tier. Four review sources feed the same queue (see `ai-review-stack.md`):

| Source | Owns | Triage notes |
|---|---|---|
| **Corridor** (per-PR + Stop hook) | Regulatory + security + project-authored guardrails | BLOCKER on open critical findings (Stop hook enforces); POLISH-declined via `mcp__plugin_corridor_corridor__updateFindingState({ closedReasonCategory: 'risk_accepted' })` |
| **Vercel Agent** (PR review on staging+main) | Correctness, performance, TS/React best-practices | Bot severity advisory; decline POLISH via PR reply with classification + reason |
| **Sentry Seer** (drafted fix PRs) | Production-only RCA; never pre-merge code | Seer PR is itself a deliverable passing the same gates |
| **`/self-review`** (Checks #1–11) | Project-specific rules (i18n, snapshots, GDPR, optimistic updates, sponsor amounts) | Wins over Vercel Agent on project-specific conflicts (reply on Agent's comment "deferred to /self-review Check #N") |

All four converge on the same triage. `reviewAddressed` flips to `"fixed"` or `"accepted"` only when zero BLOCKERs remain across ALL FOUR.

### BLOCKER — must fix before merge

- Security: auth bypass, secret exposure, injection, client-controlled auth data
- Correctness: wrong logic producing incorrect output for real input
- Data integrity: immutable-state mutation, dropped writes, confirmed race conditions
- Privacy/GDPR: PII leaked to public surface, consent/retention violations
- User-facing breakage: crashes, broken flows, wrong emails to real users
- Legal/compliance: EU Reg 2024/900 or 2025/1410 non-compliance
- Silent misconfiguration risk: looks correct but silently breaks production
- Performance regressions with measurable user impact (p95, bundle, render blocking)
- Regression introduced by a previous fix round — always BLOCKER

### IMPROVEMENT — fix only if cheap (<10 lines) and low-risk

- Code-quality win in a pattern this PR already touches
- Missing edge case with plausible real-world trigger
- Minor DX issue on a public API this PR introduces
- Pre-existing bug the fix can safely bundle (within same files)
- Infra robustness win (e.g. CI secret guard clarifying setup failure)

### POLISH — decline, document reason, move on

- Style preference not enforced by lint
- Speculative defensive code without evidence
- Documentation of already-obvious behavior
- Premature optimization
- Pattern consistency nitpicks on unrelated code
- "Would be nice" without concrete harm
- Cosmetic comment/JSDoc changes

## Decision heuristics

1. **What concretely fails if we don't fix this?** "Nothing" or "hypothetical" → POLISH.
2. **Would a reasonable engineer ship as-is?** Yes → POLISH.
3. **Is the fix <10 lines, low-risk, addresses something plausible?** Yes → IMPROVEMENT.
4. **Does this involve data loss, wrong user-visible output, or security?** Yes → BLOCKER.

When in doubt, lean POLISH. Over-fixing > under-fixing.

## Review loop termination

No hard cap on iteration count — a later round can surface a new BLOCKER introduced by an earlier fix.

| Round N outcome | Action |
|---|---|
| Any BLOCKER (incl. regression from N-1) | Fix → re-push → round N+1 |
| Only IMPROVEMENTs, all declined | Post decline, ship (`reviewAddressed: "accepted"` or `"fixed"`) |
| Only IMPROVEMENTs, some cheap | Fix cheap ones → re-push → round N+1 |
| Only POLISH | Post decline listing items + reasons, ship |
| Mix | Fix BLOCKERs + cheap IMPROVEMENTs, decline POLISH, round N+1 |

Loop terminates when zero BLOCKERs remain.

**Escalation signal (not a cap)**: three consecutive rounds each introducing a NEW BLOCKER → something is architecturally wrong. Post `/log-progress TASK_STUCK` and ask for direction. Regression-loop detection, not a round limit.

## Reviewer bot severity labels are advisory

Bot labels (Critical / Major / Minor) are hints, not verdicts. Bots over-label "Critical" for style, "Major" for speculative edge cases, "Minor" for actual BLOCKERs (rare). Ground truth is production impact.

Per-reviewer noise:
- **GitHub Copilot / generic** — over-flag style; under-flag GDPR + EU-regulation (no project context).
- **Corridor** — high signal on CWE; can over-flag rate-limit gaps in routes with explicit BotID + auth.
- **Vercel Agent** — high signal on performance + React; "missing memoization" / "use Server Component" hints are POLISH without measurable user-impact data.
- **Sentry Seer** — high signal on root-cause hypothesis; can over-attribute to recent commits when real bug is older. Verify the code path matches the trace.

## Triaging a Seer-drafted PR

Seer drafts fix PRs ("Stop after PR drafted") but does NOT auto-merge. Seer PR is itself a deliverable passing standard review gates.

1. Verify root-cause hypothesis against `mcp__sentry__get_issue`. If wrong, close PR with a comment naming actual root cause (closed-state feeds Seer's training signal).
2. Inspect fix quality (hypothesis-grade): add missing tests; add missing i18n updates (commit gate blocks); STOP if touching an immutable snapshot field — verify against `.claude/rules/registration.md` (Seer doesn't know regulatory invariants).
3. Run the standard 4-source review (Corridor + Vercel Agent + `/self-review` + GitHub bot).
4. Watch for Seer × `/loop` PR collisions — close the lower-quality, comment-link to survivor. See `.claude/rules/security.md` "Seer × `/loop` coordination".
5. If the fix is right but Seer's patch is sub-bar, refine in-place — don't close + restart. Seer's reasoning trace is useful context.

## Declining POLISH

Post a PR comment that: (1) names the item, (2) states category (style / speculative / premature optimization), (3) says filed as follow-up or permanently declined. Makes the decision auditable without forcing a fix round.

## Hook enforcement: `pre-merge-review-gate`

The `reviewAddressed` field is not just guidance — it is **hook-enforced** by `pre-merge-review-gate.sh` (PreToolUse on `gh pr merge`). The hook blocks merge when:

1. `reviewAddressed` is missing from active-task.json
2. `reviewAddressed.status` is not `"fixed"` or `"accepted"`
3. `reviewAddressed.triagedAt` is older than the latest review comment's `createdAt` (race prevention — catches "triage ran before the reviewer posted")
4. Any configured source (per `project-config.review.sources[]`) has `polish > 0` but empty `replies[]` (POLISH items not declined via PR comment)
5. GitHub API unreachable when verifying review timestamps (refuses rather than silent-passing)

**There is no bypass flag.** The escape hatch for stuck situations is to fix the underlying issue (run the triage, post the decline comments, re-push) — not to skip the gate.

### Concrete example: PR #330 (v0-politiske-annoncer, 2026-05-18)

- 12:30 UTC — single commit pushed
- 12:34 UTC — Claude bot posted structured review: 5 POLISH items, 1 near-blocker (no-op `preventDefault`)
- 12:38 UTC — auto-merged with zero follow-up commits, zero PR-reply comments

Four minutes between review and merge. The near-blocker was never addressed. None of the POLISH items were declined via reply. The `preventDefault` no-op remained in production code.

**Root cause**: `/ship-pr` Phase 6 set `reviewAddressed` without actually parsing the Claude bot review. The auto-merge fired on CI-green alone. This hook ensures that `reviewAddressed` can only be set AFTER triage has run and its `triagedAt` post-dates the latest reviewer comment.

### Configured sources

Projects declare which review sources they use in `project-config.json` → `review.sources[]`. Default: `["claudeBot", "corridor", "selfReview"]`. The hook only validates POLISH-reply completeness for declared sources. Undeclared sources are ignored.

## Anti-patterns

- Review-addiction loop — bot always finds something.
- Premature polish — JSDoc, memoization, defensive `.trim()` before asked.
- Scope creep via review — fixing pre-existing unrelated issues.
- Triaging BLOCKERs down to POLISH — don't downgrade real security issues. In doubt, lean BLOCKER.
- Round caps that ship bugs — cap by "no BLOCKERs remain", not by number.
- **Merging before triage** — setting `reviewAddressed` without reading the review. The hook catches this via the timestamp race check.
- **Optimistic merge on reviewer silence** — merging because no review appeared yet (reviewer hasn't posted). The `/babysit-prs` reviewer-wait gate (Phase 1b) prevents this.

Goal: **ship good work, ship it soon, don't polish to death — but never ship a real BLOCKER to avoid one more round.**
