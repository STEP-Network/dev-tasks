# Worktree Discipline

> **Reference rule** — describes when and how Claude Code sessions must run inside
> a git worktree. Loaded on demand by `/pickup-task` and `/ship-pr`, and enforced
> at edit-time by `.claude/hooks/worktree-required.sh`.

## The bar

> Every claimed Monday task does its source-file editing in a git worktree —
> never in the main checkout. The main checkout is for navigation and read-only
> operations only.

This is enforced by four layers:

| Layer | Mechanism | Failure mode |
|---|---|---|
| 1. Skill | `/pickup-task` Phase 0 calls `EnterWorktree` before claiming | Skill bypass falls through to layer 2 |
| 2. Hook (presence) | `worktree-required.sh` PreToolUse hook on `Edit\|Write` | Hard-blocks (exit 2) edits to non-`.claude/` paths if active task exists outside a worktree |
| 3. Hook (boundary) | `worktree-path-boundary.sh` PreToolUse hook on `Edit\|Write` | Hard-blocks (exit 2) edits whose absolute path points at the **main checkout** while the session is in a worktree (catches the absolute-path-from-session-prompt class of mistake) |
| 4. Cleanup | `/ship-pr` Phase 10 calls `ExitWorktree({ action: "remove" })` post-merge | Refuses to remove with uncommitted changes — agent must commit/stash first |

Both hooks are exercised by the test suite at `.claude/hooks/__tests__/test-worktree-hooks.sh` (15 cases — positive + negative + exemptions + opt-out + path-boundary suggestion). Run with `pnpm test:hooks`. Re-run after any hook change.

## Why

Two parallel Claude sessions in the same checkout collide on:

- **`.claude/active-task.json`** — task-state-guard.sh hook reads it on every Edit. If session A claims task X and session B claims task Y, the file races. With worktrees each session has its own copy.
- **Pre-push markers** at `/tmp/.claude-prepush-<branch>` — branch-name-based, but if both sessions are on the same branch, one's marker invalidation wipes the other's.
- **selfReviewPassed flag** — task-state-guard resets it on every source-file edit. If two sessions edit in parallel, the flag thrashes.
- **Working tree state** — git checkout, commits, dirty index. Two sessions running `pnpm install` or `git checkout` at the same time corrupts state.
- **Migration runs** — `pnpm migrate:testing` takes an advisory lock on the testing Neon branch. Two sessions racing it deadlocks until `pnpm migrate:unlock`.

Worktrees give each session its own checkout dir, its own `.claude/`, its own dirty state. Same `.git/objects` (so commits, fetches, pushes still share the work), but everything else is per-worktree.

## How

### Creating a worktree

```
EnterWorktree({ name: "feat-<short-slug>" })
```

Creates `.claude/worktrees/feat-<slug>/` on a new branch `worktree-feat-<slug>` based off the current HEAD. Slug should be Monday-task-derived (e.g. `feat-publisher-signoff`, `hotfix-broken-auth`).

**Base ref**: `.claude/settings.json` sets `worktree.baseRef = "head"` so the worktree branches off the **current local HEAD** (typically `staging` per `.claude/rules/release-flow.md`). The default `fresh` value would branch off `origin/main`, which is wrong for the staging-as-base flow — that misconfiguration caused the Phase 1G recovery work on PR #160. Always start from `staging` before calling `EnterWorktree` (run `git checkout staging && git pull` first if needed).

`/pickup-task` Phase 0 runs this automatically. Manual usage is only needed for:

- Spawning a worktree without a Monday task (rare — exploratory throwaway work)
- Setting up a parallel side-investigation while keeping the main session active

### Detection (used by the hook)

A session is "in a worktree" when:

```bash
[ "$(git rev-parse --git-common-dir)" != "$(git rev-parse --git-dir)" ]
```

This catches **both** `.claude/worktrees/<name>/` (created by `EnterWorktree`) AND sibling worktrees from `git worktree add ../foo` — the hook works for both layouts.

### Project-root resolution (for hooks that read `.claude/active-task.json`)

**`CLAUDE_PROJECT_DIR` is frozen at session start.** It points at the directory where Claude Code was launched — almost always the main checkout. It does NOT follow `EnterWorktree`. Hooks that read or write state in `.claude/` MUST use the worktree-aware resolver, not `CLAUDE_PROJECT_DIR`:

```bash
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-project-root.sh"
INPUT=$(cat)
FILE_PATH=$(extract_tool_file_path "$INPUT")  # safe even without stdin payload
PROJECT_ROOT=$(resolve_project_root "$FILE_PATH")
```

