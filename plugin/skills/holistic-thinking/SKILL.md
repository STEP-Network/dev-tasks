---
name: holistic-thinking
description: Universal three-level lens (L1 symptom / L2 root cause / L3 systemic improvement) for any non-trivial problem. Apply at session-start as a default posture, or on-demand when stuck on a hard problem.
user_invocable: true
---

# /holistic-thinking — Three-level lens for non-trivial problems

> **Overlay**: if `.claude/skills/holistic-thinking/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific instructions (extend-only — overlay can append checks/steps but cannot replace plugin behavior).

## When to apply

This is a **default posture**, not a command-only skill. Apply it ambiently when:

- A user reports a bug or unexpected behavior
- A code review finding could be addressed at multiple levels
- A regulatory / compliance question comes up
- You're about to ship a fix and want to make sure you're not just patching the symptom
- You're stuck and a single-level fix doesn't feel right

The user can also invoke `/holistic-thinking` explicitly to ask for a structured pass.

## The three levels

For any non-trivial problem, deliberately consider all three before acting:

### L1 — Symptom level

**What is broken right now, for the user, that this PR must fix?**

This is the fastest, most localized fix. It addresses what the user reported.

Examples:
- API returns 500 → catch the error, return a clear 400 with the validation message
- Locale overflow on a button → shorten the translation, or wrap text
- Test failing → fix the assertion or the code under test

L1 alone is correct for: small bugs with no broader pattern, hotfixes under deadline, code that's about to be replaced anyway.

L1 alone is **wrong** when: the same class of bug has happened before, the symptom is one of many, or the fix is fragile (papers over the issue without resolving it).

### L2 — Root cause level

**Why did the symptom occur? What design / validation / contract was missing?**

This is one level up from the symptom. Address the cause, not the visible failure.

Examples (continuing from L1):
- API 500 → the input wasn't validated; add a Zod schema at the route boundary
- Locale overflow → no max-length on the translation key + no test for long strings; add both
- Failing test → flaky retry logic was masking a real race condition; remove retry, fix race

L2 fixes prevent recurrence of the same bug class in this code. They almost always cost more lines but pay back many times over.

### L3 — Systemic improvement level

**What pattern, rule, or guard would have caught this earlier? What else is at risk from the same gap?**

This is one level out — beyond the immediate code, into process / tooling / docs.

Examples (continuing):
- API 500 → audit other routes for missing input validation; add a lint rule or self-review check
- Locale overflow → add a Playwright + Claude vision check for visual locale issues (#101); add a CI check for max-length on i18n keys
- Failing test → add a `.claude/rules/testing.md` clause documenting the race-condition pattern so future agents catch it

L3 work usually doesn't ship in the same PR — it surfaces follow-up tasks (Monday tickets, GitHub issues, docs updates). The point is to **see** the systemic angle, even if you decide to defer it.

## How to apply in practice

When facing a non-trivial problem:

1. **Diagnose the symptom (L1)**: state plainly what's broken.
2. **Trace the cause (L2)**: ask "why?" once or twice until you reach a design or contract gap.
3. **Generalize (L3)**: ask "what other places have this same gap, and what guard would prevent recurrence?"
4. **Decide what ships in this PR**: usually L1 + L2. L3 is a separate ticket, but explicitly named.
5. **Document the L3 follow-up**: in the PR description, in `docs/founder-decisions.md`, or as a GitHub issue.

## Example — applied to PolAds

**Symptom**: a registration form's "Submit" button is overflowing in Finnish on mobile.

- **L1**: shorten the Finnish translation to fit; ship.
- **L2**: the button has no min-width / max-width contract; the design tokens don't enforce it. Add CSS constraints; the same bug will hit Estonian, Polish, German.
- **L3**: there's no automated visual UAT for locale overflow (issue #101). Without it, every locale-related bug surfaces only in manual UAT. File / prioritize the visual UAT gate.

The PR ships L1 + L2. L3 is mentioned in the PR description as "follow-up: visual UAT (#101) needed to catch this class systematically."

## Anti-patterns

- **L1-only by default**: shipping symptom fixes for bugs that come from a recurring design gap. Costs more long-term.
- **L3 paralysis**: refusing to ship L1 because the L3 fix is huge. Ship L1 + L2, file L3 as a follow-up.
- **L3 scope creep**: bundling L3 systemic work into an L1 PR — doubles review time, slows the urgent fix.

## Reference

This skill complements `.claude/rules/ship-readiness.md`, which governs the BLOCKER / IMPROVEMENT / POLISH triage of review findings. Holistic-thinking is the **diagnostic lens**; ship-readiness is the **decision gate**.
