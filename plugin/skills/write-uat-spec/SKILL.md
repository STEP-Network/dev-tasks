---
name: write-uat-spec
description: Write a Playwright spec that walks the current task like a UAT human would. Runs as the HARD gate before /ship-pr Phase 6.7 (Waiting for UAT). Auth-agnostic — refuses if persona storageState is missing rather than guessing.
user_invocable: true
---

# /write-uat-spec — Autonomous UAT via Playwright

Before a task transitions to `Waiting for UAT`, this skill writes a Playwright spec that walks the feature the way a UAT human would — login (via storageState) + navigation + actions + visual + console assertions. The spec ships in the same PR as the feature. Runs locally before push (Phase 2 gate); runs against the preview URL as the Phase 4.6 hard gate; runs in CI on every PR for regression catch.

Human UAT becomes lighter: agent-verified items live in the UAT doc's "Agent-verified" section; the human focuses on judgment calls (subjective design, copy tone, business-edge cases) enumerated under "Human-only".

## When to apply

| Task type | Action |
|---|---|
| Feature (user-visible) | Write full Playwright spec |
| Bug fix | Extend existing spec for the flow; if none exists, write a new spec for the regression case |
| Refactor (no behavior change) | No new spec; existing suite must pass |
| API-only (no UI surface) | Defer to `__tests__/api/` pattern (per self-review Check #8) |
| Migration | Defer to `pnpm validate-schema` + integration test pattern |
| Docs / config | Skip |

The classifier runs against the diff (`git diff $defaultBase...HEAD --stat`) plus the task's `type` field. When unclear, prefer "write a spec" — over-coverage is cheap; under-coverage erodes the gate's value.

**CI Gate interaction (v0.26.0)**: when the task's CI Gate is `Skip (human)` / `Skip (agent)`, `/ship-pr` skips Phase 4.6 entirely and this skill is not invoked — the UAT doc records the skip and its authorization instead. The classifier table above only governs tasks under `Full` gating.

## Tool surface

Delegate the actual spec authoring to `dev-tasks:e2e-tester` (existing read-only subagent with Read / Glob / Grep / Bash / WebSearch + claude-in-chrome MCP). The subagent inspects the rendered DOM on the preview URL to choose stable selectors, then writes the file. This skill's job is to:

1. Read project-config and validate auth contract
2. Pick the right persona for the task
3. Classify the diff
4. Construct the subagent prompt
5. Parse the report
6. Verify the spec was written + runs

No new tool surface introduced.

## Auth contract — the load-bearing portability point

Skill reads `project-config.json → e2e.personas[]`. Each persona has `storageState: string | null`:

- `storageState: "playwright/.auth/<persona>.json"` → spec uses `test.use({ storageState })`. File must exist at write time.
- `storageState: null` → unauthenticated persona (public visitor). Spec written without storageState wiring.

**If the spec needs an authenticated persona AND that persona has `storageState: null` OR the file doesn't exist on disk → REFUSE.** Return a concrete error:

```
Spec for task #<id> requires persona "<X>" but storageState is missing.

Remediation:
  1. Add e2e/auth.setup.ts that logs in as "<X>" and saves storage state to
     playwright/.auth/<X>.json. See https://playwright.dev/docs/auth.
  2. Declare storageState in playwright.config.ts.projects[].use.storageState.
  3. Update .claude/project-config.json e2e.personas[] entry for "<X>" to
     point at the storageState file path.
  4. Re-run /dev-tasks:write-uat-spec.

This skill never walks the login screen inline — auth setup is consumer-side,
runs once, persists. Inline auth produces fragile + divergent specs.
```

This is the same BLOCKING-question pattern as `/dev-tasks:investigate-request` — surface the missing context, don't guess.

## BASE_URL contract

Skill accepts `--target=local|preview`:
- `--target=preview` (default in standalone + Phase 4.6) — runs against the Vercel preview URL from `.claude/active-task.json:previewUrl`
- `--target=local` — runs against `e2e.baseUrl.local` from project-config (default `http://localhost:3000`). Useful when iterating on the spec itself.

The spec MUST read `BASE_URL` from env, never hardcode:

```ts
// playwright.config.ts (consumer-side; see EXAMPLES.md)
use: { baseURL: process.env.BASE_URL ?? "http://localhost:3000" }
```

```ts
// spec file (agent writes this)
test("homepage hero loads", async ({ page }) => {
  await page.goto("/");  // uses baseURL from config
  // ...
});
```

**Honest caveat — surface in every report**: local pass ≠ preview pass. Cookie domains, OAuth callbacks, third-party origins, edge functions, env vars all differ. Phase 4.6 always uses `--target=preview` for the hard gate; `--target=local` is dev-loop only.

## Workflow

### Step 0 — Read context

- `.claude/project-config.json` → `e2e.enabled`, `e2e.personas[]`, `e2e.baseUrl`, `e2e.specDir`, `e2e.baselineSnapshots`, `e2e.humanOnlyChecks[]`, `e2e.flakyDir`
- `.claude/active-task.json` → `taskId`, `taskName`, `previewUrl`, `subtasks[]`
- `getTask(itemId)` → full task body + AC + epic context

If `e2e.enabled: false` → exit immediately with "autonomous UAT not configured in this project; full human verification required." Phase 4.6 logs this in the UAT doc.

### Step 1 — Classify

Run the classifier table above. If "Skip", "Defer to API tests", or "Defer to integration tests" → report classification + exit. Phase 4.6 records the classification in the UAT doc so the human knows which gate did or didn't apply.

### Step 2 — Pick persona

Read the task body + AC. Map to a persona:
- AC mentions "logged-in user can X" → matches authenticated persona (one of the configured ones)
- AC mentions "visitor can X" / "anyone can see Y" → `public-visitor`
- AC mentions specific role ("admin can…", "advertiser can…") → that role
- Ambiguous → use `AskUserQuestion` to ask (BLOCKING question per `investigate-request` contract)

Validate persona's `storageState`. Refuse per auth contract if missing.

### Step 3 — Discover feature-area

Read `git ls-files -- '<specDir>/**'` (default `e2e/**`). Cluster by directory. Match the task name + AC against existing area names semantically (closest match wins). If no match within reasonable similarity:

- Create new area `<specDir>/<new-area>/`
- Write `<specDir>/<new-area>/README.md` (3-5 lines) explaining what the area covers + when to add specs here vs elsewhere
- Comment in the spec file referencing why this area was created

This rule prevents organic sprawl into `e2e/registration/` + `e2e/reg/` + `e2e/registration-flow/` over three weeks.

### Step 4 — Delegate spec authoring to subagent

Spawn `dev-tasks:e2e-tester` with a structured prompt containing:

- Task ID, name, body, AC
- Preview URL (from active-task.json)
- Chosen persona + storageState path
- Selector quality rules (see below)
- Spec shape guidance (length, milestone screenshots)
- File path to write: `<specDir>/<feature-area>/<short-slug>.spec.ts`
- Instruction: navigate to entry point on preview URL via claude-in-chrome MCP, inspect DOM, choose selectors BEFORE writing the spec — don't guess from the task description alone

Subagent returns `{ filePath, lineCount, selectorBreakdown, screenshotMilestones, personasUsed, knownTechDebt }`.

### Step 5 — Verify the spec runs

`pnpm playwright test <filePath> --reporter=line` with `BASE_URL=<previewUrl>` (or local per `--target`).

- Pass → report + exit success
- Fail on missing baseline → run with `--update-snapshots`, commit baseline, re-verify. First-run baseline-creation is expected, not a failure. (See Baseline commit policy below.)
- Fail on real assertion → return failure with full Playwright output. Phase 4.6 treats this as a regression; loop back to fix.

### Step 6 — Report

Emit the structured output the caller (typically `/ship-pr` Phase 4.6) parses:

```markdown
## Spec written: `e2e/<area>/<slug>.spec.ts`

- Classification: <Feature | Bug-fix-extends-X | Bug-fix-new-spec>
- Persona: <id> (storageState: <path> | null)
- Length: <N lines>
- Selectors: { data-testid: N, role: N, text: N, xpath: N }
- Screenshot milestones: <N> (paths)
- Run target: <local | preview>
- Run result: <PASS | PASS-with-baseline-created | FAIL>
- Known tech debt: <list of xpath/css selectors needing data-testid>

## Agent-verified
- <list of explicit expect() assertions>
- <visual: N baselines>
- <console: 0 errors expected>

## Human-only (UAT doc carries this verbatim)
<from project-config.e2e.humanOnlyChecks[] PLUS any AC item not covered by an assertion>
```

## Selector quality rules

Subagent prompt MUST enforce this priority:

```
1. data-testid="..."   — stable across refactors (preferred)
2. role="button" + name — semantic, a11y-aligned
3. text="..."           — acceptable for short-lived UI
4. xpath / css          — last resort; surface as tech-debt follow-up
```

If the subagent reaches for xpath/css more than once in a single spec → flag in the report's `knownTechDebt` array. Suggest follow-up task: "Add `data-testid` to `<component>` for stable e2e selectors." Don't auto-create the follow-up; surface it for the human's call.

## Spec shape guidance — soft, not cap

20–50 lines for simple flows. 80–120 for golden paths (login → flow → assertion → screenshot). Never enforce a hard line cap — meaningful assertions matter more than terseness.

Structure:

```ts
import { test, expect } from "@playwright/test";

test.use({ storageState: "playwright/.auth/<persona>.json" }); // omit if persona is public-visitor

test.describe("<feature area>: <short-slug>", () => {
  test("<scenario from AC>", async ({ page }) => {
    // 1. Navigate to entry point
    await page.goto("/<route>");
    await expect(page).toHaveURL(/.../);
    await expect(page.getByTestId("entry-marker")).toBeVisible();
    await expect(page).toHaveScreenshot("entry.png");

    // 2. Perform user action
    await page.getByTestId("primary-input").fill("...");
    await page.getByRole("button", { name: "Submit" }).click();

    // 3. Assert outcome
    await expect(page.getByText("Saved")).toBeVisible();
    await expect(page).toHaveURL("/<expected-after-route>");
    await expect(page).toHaveScreenshot("final-state.png");

    // Console errors collected separately via page.on('console') if needed
  });
});
```

Milestone screenshots at: entry, after primary action, final state. Three is right. Don't screenshot every interaction (snapshot churn drowns signal).

## Baseline commit policy

| Path | Status |
|---|---|
| `e2e/<area>/<slug>.spec.ts-snapshots/*.png` | **COMMIT** (these are the visual regression baselines) |
| `test-results/` | gitignore |
| `playwright-report/` | gitignore |

**Critical warning**: never `.gitignore *.spec.ts-snapshots/*` "to keep the diff clean." Doing so silently makes the visual-regression gate a no-op — `toHaveScreenshot()` becomes "always passes because there's no baseline to compare against." The skill's worked examples show the correct `.gitignore` pattern; reviewers must reject any PR that gitignores snapshots.

Baseline weight grows over time. Migration gate: at ~50MB total snapshot weight, switch to Git LFS. Document in repo's CONTRIBUTING.md or `e2e/README.md`.

## Flake handling — retries + ack escape hatch

Playwright config recommendation (consumer-side):

```ts
// playwright.config.ts
export default defineConfig({
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: process.env.BASE_URL ?? "http://localhost:3000" },
  // ...
});
```

**Ack escape hatch** (mirrors `/tmp/.claude-ci-ack-<branch>` pattern from `/ship-pr` Phase 6):

```bash
# When a spec is known-flaky and blocking ship:
touch /tmp/.claude-playwright-ack-<slug>
# Phase 4.6 treats the spec as soft-pass + adds to UAT doc:
#   "KNOWN-FLAKY: <slug> — ack'd by agent; follow-up task needed to debug"
```

When the ack file is present, Phase 4.6 still runs the spec (so the failure output is captured) but doesn't block the Waiting-for-UAT transition. The UAT doc explicitly lists the ack so the human knows the gate was soft-bypassed.

Chronically-flaky specs go to `<flakyDir>` (default `e2e/flaky/`). The CI lane runs them with a non-failing reporter — they catch eventual regressions but don't block PRs. Use sparingly; flaky-quarantine is a maintenance debt, not a fix.

## Coordination with `/dev-tasks:visual-diff`

Both skills involve screenshot-based verification but cover different cases:

- **`/dev-tasks:visual-diff`** — ad-hoc Before/After verification during self-review Check #2. "I changed `<Header>`, did anything else move?" One-shot, not codified, focused on detecting cascading regressions in a specific commit.
- **`/dev-tasks:write-uat-spec`** — codified per-flow regression. The spec's `toHaveScreenshot()` runs every time the spec runs (every PR). Catches regressions caused by future changes.

When in doubt: visual-diff for "did this commit break something visible" during dev; write-uat-spec for "is this flow still working" as a durable gate.

## Cross-references

- `plugin/skills/ship-pr/SKILL.md` — Phase 2 push gate + Phase 4.6 autonomous-UAT hard gate + Phase 4.5 UAT doc agent-verified vs human-only split
- `plugin/skills/visual-diff/SKILL.md` — sibling skill for ad-hoc Before/After (see "Coordination" above)
- `plugin/skills/investigate-request/SKILL.md` — BLOCKING question + AskUserQuestion pattern (the auth-refusal flow is the same shape)
- `plugin/rules/autonomous-by-default.md` — "Missing context the agent can't derive" carve-out (auth-setup-missing is the canonical example)
- `plugin/skills/e2e-tester/` — subagent this skill delegates to
- `plugin/templates/starter-project-config.json` — example `e2e` block for consumer adoption

## Anti-patterns

- **Walking the login screen inline in the spec** — fragile, divergent per spec, hard to maintain. Use storageState. If unavailable, REFUSE.
- **Hardcoded `localhost:3000` in spec** — breaks Phase 4.6 against preview. Use `baseURL` from env.
- **Gitignoring `.spec.ts-snapshots/*`** — silently makes visual gate a no-op.
- **Asserting every pixel** — `toHaveScreenshot()` at 2–3 milestones; not every interaction.
- **Asserting only success state** — also assert URL, key text, primary CTA presence — survives layout refactors that screenshots alone might miss.
- **Hard 50-line cap** — meaningful assertions matter more than terseness. Golden paths legitimately run 80–120 lines.
- **Claiming coverage you don't have** — the UAT doc's "Agent-verified" section is the contract. If the spec didn't assert it, don't list it. Over-flag human-only items rather than under-flag.

## Output contract (Phase 4.6 parses this)

```
SPEC_PATH=e2e/<area>/<slug>.spec.ts
CLASSIFICATION=<feature|bug-extends|bug-new|skip|defer-api|defer-integration>
PERSONA=<id>
LINE_COUNT=<N>
SELECTOR_TESTID=<N>
SELECTOR_ROLE=<N>
SELECTOR_TEXT=<N>
SELECTOR_XPATH=<N>
SCREENSHOT_MILESTONES=<N>
RUN_TARGET=<local|preview>
RUN_RESULT=<PASS|PASS_NEW_BASELINE|FAIL|ACK_FLAKY>
KNOWN_TECH_DEBT=<comma-separated list of selectors needing data-testid>
AGENT_VERIFIED=<JSON array of assertion descriptions>
HUMAN_ONLY=<JSON array of items not covered>
```

Phase 4.6 reads this and writes the UAT doc accordingly. If `RUN_RESULT=FAIL` → loop back to fix mode (treat as regression).
