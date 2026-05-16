---
name: design-consistency
description: Reuse-before-invent checklist for any UI-touching change. Forces a grep-and-survey of existing components, layouts, tokens, and patterns before writing new ones. Cuts visual drift and the "we already had a component for that" cycle.
user_invocable: true
---

# /design-consistency — Reuse-before-invent checklist

## When to apply

Invoke (or apply ambiently) before writing UI code in any of these situations:

- Adding a new form field, button, card, modal, toast, or layout block
- Building a new page or admin tab
- Composing a new email template
- Touching anything under `components/`, `app/[locale]/**/page.tsx`, `lib/email/*-templates.tsx`

The user can invoke `/design-consistency` for a deliberate pass on any UI-touching PR. The skill is also referenced from `/production-quality-ownership` Q6.

## Why this skill exists

Visual drift accumulates one "small" deviation at a time. A new pattern invented on one page becomes the precedent the next page copies — until the design system has 3 ways to render a card and 2 toast styles. PolAds has a defined glass-morphism design language and shadcn primitives; **the existing system can express ~90% of what you need**. The work is finding the right piece, not building a new one.

This skill is also a hedge against a real failure mode: an AI agent's training has thousands of "build a new card" patterns and few "find the existing card" patterns. Defaults bend toward invention. This skill bends them back.

## The reuse hierarchy (check in this order)

For any visual element you're about to add, walk this list **top to bottom**. Stop at the first match.

### 1. Domain-specific component

Did someone already solve this exact problem on PolAds?

