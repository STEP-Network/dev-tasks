# /write-uat-spec — Worked Examples

Two full input → output walkthroughs documenting the expected spec shape on known inputs. These are the contract: future maintainers can dogfood the skill against these examples and verify the produced spec matches the schema.

## Example 1 — Authenticated SaaS flow (Stack Auth pattern)

### Task

```
#9999999 — Profile edit: user can update display name and see it in the header
Type: Feature  Priority: Medium  Epic: Account & Profile

Description:
Authenticated users should be able to edit their display name from the Profile
page. After save, the new name appears in the top-right header dropdown
immediately (no reload).

Acceptance criteria:
- Logged-in user navigates to /profile
- Edits the "Display name" input
- Clicks "Save profile"
- Sees a "Profile updated" toast
- Header dropdown in top-right shows the new name without reload
```

### Persona resolution

AC says "Logged-in user" → matches authenticated persona. Project has `personas: [{ id: "advertiser", storageState: "playwright/.auth/advertiser.json" }, ...]`. Pick `advertiser` (most common authenticated role).

Verify `playwright/.auth/advertiser.json` exists. If yes → proceed. If no → REFUSE per auth contract; surface remediation.

### Feature-area discovery

`git ls-files -- 'e2e/**'` shows `e2e/profile/`, `e2e/auth/`, `e2e/billing/`. Closest match for "Profile edit" → `e2e/profile/`. No new area needed.

### Spec shape (expected output at `e2e/profile/display-name-edit.spec.ts`)

```ts
import { test, expect } from "@playwright/test";

test.use({ storageState: "playwright/.auth/advertiser.json" });

test.describe("profile: display name edit", () => {
  test("user can update display name and see it in header without reload", async ({ page }) => {
    // Navigate
    await page.goto("/profile");
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByTestId("profile-form")).toBeVisible();
    await expect(page).toHaveScreenshot("profile-entry.png");

    // Capture the current header name so we can assert it changes
    const headerNameBefore = await page.getByTestId("header-user-name").innerText();

    // Edit + save
    const newName = `Nate UAT ${Date.now()}`;
    await page.getByTestId("display-name-input").fill(newName);
    await page.getByRole("button", { name: "Save profile" }).click();

    // Toast confirms save
    await expect(page.getByText("Profile updated")).toBeVisible({ timeout: 5000 });

    // Header reflects new name without reload
    await expect(page.getByTestId("header-user-name")).toHaveText(newName);
    expect(headerNameBefore).not.toBe(newName);

    await expect(page).toHaveScreenshot("profile-after-save.png");
  });
});
```

### Skill's report

```
SPEC_PATH=e2e/profile/display-name-edit.spec.ts
CLASSIFICATION=feature
PERSONA=advertiser
LINE_COUNT=26
SELECTOR_TESTID=4
SELECTOR_ROLE=1
SELECTOR_TEXT=1
SELECTOR_XPATH=0
SCREENSHOT_MILESTONES=2
RUN_TARGET=preview
RUN_RESULT=PASS_NEW_BASELINE
KNOWN_TECH_DEBT=
AGENT_VERIFIED=["url is /profile","profile-form visible","toast 'Profile updated' visible","header-user-name reflects new name","header name changed from prior value","entry screenshot","after-save screenshot"]
HUMAN_ONLY=["copy tone of the toast message","name length cap edge case (e.g. >100 chars)","name with emoji rendering","name with RTL characters","screen-reader announcement of the toast"]
```

### How `/ship-pr` Phase 4.6 consumes it

Phase 4.6 runs `pnpm playwright test e2e/profile/display-name-edit.spec.ts` against the preview URL. RUN_RESULT=`PASS_NEW_BASELINE` → baselines committed + spec passes. Phase 4.5 UAT doc is updated:

```markdown
## Agent-verified (Playwright spec: e2e/profile/display-name-edit.spec.ts)
- ✓ Navigation to /profile
- ✓ profile-form visible on entry
- ✓ "Profile updated" toast appears after save
- ✓ Header name updates without reload (delta confirmed against prior value)
- ✓ Visual baselines captured at entry + post-save

## Human-only (judgment calls remaining)
- Copy tone of the "Profile updated" toast
- Name length cap edge case (>100 chars)
- Emoji rendering in display names
- RTL character support
- Screen-reader announcement of the toast
```

Task transitions to `Waiting for UAT` with that UAT doc. Human sees a focused checklist of what they still need to verify, vs. the broad "go test the new feature" they'd previously face.

---

## Example 2 — Public marketing flow (no auth)

### Task

```
#9999998 — Homepage: hero displays new tagline
Type: Feature  Priority: Low  Epic: Marketing

Description:
Update the homepage hero copy to "Ship faster with autonomous agents".
Tagline appears on first paint, no scroll required.

Acceptance criteria:
- Anyone visiting / sees the hero with the new tagline
- Tagline is above the fold
- Visible on both mobile and desktop viewports
```

