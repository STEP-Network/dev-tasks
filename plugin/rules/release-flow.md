# Release Flow Rule

> **Reference rule** — describes the three release modes for shipping changes
> under the **staging-as-base branching flow** (effective 2026-05-05, GH issue #109).
> Loaded on demand by `/ship-pr` and `/release-version`.

## TL;DR (the new model)

- `staging` is the **persistent integration branch**. Features land here first.
- `main` is the **release branch**. It only moves when a release is cut.
- `test.polads.eu` always shows whatever's on `staging`.
- `polads.eu` always shows whatever's on `main`.
- Hotfixes branch from `main`, PR to `main`. A workflow merges them back into `staging`.
- Releases promote `staging` → `main` via `/release-version` (FF + tag + prod migrate).

## Three release modes

| Mode | Trigger | Use when |
|---|---|---|
| **Default (PR to staging)** | PR merged to `staging` via `/ship-pr` | Anything that isn't a production hotfix or a release promotion |
| **Promote / Release** | `/release-version v{X.Y.Z}` from staging | Cutting a release: FF main from staging + apply prod migrations + tag |
| **Hotfix** | PR to `main` directly from a `hotfix/...` branch | Broken prod, security issue, time-sensitive — bypasses the staging integration step |

## Decision tree

| Change type | Path |
|---|---|
| Anything user-facing (new feature, copy, UI change) | **Default** — branch from staging, PR to staging |
| Schema change with data migration risk | **Default** — staging-pending migrations are auto-layered onto preview Neon branches by `preview-staging-migrations.yml` |
| Permission / auth change touching multiple roles | **Default** — UAT happens on `test.polads.eu` after merge |
| New user-facing flow (e.g. payment, signup variant) | **Default** — UAT on staging URL is the default integration path now |
| Dependency upgrade with breaking changes | **Default** — all visibility-into-prod-data testing happens on staging |
| Hotfix for production bug | **Hotfix** — branch from main, PR to main; auto-merged back into staging |
| Security patch | **Hotfix** — same; auto-merged back into staging |
| Cutting a release | **Promote** — `/release-version` |

## Mode 1: Default (PR to staging)

```
feat/x ──► PR ──► staging ──► staging-migrate.yml applies migrations to staging Neon
            │              ╲                              ╲
            │               ╲                              ─► test.polads.eu rebuilds
            │                preview-staging-migrations.yml ─► preview Neon branch picks up staging-pending migrations
            ▼
       per-PR Vercel preview URL (with prod data + staging schema)
```

**Mechanics**:
- `/pickup-task` branches **from `staging`** (not from `main`).
- `/ship-pr` opens the PR with **`--base staging`** (not `--base main`).
- On PR open/sync, `preview-staging-migrations.yml` finds the auto-created preview Neon branch (Neon-Vercel integration creates it, parent = production), and applies any **staging-pending migrations** on top via `pnpm migrate:prod` — so the preview has prod data + staging schema.
- On PR merge to staging, `staging-migrate.yml` applies any new migrations to the staging Neon branch and Vercel rebuilds `test.polads.eu`.
- `staging` is **never deleted**. It's the moving leading edge of work that hasn't yet promoted to prod.

**This is the default — most changes flow through here.**

## Mode 2: Promote / Release (staging → main)

```
staging (assumes UAT passed, all linked Monday tasks Done)
   │
   ├─► /release-version v{X.Y.Z}
   │       1. Verify: working tree clean, all tasks Done, CI green on staging,
   │          main is ancestor of staging
   │       2. git push origin staging:main  (FF main from staging)
   │       3. pnpm migrate:prod  (apply migrations to production Neon)
   │       4. git tag -a v{X.Y.Z} ; git push origin v{X.Y.Z}
   │
   └─► release.yml (on tag push)
          ─► Vercel deploys polads.eu from new main HEAD
          ─► GitHub Release created
          ─► Monday version status → "Released"
          ─► ISR cache revalidation
```

**Mechanics**:
- `/release-version` is the single agentic entrypoint. It runs all the pre-flight checks, the FF, the prod migrate, and the tag.
- `release.yml` triggers on the tag push. It does NOT touch git refs — that's `/release-version`'s job.
- After this, `main` and `staging` are at the same SHA. New feature work continues to land on `staging`, advancing it ahead of `main` again until the next release.

## Mode 3: Hotfix (PR to main directly)

```
hotfix/y ──► PR ──► main ──► Vercel deploys polads.eu (production fix LIVE)
                       │
                       └─► hotfix-sync-staging.yml (formerly staging-deploy.yml)
                              ─► detect: is main HEAD an ancestor of staging?
                                  YES (likely a /release-version promotion):
                                      → SKIP merge-back (staging is already ahead)
                                  NO (looks like a hotfix):
                                      → merge main → staging (FF if possible, merge commit if diverged)
                                      → push staging
                              ─► staging-migrate.yml applies any new migrations to staging Neon
                              ─► Vercel rebuilds test.polads.eu with the hotfix included
```

**Mechanics**:
- Hotfix branched from `main` (NOT from staging — important: hotfix code should be calibrated to prod schema, not staging-pending schema).
- PR opened with `--base main`. CI runs against main. Reviewer approves. Merge.
- `hotfix-sync-staging.yml` (the repurposed former `staging-deploy.yml`) fires on push to `main`:
  - If main HEAD is an ancestor of staging → likely a `/release-version` promotion just happened → no-op.
  - Otherwise → merge `main` into `staging`. Fast-forward if possible; merge commit if staging diverged. If conflict → opens a PR for human resolution rather than force-pushing.
- `polads.eu` has the fix LIVE immediately.
- `test.polads.eu` gets the fix on the next Vercel rebuild after the merge to staging.

**Important**: the hotfix's preview Neon branch (created by Vercel-Neon integration when the hotfix PR opened) is forked from prod and gets NO staging-pending layering — `preview-staging-migrations.yml` skips PRs targeting `main` for exactly this reason. Hotfix previews exercise prod schema, matching prod runtime.

## Common scenarios

### Scenario A: Big feature needs stakeholder UAT before release

1. `/pickup-task` claims a Monday task and branches off `staging`.
2. Build feature on `feat/big-thing`. Open PR via `/ship-pr` with `--base staging`.
3. Per-PR Vercel preview URL has prod data + staging schema. Stakeholders validate on the preview.
4. Merge PR to `staging`. test.polads.eu picks it up automatically.
5. Coordinate full UAT on test.polads.eu.
6. After sign-off, when ready: `/release-version v{X.Y.Z}` promotes to main.

### Scenario B: Hotfix needed while UAT is in flight on staging

1. UAT for `feat/big-thing` is on test.polads.eu.
2. Bug discovered in prod — branch `hotfix/critical-bug` from `main`.
3. PR opened with `--base main`. Merge.
4. Vercel deploys polads.eu. Hotfix LIVE.
5. `hotfix-sync-staging.yml` runs:
   - Detects main has commits not on staging → merges main → staging.
   - The UAT feature on staging stays put; the hotfix is layered on top.
6. test.polads.eu rebuilds with both UAT feature + hotfix.
7. UAT continues uninterrupted (no need to re-push from feature branch).

### Scenario C: UAT feature has its own bug discovered

1. UAT on test.polads.eu reveals a bug in the feature itself.
2. Open a new PR off staging targeting staging with the fix.
3. Merge to staging. test.polads.eu rebuilds. UAT continues.

### Scenario D: Roll back staging without merging UAT

If a feature on staging needs to be reverted:

```bash
# Open a PR that reverts the offending merge commit
gh pr create --base staging --head revert/feat-x ...
```

Don't force-push staging back to a previous SHA — preserve the audit trail via revert PRs.

## Anti-patterns

- **Branching feature work off `main`** — always branch off `staging` (default flow). Branching off main is reserved for hotfixes.
- **Force-pushing `main`** — never. `main` only moves via `/release-version`'s FF or via a hotfix PR merge.
- **Force-pushing `staging`** — also no. Use revert PRs to undo work on staging.
- **Tagging from `staging`** — the tag must be on `main` HEAD after the FF. `/release-version` handles this.
- **Cherry-picking hotfix commits onto a UAT branch** — let `hotfix-sync-staging.yml` do the merge-back. Manual cherry-picks scramble lineage.
- **Letting `staging` linger ahead of `main` for >2 weeks** — releases keep the gap small. If `staging` accumulates ~10+ unreleased PRs, cut a release.
- **Deleting `staging`** — the branch is permanent. Branch protection rules enforce this.
- **Mixing UAT and prod testing on the same domain** — `test.polads.eu` is for staging UAT; `polads.eu` is for prod. They're not interchangeable.

## How the workflows enforce this

- `.github/workflows/ci.yml` — runs CI on PRs targeting `staging` (default) or `main` (hotfixes / promotion).
- `.github/workflows/preview-staging-migrations.yml` — for PRs targeting `staging`, layers staging-pending migrations onto the auto-created preview Neon branch. Skipped for PRs targeting `main` (hotfix path).
- `.github/workflows/staging-migrate.yml` — on push to `staging`, applies migrations to staging Neon. Vercel rebuilds `test.polads.eu` automatically.
- `.github/workflows/staging-deploy.yml` (renamed in spirit to `hotfix-sync-staging.yml`) — on push to `main`, merges main into staging if main has commits staging doesn't (i.e. a hotfix landed). Skips if main HEAD is already an ancestor of staging (i.e. a release-promotion).
- `.github/workflows/release.yml` — on tag `v*` push (which `/release-version` does after the FF + prod-migrate), creates GitHub Release, updates Monday, revalidates ISR cache.

The combination ensures:
- No silent overwrites of work on staging.
- Migrations always run on the right Neon branch at the right time (staging Neon for default flow; prod Neon at release time; preview Neon gets layered staging-pending migrations for default-flow PRs).
- Stakeholders always see the latest integration state on `test.polads.eu`.
- Releases are deliberate, traceable acts (one tag, one promotion).

## When this rule is loaded

- `/ship-pr` references it when deciding the PR base (default `staging`, hotfix `main`).
- `/release-version` references it for the promotion ceremony.
- `/pickup-task` references it for branching base (default `staging`, hotfix `main`).
- Any release-related question or planning.
