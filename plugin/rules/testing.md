# Testing Rules

## TL;DR

Every feature or fix MUST include tests at ALL applicable tiers:

- **Unit** (`__tests__/lib/`) — `pnpm test`. Validation, transforms, utils.
- **Integration** (`__tests__/api/`) — `pnpm test`. API routes, DB ops. Use `skipIfDbUnavailable()` guard.
- **E2E** (`e2e/`) — `pnpm playwright test`. UI flows, user-facing changes.

**No human-test subtasks.** Human verification is the parent task's `Waiting for UAT` status + the auto-generated UAT doc on column `doc_mm3adfdg`. Test subtasks describe agent-written test code, not human verification.

**Coverage:** happy path + realistic edge cases. Skip exhaustive permutations when core behavior is covered.

## Mandatory Test Tiers

Every feature or bug fix MUST include tests at ALL applicable tiers:

| Tier | Location | Command | When Required |
|------|----------|---------|---------------|
| **Unit** | `__tests__/lib/` | `pnpm test` | Validation, transforms, utils |
| **Integration** | `__tests__/api/` | `pnpm test` | API routes, DB operations |
| **E2E (Playwright)** | `e2e/` | `pnpm playwright test` | UI flows, user-facing changes |
| **Browser (MCP)** | Optional | Claude-in-Chrome | Complex UI interactions |

## Test Commands

```bash
pnpm test              # Jest unit + integration tests
pnpm test:coverage     # Coverage report
pnpm lint              # ESLint + Next.js lint
pnpm playwright test   # Playwright E2E tests
```

## Jest Patterns

- Test files in `__tests__/` mirroring source structure
- Mock patterns for database, auth, and external APIs
- Use `jest.mock()` for module-level mocks
- Integration tests use `skipIfDbUnavailable()` guard for CI without DB access

## Playwright (E2E)

- Config: `playwright.config.ts` (port 3017)
- Tests in `e2e/` directory
- Auth setup via `e2e/auth.setup.ts` (Stack Auth API `/auth/sessions`)
- Tests skip gracefully when auth credentials are unavailable
- Smoke tests for locale routing and short ID redirects
- Verify both locales render on landing and ad details pages

## Visual Validation (Screenshots & Rendered Output)

**Do NOT rely solely on string-matching unit tests for visual output. Always validate rendered HTML visually — with a BEFORE-and-AFTER pair when the change is incremental.**

### Why before-and-after, not just after

A single "after" screenshot tells you what the page looks like. It does NOT tell you what changed. The most common UI failure mode isn't "the new thing looks wrong" — it's "the new thing looks right but something adjacent broke." Spacing collapsed, a sibling moved, a font fell back, an unrelated section's padding regressed. A bare after-only check misses every one of those.

Capture a Before (current behavior), apply the diff, capture an After. Then read both with the Read tool (images supported natively) and compare in plain language:

- **Intended changes present?** — every visual acceptance-criterion bullet is observable in the After.
- **Unintended deltas?** — anything else that changed visually in the After must trace to a diff hunk. If it doesn't, it's a regression in scope; fix it before declaring done.

### When Visual Validation Is Required

| Change Type | Required Action |
|-------------|----------------|
| **Email template changes** | Capture rendered email at `/dev/email-preview` (or equivalent) BEFORE + AFTER the diff. Read both, compare. |
| **UI/UX component changes** | Capture the page/component BEFORE + AFTER the diff. Same viewport, same login state, same data. Read both, compare. |
| **Layout or styling changes** | BEFORE + AFTER mandatory — these are the highest-risk-of-unintended-regression class. |
| **Multi-state surfaces** (form empty/filled/error, modal open/closed, list empty/populated) | Capture EACH state, BEFORE + AFTER for each. Not just the happy path. |
| **Viewport / theme conditional changes** | At least 2 viewport widths AND both themes (if the project has dark/light). |

### The `/dev-tasks:visual-diff` skill

The plugin ships a skill that orchestrates this workflow — call `/dev-tasks:visual-diff <page-url>` and it walks the Before → apply diff → After → Read both → compare → flag deltas. Use it as the canonical invocation. Manual capture (steps below) is for cases where the skill doesn't fit.

### Playwright Screenshot Pattern

```typescript
import { test, expect } from '@playwright/test'

test('email template renders correctly', async ({ page }) => {
  await page.goto('/dev/email-preview')
  // Wait for content to render
  await page.waitForSelector('[data-testid="email-preview"]')
  // Capture screenshot for visual inspection
  await page.screenshot({ path: 'e2e/screenshots/email-template.png', fullPage: true })
  // Also assert key structural elements exist
  expect(await page.locator('[data-testid="email-header"]').isVisible()).toBe(true)
})

test('component renders correctly', async ({ page }) => {
  await page.goto('/en/some-page')
  await page.screenshot({ path: 'e2e/screenshots/component-render.png', fullPage: true })
})
```

### Agent Visual Inspection

After Playwright captures screenshots, the agent MUST:
1. Use the **Read tool** to open BOTH the before.png AND the after.png screenshot files (Read supports images natively)
2. Compare in plain language:
   - List each intended change. Verify each is observable in After but not Before.
   - List anything else that's different between Before and After. For each delta, trace it to a diff hunk. If you can't, it's an unintended regression.
3. Only mark visual validation PASS if:
   - All intended changes are present
   - No unintended visual deltas remain
   - Layout / spacing / color / typography unchanged in unmodified regions
4. On FAIL, name the specific regression and fix before re-running.

### Claude-in-Chrome MCP (Optional but Recommended)

For complex UI interactions that are difficult to validate with static screenshots:
- Multi-step form flows with dynamic state
- Drag-and-drop, modals, tooltips, hover states
- Cross-browser rendering validation
- Use `mcp__claude-in-chrome__computer` and `mcp__claude-in-chrome__read_page` for interactive inspection

## Race Condition Testing

When testing database operations, account for Neon replication lag:
```typescript
// Add verification with retry in tests
await retryWithBackoff(
  async () => {
    const result = await fetchData()
    expect(result.length).toBeGreaterThan(0)
    return result
  },
  3, 300, 2000
)
```

## Database Verification in Tests

```typescript
console.log('[Before Insert] Starting creation')
const item = await create(data)
console.log('[After Insert] Created:', item.id)
// If subsequent query returns empty, it's a race condition
```
