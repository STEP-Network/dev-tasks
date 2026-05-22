---
name: visual-diff
description: Before-and-after visual verification for any UI/UX diff. Captures a baseline screenshot, applies the change, captures a follow-up screenshot, then reads both via the image-aware Read tool to verify intended changes happened and surface any unintended visual deltas. The canonical invocation for self-review Check #2.
user_invocable: true
---

# /visual-diff — Before/After Visual Verification

## When to apply

Before declaring any UI/UX change done. Mandatory when diff touches:
- `components/**/*.tsx` / `.jsx`
- `app/**/page.tsx` / `layout.tsx` / `error.tsx` / `loading.tsx`
- `lib/email/*-templates.tsx`
- Any styling file (`globals.css`, theme tokens, Tailwind config)
- Public-facing route changes affecting rendered output

Optional but valuable: refactors touching shared layout primitives, dependency upgrades affecting rendered components.

A single after-screenshot tells you what the page looks like, not what changed. The common failure mode is "new thing looks right but something adjacent broke" — spacing, font fallback, padding regression, icon shift. After-only checks miss every one.

## Workflow

### Step 0 — Project context

Read `.claude/project-config.json` for `environments.uat.url`. Read overlay if present.

### Step 1 — Identify the surface

What URL(s) does this diff affect? Look at `git diff $defaultBase...HEAD --stat`. Map to URLs per project routing. Email templates → dev email-preview route (e.g. `/dev/email-preview?template=<name>`). Shared primitives → 1-2 most-affected pages or a representative grid.

Build-time / not-rendered → SKIP with documented reason in self-review Check #2.

### Step 2 — Capture Before

Take screenshot of unmodified page. Tool priority:
1. `mcp__claude-in-chrome__*` — navigate + screenshot. Load via ToolSearch.
2. Playwright via Bash against a script that navigates + screenshots. Canonical pattern in `.claude/rules/testing.md`.
3. Vercel preview URL of recent `$defaultBase` commit (latest merged PR's preview).
4. Documented skip if none reachable. Don't fake a Before.

Save `before.png` (or per-state: `before-empty.png`, `before-error.png`).

**Capture BOTH desktop AND mobile by default** (v0.8.13+; mobile no longer opt-in unless provably desktop-only):
- Desktop: 1440×900 or `devices['Desktop Chrome']`
- Mobile: 390×844 or `devices['iPhone 14']`

Save as `before-desktop.png` + `before-mobile.png`. Same for After. Step 5 compares both viewports independently.

### Step 3 — Apply the diff

Your edits are already in the worktree. If not yet applied, apply now.

### Step 4 — Capture After

Same URL, viewport, login state, data set as Before. Same tool from Step 2. Save `after.png` (+ per-state suffixes).

If page now requires different URL (routing changed), capture new URL as After AND keep old URL's screenshot — route change itself is part of the diff.

### Step 5 — Read both with Read tool

`Read({ file_path: "/abs/path/to/before.png" })` and same for After. Both render visually. Write comparison out:

```
## Intended changes (from acceptance criteria)
- [✅] Submit button label changed from "Send" to "Submit Application" — observable in After
- [⚠️] Inline validation on Phone — verify styling matches existing patterns

## Unintended deltas
- [❌ regression] Submit button right margin changed from `mr-4` to `mr-2` — not in diff, looks like flex realignment side-effect. Investigate.

## Edge states
- Empty / Error / Mobile viewport: <comparison>
```

### Step 6 — Verdict

- All intended present + zero unintended + edge states match → PASS. Note in self-review Check #2.
- Intended present + unintended deltas exist → FAIL. Either document scope growth in PR description OR fix as regression in scope. Re-run after fix.
- Intended change missing → BLOCKER. Fix and re-run.

### Step 7 — Save artifacts (optional)

High-stakes changes (regulatory, payment, public-facing legal): commit `before.png` + `after.png` to `e2e/screenshots/visual-diff/<task-id>/` and reference in PR description.

## Arguments

- `<page-url>` (optional): page to verify; infers from diff per Step 1 if omitted.

## Anti-patterns

- Capturing only After — defeats the purpose
- Different viewport/login/data between Before and After — comparison meaningless
- Pixel-diff tools (`toHaveScreenshot()`) without LLM read — flags trivial anti-aliasing, misses semantic changes
- Skipping for "tiny" changes — one-line CSS can cascade; the diff takes 30 seconds

## When to spawn the e2e-tester subagent

Complex flow (multi-step form, modal cascade, drag-and-drop) → spawn `dev-tasks:e2e-tester`:
```
Agent({
  description: "Visual diff for <flow>",
  subagent_type: "dev-tasks:e2e-tester",
  prompt: "Run /dev-tasks:visual-diff on <urls>. Use Before/After workflow per the skill. Return comparison verdict + flag unintended deltas. Don't edit files."
})
```

## Coordination with `/dev-tasks:write-uat-spec`

Both skills involve screenshot-based verification but cover different cases:

- **`/dev-tasks:visual-diff`** (this skill) — ad-hoc Before/After verification during self-review Check #2. "I changed `<Header>`, did anything else move?" One-shot, not codified, focused on detecting cascading regressions in a specific commit. Run manually.
- **`/dev-tasks:write-uat-spec`** — writes a codified per-flow Playwright spec that ships in the PR and runs as the Phase 4.6 hard gate before `Waiting for UAT`. The spec's `toHaveScreenshot()` runs every time the spec runs (every PR going forward). Catches regressions caused by *future* changes.

When in doubt: visual-diff for "did this commit break something visible" during dev; write-uat-spec for "is this flow still working" as a durable gate. They're complementary, not duplicative.

## Reference

- `.claude/rules/testing.md` Visual Validation — fuller rationale + Playwright snippets
- `.claude/skills/self-review/SKILL.md` Check #2 — the gate enforcing this skill ran
- `mcp__claude-in-chrome__*` — browser MCP, preferred capture
- `.claude/skills/e2e-tester/` — Playwright subagent for delegation
- `plugin/skills/write-uat-spec/SKILL.md` — sibling skill for codified per-flow regression (see "Coordination" above)
