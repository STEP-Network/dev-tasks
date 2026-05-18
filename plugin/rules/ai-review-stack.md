# AI Review Stack

How multiple AI/automated review layers compose into a single triage queue. STEP uses Corridor + Vercel Agent + Sentry Seer + `/self-review`; framework holds if any layer is swapped or absent.

## TL;DR

Up to four complementary layers feed one `BLOCKER / IMPROVEMENT / POLISH` queue (per `ship-readiness.md`). Each layer is primary owner of a different risk class. When two layers flag the same issue, fix once and reply on the lower-severity comment with "addressed in [other-comment-id]".

## The layers

| Layer | Role | Fires on |
|---|---|---|
| **Corridor** | Regulatory + security guardrails (CWE + project-authored compliance rules) | Plan-time (`analyzePlan`), per-PR scan, Stop hook |
| **Vercel Agent** | General code quality, correctness, performance, production investigations | PR open/sync, manual `/vercel-review` mention |
| **Sentry Seer** | Auto-RCA + draft fix PRs for production errors | New issue → root-cause hypothesis → drafted PR |
| **`/self-review`** | Project-specific rules (per `.claude/rules/*.md` + `.claude/skills/self-review/SKILL.md.local`) | Manual invocation (10-point checklist) |

Any layer can be absent; matrix still works with fewer rows.

## Coverage matrix

Primary owner per risk class. Rows are illustrative — extend per product.

| Risk class | Corridor | Vercel Agent | Seer | `/self-review` |
|---|---|---|---|---|
| Auth bypass / privilege escalation | primary | secondary | (post-incident) | secondary |
| Injection (SQL / SSRF / XSS / path traversal) | primary | secondary | (post-incident) | — |
| Compliance / regulatory rules (project-authored) | primary | — | — | secondary |
| General correctness / logic bugs | — | primary | (post-incident) | secondary |
| Performance regressions (bundle / p95 / render-blocking / N+1) | — | primary | secondary (post-incident) | — |
| Production runtime errors (real traffic) | — | secondary | primary | — |
| Project-specific patterns (i18n parity, immutable shapes, design tokens) | — | — | — | primary |
| Test-coverage tiers (unit/integration/E2E discipline) | — | secondary | — | primary |

## Triage flow

Every finding from every layer gets one label per `ship-readiness.md`: BLOCKER / IMPROVEMENT / POLISH. `/ship-pr` Phase 6 walks all open comments from all layers in one pass.

Bot severity labels are **advisory, not verdicts** — the triager makes the call, not the bot.

## No-overlap rules

1. **Same issue, two sources**: fix once. Reply on lower-severity comment with "addressed in [other-comment-id]" so both go to zero.
2. **Self-review's domain wins over generic bots**: if Vercel Agent flags something `/self-review` checks (project-specific pattern), reply on bot with "deferred to /self-review Check #N (project-specific rule)".
3. **Seer-drafted PRs aren't exempt**: they pass the same 4-layer convergence on their own merge cycle.

## Local-development scope

- Corridor: plan-time + Stop hook. Works locally.
- Vercel Agent: PRs against configured base branches only. No localhost — open a draft PR.
- Sentry Seer: production errors only. No localhost.
- `/self-review`: local diff before push. Only layer with no remote dependency.

## Project-specific extensions

Each product extends in `.claude/rules/security.md` (or equivalent):

- Vendor config (Sentry org, Corridor project ID, Vercel project slug)
- Product-specific risk classes mapping to existing layer coverage
- Layer-specific webhook bridges (Sentry → Monday auto-bug)
- Coverage matrix overrides
