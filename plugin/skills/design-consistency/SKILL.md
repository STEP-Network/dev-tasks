---
name: design-consistency
description: Reuse-before-invent checklist for any UI-touching change. Forces a grep-and-survey of existing components, layouts, tokens, and patterns before writing new ones. Cuts visual drift and the "we already had a component for that" cycle.
user_invocable: true
---

# /design-consistency — Reuse-before-invent checklist

## When to apply

Before writing UI code in any of these:
- Adding a new form field, button, card, modal, toast, or layout block
- Building a new page or admin tab
- Composing a new email template
- Touching anything under the project's UI directories (see `.claude/rules/ui-design.md`)

Also referenced from `/production-quality-ownership` Q6.

## The reuse hierarchy (check top to bottom; stop at first match)

### 1. Domain-specific component

`grep -r "ComponentName" components/` or search by behavior keyword. If a component exists for the exact concept, use it. Close-but-not-quite → extend it (add a prop) before forking.

### 2. Project's themed primitives

Most projects wrap raw HTML with themed components (e.g. `<ThemedInput />`). If typing `<input` or `<select`, stop and check whether a themed version exists. Project conventions live in the consumer's overlay or `.claude/rules/ui-design.md`.

### 3. Stock primitives (`components/ui/*`)

`Card`, `Dialog`, `Tooltip`, `Popover`, `DropdownMenu`, `Tabs`, `Accordion`, `Sheet`, `Toast`, `Badge`, `Progress`, `Skeleton`, `Alert`, `Separator`, `Checkbox`. Run `ls components/ui/` before inventing modal/popover/tabs/accordion/etc.

### 4. Layout / spacing / color tokens

Copy from adjacent pages. Reuse design tokens verbatim, not approximated. Canonical token list in `.claude/rules/ui-design.md`.

### 5. Typography + iconography

- Typography: implicit from Tailwind/framework defaults — don't override per page.
- Icons: from project's library (typically `lucide-react`). Pick names consistent with adjacent pages. Never inline SVG when an icon exists.

### 6. Toast / inline feedback / loading states

- Toast: project's hook (e.g. `useToast()`). Never `alert()` or inline div.
- Loading: follow project pattern (optimistic vs `<Skeleton />`).
- Error: per-field inline via form library; page-level via toast.
- Empty: match existing convention.

### 7. Email visual atoms

Emails: no `<style>` tags survive, inline CSS only. Reuse from project's email template utilities. Never copy UI-page rules to emails — emails follow different conventions (dark text on light, max ~600px width, brand colors via inline style).

## The grep-first rule

Before writing new component, run two greps:
```bash
grep -r "behavior-keyword" components/
grep -r "card-or-modal-or-button-thing" app/ components/
```
If either returns >0 results, read those files before inventing.

## When invention IS right

All four must be true:
- Grepped obvious keywords + read candidates — none fit
- Closest existing component requires gutting >50% of props to repurpose
- New pattern will be reused by ≥2 future surfaces
- Upstream component library doesn't have a usable equivalent

Then: invent as properly-named reusable in `components/ui/` or `components/<domain>/`, not inline. Document WHY in architecture-decisions doc or PR description.

## Output of a /design-consistency pass

```
Design consistency pass — PR #N

Components surveyed:
  ✅ Existing <DomainCard /> reused — match
  ⚠️  New <StatusPill /> added — was existing <Badge /> adequate? Check.
  ❌ Inline <input> in path/to/file.tsx:42 — should use themed wrapper

Layout: matches existing patterns
Iconography: from project's library

Verdict: 1 BLOCKER (raw input), 1 IMPROVEMENT (consider Badge over StatusPill).
```

## Anti-patterns

- NIH: building because grepping felt like "wasted effort"
- Pattern fork: copying a file and tweaking inline rather than adding a prop
- Token drift: `bg-white/15`, `bg-white/12`, `bg-white/10` all on different pages
- Stub-first: building `<NewComponent />` to fill in later — never gets reused
- One-off icon swap: codebase already picked one

## Reference

- `.claude/rules/ui-design.md` — project's themed components, tokens, layout
- `components/ui/` — stock primitives (run `ls` first)
- `.claude/skills/production-quality-ownership/SKILL.md` Q6 — short version
