# AI Review Stack

> Reference rule. Describes how multiple AI/automated review layers compose into a single triage queue. Vendor-agnostic — STEP currently uses Corridor + Vercel Agent + Sentry Seer + `/self-review`, but the framework holds if any layer is swapped or absent.

## TL;DR

Up to four complementary review layers feed into one `BLOCKER / IMPROVEMENT / POLISH` queue (per `ship-readiness.md`). No layer is a substitute for the others; each is the primary owner of a different risk class. When two layers flag the same issue, fix once and reply on the lower-severity comment with "addressed in [other-comment-id]".

## The layers

| Layer | Role | Scope | Fires on |
|---|---|---|---|
| **Corridor** | Regulatory + security guardrails (CWE + project-authored compliance rules) | Static-analysis + AI guardrails per-PR | Plan-time (`analyzePlan`), per-PR scan, Stop hook |
| **Vercel Agent** | General code quality, correctness, performance, production investigations | PR code review on configured base branches | PR open/sync, manual `/vercel-review` mention |
| **Sentry Seer** | Auto-RCA + draft fix PRs for production errors | Production error issues in Sentry | New issue → root-cause hypothesis → drafted PR (recommended: "Stop after PR drafted" handoff) |
| **`/self-review`** | Project-specific rules (per consumer's `.claude/rules/*.md` + `.claude/skills/self-review/SKILL.md.local` overlay) | Local diff before push | Manual invocation (10-point checklist) |

Any layer can be absent in a given project — the matrix still works with fewer rows. If your project only has Corridor + `/self-review`, the queue is two-source; the triage rules below apply identically.

## Coverage matrix

What each layer is the *primary* owner of. Secondary entries mean "this layer catches it sometimes but isn't responsible." Rows are illustrative — extend per product.

| Risk class | Corridor | Vercel Agent | Seer | `/self-review` |
|---|---|---|---|---|
| Auth bypass / privilege escalation | primary | secondary | (post-incident) | secondary |
| Injection (SQL / SSRF / XSS / path traversal) | primary | secondary | (post-incident) | — |
| Compliance / regulatory rules (project-authored) | primary | — | — | secondary |
| General correctness / logic bugs | — | primary | (post-incident) | secondary |
| Performance regressions (bundle / p95 / render-blocking / N+1) | — | primary | secondary (post-incident) | — |
| Production runtime errors (real traffic) | — | secondary | primary | — |
| Project-specific patterns (i18n parity, immutable shapes, design tokens, etc.) | — | — | — | primary |
| Test-coverage tiers (unit/integration/E2E discipline) | — | secondary | — | primary |

## Triage flow — one queue, multiple sources

```
            ┌───────────┐
            │ Corridor  │──┐
            └───────────┘  │
            ┌───────────┐  │
            │ Vercel    │──┤
            └───────────┘  │     ┌─────────────────────┐     ┌──────────────────┐
            ┌───────────┐  ├────►│  triage queue       ├────►│ BLOCKER → fix    │
            │ Seer      │──┤     │  per ship-readiness │     │ IMPROVEMENT → ?  │
            └───────────┘  │     │  .md                │     │ POLISH → decline │
            ┌───────────┐  │     └─────────────────────┘     └──────────────────┘
            │ self-rev  │──┘
            └───────────┘
```

Every finding from every layer gets one of three labels:

- **🔴 BLOCKER** — security/correctness/regulatory. Must fix before merge.
- **🟡 IMPROVEMENT** — small fix, real win. Fix if cheap.
- **🟢 POLISH** — speculative or stylistic. Decline with a one-line reply.

`/ship-pr` Phase 6 (Review iteration) walks all open comments from all four layers in one pass. The treatment of bot severity labels: **advisory, not verdicts** — the human-or-agent triager makes the BLOCKER/IMPROVEMENT/POLISH call, not the bot.

## No-overlap rules

To prevent review-loop noise when two layers flag the same finding:

1. **Same issue, two sources**: fix once. Reply on the lower-severity comment with "addressed in [other-comment-id]" so the dashboard count goes to zero on both.
2. **Self-review's domain wins over generic bots**: if Vercel Agent flags something `/self-review` explicitly checks (e.g. a project-specific pattern), the `/self-review` verdict wins — those checks have project context the generic bot lacks. Reply on the bot comment with "deferred to /self-review Check #N (project-specific rule)".
3. **Seer-drafted PRs aren't exempt from review**: a Sentry Seer-drafted PR goes through the same 4-layer convergence (Corridor + Vercel Agent + `/self-review` + GitHub bot reviewer) on its own merge cycle. CI green + zero BLOCKERs is still the merge bar.

## Local-development scope

- Corridor: runs at plan-time (`analyzePlan`), and on Stop. Works locally.
- Vercel Agent: only fires on real PRs against configured base branches. No localhost equivalent — open a draft PR to exercise it.
- Sentry Seer: production errors only. No localhost equivalent.
- `/self-review`: local diff before push. The only layer that runs without any remote infrastructure.

## When this rule is loaded

- An agent about to call `/self-review` or `/ship-pr` Phase 6 — the rule explains how to triage the resulting findings.
- A user asks "should this finding from \<bot\> block the PR?" — the rule gives the convergence-aware answer.
- Onboarding a new STEP product — the rule documents the expected review surface.

## Project-specific extensions

Each product extends this framework in its own `.claude/rules/security.md` (or equivalent), adding:

- Vendor-specific config (Sentry org, Corridor project ID, Vercel project slug)
- Product-specific risk classes that map to existing layers' coverage (regulatory specifics, project patterns)
- Layer-specific webhook bridges (e.g. Sentry → Monday auto-bug)
- Override entries in the coverage matrix where their judgment differs from the defaults above
