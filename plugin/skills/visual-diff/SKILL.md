---
name: visual-diff
description: Before-and-after visual verification for any UI/UX diff. Captures a baseline screenshot, applies the change, captures a follow-up screenshot, then reads both via the image-aware Read tool to verify intended changes happened and surface any unintended visual deltas. The canonical invocation for self-review Check #2.
user_invocable: true
---

# /visual-diff — Before/After Visual Verification

> **Overlay**: if `.claude/skills/visual-diff/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific instructions (extend-only — overlay can append checks/steps but cannot replace plugin behavior). PolAds-specific URLs, preview-deploy patterns, login fixtures, and per-page acceptance criteria belong in the overlay.

## When to apply

Invoke before declaring any UI/UX change done. Mandatory when the diff touches:

- `components/**/*.tsx` / `.jsx`
- `app/**/page.tsx` / `layout.tsx` / `error.tsx` / `loading.tsx`
- `lib/email/*-templates.tsx` (or wherever email templates live)
- Any styling file (`globals.css`, theme tokens, Tailwind config)
- Public-facing route changes that affect rendered output

Optional but valuable on: refactors that touch shared layout primitives, dependency upgrades that affect rendered components (React, Next, Tailwind, etc.).

## Why before-and-after, not just after

A single "after" screenshot tells you what the page looks like. It does NOT tell you what changed. The most common UI failure mode is NOT "the new thing looks wrong" — it's "the new thing looks right but something adjacent broke." Spacing collapsed in a sibling component, a font fell back, a section's padding regressed because a wrapper class changed, an unrelated icon shifted because flex order changed. A bare after-only check misses every one of those.

## Workflow

### Step 0 — Project context

Read `.claude/project-config.json`. Extract `environments.uat.url` (used for capturing Before against a deployed baseline if no local server is running). Read overlay if present.

### Step 1 — Identify the surface

What URL(s) does this diff affect?

- Look at the file paths in `git diff $defaultBase...HEAD --stat`. For `components/registration/*` edits, the affected page is `/[locale]/register` (or whatever the project's routing convention dictates).
- For email templates, the affected URL is the project's dev email-preview route (e.g. `/dev/email-preview?template=<name>`).
- For shared primitives (used by N pages), pick the 1–2 most-affected pages OR capture a representative grid of them.

If the diff is purely build-time / not-rendered (e.g. config, types, server-only utilities with no UI effect): SKIP this skill with a documented reason in self-review Check #2.

### Step 2 — Capture Before

Take a screenshot of the unmodified page. Use whichever tool is available, in this order:

1. **`mcp__claude-in-chrome__*`** (browser MCP) — if the consumer is in a Claude Code session with browser access. Load `mcp__claude-in-chrome__tabs_create_mcp` and `mcp__claude-in-chrome__computer` (or `mcp__claude-in-chrome__navigate`) via ToolSearch, navigate to the page on whatever URL is reachable (local dev / preview / staging), and screenshot.
2. **Playwright via Bash** — if no browser MCP, run `pnpm playwright test --grep "<test-name>"` against a script that navigates + screenshots. Sample script lives in `.claude/scripts/visual-diff.spec.ts` if the project has one; otherwise see `.claude/rules/testing.md` for the canonical Playwright pattern.
3. **Vercel preview URL of a recent commit on `$defaultBase`** — `gh pr view $(gh pr list --base $defaultBase --state merged --limit 1 --json number --jq '.[0].number') --json comments` to find the latest preview URL, then use the same screenshot tool against it. Acceptable when no local server is running.
4. **Documented skip** — if NONE of the above is reachable, document why in self-review Check #2 and continue. Don't fake a Before.

Save as `before.png` (or per-state if multiple: `before-empty.png`, `before-error.png`, etc.). Same viewport, login state, and data set as you plan to use in step 4.

### Step 3 — Apply the diff

Your edits are already in the worktree. If not yet applied, apply them now.

### Step 4 — Capture After

Same URL, same viewport, same login state, same data set as Before. Same tool from step 2. Save as `after.png` (and matching per-state suffixes if multiple).

If the page now requires a different URL (e.g. routing changed), capture the new URL as After AND keep the old URL's screenshot — the route change itself is part of the diff worth verifying.

### Step 5 — Read both with the Read tool

The Read tool supports images natively. Pass each screenshot's absolute path:

```
Read({ file_path: "/abs/path/to/before.png" })
Read({ file_path: "/abs/path/to/after.png" })
```

Both render visually in your context. Compare in plain language. Write the comparison out (don't just internalize it):

```
## Intended changes (from acceptance criteria)
- [✅] Submit button label changed from "Send" to "Submit Application"  — observable in After
- [✅] New required field "Phone" added between Email and Address — observable in After
- [⚠️] Inline validation on Phone — Before had no validation, After shows red text on invalid input; intended but verify the styling matches existing patterns

## Unintended deltas (anything else different between Before and After)
- [✅ none] OR
- [❌ regression] The Submit button's right margin changed from `mr-4` to `mr-2` — not in the diff, looks like a flex realignment side-effect. Investigate.

## Edge states (if applicable)
- Empty state: <comparison>
- Error state: <comparison>
- Mobile viewport: <comparison>
```

### Step 6 — Verdict

- **All intended changes present + zero unintended deltas + edge states match** → PASS. Note in self-review Check #2.
- **Intended changes present + unintended deltas exist** → FAIL. Either:
  - The unintended delta is also desirable (e.g. the spacing actually looks better): document it in the PR description and proceed. Don't silently let scope grow without naming it.
  - The unintended delta is a regression: fix in scope. Re-run /visual-diff after the fix.
- **Intended change missing** → BLOCKER. Fix and re-run.

### Step 7 — Save artifacts (optional)

For high-stakes changes (regulatory pages, payment flows, public-facing legal text), commit `before.png` + `after.png` to `e2e/screenshots/visual-diff/<task-id>/` and reference them in the PR description. This preserves the audit trail for downstream review.

## Arguments

- `<page-url>` (optional): the page to verify. If omitted, the skill infers from the diff (per Step 1).

## Anti-patterns

- **Capturing only After**: defeats the purpose. The before is what makes unintended regressions visible.
- **Different viewport / login / data between Before and After**: makes the comparison meaningless. Hold every variable except the diff constant.
- **Pixel-diff tools (`toHaveScreenshot()`) without LLM read**: pixel diff flags trivial sub-pixel anti-aliasing changes as regressions and misses meaningful semantic changes (color drift within tolerance, text reflow). The LLM-reads-both approach handles both correctly, and the pixel-diff approach is fragile.
- **Skipping for "tiny" changes**: a one-line CSS change can cascade. Run the diff anyway — it's 30 seconds.

## When to spawn the e2e-tester subagent

For diffs that touch a complex flow (multi-step form, modal cascade, drag-and-drop), running visual-diff inline burns context. Spawn `dev-tasks:e2e-tester` instead:

```
Agent({
  description: "Visual diff for <flow>",
  subagent_type: "dev-tasks:e2e-tester",
  prompt: "Run /dev-tasks:visual-diff on <urls>. Use the Before/After workflow per the skill. Return the comparison verdict + flag any unintended deltas. Don't edit files."
})
```

The subagent has Playwright + Bash + Read, which is enough for the workflow.

## Reference

- `.claude/rules/testing.md` Visual Validation section — fuller rationale + Playwright snippets
- `.claude/skills/self-review/SKILL.md` Check #2 — the gate that enforces this skill ran when UI changed
- `mcp__claude-in-chrome__*` — browser MCP, the preferred capture tool when available
- `.claude/skills/e2e-tester/` (subagent definition) — for delegating to a Playwright subagent
