---
name: design-consistency
description: Reuse-before-invent checklist for any UI-touching change. Forces a grep-and-survey of existing components, layouts, tokens, and patterns before writing new ones. Cuts visual drift and the "we already had a component for that" cycle.
user_invocable: true
---

# /design-consistency — Reuse-before-invent checklist

> **Overlay**: if `.claude/skills/design-consistency/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific instructions (extend-only — overlay can append checks/steps but cannot replace plugin behavior). Project-specific component names, design tokens, and directory conventions belong in the overlay.

## When to apply

Invoke (or apply ambiently) before writing UI code in any of these situations:

- Adding a new form field, button, card, modal, toast, or layout block
- Building a new page or admin tab
- Composing a new email template
- Touching anything under the project's UI directories (consult `.claude/rules/ui-design.md` for paths)

The user can invoke `/design-consistency` for a deliberate pass on any UI-touching PR. The skill is also referenced from `/production-quality-ownership` Q6.

## Why this skill exists

Visual drift accumulates one "small" deviation at a time. A new pattern invented on one page becomes the precedent the next page copies — until the design system has 3 ways to render a card and 2 toast styles. **The existing system can express most of what you need**. The work is finding the right piece, not building a new one.

This skill is also a hedge against a real failure mode: an AI agent's training has thousands of "build a new card" patterns and few "find the existing card" patterns. Defaults bend toward invention. This skill bends them back.

## The reuse hierarchy (check in this order)

For any visual element you're about to add, walk this list **top to bottom**. Stop at the first match.

### 1. Domain-specific component

Did someone already solve this exact problem in this codebase? Each project has its own component organization — consult the consumer's overlay or `.claude/rules/ui-design.md` for the canonical directories and naming patterns. Common patterns:

- A `components/<domain>/` directory per feature area
- Domain-specific list/card/form components that wrap lower-level primitives

**Grep first**: `grep -r "ComponentName" components/` or search by behavior keyword. If a component exists for the *exact* concept, use it. If a close-but-not-quite component exists, extend it (add a prop) before forking it.

### 2. Project's themed primitives

Most projects wrap lower-level primitives in themed components to enforce the design language consistently. If the project has them (consult overlay), use those instead of raw HTML:

- Themed `<Input />` / `<Select />` wrapper — never raw `<input>` / `<select>`
- Project's `<Button />` with its canonical variants (primary CTA, ghost, destructive, etc.)

If you're typing `<input` or `<select`, stop and check whether a themed version exists in the project.

### 3. Stock primitives (`components/ui/*`)

Lower-level building blocks: `Card`, `Dialog`, `Tooltip`, `Popover`, `DropdownMenu`, `Tabs`, `Accordion`, `Sheet`, `Toast`, `Badge`, `Progress`, `Skeleton`, `Alert`, `Separator`, `Checkbox`, etc.

If you're about to build something that resembles a "modal", "popover", "dropdown", "tabs", "accordion", "side panel" — there's almost certainly a primitive for it. **Run `ls components/ui/` and read the file names** before writing one.

### 4. Existing layout / spacing / color tokens

Before inventing new visual atoms, copy from adjacent pages. The project's design tokens (page wrapper, container, card surface, primary CTA, form spacing, nav clearance, etc.) should be reused verbatim — not approximated. Consult the consumer's `.claude/rules/ui-design.md` for the canonical token list.

### 5. Typography + iconography

- Typography is usually implicit from Tailwind/framework defaults — don't override font-family or invent custom sizes per page.
- Icons come from the project's icon library (typically `lucide-react`). Pick names consistent with adjacent pages.
- Never embed inline SVG when an icon-library icon exists.

### 6. Toast / inline feedback / loading states

- **Toast**: use the project's toast hook (e.g. `useToast()`). Never `alert()`, never inline div.
- **Loading state**: follow the project's pattern. Some prefer optimistic updates (no spinners); some use `<Skeleton />` for genuinely-async surfaces.
- **Error state**: per-field inline message via the form library; page-level errors via toast.
- **Empty state**: match the existing empty-state convention in the project.

### 7. Email visual atoms

Emails have their own constraints (no `<style>` tags survive, inline CSS only, plain-text fallback). Reuse from the project's email template utilities and the existing template files.

For new emails, **never copy the rules from a UI page** — emails follow different conventions (dark text on light backgrounds; max width ~600px; brand colors via inline style attributes). Survey existing templates first.

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
- You've checked the upstream component library for a component that doesn't yet exist locally

If all four are true: invent, but do it as a properly-named reusable component in `components/ui/` or `components/<domain>/`, not inline in a page. Document the WHY in the project's architecture-decisions doc (or in the PR description as a fallback).

## Output of a /design-consistency pass

When invoked explicitly, produce a triage of the UI-touching diff. Concrete example structure:

```
Design consistency pass — PR #N

Components surveyed:
  ✅ Existing <DomainCard /> reused for new admin page — match
  ✅ Existing themed input wrapper reused for new field — match
  ⚠️  New <StatusPill /> added — was the existing <Badge /> already adequate? Check.
  ❌ Inline <input> in path/to/file.tsx:42 — should use themed wrapper

Layout surveyed:
  ✅ Page wrapper matches existing pattern
  ✅ Card surface matches design tokens

Iconography:
  ✅ All icons from project's icon library

Verdict: 1 BLOCKER (raw input), 1 IMPROVEMENT (consider Badge over StatusPill).
```

## Anti-patterns

- **NIH (not-invented-here)**: building because grepping felt like "wasted effort"
- **Pattern fork**: copying an existing component file and tweaking inline rather than adding a prop
- **Token drift**: `bg-white/15`, `bg-white/12`, `bg-white/10` all on different pages because nobody enforced the canonical value
- **Stub-first**: building `<NewComponent />` as a stub "to fill in later" — it never gets reused, so it shouldn't exist
- **One-off icon swap**: `<X />` here, `<Close />` there, `<XCircle />` somewhere else — the codebase already picked one
- **Inline error UI**: rendering `<div className="text-red-500">{error}</div>` instead of using the form library's `<FormMessage />`

## Reference

- `.claude/rules/ui-design.md` — project's themed components, design tokens, page layout rules (in the consumer repo)
- Project's component directories — grep there for behavior keywords before inventing
- `components/ui/` — stock primitives (run `ls` here before inventing)
- `.claude/skills/production-quality-ownership/SKILL.md` Q6 — short version of this check, run before declaring done
