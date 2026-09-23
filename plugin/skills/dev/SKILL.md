---
name: dev
description: Start work — branch, dev server, and the issue's description as context. No tracker writes.
user_invocable: true
---

# /dev — start work

`/dev [<issue id> | <free text>]`

The whole of the human start-of-work flow. It writes NOTHING to the tracker: no
claim, no status flip, no subtasks, no hours. The branch name is what links the
work to its issue, and CI's `Task trace` check is what enforces that a PR
carries one.

## Phase 0: where you are

Read `.claude/project-config.json` for `git.defaultBase` (default `staging`):

```bash
DEFAULT_BASE=$(jq -r '.git.defaultBase // "staging"' .claude/project-config.json 2>/dev/null)
```

Read the machine profile:

```bash
PROFILE=$(bash "${CLAUDE_PLUGIN_ROOT}/hooks/lib/profile.sh" get profile)
SURFACE=$(bash "${CLAUDE_PLUGIN_ROOT}/hooks/lib/profile.sh" get devSurface)
```

**Work in the MAIN checkout.** `worktree-required` and `worktree-path-boundary`
are agent-only, so on a human laptop nothing objects. Pass `--worktree` to opt
into one anyway (a second parallel change, or a long-running branch you want to
keep a server on); when passed, run `EnterWorktree({name: "<branch>"})` and
continue there.

## Phase 1: resolve the branch name

**With an issue id** (anything matching `STEP-<n>`, or a Monday item id while
`tracker.provider` is still `monday`):

```bash
npx tsx "${CLAUDE_PLUGIN_ROOT}/scripts/trackerctl.ts" branch "$REF"
```

That prints one line of JSON: `{"branch":"STEP-123-fix-the-thing","id":"STEP-123","title":"..."}`.
Use `branch` verbatim. The identifier in capitals is what makes Linear autolink
the branch and what `LINEAR_REF_RE` in the `Task trace` check matches.

**With free text**, there is no issue yet. Build `feat/<slug>` from the text,
and note that `/ship` will create the issue at PR time so the PR is traceable.

**With no argument at all**, stay on the current branch if it is not the base
branch; if it IS the base branch, ask what the work is rather than guessing.

## Phase 2: branch

```bash
git fetch origin
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
elif git show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
  git checkout -b "$BRANCH" --track "origin/$BRANCH"
else
  git checkout -b "$BRANCH" "origin/$DEFAULT_BASE"
fi
```

A branch that already exists — locally or remote-only — is resumed as-is.
Only a genuinely new name is cut from `origin/$DEFAULT_BASE`. Never reset
someone's work onto the base.

## Phase 3: load the issue as context

With an issue id, read it and put the description and acceptance criteria into
the session as context:

```bash
npx tsx "${CLAUDE_PLUGIN_ROOT}/scripts/trackerctl.ts" read "$REF"
```

Fields: `title`, `description`, `acceptanceCriteria`, `state`, `labels`, `url`.
Summarise the acceptance criteria back in two or three lines so the person can
correct a misreading before any code is written. Do not restate the whole
description.

## Phase 4: the dev server

```bash
pnpm dev
```

Run it in the background and print the local URL. If the project has no `dev`
script, say so and skip — this is a convenience, not a gate.

## Phase 5: hand off

- `devSurface: localhost` (the human default): stop here. The person iterates
  against localhost and runs `/preview` or `/ship` when ready.
- `devSurface: preview` (the agent default): continue straight into `/preview`,
  because there is no browser on that machine to point at localhost.

## What /dev deliberately does NOT do

- No `pnpm install` unless `node_modules` is absent. A reinstall on every start
  is minutes of nothing.
- No build, no lint, no test, no Playwright. CI owns all four (spec section 7).
- No tracker write of any kind. If you find yourself wanting one, the answer is
  `/ship`, which creates the issue when none is linked.
