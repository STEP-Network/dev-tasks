# Testing

Every feature or fix MUST include tests at ALL applicable tiers. **No human-test subtasks** — human verification is the parent task's `Waiting for UAT` + auto-generated UAT doc on column `doc_mm3adfdg`.

**Coverage**: happy path + realistic edge cases. Skip exhaustive permutations when core behavior is covered.

## Mandatory tiers

| Tier | Location | Command | When required |
|---|---|---|---|
| **Unit** | `__tests__/lib/` | `pnpm test` | Validation, transforms, utils |
| **Integration** | `__tests__/api/` | `pnpm test` | API routes, DB ops. Use `skipIfDbUnavailable()` guard |
| **E2E (Playwright)** | `e2e/` | `pnpm playwright test` | UI flows, user-facing changes |
| **Browser (MCP)** | Optional | Claude-in-Chrome | Complex UI interactions |

Other commands: `pnpm test:coverage` (coverage report), `pnpm lint` (ESLint + Next.js lint).

## Jest patterns

Test files in `__tests__/` mirror source structure. `jest.mock()` for database, auth, external APIs. Integration tests use `skipIfDbUnavailable()` for CI without DB access.

## Playwright (E2E)

Config `playwright.config.ts` (port 3017); tests in `e2e/`. Auth setup via `e2e/auth.setup.ts` (Stack Auth API `/auth/sessions`); skip gracefully when auth credentials unavailable. Smoke tests for locale routing + short ID redirects; verify both locales render on landing + ad details pages.

## Visual validation

Do NOT rely solely on string-matching unit tests for visual output. Always validate rendered HTML visually with BEFORE-and-AFTER for incremental changes — a single "after" doesn't tell you what changed. The most common UI failure isn't "new thing looks wrong" but "new thing looks right and something adjacent broke."

Capture Before, apply diff, capture After. Read both with the Read tool (image-aware) and compare:

- **Intended changes present?** Every visual AC bullet observable in After.
- **Unintended deltas?** Anything else that changed must trace to a diff hunk; unexplained = regression.

| Change type | Required action |
|---|---|
| Email template | Capture at `/dev/email-preview` BEFORE + AFTER. |
| UI/UX component | Capture page/component BEFORE + AFTER. Same viewport, login state, data. |
| Layout / styling | BEFORE + AFTER mandatory — highest regression risk. |
| Multi-state surfaces (form empty/filled/error, modal open/closed, list empty/populated) | Each state, BEFORE + AFTER. |
| Viewport / theme conditional | At least 2 viewport widths AND both themes (if dark/light). |

**Canonical invocation**: `/dev-tasks:visual-diff` walks Before → apply diff → After → Read both → compare → flag deltas. Manual capture is for cases where the skill doesn't fit.

Agent visual inspection after Playwright captures:
1. Read tool opens both before.png and after.png (image-aware).
2. List each intended change; verify each in After but not Before. List anything else different; trace each to a diff hunk.
3. PASS only if: all intended changes present, no unintended deltas, layout/spacing/color/typography unchanged in unmodified regions.
4. On FAIL, name the specific regression and fix before re-running.

For complex interactions hard to validate with static screenshots (multi-step forms, drag-and-drop, modals, tooltips, hover, cross-browser): use `mcp__claude-in-chrome__computer` and `mcp__claude-in-chrome__read_page`.

## Accessibility (WCAG-AA)

Zero axe-core violations on WCAG-A and WCAG-AA rules for every user-facing page (STEP-wide as of v0.8.13).

Pattern: Playwright + `@axe-core/playwright`. `AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()`; assert `violations` is empty.

When a violation is found:
- **Real**: fix in same PR. Common: alt text, contrast, aria labels, keyboard nav, focus indicator.
- **False positive** (rare): `axe.configure({ rules: [{ id: 'rule-name', enabled: false }] })` for that test ONLY. Never globally disable.
- **Out-of-scope (third-party iframe / vendor widget)**: scope axe with `.include('main')`.

A11y violations can hide in modal/error/loading states. Test each state.

## Cross-browser

Default Chromium for every E2E. Firefox + WebKit for user-flow critical (registration, checkout, login, public-facing). Pattern: Playwright projects. Convention — `e2e/critical/*.spec.ts` for cross-browser scope, `e2e/mobile/*.spec.ts` for mobile-viewport. Everything else Chromium-only.

Extend cross-browser coverage when:
- Change touches a critical-flow page
- CSS features with Safari quirks (subgrid, `:has`, ::backdrop, color-mix)
- Form input behavior (Safari handles autofill / date pickers / file inputs differently)
- Service Worker, IndexedDB, BroadcastChannel (Firefox/Safari differences)

## Performance budgets

Web Vitals (LCP, CLS, INP) within budget. Failing budgets BLOCK the PR — not advisory.

Pattern: Playwright performance API or `web-vitals` library. Assert TTFB < 800ms, FCP < 1800ms, DOMContentLoaded < 3500ms, LCP < 2500ms (good), CLS < 0.1 (good). Richer measurement via Lighthouse CI in GitHub Actions.

Set initial budgets from current measurements (median LCP/CLS/INP across 5 runs on staging). Tighten over time.

## Visual regression baselines (future)

When Phase 2 of `e2e-masterplan.md` lands, committed-baseline `toHaveScreenshot` with intentional-update flow. Until then, `/dev-tasks:visual-diff` ephemeral before/after is canonical.

## Race condition testing

Account for Neon replication lag. Use `retryWithBackoff(fn, retries=3, baseMs=300, maxMs=2000)` patterns. Log before/after insert with `console.log` markers — if subsequent query returns empty, it's a race.
