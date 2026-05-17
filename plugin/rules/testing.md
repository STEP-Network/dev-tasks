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

## Accessibility Testing (WCAG-AA)

**Goal**: zero axe-core violations on WCAG-A and WCAG-AA rules for every user-facing page. STEP-wide policy as of v0.8.13.

### Pattern (Playwright + @axe-core/playwright)

Install once: `pnpm add -D @axe-core/playwright`.

```typescript
// e2e/accessibility.spec.ts
import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const PAGES_UNDER_TEST = [
  '/',
  '/[locale]/register',
  '/[locale]/account',
  '/[locale]/admin',
]

for (const path of PAGES_UNDER_TEST) {
  test(`a11y: ${path}`, async ({ page }) => {
    await page.goto(path)
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])  // baseline WCAG-AA
      .analyze()
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
  })
}
```

### When a violation is found

- **Real violation**: fix in the same PR. Common issues: missing alt text, low contrast, missing aria labels, keyboard navigation broken, focus indicator removed.
- **False positive on axe-core's rule**: very rare but possible. Document the exception with a one-liner and `axe.configure({ rules: [{ id: 'rule-name', enabled: false }] })` for that specific test ONLY. Do NOT globally disable rules.
- **Out-of-scope (third-party iframe / vendor widget)**: scope axe with `.include('main')` to skip out-of-scope DOM.

### Multi-state a11y

A11y violations can hide in modal/error/loading states. Capture each state:

```typescript
test('a11y: registration form — empty + error states', async ({ page }) => {
  await page.goto('/[locale]/register')
  // Empty state
  let results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
  // Trigger error state
  await page.click('button[type="submit"]')  // submit without filling
  await page.waitForSelector('[role="alert"]')
  results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
})
```

## Cross-browser Testing

**Default**: Chromium for every E2E test. Firefox + WebKit for user-flow critical tests (registration, checkout, login, public-facing pages).

### Pattern (Playwright projects)

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  projects: [
    // Default project — most tests
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Critical-flow project — slower tests scoped to user-facing routes
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testMatch: /critical\/.*\.spec\.ts/,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: /critical\/.*\.spec\.ts/,
    },
    // Mobile project — for responsive flows
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
      testMatch: /mobile\/.*\.spec\.ts/,
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
      testMatch: /mobile\/.*\.spec\.ts/,
    },
  ],
})
```

Convention: name tests under `e2e/critical/*.spec.ts` for cross-browser scope, `e2e/mobile/*.spec.ts` for mobile-viewport scope. Everything else runs Chromium-only — fast enough for the iteration loop, broad enough to catch most issues.

### When to extend cross-browser coverage

- Any change touching a page in the critical-flow set
- Any change involving CSS features with known Safari quirks (subgrid, `:has`, ::backdrop, color-mix)
- Any change involving form input behavior (Safari handles autofill / date pickers / file inputs differently)
- Any change introducing a Service Worker, IndexedDB, or BroadcastChannel pattern (Firefox/Safari implementation differences)

## Performance Budgets

**Goal**: prevent silent performance regressions. Web Vitals (LCP, CLS, INP) within budget on user-facing pages.

### Pattern (Playwright performance API)

```typescript
// e2e/performance.spec.ts
import { test, expect } from '@playwright/test'

test('performance budget: landing page', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' })

  const metrics = await page.evaluate(() => {
    const navTiming = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming
    const paintTiming = performance.getEntriesByType('paint')
    const fcp = paintTiming.find(p => p.name === 'first-contentful-paint')?.startTime
    return {
      ttfb: navTiming.responseStart - navTiming.requestStart,
      domLoaded: navTiming.domContentLoadedEventEnd,
      fcp,
    }
  })

  expect(metrics.ttfb).toBeLessThan(800)     // 800ms TTFB budget
  expect(metrics.fcp).toBeLessThan(1800)     // 1.8s FCP budget
  expect(metrics.domLoaded).toBeLessThan(3500) // 3.5s DOMContentLoaded budget
})
```

For deeper Web Vitals (LCP, CLS, INP), use the `web-vitals` library:

```typescript
import { test, expect } from '@playwright/test'

test('Web Vitals: landing page', async ({ page }) => {
  await page.goto('/')

  const vitals = await page.evaluate(() => {
    return new Promise<{ lcp: number; cls: number }>((resolve) => {
      // Use web-vitals library if installed, OR roll your own
      // observer for LCP / CLS / INP
      // ...
    })
  })

  expect(vitals.lcp).toBeLessThan(2500)  // LCP good
  expect(vitals.cls).toBeLessThan(0.1)   // CLS good
})
```

### Lighthouse CI alternative

For richer perf measurement, integrate Lighthouse CI in GitHub Actions. Out of scope for the inline Playwright pattern but worth setting up at the consumer level.

### Performance budget tuning

Set initial budgets based on current measurements (capture median LCP/CLS/INP across 5 runs on the staging deploy). Tighten over time as the product improves. Failing budgets BLOCK the PR — they're not advisory.

## Visual Regression Baselines (Phase 2 — future)

When Phase 2 of `e2e-masterplan.md` lands, this section will describe committed-baseline `toHaveScreenshot` workflow with intentional-update flow. Until then, `/dev-tasks:visual-diff` ephemeral before/after is the canonical pattern.

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
