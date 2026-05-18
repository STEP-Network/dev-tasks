---
name: holistic-thinking
description: Universal three-level lens (L1 symptom / L2 root cause / L3 systemic improvement) for any non-trivial problem. Apply at session-start as a default posture, or on-demand when stuck on a hard problem.
user_invocable: true
---

# /holistic-thinking — Three-level lens for non-trivial problems

Default posture, not command-only. Apply ambiently when:
- User reports a bug or unexpected behavior
- Code review finding could be addressed at multiple levels
- Regulatory / compliance question comes up
- About to ship a fix and want to make sure you're not patching the symptom
- Stuck and a single-level fix doesn't feel right

User can also invoke explicitly for a structured pass.

## The three levels

### L1 — Symptom

**What is broken right now, for the user, that this PR must fix?**

Fastest, most localized fix. Addresses what the user reported.

L1 alone is correct for: small bugs with no broader pattern, hotfixes under deadline, code about to be replaced. Wrong when: same bug class happened before, symptom is one of many, fix is fragile.

### L2 — Root cause

**Why did the symptom occur? What design / validation / contract was missing?**

One level up from symptom. Address the cause, not the visible failure. Almost always costs more lines but pays back many times.

### L3 — Systemic improvement

**What pattern, rule, or guard would have caught this earlier? What else is at risk?**

One level out — process / tooling / docs. Usually doesn't ship in same PR; surfaces follow-up tasks. The point is to see the systemic angle, even if you decide to defer.

## How to apply

1. Diagnose symptom (L1): state plainly what's broken.
2. Trace cause (L2): ask "why?" once or twice until you reach design or contract gap.
3. Generalize (L3): "what other places have this same gap, and what guard would prevent recurrence?"
4. Decide what ships: usually L1 + L2. L3 is a separate ticket, but explicitly named.
5. Document L3 follow-up: PR description, `docs/founder-decisions.md`, or GitHub issue.

## Anti-patterns

- **L1-only by default** — shipping symptom fixes for bugs from recurring design gaps; costs more long-term
- **L3 paralysis** — refusing to ship L1 because L3 fix is huge; ship L1 + L2, file L3 follow-up
- **L3 scope creep** — bundling L3 systemic work into an L1 PR; doubles review time, slows urgent fix

## Reference

Complements `.claude/rules/ship-readiness.md` (BLOCKER / IMPROVEMENT / POLISH triage). This skill is the diagnostic lens; ship-readiness is the decision gate.