### Persona resolution

AC says "Anyone visiting" → unauthenticated. Pick `public-visitor` persona (`storageState: null`). No auth refusal possible — null is the expected configuration for this persona.

### Feature-area discovery

`git ls-files -- 'e2e/**'` shows no `e2e/marketing/` or `e2e/homepage/`. Closest semantic match → none.

Create new area `e2e/marketing/` + write `e2e/marketing/README.md`:

```markdown
# e2e/marketing/

Specs covering the public marketing surface — homepage, pricing, about,
landing pages. All run as the `public-visitor` persona (no auth). Add a spec
here when shipping copy or layout changes to any page reachable without login.
```

### Spec shape (expected output at `e2e/marketing/hero-tagline.spec.ts`)

```ts
import { test, expect, devices } from "@playwright/test";

// No test.use({ storageState }) — public-visitor persona has storageState: null

test.describe("marketing: homepage hero tagline", () => {
  test("hero shows new tagline above the fold on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const hero = page.getByTestId("homepage-hero");
    await expect(hero).toBeVisible();
    await expect(hero).toContainText("Ship faster with autonomous agents");
    // Above-the-fold check: hero is within initial viewport without scrolling
    const box = await hero.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(900);
    await expect(page).toHaveScreenshot("homepage-desktop.png");
  });

  test("hero shows new tagline above the fold on mobile", async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices["iPhone 14"] });
    const page = await ctx.newPage();
    await page.goto("/");
    const hero = page.getByTestId("homepage-hero");
    await expect(hero).toBeVisible();
    await expect(hero).toContainText("Ship faster with autonomous agents");
    await expect(page).toHaveScreenshot("homepage-mobile.png");
    await ctx.close();
  });
});
```

### Skill's report

```
SPEC_PATH=e2e/marketing/hero-tagline.spec.ts
CLASSIFICATION=feature
PERSONA=public-visitor
LINE_COUNT=28
SELECTOR_TESTID=2
SELECTOR_ROLE=0
SELECTOR_TEXT=0
SELECTOR_XPATH=0
SCREENSHOT_MILESTONES=2
RUN_TARGET=preview
RUN_RESULT=PASS_NEW_BASELINE
KNOWN_TECH_DEBT=
AGENT_VERIFIED=["homepage-hero visible","hero contains new tagline text","hero above the fold on desktop (1440x900)","hero visible on mobile (iPhone 14 viewport)","desktop screenshot","mobile screenshot"]
HUMAN_ONLY=["copy tone — does the new tagline match brand voice","placement vs surrounding hero elements — visual hierarchy","i18n: is this tagline translated for non-English locales","SEO meta title/description updated to match"]
```

---

## What these examples are NOT

- **Not runtime tests.** The skill orchestrates a `dev-tasks:e2e-tester` subagent that inspects the actual rendered DOM on the preview URL. Real selectors will reflect actual `data-testid` values in the consumer codebase, not these illustrative ones.
- **Not persona-name binding.** `advertiser`, `public-visitor`, `partner-admin`, `super-admin` are illustrative IDs from PolAds — use whatever `id` values you declare in your project's `e2e.personas[]` block. The skill looks up personas by your project's chosen IDs; there are no built-in persona names.
- **Not exhaustive.** Multi-page flows, modal interactions, drag-and-drop, file uploads, and other complex shapes follow the same structure with more interactions per test.

## Common shapes worth knowing

| Scenario | Pattern |
|---|---|
| Form with validation | Fill required fields, click submit, assert validation toast / error states alongside success path |
| Modal cascade | `page.getByRole('dialog', { name: '<title>' })` — assert open + content + close behavior |
| Async data load | `await expect(page.getByTestId('list-item')).toHaveCount(N, { timeout: 10_000 })` |
| File upload | `await page.setInputFiles('input[type=file]', 'tests/fixtures/<file>.pdf')` |
| Drag-and-drop | `await source.dragTo(target)` — fragile; consider data-testid + keyboard alternative |
| Email-link auth | OUT OF SCOPE — auth via storageState only, not inline auth-walk |

## Verifying the skill against these examples

When updating the skill, dogfood against these inputs:

1. Run `/dev-tasks:write-uat-spec` standalone with the first example's task body
2. Compare produced spec structure to Example 1 above
3. Required matches: section headers, selector breakdown shape, AGENT_VERIFIED vs HUMAN_ONLY split. Content varies with the actual codebase; structure is the contract.

Failures to look for:
- Spec uses `localhost:3000` hardcoded (should read `baseURL` from config)
- Spec inlines login flow (should use `storageState`)
- Spec gitignores `*.spec.ts-snapshots/` (silently no-ops the gate)
- Spec has zero `data-testid` selectors (subagent chose fragile selectors)
- Report's HUMAN_ONLY array is empty (under-flagging — almost every flow has SOMETHING the agent can't verify)
- Spec exceeds 200 lines (probably testing implementation details, not user-visible behavior)
