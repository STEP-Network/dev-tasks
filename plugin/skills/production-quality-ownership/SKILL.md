---
name: production-quality-ownership
description: Seven-question craftsman checklist run before declaring work "done". Tightens the bar against shipping plausibly-correct work that hasn't been verified end-to-end, and surfaces forgotten cross-component coupling.
user_invocable: true
---

# /production-quality-ownership — Pre-declaration craftsman checklist

## When to apply

Run mentally **before declaring a subtask, PR, or feature "done"** — before:
- Marking a Monday subtask Done
- Setting `selfReviewPassed: true`
- Posting `/log-progress SUBTASK_COMPLETED` or `TASK_COMPLETED`
- Calling work finished in a user-facing reply

Complement to `/self-review`: self-review checks code-level correctness; this checks ownership-level completeness.

## The seven questions

Any "no" or "not sure" is a blocker.

### 1. Did I test the happy path AND realistic edge cases?

Happy path covered (unit / integration / E2E per tier rules). Edge cases: empty input, max-length, missing optional, concurrent submission, partial failure. UI tested in a real browser. Data tested with both fresh and existing rows.

### 2. Did I verify visually, not just functionally?

For any UI / email / rendered-output change: screenshot + Read tool (image-aware) for visual inspection. Locale changes: spot-check ≥3 non-default locales. Dark/light + mobile/desktop: both states if change touches them.

A passing test ≠ visually-correct output.

### 3. Are all configured locales covered?

Only if `project-config.i18n.enabled = true`.

New i18n keys with proper native translations in ALL configured locales (not fallback). No "TODO: translate" placeholders. Spot-check 2–3 non-default locales for native text.

i18n off → N/A.

### 4. Are docs + knowledge base + rules updated?

- User-facing behavior changes → user docs + embedded RAG/chatbot copies
- API changes → API docs
- Schema changes → architecture / data-model doc
- New patterns → `.claude/rules/<domain>.md`
- New skills → `.claude/skills/<name>/SKILL.md` + CLAUDE.md if relevant

If the next agent can't infer correct behavior from docs/rules, work isn't done.

### 5. Have I considered every system surface this could affect?

Most-skipped question, source of most "you forgot X" feedback. Walk this list deliberately, not from memory.

Generic categories (consumer's overlay should list concrete files/routes per):
- **Role-specific views** — same data shown to admin/user/public/partner via different lenses; one change → updates in 3-5 others
- **Notification surfaces** — every state change has 1-3 emails or in-app notifications; locale source = recipient's preference, not admin's browser
- **Toast / inline feedback** — success toast on success, useful error toast on failure, project's pattern not invented
- **Data-shape surfaces** — validation schema (Zod), DB schema (ORM/migrations), TypeScript types, snapshot/serialized shapes, migration (additive vs destructive)
- **API + integration surfaces** — public API serializers (PII leak test), webhooks, payment providers, third-party integrations
- **Knowledge base / RAG** — embedded knowledge kept in sync with docs
- **E2E + test surfaces** — broken user journeys re-run, new E2E if needed, visual baselines
- **Documentation surfaces** — user-facing guides, architecture, API docs, rule files

Adding one field to a primary form typically hits 10+ surfaces (validation → DB → snapshot → backfill → display per role → email per recipient → public-API serializer → locale keys → user docs → RAG → integration test → E2E). Walk the list.

### 6. Did I reuse existing UI components, or invent something new?

Before adding new visual atoms: is there an existing component? Does this page mirror an existing layout? Using existing spacing/typography/color tokens, not inventing? Icons consistent with adjacent pages? Toast helper + standard severity, not rolled own?

Diverging from existing pattern → WHY in PR description + architecture-decisions doc.

Deep version: `/design-consistency` skill (invoke for any UI-touching PR).

### 7. Could a stakeholder / auditor read commit + PR description and understand WHY?

Commit message says why, not what. PR description traces to the rule/decision/stakeholder ask. Interpretive decisions → founder-decisions doc (or PR description as fallback). A reader six months from now can defend this choice without archive search.

Regulated industries: relevant regulation/audit context in overlay file.

## Process

1. Read each of the seven questions to yourself.
2. Honest yes → continue.
3. "Not sure" / "no" → fix the gap; do NOT declare done.
4. All seven honest yes → proceed with self-review → ship-pr (and any board-state writes via `manageSubtasks` / `/log-progress SUBTASK_COMPLETED`). No narrative progress Update is posted from this checklist — progress is tracked in git commits (every commit carries the task `#id`), and the single routine summary posts at the end of `/ship-pr`.

## Reference

- `.claude/skills/self-review/SKILL.md` — code-level 10-point checklist
- `.claude/skills/design-consistency/SKILL.md` — deep version of Q6
- `.claude/rules/ship-readiness.md` — BLOCKER / IMPROVEMENT / POLISH triage
- Consumer's `.claude/rules/` for project-specific testing/ui-design/i18n