- `components/registration/*` — for advertiser registration flows (steps, forms, summaries, in-kind contribution sections, sponsor blocks)
- `components/admin/*` — for admin tables, partner management, complaint handling, deletion-request UIs
- `components/sign-off/*` — for publisher sign-off review forms (lands when PR #86 merges; until then sign-off UI is on the `feat/publisher-sign-off-workflow` branch). <!-- TODO(post-PR-86): drop the merge hedge once PR #86 lands -->
- `components/amendment/*` — for transparency notice amendments
- `components/registration/AdvertisementCard`, `SponsorEntry`, `InKindContributionSection`, etc. — frequently the right re-use target

**Grep first**: `grep -r "ComponentName" components/` or search by behavior keyword. If a component exists for the *exact* concept, use it. If a close-but-not-quite component exists, extend it (add a prop) before forking it.

### 2. Themed primitives

PolAds-defined wrappers around shadcn that enforce the glass-morphism look:

- **`<ThemedInput />`** — never raw `<input>`
- **`<ThemedSelect />`** — never raw `<select>`
- **`<Button />`** with the gradient variant for primary CTAs (`bg-gradient-to-r from-purple-600 to-pink-600`)

If you're typing `<input` or `<select`, stop and check whether the themed version exists. The hook (`snapshot-guard.sh`) doesn't catch this; the code reviewer does.

(Note: `<Checkbox />` is the stock shadcn primitive from `components/ui/checkbox.tsx`, NOT a PolAds-defined themed wrapper — see Level 3 below. Don't try to invent a `<ThemedCheckbox />` if you can't find one; the existing shadcn `<Checkbox />` IS the canonical one.)

### 3. shadcn primitives (`components/ui/*`)

Lower-level building blocks: `Card`, `Dialog`, `Tooltip`, `Popover`, `DropdownMenu`, `Tabs`, `Accordion`, `Sheet`, `Toast`, `Badge`, `Progress`, `Skeleton`, `Alert`, `Separator`, **`Checkbox`** (over raw `<input type="checkbox">`), etc.

If you're about to build something that resembles a "modal", "popover", "dropdown", "tabs", "accordion", "side panel" — there's a shadcn component for it. **Run `ls components/ui/` and read the file names** before writing one.

### 4. Existing layout / spacing / color tokens

Before inventing new visual atoms, copy from adjacent pages:

- **Page wrapper**: `<main className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 pt-20 pb-10">`
- **Container**: `<div className="max-w-4xl mx-auto px-4">` (or `max-w-6xl` for admin)
- **Card surface**: `bg-white/10 backdrop-blur-xl border border-white/20 rounded-xl`
- **Tooltip surface**: `bg-gray-900/95 backdrop-blur-sm border-white/20 text-white`
- **Primary CTA**: `bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700`
- **Form field spacing**: existing form-step components are the canonical pattern
- **Top padding for nav clearance**: `pt-20` is the HARD rule per `.claude/rules/ui-design.md`

### 5. Typography + iconography

- Typography is implicit from Tailwind defaults — don't override font-family or invent custom sizes per page.
- Icons come from `lucide-react`. Pick names consistent with adjacent pages (e.g. if existing admin tabs use `<Trash2 />` for delete, don't introduce `<X />`).
- Never embed inline SVG when a `lucide-react` icon exists.

### 6. Toast / inline feedback / loading states

- **Toast**: `useToast()` from `components/ui/use-toast.tsx`. Standard variants (default, destructive). Never `alert()`, never inline div.
- **Loading state**: optimistic-update pattern (no spinners) per `.claude/rules/ui-design.md`. If a spinner *is* genuinely needed (e.g. a long-running export), use the `<Skeleton />` shadcn primitive.
- **Error state**: per-field inline message via the form library; page-level errors via toast.
- **Empty state**: glass card with a centered illustration + CTA, mirroring existing `ListingsEmptyState` patterns.

### 7. Email visual atoms

Emails have their own constraints (no `<style>` tags survive, inline CSS only, plain-text fallback). Reuse from `lib/email/email-template-utils.tsx` (`safeT()`, header/footer builders) and the existing template files (`partner-welcome-templates.tsx`, `advertiser-welcome-templates.tsx`).

For new emails, **never copy the rules from a UI page** — emails follow different conventions (dark text on light backgrounds; no glass-morphism; max width ~600px; brand colors via inline style attributes). Survey existing templates first.

## The grep-first rule

Before writing any new component, **run two greps**:

```bash
# Behavior-keyword grep
grep -r "behavior-keyword" components/

# Visual-keyword grep
grep -r "card-or-modal-or-button-thing" app/ components/
```

If either grep returns >0 results, read those files before deciding to invent.

## When invention IS the right call

Sometimes the existing system genuinely doesn't have what you need. Indicators:

- You've grep'd for the obvious keywords and read the candidates — none fit
- The closest existing component requires gutting more than half its props to repurpose
- The new pattern will be reused by ≥2 future surfaces (otherwise: inline it)
- You've checked shadcn/ui upstream for a component that doesn't yet exist locally

If all four are true: invent, but do it as a properly-named reusable component in `components/ui/` or `components/<domain>/`, not inline in a page. And document the WHY in `docs/architecture-decisions.md` (planned via #92) so the next agent knows it was deliberate — or in the PR description as a fallback until that file exists.

## Output of a /design-consistency pass

When invoked explicitly, produce a triage of the UI-touching diff:

```
Design consistency pass — PR #N

Components surveyed:
  ✅ Existing `<AdvertisementCard />` reused for the new admin detail page — match
  ✅ Existing `<ThemedInput />` reused for new field — match
  ⚠️  New `<StatusPill />` added in components/admin/StatusPill.tsx — was an existing
      `<Badge variant="outline">` already adequate? Check.
  ❌ Inline `<input>` in components/admin/QuickFilter.tsx:42 — should be `<ThemedInput />`

Layout surveyed:
  ✅ Page wrapper matches existing pattern (pt-20 pb-10, max-w-4xl)
  ✅ Card surface matches glass-morphism convention

Iconography:
  ✅ All icons from lucide-react, consistent with adjacent admin tabs

Verdict: 1 BLOCKER (raw input), 1 IMPROVEMENT (consider Badge over StatusPill).
```

## Anti-patterns

- **NIH (not-invented-here)**: building because grepping felt like "wasted effort"
- **Pattern fork**: copying an existing component file and tweaking inline rather than adding a prop
- **Token drift**: `bg-white/15`, `bg-white/12`, `bg-white/10` all on different pages because nobody enforced the canonical 10
- **Stub-first**: building `<NewComponent />` as a stub "to fill in later" — it never gets reused, so it shouldn't exist
- **One-off icon swap**: `<X />` here, `<Close />` there, `<XCircle />` somewhere else — the codebase already picked one
- **Inline error UI**: rendering `<div className="text-red-500">{error}</div>` instead of using the form library's `<FormMessage />`

## Reference

- `.claude/rules/ui-design.md` — themed components, glass-morphism patterns, page layout HARD rule (`pt-20`)
- `.claude/rules/registration.md` — RegistrationForm + step component conventions
- `.claude/rules/admin.md` — admin dashboard component conventions
- `.claude/rules/emails.md` — email template architecture (separate visual world)
- `.claude/skills/production-quality-ownership/SKILL.md` Q6 — short version of this check, run before declaring done
- `components/ui/` — shadcn primitives (run `ls` here before inventing)
- `components/registration/`, `components/admin/`, `components/amendment/` — domain-specific components on `main` (grep here for behavior keywords). Once PR #86 merges, also `components/sign-off/`. <!-- TODO(post-PR-86): include sign-off in the on-main list -->
