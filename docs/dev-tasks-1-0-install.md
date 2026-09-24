# Installing dev-tasks 1.0 in a consumer project

## 1. The machine profile (once per machine, never committed)

```bash
cat > ~/.claude/dev-tasks-profile.json <<'JSON'
{ "profile": "human", "devSurface": "localhost", "mini": null }
JSON
```

A Mac mini running agents uses:

```json
{ "profile": "agent", "devSurface": "preview", "mini": "eve" }
```

`mini` is that machine's name (`eve` on Eve's mini, `bob` on Bob's). Since
1.1.0, `trackerctl claim` and `trackerctl heartbeat` act as that mini, and a
machine without one (a laptop) is refused: only minis claim.

An absent file means `human`. `DEV_TASKS_PROFILE=agent` overrides it for one
process. A file that is present but corrupt resolves to `agent`, deliberately:
a machine somebody configured must not silently disarm its own guards.

Check it:

```bash
bash ~/.claude/plugins/cache/dev-tasks-marketplace/dev-tasks/1.1.0/hooks/lib/profile.sh get profile
```

## 2. Refresh the plugin cache

A plain `/reload-plugins` does NOT pick up a new plugin version. Remove the
cache directory and reinstall:

```bash
command rm -r -f ~/.claude/plugins/cache/dev-tasks-marketplace
```

Then in a Claude Code session:

```
/plugin marketplace add /Users/nate/dev-tasks
/plugin install dev-tasks@dev-tasks-marketplace
/reload-plugins
```

Confirm the version:

```bash
ls ~/.claude/plugins/cache/dev-tasks-marketplace/dev-tasks/
```
Expected: `1.1.0`.

## 3. `.claude/project-config.json`

Add the tracker block:

```json
"tracker": { "provider": "monday" }
```

Flip `provider` to `linear` on cutover weekend. Unsetting it is the rollback,
and it needs no code change.

**Prerequisites for `/dev`, `/preview`, and `/ship` to run unblocked:**

- `git.prePushMarker: false` — otherwise `bash-guard` gate (c) blocks every
  `/preview`/`/ship` push behind a local build/lint/test marker that neither
  skill writes.
- `ci.greenBeforeStop: false` — otherwise `stop-ci-green-check` holds the
  session open waiting for a PR that `/ship` deliberately leaves for CI to
  finish.
- Do NOT add `task-state-guard` or `commit-id-gate` to `hooks.enabled[]` —
  `task-state-guard` refuses the first edit when there is no
  `.claude/active-task.json` (which `/dev` never creates), and
  `commit-id-gate` refuses the pre-issue commit `/preview` makes before
  `/ship` has opened anything for a commit to reference.

Then trim `hooks.enabled[]`. Spec section 4 retires two of these outright and
turns the other two off on BOTH profiles — four in total, so remove them all:

- `subtask-reminder` — retired in 1.0 (the script is gone)
- `post-self-review` — retired in 1.0 (the script is gone)
- `pipeline-reminder` — off for both profiles
- `stop-visual-diff-check` — off for both profiles (CI captures the screenshots)

`worktree-required` and `worktree-path-boundary` STAY in the list. Both are
now profile-gated (inert on a laptop). `worktree-path-boundary` is then live
on a mini as soon as the session is inside a worktree; `worktree-required` is
ALSO keyed on `.claude/active-task.json` existing, which the 1.0 `/dev` flow
never creates, so on a mini it stays inert too until a future phase-2 worker
writes a task file. One config serves both profiles regardless.

**Plugin rules (1.0.1).** `rule-autoload` no longer runs by default: skills
read `${CLAUDE_PLUGIN_ROOT}/rules/<file>` when they need a rule. A Monday
project that wants the 1.0.0 behaviour back (lifecycle rules injected on the
first matching edit of a session) adds `"rule-autoload"` to `hooks.enabled[]`.
Under `linear`, leave it out: 11 of the 17 rules describe the Monday pipeline.
A project's own `rules.extraRules` files surface without that entry.

## 4. The Linear key (only when `provider` is `linear`)

```bash
mkdir -p ~/.config/linear
read -rs KEY
(umask 077; printf 'LINEAR_API_KEY=%s\n' "$KEY" > ~/.config/linear/.env)
chmod 600 ~/.config/linear/.env
unset KEY
```

Never in the repo, never in a shell history line that persists, never as a CLI
argument. `LINEAR_API_KEY` in the environment wins over the file.

## 5. Smoke test

```bash
cd <consumer-project>
npx tsx ~/.claude/plugins/cache/dev-tasks-marketplace/dev-tasks/1.1.0/scripts/trackerctl.ts ready --limit 3
```

Expected: one line of JSON, an array of up to three issues. An empty array is
a valid answer and means nothing is Ready.

## 6. What changed for a person

| Before | Now |
|---|---|
| `/pickup-task` → work → `/self-review` → `/ship-pr` | `/dev` → work → `/ship` |
| local build, lint, test, Playwright before every push | `tsc --noEmit` once, in `/ship` |
| agent polls CI, then merges | auto-merge; GitHub decides |
| a commit refused without `selfReviewPassed` | review is the CI `Claude review` check |
| every edit needs a worktree | worktrees are for agents; `--worktree` opts in |
