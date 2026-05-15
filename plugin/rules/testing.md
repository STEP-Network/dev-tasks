---
globs:
  - "__tests__/**"
  - "e2e/**"
  - "jest.config.js"
  - "jest.setup.*"
  - "playwright.config.ts"
---

# Testing Rules

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

**Do NOT rely solely on string-matching unit tests for visual output. Always validate rendered HTML visually.**

### When Visual Validation Is Required

| Change Type | Required Action |
|-------------|----------------|
| **Email template changes** | Playwright test navigates to `/dev/email-preview`, takes screenshot, agent reads screenshot via Read tool |
| **UI/UX component changes** | Playwright test renders the page/component, takes screenshot, agent reads and inspects the image |
| **Layout or styling changes** | Screenshot before/after comparison where feasible |

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
1. Use the **Read tool** to open the screenshot file (Read supports images natively)
2. Visually inspect the rendered output for layout issues, missing elements, broken styling
3. Only mark the visual validation as PASS if the rendered output looks correct

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
