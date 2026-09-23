# dev-tasks 1.0 phase 0 — rehearsal record and rollout gates

Spec section 13. Phase 1 does not start until every row reads Verified.

## Live rehearsal against the STEP team — 2026-09-23

Run from the `feat/dev-tasks-1-0-phase-0` worktree, `plugin/scripts/trackerctl.ts`
with `DEV_TASKS_TRACKER=linear`. The plan wrote the path into the installed
1.0.0 plugin cache; that directory only exists after this PR merges and the
cache is refreshed, so the rehearsal ran the same source from the branch. The
installed-cache row below stays open until then.

| Step | Command | Result |
|---|---|---|
| 2 | `ready --limit 5` | 5 issues, all `Ready`, sorted priority-then-age; the one `No priority` issue (STEP-2147) last |
| 2 | `read STEP-3055` | `id` STEP-3055, title set, state `Agent UAT`, url on `linear.app`. Its description has no acceptance-criteria heading, so the empty `acceptanceCriteria` is correct; STEP-3057 (from `ready`) does carry one and it was extracted (2,022 chars) |
| 3 | `create` (write 1) | **STEP-3063**, state `Ready`, acceptance criteria round-tripped |
| 3 | labels | `--label type/chore --label chore` came back `["chore"]` — see finding 1 |
| 4 | `branch STEP-3063` | `STEP-3063-rehearsal-delete-me-dev-tasks-1-0-phase-0` — capitals, no username prefix |
| 4 | `comment`, `attach`, `claim --as rehearsal-runner` | all exit 0; read back through the API: state `In Progress`, comments `rehearsal comment` and `claimed by rehearsal-runner at …`, attachment `PR #1` → `https://example.com/pr/1`, no assignee (the claimant is not a Linear user) |
| 5 | `TRACKERCTL_MAX_WRITES=0 comment …` | `Refusing the write: TRACKERCTL_MAX_WRITES=0 reached`, exit 1, no comment landed |
| 5 | `TRACKERCTL_MAX_WRITES=abc comment …` | `TRACKERCTL_MAX_WRITES must be a non-negative integer.`, exit 1, no comment landed |
| 6 | `issueDelete` (one-off, through the plugin's own transport) | `success: true`; the issue is in Linear's Trash, recoverable for 30 days |
| 6 | `read STEP-3063` | `Linear: no issue STEP-3063 on team STEP`, exit 1 |
| 8 | `DEV_TASKS_PROFILE=agent profile.sh get profile` | `agent` |
| 8 | `DEV_TASKS_PROFILE=agent profile.sh get devSurface` | `localhost` — the override changes `profile` only, and this laptop's profile file sets `devSurface: localhost` explicitly. A mini's file says `preview` |
| 8 | `bash-guard.sh` on `git push origin staging`, PolAds config | exit 2 on `agent` AND on `human` |

The Linear key was read from `~/.config/linear/.env` and never printed.

## Findings

1. **Linear label names are bare.** The workspace's group labels are addressed by
   their child name — `chore`, `polads`, `feature` — not `type/chore`. The adapter
   matches names exactly and skips unknown ones by design, so `/ship`'s
   `--label "type/chore"` never applied a label. Fixed on this branch: `/ship` now
   passes `--label chore`, and the doc comments that showed the `group/name` form
   were corrected.
2. **`TRACKERCTL_MAX_WRITES` counts per process.** The counter lives in the
   transport's memory, so each `trackerctl` invocation starts from zero. It bounds
   one run of one command (a loop inside a single process), not a whole
   rehearsal made of separate invocations. The plan's "5 of 6 across commands"
   arithmetic was wrong; refusal was proven with a cap of 0 instead.
3. `~/.config/linear/.env` on this machine is mode 644. The contract says 600.

## Rollout gates

| Gate | How it is met | Status |
|---|---|---|
| Auto-merge lands three PRs unattended | three `/ship` PRs merged by GitHub with no human pressing merge; record the PR numbers | Open |
| `Claude review` runs clean on five PRs | PolAds-repo workflow, tracked separately. It is added to ruleset 21998691 by a HUMAN only after five clean runs | Open |
| The profile matrix behaves on a human laptop | `worktree-required` inert, i18n gates inert, gate (f) still blocks a push to staging | Verified in the hook test suites (`worktree-profile-gate`, `bash-guard-i18n-profile`, `bash-guard-gate-b-retired`) and live for gate (f) above |
| The profile matrix behaves on an agent profile | with `DEV_TASKS_PROFILE=agent`: `worktree-required` blocks, i18n gates block, gate (f) still blocks | Partially verified — see note |
| No retired hook is registered | `bash hooks/__tests__/retired-hooks.test.sh` green on the installed 1.0.0 cache, not just in the source tree | Source tree verified; installed cache open until the post-merge reinstall |
| The Linear adapter round-trips live | steps 2-6 above | Verified 2026-09-23 |
| One full week on one machine before a second adopts it | date started, date cleared | Open |

## Known limits of this rehearsal

- The Monday adapter was NOT exercised live. It is unit-tested only, and it is
  deleted a release after the cutover.
- `listReady` came back with five real Ready issues, so the query and the sort
  were exercised against live data.
- `claim` did not resolve a Linear user, because the claimant is not a member.
  The assignee branch of `claimIssue` is therefore unexercised against the live API.
- **Note on the agent-profile row above:** `worktree-required` blocking under
  `DEV_TASKS_PROFILE=agent` was verified against the `worktree-profile-gate`
  fixture, which plants a `.claude/active-task.json` deliberately — the hook
  is ALSO keyed on that file existing, and it exits 0 without it regardless of
  profile. The 1.0 `/dev` flow never creates `active-task.json`, so on a real
  agent mini `worktree-required` stays inert until a future phase-2 worker
  writes one. The hook's logic is verified; its live effect in the 1.0 `/dev`
  flow is not, hence "partially."
