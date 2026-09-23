---
name: ship
description: Typecheck, push, open a traceable PR to the base branch, arm auto-merge, stop.
user_invocable: true
---

# /ship — open the PR and stop

`/ship [--skip-typecheck]`

The session's last act. Everything after the PR opens runs in GitHub Actions
(spec section 7): lint, the test shards, the Vercel build, i18n, `Task trace`
and `Claude review`. This skill does not wait for any of them.

## Phase 0: config and profile

Read `.claude/project-config.json`:
- `git.defaultBase` (default `staging`) — the PR base
- `git.autoMergePolicy` — auto-merge is armed only when the base's policy is
  `auto-after-checks-and-review`. `never` or `manual-only` means open the PR
  and leave it for a human, and say so.
- `tracker.provider` (default `monday`; `DEV_TASKS_TRACKER` env var
  overrides) — which kind of id Phase 3/4 are working with. Equivalently:
  look at the shape of the `id` trackerctl hands back in Phase 3 — `STEP-<n>`
  is Linear, a bare number is Monday. Phase 4's PR title and body differ by
  provider, so know which one you're on before you get there.

```bash
PROFILE=$(bash "${CLAUDE_PLUGIN_ROOT}/hooks/lib/profile.sh" get profile)
```

**Refuse outright if the current branch IS the base branch**, or is `main`.
There is nothing to ship from there and `bash-guard` gate (f) would refuse the
push anyway — refusing here gives a better message.

## Phase 1: the one local check

```bash
pnpm tsc --noEmit        # or: npx tsc --noEmit
```

About 90 seconds. It is here and nothing else is, because a type error is the
one failure that makes every later CI job meaningless, and it needs no
database, no browser and no secrets.

`--skip-typecheck` skips it. Say in the PR body when it was skipped.

On failure: fix the errors and re-run. Do not open the PR.

## Phase 2: commit and push

```bash
git add -A
git commit -m "<type>: <subject>"    # feat|fix|refactor|perf|test|docs|chore
git push -u origin HEAD
```

`HEAD`, never a branch name.

## Phase 3: make sure there is an issue

Read the branch name. If it contains an identifier the tracker recognises
(`STEP-<n>`, or a Monday item id while `tracker.provider` is `monday`), that is
the issue — confirm it resolves:

```bash
npx tsx "${CLAUDE_PLUGIN_ROOT}/scripts/trackerctl.ts" read "$REF"
```

**If there is no identifier, create one now.** This is what makes the PR
traceable, and it is the reason `/ship` exists rather than a hook: the `Task
trace` required check refuses an app-source PR with no issue reference, and
guaranteeing the reference is better than blocking on its absence.

```bash
npx tsx "${CLAUDE_PLUGIN_ROOT}/scripts/trackerctl.ts" create \
  --title "<the PR's subject line>" \
  --description "$(git log --format='- %s' "origin/$DEFAULT_BASE..HEAD")" \
  --label "chore" \
  --state "In Progress"
```

Take `id` out of the JSON. Use the PR's subject line as the issue title so the
two read the same (the PR's title itself doesn't exist yet — it's built in
Phase 4 from this same subject plus the id created here); use the commit
subjects as the description so the issue says what landed.

> A PR whose changed paths are ALL under `.claude/`, `.github/` or `docs/` is
> exempt from `Task trace` and needs no issue. Check with
> `git diff --name-only "origin/$DEFAULT_BASE..HEAD"` before creating one —
> an issue per docs typo is noise on the board.

## Phase 4: open the PR

The identifier goes in BOTH places, and they are read by different things —
and the exact shape of each depends on `tracker.provider` from Phase 0:

- **the PR TITLE** — what a human sees in the PR list, and what the
  tracker's own GitHub integration links on.
  - `linear`: `STEP-123: <subject>`
  - `monday`: `<subject> (#<id>)`
- **the PR BODY**'s first line is the trace line that `lib/ci/pr-task-trace.ts`
  reads — the required `Task trace` check does NOT read the title, so a
  title-only reference fails it regardless of provider.
  - `linear`: `LINEAR_REF_RE` matches `STEP-123` — capitals, always; the
    regex is case-sensitive.
  - `monday`: `TASK_LINE_RE` matches `Monday.com Task: #<id>` exactly —
    that literal shape, not a bare id and not `#<id>` alone.

```bash
# linear
gh pr create \
  --base "$DEFAULT_BASE" \
  --title "STEP-123: <subject>" \
  --body "$(cat <<'BODY'
STEP-123

## What changed
<two or three lines>

## How it was checked
tsc --noEmit locally; everything else is CI.
BODY
)"

# monday
gh pr create \
  --base "$DEFAULT_BASE" \
  --title "<subject> (#<id>)" \
  --body "$(cat <<'BODY'
Monday.com Task: #<id>

## What changed
<two or three lines>

## How it was checked
tsc --noEmit locally; everything else is CI.
BODY
)"
```

## Phase 5: arm auto-merge

```bash
gh pr merge "$PR" --auto --squash --delete-branch
```

GitHub merges when every required check is green and not a moment earlier.
This replaces the polling loop `/ship-pr` used to sit in.

**Never `--admin`.** It merges past a red required check; spec section 11 bans
it and the staging ruleset's `bypass_actors` is empty, so there is nothing to
bypass with.

If the base's `autoMergePolicy` is `never` or `manual-only`, skip this phase
and say the PR is waiting for a human.

## Phase 6: link the PR back to the issue

```bash
npx tsx "${CLAUDE_PLUGIN_ROOT}/scripts/trackerctl.ts" attach "$REF" \
  --url "$PR_URL" --title "PR #$PR"
```

Non-fatal. The PR is open and traceable whether or not this write lands; a
failed attachment must never read as a failed ship.

## Phase 7: announce and stop

On an agent profile, post one line to `#polads-agents`: the identifier, the PR
URL, and whether auto-merge is armed.

On a human profile, print the same line.

**Then stop.** Do not poll CI, do not open the preview, do not flip a tracker
state — Linear's GitHub integration moves the issue to In Review on open and to
Agent UAT on merge (spec section 7.3).

## What /ship deliberately does NOT do

- No build, lint, test, Playwright, schema validation or visual diff.
- No UAT document and no screenshots. CI writes those after the staging deploy.
- No status flip, no subtask bookkeeping, no hours.
- No merge. Auto-merge is armed; GitHub decides when.
