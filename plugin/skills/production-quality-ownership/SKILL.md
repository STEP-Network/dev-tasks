---
name: production-quality-ownership
description: Seven-question craftsman checklist run before declaring work "done". Tightens the bar against shipping plausibly-correct work that hasn't been verified end-to-end, and surfaces forgotten cross-component coupling.
user_invocable: true
---

# /production-quality-ownership — Pre-declaration craftsman checklist

> **Overlay**: if `.claude/skills/production-quality-ownership/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific instructions (extend-only — overlay can append checks/steps but cannot replace plugin behavior). **Project-specific cross-coupling surfaces, doc paths, locale lists, and regulatory context belong in the overlay.**

## When to apply

Run mentally **before declaring a subtask, PR, or feature "done"** — i.e. before:

- Marking a Monday subtask "Done"
- Setting `selfReviewPassed: true`
- Posting `/log-progress SUBTASK_COMPLETED` or `TASK_COMPLETED`
- Calling work finished in a user-facing reply

The user can also invoke `/production-quality-ownership` explicitly when they want a deliberate pre-flight pass.

This is a **complement** to `/self-review`. Self-review checks correctness against a 10-point checklist. This skill checks the broader **ownership posture**: did you take the work all the way to shipped quality, not just compiling code?

## The seven questions

Answer all seven honestly before declaring done. **Any "no" or "not sure" is a blocker.**

### 1. Did I test the happy path AND realistic edge cases?

- Happy path covered? (Unit / integration / E2E per the project's testing tier rules.)
- Edge cases covered? (Empty input, max-length input, missing optional field, concurrent submission, partial failure.)
- For UI: tested in a real browser, not just compiled?
- For data: tested with a row that already exists vs. a fresh row?

### 2. Did I verify visually, not just functionally?

- For any UI / email / rendered-output change: did I take a screenshot and **read it with the Read tool** (it supports images natively) to visually inspect the rendered result?
- For locale changes: spot-checked at least 3 non-default locales rendered correctly?
- For dark/light theme + mobile/desktop: checked both states if the change touches them?

A passing test is not the same as visually-correct output. UI bugs slip through type checks every day.

### 3. Are all configured locales covered?

Only applies if the project enables i18n (`project-config.i18n.enabled = true`).

- Any new i18n key has been added with a **proper native translation** in all configured locales (not default-language fallback)?
- No "TODO: translate" placeholders left in non-default locale files?
- Spot-checked 2-3 non-default locales to confirm native text, not copy-paste?

If i18n is not enabled for this project, mark N/A.

### 4. Are docs + knowledge base + rules updated?

- For user-facing behavior changes: did I update the project's user-facing docs AND any embedded copies (e.g. RAG / chatbot knowledge base) the project maintains?
- For API changes: API documentation file updated?
- For schema changes: architecture / data-model doc updated?
- For new patterns: `.claude/rules/<domain>.md` in the consumer repo?
- For new skills: `.claude/skills/<name>/SKILL.md` + reference from CLAUDE.md if relevant?

If the agent who picks up the next related task can't infer correct behavior from docs / rules, the work isn't done.

### 5. Have I considered every system surface this could affect?

This is the most-skipped question and the source of the most "you forgot to update X" feedback. Walk this list deliberately, not from memory.

**Generic categories** — the consumer's overlay should list concrete files/routes per category:

- **Role-specific views** — the same data is usually shown to different audiences (admin, user, public, partner) through different lenses. A change to one usually demands updates in 3-5 others.
- **Notification surfaces** — every state change usually has 1-3 emails or in-app notifications. Identify recipients, update each template, mind locale source (recipient's preference, not admin's browser).
- **Toast / inline feedback** — success toast on success? Error toast on failure with a *useful* message? Toasts using the project's pattern, not invented inline?
- **Data-shape surfaces** — validation schema (Zod / equivalent), DB schema (ORM / migrations), TypeScript types, snapshot/serialized shapes, migration (additive vs destructive, classified, applied per the project's database lifecycle).
- **API + integration surfaces** — public API serializers (does it leak PII? test the data filter). Webhooks, payment providers, third-party integrations affected?
- **Knowledge base / RAG surfaces** — any embedded knowledge the chatbot or search uses, kept in sync with the doc copies.
- **E2E + test surfaces** — does this break a previously-tested user journey? Re-run affected spec files. Need a NEW E2E test? Visual screenshot baselines?
- **Documentation surfaces** — user-facing guides, architecture, API docs, rule files.

**Walk-through pattern**: when a new field is added to a primary form, the typical surfaces are: validation schema → DB column → snapshot/serialized fields → backfill (if applicable) → display page (each role) → email templates (each recipient) → public-API serializer → locale keys → user docs + embedded knowledge copies → integration test → E2E spec. **Easily 10+ places.** Missing any one is a "you forgot X" cycle. Walk the list.

The consumer's overlay should list its concrete cross-coupling map (e.g. "registration field → these 13 surfaces"). This generic skill names the categories.

### 6. Did I reuse existing UI components, design, and layout — or invent something new?

Most projects have a defined design system: themed component wrappers (e.g. `<ThemedInput />`), stock primitives (shadcn/ui or similar), canonical design tokens (page wrapper, container, card surface, primary CTA). New invention is more often a tell of "I didn't look hard enough" than "the existing system can't express this".

Before adding new visual atoms or layouts, ask:

- **Component**: is there an existing component that already does this? Did I grep for the variant I need before writing one?
- **Layout pattern**: does this page mirror the structure of an existing page? Am I diverging on purpose or by accident?
- **Spacing / typography / color**: am I using the existing tokens or inventing new ones?
- **Iconography**: am I using the project's icon library consistently with adjacent pages?
- **Toast / inline feedback**: am I using the existing toast helper + standard severity styling, or rolling my own?

If diverging from an existing pattern, the WHY belongs in the PR description and ideally a one-line entry in an architecture-decisions doc.

The deep version of this check lives in `/design-consistency` (its own skill) — invoke it for any UI-touching PR.

### 7. Could a stakeholder / auditor read the commit message + PR description and understand WHY?

For any scope-altering or strategically-relevant change:

- Commit message says **why**, not just what
- PR description traces the change back to the rule, decision, or stakeholder ask
- For interpretive decisions, the WHY belongs in a founder-decisions / architecture-decisions doc (or the PR description as a fallback)
- A reader six months from now can defend this choice without an archive search

Projects in regulated industries should add the relevant regulation/audit context in their overlay file (e.g. "this product is governed by EU Reg X — every interpretive call must trace to the rule").

## Process

When work feels "done":

1. Read each of the seven questions out loud (or to yourself, in your head).
2. Honest yes? → continue.
3. "Not sure" or "no"? → fix the gap; do NOT declare done.
4. After all seven are honest yes → proceed with self-review / ship-pr / log-progress.

## Anti-patterns

- **Compiles → done**: type check passes, so the work is finished. (No: visual + functional + edge cases + i18n still required.)
- **Tests pass → done**: green CI, so ship. (No: tests reflect what was anticipated; visual UAT and edge cases still matter.)
- **Locale-skim**: "I'll backfill non-default translations later." Hook will hard-block; but the deeper issue is shipping incomplete work.
- **No-doc-update**: "It's just a refactor." If the behavior is described anywhere (docs, rules, knowledge base), and the behavior changed, those need to update.
- **Single-surface focus**: shipping the form change without updating the review page, admin detail view, public-facing display, email template, or knowledge-base copy. The "you forgot X" cycle.
- **Reinventing existing UI**: writing a new card / input / toast / spinner instead of grepping `components/ui/*` first.
- **WHY-less commits**: terse commit messages that don't survive an audit six months later.

## Why this skill exists

Small codebases accumulate quality drift fast. This skill is the **handbrake against shipping plausibly-correct work that hasn't been verified end-to-end**. Self-review catches code-level correctness; this catches **ownership-level completeness**.

## Reference

Complements:
- `.claude/skills/self-review/SKILL.md` — code-level 10-point checklist
- `.claude/skills/ship-pr/SKILL.md` — pipeline gate (build / lint / test / push / PR)
- `.claude/skills/design-consistency/SKILL.md` — deep version of Q6 (UI reuse vs invent)
- `.claude/rules/ship-readiness.md` — BLOCKER / IMPROVEMENT / POLISH triage
- Consumer's `.claude/rules/` for project-specific testing, ui-design, i18n, etc.
