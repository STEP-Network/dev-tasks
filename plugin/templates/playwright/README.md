# Playwright templates

Copy-paste starters for STEP Network projects onboarding to the dev-tasks plugin's E2E baseline.

## Files

| Template | Copies to | Notes |
|---|---|---|
| `playwright.config.ts.example` | `<consumer>/playwright.config.ts` | Adjust `webServer.port` + `webServer.command` to match the project |
| `e2e-sample-flow.spec.ts.example` | `<consumer>/e2e/critical/landing-page.spec.ts` | Adapt the user-flow assertions |
| `e2e-accessibility.spec.ts.example` | `<consumer>/e2e/accessibility.spec.ts` | Update `PAGES_UNDER_TEST` with your routes |
| `e2e-performance.spec.ts.example` | `<consumer>/e2e/performance.spec.ts` | Adjust budgets based on your baseline measurements |

## Setup steps for a new STEP product

1. Install Playwright:
   ```sh
   pnpm add -D @playwright/test @axe-core/playwright
   pnpm exec playwright install --with-deps chromium firefox webkit
   ```

2. Copy templates from `${CLAUDE_PLUGIN_ROOT}/templates/playwright/` to the consumer repo (strip the `.example` suffix on the spec files).

3. Update `playwright.config.ts.example` → `playwright.config.ts`:
   - Set `webServer.port` to match the project's dev server
   - Set `webServer.command` to match the start script
   - Trim cross-browser projects if you don't need all five initially

4. Add `pnpm` scripts to `package.json`:
   ```json
   {
     "scripts": {
       "test:e2e": "playwright test",
       "test:e2e:critical": "playwright test --project=chromium --project=firefox --project=webkit --grep critical",
       "test:e2e:mobile": "playwright test --project=mobile-chrome --project=mobile-safari",
       "test:e2e:a11y": "playwright test accessibility",
       "test:e2e:perf": "playwright test performance"
     }
   }
   ```

5. CI integration (GitHub Actions example):
   ```yaml
   - name: Run Playwright tests
     run: pnpm test:e2e
     env:
       PLAYWRIGHT_BASE_URL: ${{ steps.preview.outputs.url }}
   - uses: actions/upload-artifact@v4
     if: always()
     with:
       name: playwright-report
       path: playwright-report/
       retention-days: 30
   ```

6. Run a smoke test locally to confirm setup:
   ```sh
   pnpm test:e2e --reporter=list
   ```

## What the plugin's `e2e-tester` subagent expects

When spawning `dev-tasks:e2e-tester`, it will:

- Read `playwright.config.ts` to find the dev server port + browser projects
- Read `package.json` to find the right `pnpm` script
- Read `.claude/project-config.json` for `environments.uat.url` as the default test target
- Run tests via Bash and parse results

If any of these is missing or non-standard, the subagent surfaces the issue rather than guessing.

## Reference

- `.claude/rules/testing.md` — full test discipline (unit / integration / E2E / a11y / cross-browser / performance / visual regression)
- `.claude/rules/e2e-masterplan.md` — the multi-phase plan toward selective-UAT autonomy
- `.claude/skills/visual-diff/SKILL.md` — before/after visual verification (orthogonal to these templates; not Playwright-based)
- `.claude/agents/e2e-tester.md` — subagent that runs these tests