`resolve_project_root` returns `git rev-parse --show-toplevel` from (in order): the edited file's directory, then CWD; falls back to `CLAUDE_PROJECT_DIR`, then `$PWD`. This means a hook fired from a worktree edits/reads the worktree's `.claude/active-task.json`, not the main checkout's. Don't read `${CLAUDE_PROJECT_DIR}/.claude/...` directly — that pattern is what caused retros #2922252904, #2922256731, and #2922302538.

### Cleanup

```
ExitWorktree({ action: "remove" })
```

Refuses to remove if:
- Working tree has uncommitted changes
- Local branch has commits not on the original branch (which means they weren't merged)

**Both refusal modes are correct safety properties.** Don't reach for `discard_changes: true` reflexively — investigate the leftovers first. They might be:

- Real work you forgot to commit → commit + push to the branch
- Stale generated files → safe to discard
- Files for a different task you accidentally edited → stash and re-apply elsewhere

`/ship-pr` Phase 10 runs `ExitWorktree({ action: "remove" })` automatically after merge. The merge means HEAD is now reachable from staging/main, so the worktree branch's commits are no longer "unmerged" — `ExitWorktree` succeeds.

## Escape hatch: `allowMainCheckout: true`

The hook honors an explicit opt-out flag in `.claude/active-task.json`:

```json
{
  "taskId": "...",
  "taskName": "...",
  "claimToken": "...",
  "allowMainCheckout": true,
  ...
}
```

When set to `true`, the hook exits 0 unconditionally. Use **only** for:

- **Hot-path emergencies**: production is on fire and a worktree-spinup adds friction the user can't afford
- **Throwaway exploration**: agent is iterating on something that won't ship as-is
- **Migration of a long-running existing branch** that predates this rule and isn't worth moving into a worktree

The flag is **not for daily convenience**. If you reach for it more than once a week, the rule isn't working and we should re-examine the discipline (not relax the gate).

When the flag is set, document **why** in the Monday task body or a PR comment. Future audits should be able to answer "why did this work skip the worktree gate?" by reading the task description, not by archaeology.

## Anti-patterns

- **Running `/pickup-task` from the main checkout and ignoring Phase 0** — the hook will hard-block your first source edit, and you'll have to start over from inside a worktree anyway. Phase 0 is the cheap path; bypass costs you more.
- **Manually setting `allowMainCheckout: true` to silence the hook** — habit-forming and erodes the gate. Either start a worktree, or document the genuine reason in the task body.
- **Deleting a worktree with `git worktree remove --force` while uncommitted changes exist** — discards real work. The `ExitWorktree` tool's refusal is the safety net; don't bypass it without inspecting first.
- **Two worktrees on the same feature branch** — git refuses this (one branch can only be checked out in one place). If you need parallel investigation of the same branch, use named sessions (`/resume`) instead.
- **Worktrees stacked under each other** — e.g. running `EnterWorktree` from inside another worktree. The tool refuses. Exit first, then create the next.
- **Treating worktrees as long-lived branches** — they're per-task disposable workspaces. After the PR merges, the worktree should be removed. Stale worktrees accumulate disk usage and confuse `git worktree list` reasoning.

## Migrating an existing in-flight branch

You may be on a long-running feature branch (created before this rule) and want to keep it on the main checkout. Two paths:

**Option A — opt out for this branch only** (lowest friction, but not future-proof):

1. Add `"allowMainCheckout": true` to `.claude/active-task.json`
2. Note the reason in the linked Monday task body
3. Continue editing in the main checkout
4. When this PR ships and the next task starts, `/pickup-task` Phase 0 will create a worktree for the next branch as normal

**Option B — move the branch into a worktree** (cleaner, recommended for long-lived work):

1. From the main checkout, with the branch checked out: commit or stash any in-flight changes
2. Switch the main checkout to `staging` (or wherever it should idle): `git checkout staging`
3. Create a worktree on the existing branch: `git worktree add .claude/worktrees/feat-<slug> feat/<slug>`
4. `EnterWorktree({ path: ".claude/worktrees/feat-<slug>" })` to switch the session into it
5. Apply any stashed changes inside the worktree

After Option B, the branch lives in the worktree, the main checkout is back on staging, and the hook is happy. Future `/pickup-task` invocations will spawn fresh worktrees alongside.

> **Important caveat for branches that predate this PR**: the
> `worktree-required.sh` hook ships *with* this PR. A branch that diverged
> before the merge does not contain the hook file or its `settings.json`
> registration, so the hook **does not fire** in a worktree of that branch
> until you merge `staging` into it (or rebase). This means Option B's
> protection only kicks in after the branch has caught up with `staging`.
> The migration sequence is then: catch up first, *then* move into a
> worktree, *then* benefit from the hook.

## Traceability: Monday task ↔ branch ↔ worktree path

The path of a worktree is fully derivable from the Monday task's Branch column —
no separate "Worktree path" column is needed. Convention (effective 2026-05-13):

```text
Monday Branch column (text_mm0pvs3n) → "feat/foo-bar"
Worktree path                        → ".claude/worktrees/feat-foo-bar"
Worktree branch                      → "feat/foo-bar" (same as Branch column)
```

**Derivation rule** (one line of bash):

```bash
worktree_path=".claude/worktrees/$(echo "$branch" | tr '/' '-')"
```

Used by:

- `.claude/scripts/find-worktree-for-task.sh` — give it a Monday task ID, get the worktree path. Reads the task's Branch column via `mcp__plugin_dev-tasks_dev-tasks__getTask` (or `gh api` against Monday), derives the path, exits.
- `.claude/scripts/worktree-audit.sh` — already cross-references via `.claude/active-task.json`; falls back to branch-name derivation when active-task.json is absent.
- `/pickup-task` Phase 10 — verifies the renamed worktree branch matches the worktree path slug.
- `/ship-pr` Phase 4 — sets the Branch column to the actual branch; downstream tooling derives the path.

**Why convention beats a dedicated column**:

- git enforces one-branch-one-worktree physically — multi-worktree-per-task is impossible at the git layer, so a "Worktree path" column couldn't represent anything the branch name can't.
- Branch column is already populated end-to-end (by `/ship-pr` Phase 4). Adding a separate column doubles the source-of-truth surface and creates sync risk.
- Zero ongoing maintenance cost: the rule is one line of bash.
- Forward-compat: if a future requirement needs multiple worktrees per task (unlikely; git refuses), the convention can be extended (e.g. `feat-foo-bar-2`); no MCP schema change needed.

**The reverse direction** (worktree → Monday task): read `.claude/active-task.json` from the worktree. `taskId` is the canonical link.

## Cleanup cadence (audit + remove stale worktrees)

`.claude/scripts/worktree-audit.sh` classifies every entry in `git worktree list` and (with `--remove`) deletes the DONE ones. Run it:

- **Post-merge** — whenever `/ship-pr` auto-merges or you manually merge a PR. `/ship-pr` Phase 10 already removes the active session's worktree; the audit catches worktrees from prior sessions that `/ship-pr` couldn't clean (closed-without-merge, abandoned branches, sessions interrupted before Phase 10).
- **Weekly** — as a housekeeping habit. Each stale worktree carries ~3-5 GB of `node_modules` + `.next` build artifacts; 10 stale trees = ~30 GB reclaimable.
- **Before starting a long autonomous run** — clean state avoids `git worktree add` collisions on similar branch names.

### Classification matrix

| Class | Branch state | Working tree | Has Monday active-task.json | Disposition |
|-------|--------------|--------------|------------------------------|-------------|
| **DONE** | Merged (direct OR squash-PR) | Clean | Either | Remove automatically with `--remove` |
| **IN-FLIGHT (dirty)** | Either | Dirty | Either | Preserve; agent should commit/stash or user reviews |
| **IN-FLIGHT (active task)** | Unmerged | Clean | Present | Preserve; in active development |
| **ABANDONED** | Unmerged | Clean | Absent | Flag for user decision |

### Escape hatches

- `git worktree remove --force <path>` — bypasses the dirty-tree refusal. Use when the dirty state is verified throwaway (untracked one-off scripts, etc.).
- `bash .claude/scripts/worktree-audit.sh --remove` — interactive prompt per tree. Use when reviewing a mixed bag.
- `bash .claude/scripts/worktree-audit.sh --remove -y` — assume-yes; bulk-removes all DONE worktrees without prompting.

### What the audit will NEVER remove

- The main checkout (`git worktree list` first entry).
- The currently-active worktree (the one the agent is running from). Detected via `git rev-parse --git-common-dir` vs `--git-dir` mismatch in the script.

## When this rule is loaded

- `/pickup-task` Phase 0 references it
- `/ship-pr` Phase 10 references it
- The worktree-audit script references it
- Anyone debugging a `worktree-required.sh` BLOCK message — the message links here

Not auto-loaded per file edit (it's workflow guidance, not per-file policy).
