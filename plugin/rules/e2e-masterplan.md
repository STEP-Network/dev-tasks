# E2E Masterplan — toward selective-UAT autonomy

> **Reference rule.** Loaded on-demand when the agent considers test discipline / lifecycle skip-criteria / visual-diff scope.

## TL;DR

STEP's long-term aim is **agent autonomy with selective human review**: AI handles the ~80% of changes that are mechanically verifiable end-to-end, humans review the ~20% where subjective judgment matters (UX feel, regulatory interpretation, stakeholder-visible design). UAT becomes selective, not universal.

This rule maps the path: where we are now, where we want to be, the five phases between, and the auto-promote criteria that route a change to one bucket or the other.

## The framing — push back on "AI good at E2E = no UAT"

That formulation is too strong. UAT catches three things automated E2E never will:

1. **Subjective UX** — "this feels weird," "the spacing is off in a way that matters but no test will flag." Humans have taste; tests don't.
2. **Regulatory interpretive judgments** — does this implementation meet the spirit of EU Reg 2024/900 Article 3? Of GDPR Article 17's "without undue delay"? These are decisions, not facts. Tests verify facts.
3. **Stakeholder design review** — is this the right feature to ship at all, regardless of whether it works? Product owners + legal + design weigh in here.

So the limit isn't "zero UAT." The limit is "UAT only when human judgment is actually required." Most diffs don't require it; some always will.

## Where we are now (UAT-universal)

Current task lifecycle: `Needs Refinement → Ready to Start → In Progress → Waiting for UAT → Pending Deploy to Prod → Done`. Every task hits `Waiting for UAT` and waits for a human regardless of how mechanical the change is. A 5-line locale-file addition gets the same gate as a payment-flow refactor.

What we have under the hood today (post-v0.8.12):

| Layer | Capability | Strength |
|---|---|---|
| Unit tests (`pnpm test`) | Validation, transforms, utils | Solid — pnpm-enforced |
| Integration tests | API + DB ops with retry | Solid for products that wrote them |
| Functional E2E (Playwright) | User journey assertions | Project-specific; plugin gives templates as of v0.8.13 |
| `/dev-tasks:visual-diff` (v0.8.11+) | Before/after screenshot + LLM-driven semantic check | Strong — covers the most common UI regression class |
| AI Review Stack (Corridor + Vercel Agent + Claude bot) | Static analysis + correctness review | Strong via per-PR triage |
| `self-review` Check #2/6/8 | UI/visual/test discipline | Strong — has teeth via iterative review loop |
| `e2e-tester` subagent | Playwright runner | Genericized in v0.8.13 |
| Accessibility testing | — | **Gap** (Phase 2) |
| Visual regression baselines | Ephemeral (each PR captures fresh) | **Gap** (Phase 2 — committed baselines) |
| Cross-browser | Per-project Playwright config | **Gap** (Phase 2 — standard pattern) |
| Performance budgets | — | **Gap** (Phase 2) |
| Auto-promote past UAT | — | **Gap** (Phase 3) |
| Production auto-revert | — | **Gap** (Phase 4) |

## Where we want to be (selective UAT)

New lifecycle: `Needs Refinement → Ready to Start → In Progress → [Verified | Waiting for UAT] → Pending Deploy to Prod → Done`. The transition out of `In Progress` routes based on auto-promote criteria.

### Auto-promote criteria — when does a task skip UAT?

ALL of these must be true:

| Criterion | Source | Threshold |
|---|---|---|
| All unit/integration/E2E tests PASS | CI | green |
| Visual diff PASS with zero unintended deltas | `/dev-tasks:visual-diff` | clean |
| Accessibility PASS (no WCAG-A or WCAG-AA violations) | axe-core / `@playwright/accessibility` | zero violations |
| Cross-browser PASS (Chromium + Firefox + WebKit) | Playwright projects | green per browser |
| Performance within budget (LCP, CLS, INP) | Lighthouse / Playwright perf assertions | within configured budgets |
| Acceptance criteria semantically verified | `/dev-tasks:auto-verify` reads screenshots + cross-checks against AC | each bullet observable |
| AI Review Stack clean (Corridor + Vercel Agent + Claude bot) | per-PR reviews | zero open BLOCKERs |
| Mobile + desktop captured | Visual-diff default | both viewports |
| Surface not in "always-UAT" list | per-project config | not regulated / payment / public-API contract |

If ALL pass: task goes to `Verified` → release ceremony promotes to prod → `Done`. Skip UAT.

If ANY fail: stays at `Waiting for UAT`. Human reviews.

### Always-UAT surfaces (regardless of AI confidence)

Per consumer's project-config: a list of file patterns / route patterns / Monday epic IDs that ALWAYS require UAT. Common picks:

- Regulated UI (e.g., consent dialogs, terms-of-service, transparency notices under EU Reg 2024/900)
- Payment flow (checkout, billing, subscription changes)
- Public API contract changes (breaking-changes that downstream consumers depend on)
- Auth / sign-up flow (login, password reset, MFA)
- Cross-product integration points

These bypass auto-promote and stay UAT-gated forever. Configured via `project-config.lifecycle.alwaysUatPatterns[]`.

## The five phases between

### Phase 1 — Baseline coverage + correctness (v0.8.13 — ships with this rule)

- Fix `e2e-tester` subagent (drop product-specific contamination)
- `rules-routing.json` routes `testing.md` on UI source globs (not just test globs)
- Ship Playwright templates: `playwright.config.ts.example`, sample flow test, sample visual-regression test, sample a11y test
- Optional `ui-change-test-reminder.sh` hook (PostToolUse nudge on UI edits)
- `visual-diff` skill defaults to mobile + desktop capture (not opt-in)
- `testing.md` adds sections for accessibility, cross-browser, multi-viewport, performance budgets
- This document itself (`e2e-masterplan.md`)

