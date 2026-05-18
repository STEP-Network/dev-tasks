# Worktree Discipline

When and how Claude Code sessions must run inside a git worktree. Enforced by `.claude/hooks/worktree-required.sh`.

## The bar

Every claimed Monday task does source-file editing in a git worktree — never in the main checkout. The main checkout is for navigation and read-only operations only.

Enforced by four layers:

| Layer | Mechanism | Failure mode |
|---|---|---|
| 1. Skill | `/pickup-task` Phase 0 calls `EnterWorktree` before claiming | Skill bypass falls through |
| 2. Hook (presence) | `worktree-required.sh` PreToolUse on `Edit\|Write` | Hard-blocks (exit 2) edits to non-`.claude/` paths if active task exists outside a worktree |
| 3. Hook (boundary) | `worktree-path-boundary.sh` PreToolUse on `Edit\|Write` | Hard-blocks (exit 2) edits whose absolute path points at main checkout while session is in worktree |
| 4. Cleanup | `/ship-pr` Phase 10 calls `ExitWorktree({ action: "remove" })` post-merge | Refuses with uncommitted changes — commit/stash first |

Both hooks exercised by `.claude/hooks/__tests__/test-worktree-hooks.sh` (15 cases). Run `pnpm test:hooks` after any hook change.

## Why

Two parallel sessions in the same checkout collide on: `.claude/active-task.json` (task-state-guard reads on every Edit); `/tmp/.claude-prepush-<branch>` markers; `selfReviewPassed` flag (task-state-guard resets on every source edit); working-tree state (git checkout, commits, dirty index, parallel `pnpm install`); migration runs (`pnpm migrate:testing` advisory lock on testing Neon — racing deadlocks; recover with `pnpm migrate:unlock`).

Worktrees give each session its own checkout dir, `.claude/`, and dirty state. Same `.git/objects` (commits/fetches/pushes shared).

## How

### Creating

```
EnterWorktree({ name: "feat-<short-slug>" })
```

Creates `.claude/worktrees/feat-<slug>/` on new branch `worktree-feat-<slug>` based off current HEAD. Slug should be Monday-task-derived (e.g. `feat-publisher-signoff`, `hotfix-broken-auth`).

**Base ref**: `.claude/settings.json` sets `worktree.baseRef = "head"` — branches off current local HEAD (typically `staging` per `release-flow.md`). Default `fresh` would branch off `origin/main`, wrong for staging-as-base. Always start from `staging` before `EnterWorktree` (`git checkout staging && git pull` if needed).

`/pickup-task` Phase 0 runs this automatically. Manual usage is for: worktrees without a Monday task (exploratory), parallel side-investigation.

### Detection (used by the hook)

```bash
[ "$(git rev-parse --git-common-dir)" != "$(git rev-parse --git-dir)" ]
```

Catches both `.claude/worktrees/<name>/` (from `EnterWorktree`) AND sibling worktrees from `git worktree add ../foo`.

### Project-root resolution for hooks

`CLAUDE_PROJECT_DIR` is frozen at session start (launch directory, usually main checkout) and does NOT follow `EnterWorktree`. Hooks reading/writing `.claude/` state MUST use the worktree-aware resolver in `plugin/hooks/lib/resolve-project-root.sh`.

PreToolUse hooks (Edit / Write / MultiEdit / NotebookEdit) — pass the edited file's path; `resolve_project_root` locks onto the worktree owning it:

```bash
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-project-root.sh"
INPUT=$(cat)
FILE_PATH=$(extract_tool_file_path "$INPUT")
PROJECT_ROOT=$(resolve_project_root "$FILE_PATH")
```

Stop hooks and others without stdin — call `resolve_project_root ""`.

Resolution order: edited file's directory (walking up), CWD, fallback `CLAUDE_PROJECT_DIR`, fallback `$PWD`. Don't read `${CLAUDE_PROJECT_DIR}/.claude/...` directly — caused retros #2922252904, #2922256731, #2922302538.

