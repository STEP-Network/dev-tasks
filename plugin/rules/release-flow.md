# Release Flow

Three release modes under the **staging-as-base branching flow** (effective 2026-05-05, GH issue #109).

## TL;DR

- `staging` is the **persistent integration branch**. Features land here first.
- `main` is the **release branch**. Moves only when a release is cut.
- `test.polads.eu` always shows `staging`. `polads.eu` always shows `main`.
- Hotfixes branch from `main`, PR to `main`. A workflow merges them back into `staging`.
- Releases promote `staging` → `main` via `/release-version` (FF + tag + prod migrate).

## Three release modes

| Mode | Trigger | Use when |
|---|---|---|
| **Default (PR to staging)** | PR merged to `staging` via `/ship-pr` | Anything that isn't a production hotfix or release promotion |
| **Promote / Release** | `/release-version v{X.Y.Z}` from staging | Cutting a release: FF main + prod migrations + tag |
| **Hotfix** | PR to `main` directly from `hotfix/...` | Broken prod, security issue, time-sensitive |

## Decision tree

| Change type | Path |
|---|---|
| Anything user-facing (feature, copy, UI) | Default |
| Schema change with migration risk | Default — staging-pending migrations auto-layered onto preview Neon by `preview-staging-migrations.yml` |
| Permission / auth change | Default — UAT on `test.polads.eu` after merge |
| New user-facing flow | Default |
| Dependency upgrade with breaking changes | Default |
| Hotfix for production bug | Hotfix |
| Security patch | Hotfix |
| Cutting a release | Promote |

## Mode 1: Default (PR to staging)

```
feat/x → PR → staging → staging-migrate.yml applies migrations to staging Neon
                  ↘                              ↘
                   ↘                              → test.polads.eu rebuilds
                    preview-staging-migrations.yml → preview Neon picks up staging-pending migrations
            ↓
       per-PR Vercel preview URL (prod data + staging schema)
```

- `/pickup-task` branches from `staging`. `/ship-pr` opens PR with `--base staging`.
- On PR open/sync, `preview-staging-migrations.yml` finds auto-created preview Neon branch (parent = production), applies staging-pending migrations via `pnpm migrate:prod` — preview has prod data + staging schema.
- On merge to staging, `staging-migrate.yml` applies new migrations to staging Neon; Vercel rebuilds `test.polads.eu`.
- `staging` is never deleted.

## Mode 2: Promote / Release (staging → main)

```
staging (UAT passed, all linked Monday tasks Done)
   │
   ├─ /release-version v{X.Y.Z}
   │     1. Verify: clean tree, tasks Done, CI green on staging, main is ancestor of staging
   │     2. git push origin staging:main   (FF main from staging)
   │     3. pnpm migrate:prod
   │     4. git tag -a v{X.Y.Z} ; git push origin v{X.Y.Z}
   │
   └─ release.yml (on tag push)
        → Vercel deploys polads.eu from new main HEAD
        → GitHub Release created
        → Monday version status → Released
        → ISR cache revalidation
```

- `/release-version` is the single agentic entrypoint.
- `release.yml` triggers on tag push. Does NOT touch git refs — `/release-version`'s job.
- After this, `main` and `staging` are at same SHA. New work continues on `staging`.

## Mode 3: Hotfix (PR to main)

```
hotfix/y → PR → main → Vercel deploys polads.eu (production fix LIVE)
                  │
                  └─ hotfix-sync-staging.yml (formerly staging-deploy.yml)
                        → detect: is main HEAD an ancestor of staging?
                            YES (likely /release-version promotion): SKIP merge-back
                            NO (hotfix): merge main → staging (FF if possible; merge commit if diverged)
                                         push staging
                        → staging-migrate.yml applies migrations to staging Neon
                        → Vercel rebuilds test.polads.eu with hotfix
```

- Hotfix branched from `main` (NOT staging — hotfix code should match prod schema, not staging-pending).
- PR opened `--base main`. CI runs against main. Merge.
- `hotfix-sync-staging.yml` on push to `main`: if main HEAD is ancestor of staging → no-op (release promotion). Else → merge main into staging (FF if possible; merge commit if diverged; opens PR for human if conflict — never force-push).
- `polads.eu` fix LIVE immediately. `test.polads.eu` on next rebuild.

The hotfix's preview Neon (Vercel-Neon integration) is forked from prod and gets NO staging-pending layering — `preview-staging-migrations.yml` skips PRs targeting `main`.

## Common scenarios

- **Big feature needs stakeholder UAT**: `/pickup-task` from `staging` → `/ship-pr --base staging` → stakeholders validate per-PR preview → merge to staging → UAT on test.polads.eu → `/release-version` after sign-off.
- **Hotfix while UAT in flight**: hotfix from `main`, PR `--base main`, merge → polads.eu LIVE → `hotfix-sync-staging.yml` merges main → staging → test.polads.eu rebuilds with both UAT feature + hotfix.
- **UAT feature has its own bug**: new PR off staging targeting staging.
- **Roll back staging**: `gh pr create --base staging --head revert/feat-x ...`. Never force-push staging — preserve audit trail via revert PRs.

## Anti-patterns

- Branching feature work off `main` — always off `staging`. Branching off main is for hotfixes.
- Force-pushing `main` — never. Only via `/release-version` FF or hotfix PR merge.
- Force-pushing `staging` — also no. Use revert PRs.
- Tagging from `staging` — tag must be on `main` HEAD after FF; `/release-version` handles this.
- Cherry-picking hotfix commits onto a UAT branch — let `hotfix-sync-staging.yml` do the merge-back.
- Letting `staging` linger >2 weeks ahead of `main`. ~10+ unreleased PRs → cut a release.
- Deleting `staging` — branch is permanent (branch protection enforces).
- Mixing UAT and prod on same domain.

## Workflow enforcement

- `ci.yml` — runs CI on PRs targeting `staging` (default) or `main` (hotfixes/promotion).
- `preview-staging-migrations.yml` — for PRs targeting `staging`, layers staging-pending migrations onto preview Neon. Skipped for `main`.
- `staging-migrate.yml` — on push to `staging`, applies migrations to staging Neon. Vercel rebuilds `test.polads.eu`.
- `staging-deploy.yml` → `hotfix-sync-staging.yml` (renamed in spirit) — on push to `main`, merges main into staging if main has commits staging doesn't. Skips if main HEAD is already an ancestor of staging.
- `release.yml` — on tag `v*` push, creates GitHub Release, updates Monday, revalidates ISR.

Combination ensures: no silent overwrites of staging; migrations on the right Neon at the right time; stakeholders see latest on `test.polads.eu`; releases are deliberate one-tag promotions.