### Phase 2 — Quality dimensions (future, ~v0.9.0)

- Committed visual regression baselines pattern via `toHaveScreenshot`
- Standard a11y testing pattern (axe-core + WCAG-AA assertions in the e2e/ template)
- Performance budget pattern (Playwright perf assertions OR Lighthouse CI integration)
- Cross-browser standard config (Chromium + Firefox + WebKit on critical flows; Chromium-only on the rest)

### Phase 3 — Confidence-scored auto-promote (future, ~v0.9.1)

- New skill `/dev-tasks:auto-verify` — runs the full verification stack, outputs structured confidence score per the auto-promote criteria above
- New Monday status `Verified` between `In Progress` and `Pending Deploy to Prod`
- `/ship-pr` Phase 6.5 — replace unconditional "task → Waiting for UAT" with routed transition based on confidence score
- Always-UAT patterns config in `project-config.lifecycle.alwaysUatPatterns[]`

### Phase 4 — Production safety net (future, ~v0.9.2)

- Auto-revert reflex when Sentry detects production-error spike traceable to recent deploy
- `/dev-tasks:rollback` skill — fast revert PR + Monday status reversal
- Canary deployment pattern guidance (if Vercel rolling-canary supports it for STEP setup)

### Phase 5 — Continuous calibration (ongoing)

- Track false-positive rate (Verified tasks that turn out to have UAT-catchable issues) and false-negative rate (Waiting-for-UAT tasks that didn't actually need it)
- Adjust thresholds based on observed rates
- Per-surface escalation when false-positive rate spikes for a class of changes

## How this rule interacts with existing skills/rules

| Touch point | Effect |
|---|---|
| `task-lifecycle.md` | Phase 3 adds `Verified` status between `In Progress` and `Pending Deploy to Prod`. Per-status gate logic in the MCP server. |
| `/refine-task` | Trigger criteria for `holistic-thinking` invocation already exist (v0.8.11). Phase 3 adds "if this task is in an always-UAT surface, note it in the plan." |
| `/pickup-task` | Phase 3 adds "if always-UAT surface, skip auto-promote at ship time." |
| `/self-review` | Check #2 (visual) + Check #8 (tests) are the foundation. Phase 2 strengthens them. Phase 3 adds Check #12 (confidence score for auto-promote). |
| `/ship-pr` | Phase 1 validation (build/lint/test/E2E) is the foundation. Phase 3 replaces Phase 6.5 with routed transition. |
| `/dev-tasks:visual-diff` | Phase 1 makes mobile default. Phase 2 adds committed baselines. Phase 3 makes a clean visual diff a required input to auto-verify. |
| `auto-version.ts` service | Phase 3 — `Verified` transition also auto-links to version (same as `Waiting for UAT` does today). |
| `/release-version` | Unchanged in shape. Auto-promoted tasks land in versions and get released the same way. |

## Anti-patterns / what NOT to build

- **Trying to make Claude "judge UX subjectively."** It can read screenshots and verify "is the submit button present + labeled correctly." It cannot replace a human looking at a flow and saying "this feels wrong" with no specific articulable reason. Don't pretend otherwise.
- **Removing UAT entirely.** Even at the limit, some surfaces always need human review (see "always-UAT surfaces" above). The aim is selective, not zero.
- **Threshold-tuning by guessing.** Set initial thresholds, observe FP/FN rates, adjust based on data. Phase 5 is real work.
- **Skipping accessibility testing for "non-public" pages.** Internal admin tools are also used by humans who may have disabilities. Same standards apply.
- **Visual regression on every pixel.** Tolerance is configurable; antialiasing micro-diffs are noise. Phase 2 must include a sensible tolerance config.
- **Auto-revert that revives bugs.** The auto-revert reflex needs a kill switch and a "do not auto-revert past commit X" mechanism. Phase 4 has to design this carefully.

## Open questions (intentional — flag for future calibration)

- Where exactly is the line between "regulated surface" and "non-regulated"? PolAds has a clear answer (EU Reg 2024/900 + GDPR); STEPhie's line is TBD.
- Visual regression tolerance: what's the default pixel-diff threshold? Per-pixel? Per-region? Probably worth a per-project knob in config.
- How does Phase 3's `Verified` status interact with `/babysit-prs` orchestrator polling? Subagent-produced PRs that auto-promote bypass the orchestrator's merge step — needs explicit handling.
- Performance budgets: per-page (LCP/CLS/INP per route) or per-component (render time per shared primitive)? Probably page-level for v0.9.0, component-level later.

These are flagged here so they're remembered when the relevant phase arrives. Don't try to answer them prematurely.

## When this rule is loaded

- Agent considering whether a UI change is auto-promotable
- Agent considering skipping E2E discipline for "small" changes
- Onboarding a new STEP product to the plugin — read this to understand the current vs target state
- Calibrating thresholds based on observed FP/FN data (Phase 5)

## Reference

- `.claude/skills/visual-diff/SKILL.md` — visual verification workflow
- `.claude/skills/self-review/SKILL.md` — quality discipline gate
- `.claude/skills/ship-pr/SKILL.md` — push/merge lifecycle
- `.claude/rules/testing.md` — concrete test patterns (Phase 1 baseline)
- `.claude/rules/ai-review-stack.md` — Corridor + Vercel Agent + Claude bot triage
- `.claude/rules/agent-autonomy.md` — autonomous merge policy (Phase 3 will extend with auto-promote)
- `.claude/rules/task-lifecycle.md` — Monday status flow (Phase 3 adds `Verified`)