### Cleanup

```
ExitWorktree({ action: "remove" })
```

Refuses if working tree has uncommitted changes OR local branch has commits not on the original branch (unmerged). Don't reach for `discard_changes: true` reflexively — investigate first (real work to commit; stale generated files; files for a different task to stash).

`/ship-pr` Phase 10 runs this automatically after merge.

## Escape hatch: `allowMainCheckout: true`

In `.claude/active-task.json`:

```json
{ "taskId": "...", "taskName": "...", "claimToken": "...", "allowMainCheckout": true, ... }
```

When `true`, hook exits 0 unconditionally. Use only for: hot-path emergencies, throwaway exploration, migration of a long-running branch that predates this rule. Not for daily convenience — if you reach for it more than once a week, the rule isn't working.

Document **why** in the Monday task body or PR comment.

## Anti-patterns

- Running `/pickup-task` from main checkout and ignoring Phase 0 — hook hard-blocks the first edit anyway.
- Manually setting `allowMainCheckout: true` to silence the hook — habit-forming.
- `git worktree remove --force` while uncommitted changes exist — discards real work.
- Two worktrees on the same feature branch — git refuses. Use named sessions (`/resume`).
- Stacked worktrees (running `EnterWorktree` from inside another) — the tool refuses.
- Treating worktrees as long-lived branches — they're per-task disposable.

## Migrating an existing in-flight branch

**Option A** — opt out for this branch: add `"allowMainCheckout": true` to `.claude/active-task.json`, note reason in Monday task. Next `/pickup-task` Phase 0 creates a worktree for the next branch normally.

**Option B** — move the branch into a worktree: from main checkout with branch checked out, commit/stash → `git checkout staging` → `git worktree add .claude/worktrees/feat-<slug> feat/<slug>` → `EnterWorktree({ path: ".claude/worktrees/feat-<slug>" })` → apply stashed changes.

> **Pre-PR branches**: `worktree-required.sh` ships with this PR. A branch that diverged before the merge doesn't contain the hook or its `settings.json` registration — hook doesn't fire until you merge `staging` in. Catch up first, then move into a worktree, then benefit from the hook.

## Traceability: Monday task ↔ branch ↔ worktree path

Worktree path is derivable from Monday's Branch column (`text_mm0pvs3n`) — convention effective 2026-05-13: branch `feat/foo-bar` → path `.claude/worktrees/feat-foo-bar` → worktree branch `feat/foo-bar`. Derivation: `worktree_path=".claude/worktrees/$(echo "$branch" | tr '/' '-')"`. Used by `.claude/scripts/find-worktree-for-task.sh`, `.claude/scripts/worktree-audit.sh`, `/pickup-task` Phase 10, `/ship-pr` Phase 4.

Reverse direction (worktree → task): read `.claude/active-task.json`. `taskId` is canonical.

## Cleanup cadence

`.claude/scripts/worktree-audit.sh` classifies every `git worktree list` entry and (with `--remove`) deletes DONE ones. Run post-merge, weekly (each stale worktree ~3–5 GB of `node_modules` + `.next`), and before long autonomous runs.

| Class | Branch state | Working tree | active-task.json | Disposition |
|---|---|---|---|---|
| **DONE** | Merged (direct or squash-PR) | Clean | Either | Remove with `--remove` |
| **IN-FLIGHT (dirty)** | Either | Dirty | Either | Preserve; commit/stash or user reviews |
| **IN-FLIGHT (active task)** | Unmerged | Clean | Present | Preserve; in active development |
| **ABANDONED** | Unmerged | Clean | Absent | Flag for user decision |

Escape hatches: `git worktree remove --force <path>` (bypasses dirty-tree refusal); `bash .claude/scripts/worktree-audit.sh --remove` (interactive); `--remove -y` (assume-yes; bulk-removes DONE).

Audit NEVER removes: the main checkout (first `git worktree list` entry), the currently-active worktree.
