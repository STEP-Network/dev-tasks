# Ship-Readiness Principle

> **Reference rule** — not auto-loaded per file edit. Loaded by `/self-review` and `/ship-pr`
> when those skills run. Governs how to respond to findings from self-review or PR code review.

## The bar

A PR is **ship-ready when it is correct, safe, and tested** — NOT when it is polished to perfection.

## What "ship-ready" requires (the YES bar)

Every PR must clear these before merge:

- **Correctness**: the change does what it claims to do, for all realistic inputs
- **Safety**: no auth bypass, no secret exposure, no PII leak, no immutable-state mutation
- **Tests**: required tiers per `.claude/rules/testing.md`, covering happy path + realistic edge cases
- **i18n completeness**: all 24 locale files updated when keys are added (hook-enforced)
- **Docs**: user-facing docs updated when user-facing behavior changed (incl. RAG copies)
- **No regressions**: existing tests still pass, lint clean, build passes
- **Reviewable**: commit messages, PR description, acceptance testing checklist clear for a human

## What "ship-ready" does NOT require (the NO bar)

- Perfect by every style metric
- Documentation of every line's rationale
- Defensive code for speculative edge cases with no evidence of occurrence
- Consistency with every pattern used elsewhere in the repo
- Addressing every suggestion from an AI code reviewer
- Memoization / caching / optimization without profiling evidence
- Exhaustive test cases for every permutation when core behavior is covered

## Triage classification (BLOCKER / IMPROVEMENT / POLISH)

Every review finding — whether from self-review or a PR code reviewer — falls into one tier.

**Four review sources feed the same triage queue** (see `.claude/rules/security.md` "AI Review Stack" for the full matrix):

