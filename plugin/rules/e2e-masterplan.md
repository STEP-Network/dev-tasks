# E2E Masterplan — toward selective-UAT autonomy

## TL;DR

STEP's long-term aim: **agent autonomy with selective human review.** AI handles ~80% of changes that are mechanically verifiable end-to-end; humans review the ~20% where subjective judgment matters (UX feel, regulatory interpretation, stakeholder-visible design). UAT becomes selective, not universal.

The limit isn't "zero UAT" — it's "UAT only when human judgment is actually required." UAT catches subjective UX, regulatory interpretive judgments (EU Reg 2024/900 Article 3, GDPR Article 17's "without undue delay"), and stakeholder design review — automation never will.

## Current state (UAT-universal)

Every task hits `Waiting for UAT` (see `task-lifecycle.md`) regardless of how mechanical.

Capability inventory (post-v0.8.12) — Solid: unit tests, integration (products with them), functional E2E (Playwright templates v0.8.13), `/dev-tasks:visual-diff` (v0.8.11+), AI Review Stack (Corridor + Vercel Agent + Claude bot), `self-review` Check #2/6/8, `e2e-tester` subagent (genericized v0.8.13). Gaps: accessibility, visual regression baselines, cross-browser, performance budgets (all Phase 2); auto-promote past UAT (Phase 3); production auto-revert (Phase 4).

**Full-suite execution (v0.34.0) — in-session advisory, not a mandatory CI lane.** Earlier guidance treated the full `playwright test e2e/` run as a consumer-side CI responsibility (a per-preview GitHub Actions lane). That is superseded for the full suite: the `e2e.fullSuite` capability (`/dev-tasks:run-full-e2e`, invoked by `/ship-pr` Phase 6.6 + `/babysit-prs` post-deploy) runs the consumer's ENTIRE suite **in-session against staging** — ON by default (opt-out), sharded via `--workers`, ADVISORY (records pass/fail, never gates merge), with a bulletproof safe-skip that no-ops for any project lacking a staging URL + a real suite. The dev machine is usually faster than a CI runner and staging is already deployed, so consumers can retire the per-preview CI E2E lane and reclaim minutes. **Unchanged:** the per-task spec HARD gate (Phase 4.6/6.5) against the preview URL — that remains the only E2E gate before merge. Any narrower staging→prod CI gate a consumer keeps is their choice; what's retired is the redundant per-preview lane.

## Target state (selective UAT)

New lifecycle: `Needs Refinement → Ready to Start → In Progress → [Verified | Waiting for UAT] → Pending Deploy to Prod → Done`. Transition out of `In Progress` routes based on auto-promote criteria.

### Auto-promote criteria — ALL must be true

| Criterion | Source | Threshold |
|---|---|---|
| All unit/integration/E2E tests PASS | CI | green |
| Visual diff PASS with zero unintended deltas | `/dev-tasks:visual-diff` | clean |
| Accessibility PASS (WCAG-A + WCAG-AA) | axe-core / `@playwright/accessibility` | zero violations |
| Cross-browser PASS (Chromium + Firefox + WebKit) | Playwright projects | green per browser |
| Performance within budget (LCP, CLS, INP) | Lighthouse / Playwright perf assertions | within budgets |
| Acceptance criteria semantically verified | `/dev-tasks:auto-verify` | each bullet observable |
| AI Review Stack clean | Corridor + Vercel Agent + Claude bot | zero open BLOCKERs |
| Mobile + desktop captured | Visual-diff default | both viewports |
| Surface not in "always-UAT" list | per-project config | not regulated / payment / public-API |

ALL pass → `Verified` → release ceremony → `Done`. ANY fail → stays `Waiting for UAT`.

### Always-UAT surfaces

Configured via `project-config.lifecycle.alwaysUatPatterns[]`. Common picks: regulated UI (consent dialogs, transparency notices under EU Reg 2024/900), payment flow, public API contract changes, auth / sign-up flow, cross-product integration points.

## Five phases

| Phase | When | Deliverables |
|---|---|---|
| **1** Baseline coverage + correctness | v0.8.13 | Fix `e2e-tester` subagent (drop product-specific contamination); `rules-routing.json` routes `testing.md` on UI source globs; Playwright templates (`playwright.config.ts.example`, sample flow / visual-regression / a11y tests); optional `ui-change-test-reminder.sh` PostToolUse hook; `visual-diff` defaults to mobile + desktop; `testing.md` adds a11y, cross-browser, multi-viewport, performance; this document |
| **2** Quality dimensions | ~v0.9.0 | Committed visual regression baselines via `toHaveScreenshot`; standard a11y pattern (axe-core + WCAG-AA); performance budget pattern; cross-browser standard config |
| **3** Confidence-scored auto-promote | ~v0.9.1 | New skill `/dev-tasks:auto-verify`; new Monday status `Verified`; `/ship-pr` Phase 6.5 routed transition; `project-config.lifecycle.alwaysUatPatterns[]` |
| **4** Production safety net | ~v0.9.2 | Auto-revert on Sentry production-error spike; `/dev-tasks:rollback` skill; canary deployment guidance |
| **5** Continuous calibration | Ongoing | Track FP/FN rates; adjust thresholds; per-surface escalation when FP rate spikes |

## Interactions with existing skills/rules

| Touch point | Effect |
|---|---|
| `task-lifecycle.md` | Phase 3 adds `Verified` status. Per-status gate logic in MCP server. |
| `/refine-task` | Phase 3 adds "if always-UAT surface, note it." |
| `/pickup-task` | Phase 3 adds "if always-UAT, skip auto-promote." |
| `/self-review` | Check #2 (visual) + #8 (tests) foundation; Phase 3 adds Check #12 (confidence score). |
| `/ship-pr` | Phase 1 validation foundation; Phase 3 replaces Phase 6.5 with routed transition. |
| `/dev-tasks:visual-diff` | Phase 1 mobile default; Phase 2 baselines; Phase 3 clean diff required for auto-verify. |
| `auto-version.ts` | Phase 3 — `Verified` transition also auto-links to version. |
| `/release-version` | Unchanged shape. Auto-promoted tasks release identically. |

## Anti-patterns

- Trying to make Claude judge UX subjectively. It reads screenshots and verifies presence/labeling; does not replace human taste.
- Removing UAT entirely. Some surfaces always need human review.
- Threshold-tuning by guessing. Set initial, observe FP/FN, adjust based on data.
- Skipping a11y for "non-public" pages. Internal admin tools have users with disabilities too.
- Visual regression on every pixel. Tolerance must be configurable.
- Auto-revert that revives bugs. Phase 4 needs a kill switch and "do not auto-revert past commit X."

## Open questions

- Line between "regulated surface" and "non-regulated"? PolAds: EU Reg 2024/900 + GDPR. STEPhie: TBD.
- Visual regression tolerance: default pixel-diff threshold? Likely per-project knob.
- Phase 3 `Verified` × `/babysit-prs` polling — subagent PRs that auto-promote bypass orchestrator merge; needs explicit handling.
- Performance budgets: per-page or per-component? Likely page-level v0.9.0, component-level later.

## Reference

`visual-diff` / `self-review` / `ship-pr` skills; `testing.md`, `ai-review-stack.md`, `agent-autonomy.md`, `task-lifecycle.md`.
