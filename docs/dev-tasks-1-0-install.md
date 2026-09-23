# Installing dev-tasks 1.0 in a consumer project

## 1. The machine profile (once per machine, never committed)

```bash
cat > ~/.claude/dev-tasks-profile.json <<'JSON'
{ "profile": "human", "devSurface": "localhost", "mini": null }
JSON
```

A Mac mini running agents uses:

```json
{ "profile": "agent", "devSurface": "preview", "mini": "bob" }
```

An absent file means `human`. `DEV_TASKS_PROFILE=agent` overrides it for one
process. A file that is present but corrupt resolves to `agent`, deliberately:
a machine somebody configured must not silently disarm its own guards.

Check it:

```bash
bash ~/.claude/plugins/cache/dev-tasks-marketplace/dev-tasks/1.0.0/hooks/lib/profile.sh get profile
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
Expected: `1.0.0`.

## 3. `.claude/project-config.json`

Add the tracker block:

```json
"tracker": { "provider": "monday" }
```

Flip `provider` to `linear` on cutover weekend. Unsetting it is the rollback,
and it needs no code change.

Then trim `hooks.enabled[]`. Spec section 4 turns three of them off on BOTH
profiles, so remove them outright:

- `subtask-reminder` — retired in 1.0 (the script is gone)
- `post-self-review` — retired in 1.0 (the script is gone)
- `pipeline-reminder` — off for both profiles
- `stop-visual-diff-check` — off for both profiles (CI captures the screenshots)

`worktree-required` and `worktree-path-boundary` STAY in the list. They are
now profile-gated, so they are inert on a laptop and live on a mini, and one
config serves both.

## 4. The Linear key (only when `provider` is `linear`)

```bash
mkdir -p ~/.config/linear
printf 'LINEAR_API_KEY=%s\n' "$KEY" > ~/.config/linear/.env
chmod 600 ~/.config/linear/.env
```

Never in the repo, never in a shell history line that persists, never as a CLI
argument. `LINEAR_API_KEY` in the environment wins over the file.

## 5. Smoke test

```bash
cd <consumer-project>
npx tsx ~/.claude/plugins/cache/dev-tasks-marketplace/dev-tasks/1.0.0/scripts/trackerctl.ts ready --limit 3
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