| Source | Owns | Triage notes |
|---|---|---|
| **Corridor** (per-PR findings + Stop hook) | Regulatory + security + project-authored guardrails | BLOCKER on open critical findings (Stop hook enforces); POLISH-declined items closed via `mcp__plugin_corridor_corridor__updateFindingState({ closedReasonCategory: 'risk_accepted' })` |
| **Vercel Agent** (PR review comments on staging+main) | Correctness, performance, TS/React best-practices | Bot severity labels are advisory — apply heuristics below; decline POLISH via PR reply with classification + reason |
| **Sentry Seer** (drafted fix PRs for production errors) | Production-only RCA; never pre-merge code | A Seer-drafted PR is itself a deliverable that must pass the same gates (Corridor + Vercel Agent + `/self-review`). See "Triaging a Seer draft PR" below |
| **`/self-review`** (local Checks #1–11) | Project-specific rules (i18n, snapshots, GDPR, optimistic updates, sponsor amounts, etc.) | Wins over Vercel Agent on project-specific scope conflicts (reply on Agent's comment "deferred to /self-review Check #N") |

All four converge on the same `BLOCKER / IMPROVEMENT / POLISH` decision. `reviewAddressed` flips to `"fixed"` or `"accepted"` only when zero BLOCKERs remain across ALL FOUR sources.

### 🔴 BLOCKER — must fix before merge

- Security: auth bypass, secret exposure, injection, client-controlled auth data
- Correctness: wrong logic producing incorrect output for a real input
- Data integrity: immutable-state mutation, dropped writes, confirmed race conditions
- Privacy/GDPR: PII leaked to a public surface, consent/retention violations
- User-facing breakage: crashes, broken flows, wrong emails sent to real users
- Legal/compliance: EU Reg 2024/900 or 2025/1410 non-compliance
- Silent misconfiguration risk: config that looks correct but silently breaks production
- **Performance regressions** with measurable user impact (p95 latency, bundle size, render blocking)
- **Regression introduced by a previous fix round** — always treat as BLOCKER, never rationalize away

### 🟠 IMPROVEMENT — fix only if cheap (<10 lines) and low-risk

- Code-quality win in a pattern this PR already touches
- Missing edge case with plausible real-world trigger
- Minor DX issue on a public API this PR introduces
- Pre-existing bug the fix can safely bundle (within the same files)
- Infra robustness win (e.g. CI secret guard that clarifies a setup failure)

### 🟡 POLISH — decline, document reason, move on

- Style preference not enforced by lint
- Speculative defensive code for scenarios without evidence
- Documentation of already-obvious behavior
- Premature optimization
- Pattern consistency nitpicks on unrelated code
- "Would be nice" suggestions without concrete harm
- Cosmetic comment/JSDoc changes

## Decision heuristics

When classifying a finding, ask:

1. **What concretely fails if we don't fix this?** If "nothing" or "hypothetical scenario" → POLISH.
2. **Would a reasonable engineer read this and think 'I'd want to ship as-is'?** If yes → POLISH.
3. **Is the fix <10 lines AND low-risk AND addresses something plausible?** If yes → IMPROVEMENT.
4. **Does this involve data loss, wrong user-visible output, or security?** If yes → BLOCKER.

**When in doubt, lean POLISH.** The downside of over-fixing (review-loop noise, slower shipping) is worse than the downside of under-fixing (follow-up ticket).

## How the review loop terminates

**There is NO hard cap on iteration count.** A later round can legitimately surface a new BLOCKER introduced by an earlier fix — caps would ship bugs. Instead, each round is governed by critical analysis:

**Per-round decision gate** — after triaging the findings of round N:

| Round N outcome | Action |
|---|---|
| Any BLOCKER (including regression from round N-1) | Fix → re-push → round N+1 |
| Only IMPROVEMENTs, all declined | Post decline comment, ship (`reviewAddressed: "accepted"` or `"fixed"`) |
| Only IMPROVEMENTs, some cheap | Fix cheap ones → re-push → round N+1 |
| Only POLISH | Post decline comment listing items + reasons, ship |
| Mix: BLOCKERs + IMPROVEMENTs + POLISH | Fix BLOCKERs + cheap IMPROVEMENTs, decline POLISH, round N+1 |

**The loop terminates naturally when zero BLOCKERs remain.** Number of rounds is whatever it takes.

**Escalation signal (not a cap)**: if three consecutive rounds each introduce a NEW BLOCKER that wasn't present before, something is architecturally wrong. Post `/log-progress TASK_STUCK` and ask the user for direction rather than continuing to iterate. This is "regression-loop detection", not a round limit — good loops fixing real issues continue freely.

## Reviewer bot severity labels are advisory

Bot labels (🔴 Critical / 🟠 Major / 🟡 Minor) from any of the AI reviewers — GitHub bot, Corridor, Vercel Agent, or Sentry Seer's "confidence" indicator — are hints, not verdicts. Apply the triage heuristic yourself. Bots regularly over-label:

- "Critical" for non-load-bearing style issues
- "Major" for speculative edge cases
- "Minor" for things that are actually BLOCKERs (rare but happens)

Ground truth is the production impact, not the emoji.

**Per-reviewer noise patterns observed so far** (calibrate accordingly):

- **GitHub Copilot reviewer / generic bots** — over-flag style preferences; under-flag GDPR + EU-regulation concerns (no project context).
- **Corridor** — high signal on CWE patterns; can over-flag rate-limit gaps in routes that have explicit BotID + auth (read the existing pipeline before treating as BLOCKER).
- **Vercel Agent** — high signal on performance + React patterns; can over-flag "missing memoization" or "use Server Component" hints without profiling evidence — these are POLISH unless there's measurable user-impact data.
- **Sentry Seer** — high signal on the root-cause hypothesis (it has the stack trace + replay); can over-attribute to recent commits when the real bug is older. Verify the code path Seer points at actually matches the trace.

## Triaging a Seer-drafted PR

Sentry Seer drafts fix PRs (with "Stop after PR drafted" config) but does NOT auto-merge. A Seer-drafted PR is itself a deliverable that must pass the standard review gates. Apply this checklist when reviewing one:

1. **Verify the root-cause hypothesis**. Does the stack-trace path Seer cites actually match the production error? Cross-check against `mcp__sentry__get_issue` if available. If the hypothesis is wrong, close the PR with a comment naming the actual root cause — closed-state semantics feed back into Seer's training signal for the org.

2. **Inspect the fix quality**. Seer's patches are hypothesis-grade, not production-grade:
   - Missing tests? Add them yourself (don't decline the PR for "no tests" — Seer doesn't ship them).
   - Missing i18n updates (24 locales)? Add them yourself, or the commit gate will block.
   - Touching an immutable snapshot field? STOP — verify against `.claude/rules/registration.md`. Seer doesn't know our regulatory invariants.

3. **Run the standard 4-source review** on the Seer PR (Corridor + Vercel Agent + `/self-review` + GitHub bot). All four must clear BLOCKERs before merge.

4. **Watch for Seer × `/loop` PR collisions**. If both Seer AND `/loop` opened PRs for the same underlying Monday bug, close the lower-quality one + comment-link to the surviving one. The autonomous-loop orchestration (task #2914342499) will eventually automate this; until then, manual triage. See `.claude/rules/security.md` "Seer × `/loop` coordination" for the exact decision matrix.

5. **If the proposed fix is right but Seer's patch is sub-bar**, refine in-place — don't close + restart from scratch. Seer's reasoning trace in the PR body is useful context for the refinement.

## Declining a review suggestion

When declining a POLISH item, post a PR comment that:

1. Names the item being declined
2. States which category it falls into (style / speculative / premature optimization / etc.)
3. Says whether it's being filed as follow-up or permanently declined

Example:
> **Declining** the memoization suggestion on `getAppEnvironment()`. Classification: premature optimization — no profiling evidence that env reads are a hotspot. Filed for future reconsideration if profiling shows it matters.

This makes the decision auditable without forcing a fix round.

## Anti-patterns to avoid

- **Review-addiction loop**: fixing every reviewer suggestion because it's there. The bot always finds something.
- **Premature polish**: adding JSDoc, memoization, or defensive `.trim()` guards before anyone asked.
- **Scope creep via review**: fixing pre-existing unrelated issues just because the reviewer mentioned them.
- **Triaging BLOCKERs down to POLISH**: the inverse failure — don't downgrade real security issues to avoid fixing them. If in doubt between BLOCKER and POLISH, lean BLOCKER.
- **Round caps that ship bugs**: capping iterations by number rather than by "no BLOCKERs remain" can ship genuine regressions. Avoid.

## When the rule applies

Loaded on demand by:
- `/self-review` — when triaging self-reviewer findings
- `/ship-pr` Phase 6 — when triaging PR review comments
- Any manual code-review response

Not auto-loaded per file edit (it's workflow guidance, not per-file policy).

The goal: **ship good work, ship it soon, don't polish it to death — but never ship a real BLOCKER to avoid "one more round".**
