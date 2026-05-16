---
name: production-quality-ownership
description: Seven-question craftsman checklist run before declaring work "done". Tightens the bar against shipping plausibly-correct work that hasn't been verified end-to-end, and surfaces forgotten cross-component coupling.
user_invocable: true
---

# /production-quality-ownership — Pre-declaration craftsman checklist

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

- Happy path covered? (Unit / integration / E2E per `.claude/rules/testing.md` tier rules.)
- Edge cases covered? (Empty input, max-length input, missing optional field, concurrent submission, partial failure.)
- For UI: tested in a real browser, not just compiled?
- For data: tested with a row that already exists vs. a fresh row?

### 2. Did I verify visually, not just functionally?

- For any UI / email / rendered-output change: did I take a screenshot and **read it with the Read tool** (it supports images natively) to visually inspect the rendered result?
- For locale changes: spot-checked at least 3 non-English locales rendered correctly?
- For dark/light theme + mobile/desktop: checked both states if the change touches them?

A passing test is not the same as visually-correct output. UI bugs slip through type checks every day.

### 3. Are all 24 locales covered?

- Any new i18n key has been added with a **proper native translation** in all 24 EU locales (not English fallback)?
- No "TODO: translate" placeholders left in non-EN files?
- Spot-checked 2-3 non-EN locales to confirm native text, not English copy-paste?

This is a hard rule (see `.claude/rules/i18n.md` and the `i18n-completeness-check.sh` hook).

### 4. Are docs + RAG + rules updated?

- For user-facing behavior changes: did I update `docs/BRUGER-GUIDE-*` AND `rag/embedded/BRUGER-GUIDE-*`?
- For API changes: `docs/API_DOCUMENTATION.md`?
- For schema changes: `docs/ARCHITECTURE.md`?
- For new patterns: `.claude/rules/<domain>.md`?
- For new skills: `.claude/skills/<name>/SKILL.md` + reference from CLAUDE.md if relevant?

If the agent who picks up the next related task can't infer correct behavior from docs / rules, the work isn't done.

### 5. Have I considered every system surface this could affect?

This is the most-skipped question and the source of the most "you forgot to update X" feedback. PolAds has many cross-coupled surfaces — a "small" change in one place often demands updates in 3-5 others. Walk this list deliberately, not from memory.

**Cross-role surfaces** (advertiser / publisher / admin all see the same data through different lenses):

- **Advertiser views** — registration form, draft list at `/account`, transparency notice at `/[id]`, edit form during NeedsRevision
- **Publisher views** — sign-off review page at `/sign-off/[token]`, PDF/CSV export, partner dashboard if applicable
- **Admin views** — `/admin/advertisements`, `/admin/campaigns`, `/admin/partners`, audit-trail tabs, complaint handling, deletion-request handling
- **Public views** — `/[id]` transparency notice, `/search`, sitemap, public API (`/api/v1/**`, `/api/public/**`), RAG-embedded docs
- **Did I update each surface that displays this data?** A new field on advertiser registration almost always needs a corresponding row in publisher review + admin detail + transparency notice + public API GDPR filter.

**Notification surfaces** (every state change usually has 1-3 emails):

- **Advertiser-facing emails** — submission confirmation, NeedsRevision notice, Confirmed notification, GDPR auto-deletion notice, magic-link auth
- **Publisher-facing emails** — sign-off request (token email), reminder, signed-off confirmation, DPA consent
- **Admin-facing emails** — partner signup notification, complaint received, deletion request received
- **Did I update the right email template?** Locale source (recipient's preference, NEVER admin's browser — see `.claude/rules/emails.md`). Both HTML and plain-text variants. All 24 locales.

**Toast / inline-feedback surfaces** (visible UI feedback for every mutation):

- Did the user get a success toast on success? An error toast on failure with a *useful* message?
- Are toasts using the existing `useToast()` pattern, not invented inline?
- Did optimistic-update mutations register `onError` rollback that *also* triggers a toast?

**Data-shape surfaces** (validation + types + DB stay in sync):

- **Validation** — `lib/validation/registration-schemas.ts` Zod schema updated?
- **DB schema** — `lib/db/registration-schema.ts` Drizzle column added/changed?
- **Types** — TypeScript inferred types flow correctly to API + UI? Any local-component type that duplicates the source-of-truth?
- **Snapshots** — `advertiser_snapshot` / `sponsors_snapshot` JSONB shape captured at submission. Backfill SQL needed for *unconfirmed* snapshots? (Confirmed = NEVER backfill — hard rule.)
- **Migration** — generated, tested on testing branch, additive-or-destructive classified, applied to production *before* the code ships if additive.

**API + integration surfaces**:

- Public API (`/api/public/advertisements/[formId]/` and any other `/api/public/**` route) — does this change leak PII through the GDPR filter (`lib/utils/gdpr-filter.ts`)? Test it.
- RAG chatbot — is the embedded knowledge base stale? `rag/embedded/BRUGER-GUIDE-*.md` updated?
- Webhooks (Stack Auth, payment providers if any) — affected?
- External integrations (Resend templates, Vercel Blob URLs, Upstash rate-limit keys) — affected?

**E2E + test surfaces**:

- Does this break a previously-tested user journey? Run the affected `.spec.ts` files.
- Does the change need a NEW E2E test (per `.claude/rules/testing.md` tier rules)?
- Visual screenshot tests — do they need re-baselining?

**Documentation surfaces**:

- User-facing guides — `docs/BRUGER-GUIDE-REGISTRERING.md` + `rag/embedded/BRUGER-GUIDE-REGISTRERING.md` (BOTH copies)
- Admin guide — `docs/BRUGER-GUIDE-ADMIN-DASHBOARD.md` + RAG copy
- Architecture — `docs/ARCHITECTURE.md` if schema or auth pattern changed
- API — `docs/API_DOCUMENTATION.md` if endpoint surface changed
- `.claude/rules/<domain>.md` if a domain pattern changed

**Concrete walk-through** — when a new field is added to the advertiser registration form, the typical surfaces that need updates are: Zod schema → DB column → snapshot field → backfill (for unconfirmed) → publisher sign-off review page (display) → admin detail view (display) → transparency notice (display, with GDPR filter) → public API serializer → 24-locale i18n keys → email template (if mentioned in any email) → ReviewStep summary → user guide + RAG copy → integration test → E2E spec. **That's ~13 places.** Missing any one is a "you forgot X" cycle. Walk the list.

The full list will live in `.claude/rules/cross-component-coupling.md` (planned) for path-scoped auto-loading. Until that file lands, this question is the canonical reminder — do not attempt to load the rule file.

### 6. Did I reuse existing UI components, design, and layout — or invent something new?

PolAds has a defined design system (glass-morphism + `ThemedInput` / `ThemedSelect` / shadcn primitives + glass tooltips + gradient-purple-pink CTAs). New invention is more often a tell of "I didn't look hard enough" than "the existing system can't express this".

Before adding new visual atoms or layouts, ask:

- **Component**: is there an existing component (`components/ui/*`, `components/registration/*`, `components/admin/*`) that already does this? Did I grep for the variant I need before writing one?
- **Layout pattern**: does this page mirror the structure of an existing page (e.g. `pt-20 pb-10`, max-width container, glass card grid)? Am I diverging on purpose or by accident?
- **Spacing / typography / color**: am I using the existing Tailwind tokens (`bg-white/10 backdrop-blur-xl border border-white/20`, gradient buttons) or inventing new ones?
- **Iconography**: am I using `lucide-react` icons consistently with adjacent pages?
- **Toast / inline feedback**: am I using the existing `useToast()` + standard severity styling, or rolling my own?

If diverging from an existing pattern, the WHY belongs in the PR description ("standard glass card doesn't express this because…") and ideally a one-line entry in `docs/architecture-decisions.md` (planned via #92).

The deep version of this check lives in `/design-consistency` (its own skill) — invoke it for any UI-touching PR.

### 7. Could a regulator / auditor read the commit message + PR description and understand WHY?

PolAds is a regulated product (EU Reg 2024/900 + 2025/1410). For any scope-altering or regulatory-relevant change:

- Commit message says **why**, not just what
- PR description traces the change back to the rule, decision, or stakeholder ask
- For interpretive decisions (e.g. "publisher edits don't auto-mutate sponsorsSnapshot"), the WHY belongs in `docs/founder-decisions.md` once that file lands (planned via GitHub issue #92). Until then, capture the WHY in the PR description and the matching Monday task.
- A reader six months from now can defend this choice without an archive search

## Process

When work feels "done":

1. Read each of the seven questions out loud (or to yourself, in your head).
2. Honest yes? → continue.
3. "Not sure" or "no"? → fix the gap; do NOT declare done.
4. After all seven are honest yes → proceed with self-review / ship-pr / log-progress.

## Anti-patterns

- **Compiles → done**: type check passes, so the work is finished. (No: visual + functional + edge cases + i18n still required.)
- **Tests pass → done**: green CI, so ship. (No: tests reflect what was anticipated; visual UAT and edge cases still matter.)
- **Locale-skim**: "I'll backfill non-EN translations later." Hook will hard-block; but the deeper issue is shipping incomplete work.
- **No-doc-update**: "It's just a refactor." If the behavior is described anywhere (docs, rules, RAG), and the behavior changed, those need to update.
- **Single-surface focus**: shipping the registration form change without updating the publisher review page, admin detail view, transparency notice, email template, or RAG copy. The "you forgot X" cycle.
- **Reinventing existing UI**: writing a new card / input / toast / spinner instead of grepping `components/ui/*` first. The codebase already has the component you need 90% of the time.
- **WHY-less commits**: terse commit messages that don't survive a regulatory audit six months later.

## Why this skill exists

PolAds is small enough that quality drift accumulates fast. This skill is the **handbrake against shipping plausibly-correct work that hasn't been verified end-to-end**. Self-review catches code-level correctness; this catches **ownership-level completeness**.

## Reference

Complements:
- `.claude/skills/self-review/SKILL.md` — code-level 10-point checklist
- `.claude/skills/ship-pr/SKILL.md` — pipeline gate (build / lint / test / push / PR)
- `.claude/skills/design-consistency/SKILL.md` — deep version of Q6 (UI reuse vs invent)
- `.claude/rules/ship-readiness.md` — BLOCKER / IMPROVEMENT / POLISH triage
- `.claude/rules/i18n.md` — 24-locale rule
- `.claude/rules/ui-design.md` — themed components, glass-morphism patterns, page layout rules
- `.claude/rules/testing.md` — mandatory test tiers
