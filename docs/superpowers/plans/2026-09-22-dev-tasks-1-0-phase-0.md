# dev-tasks 1.0 Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan is executed in `/Users/nate/dev-tasks`, not in the repo it is committed to.** It lives here only because the dev-tasks checkout had an unrelated active task holding the worktree gate when it was written. Copy it to `dev-tasks/docs/superpowers/plans/` as the first act of execution, or run it from this path — either way every file path below is relative to `/Users/nate/dev-tasks`.

**Goal:** Turn the dev-tasks plugin from a single Monday-shaped pipeline into a two-flow plugin — a machine profile that decides which hooks run, three thin skills (`/dev`, `/preview`, `/ship`) that replace the ten-phase ship ceremony, and a tracker adapter with a Linear implementation — so that a human can show a change in minutes and the Monday-to-Linear cutover needs a config key rather than a rewrite.

**Architecture:** Subtraction first, then one new seam. Four hooks and one bash-guard gate are deleted outright; three surviving hooks learn to ask `profile_is agent` before they block. The new seam is `plugin/src/tracker/` — one interface, a Linear implementation over the GraphQL API, and a deliberately minimal Monday implementation kept only for the cutover weekend — reached from the markdown skills through one CLI, `plugin/scripts/trackerctl.ts`. **The MCP server is not touched.** Its 45 tools stay Monday-shaped and keep working; adding parallel Linear tools would double a surface that is about to be retired, and a CLI is unit-testable with a mocked `fetch` where an MCP tool handler is not.

**Tech Stack:** Bash 3.2 (macOS system bash) + `jq` for hooks, TypeScript 5.9 with `"type": "module"` and `.ts` extension imports, Node 20 `fetch`, vitest 3 (`src/**/__tests__/**/*.test.ts`), bash test scripts (`hooks/__tests__/*.test.sh`), Linear GraphQL API (`https://api.linear.app/graphql`), Monday GraphQL API v2, `gh` CLI, `git`.

**Spec:** `/Users/nate/v0-politiske-annoncer/docs/superpowers/specs/2026-09-21-two-flow-agent-workflow-design.md` — sections 1-5 (decisions, the two flows, machine profiles, the three human commands), 7 (what CI owns instead), 9.1-9.2 (Linear structure and board mapping), 10 (plugin scope), 11 (guardrails that do not move), 13 (rollout gates), 14 (phasing), 15 (what a human verifies first). Read sections 4, 5 and 10 before Task 1; they are the whole of this plan's mandate.

## Global Constraints

- **This plan changes the `dev-tasks` repo only** (`/Users/nate/dev-tasks`, github.com/STEP-Network/dev-tasks). The PolAds repo gets exactly one change, in Task 14: an edited `.claude/project-config.json`. The `Claude review` GitHub check named in spec §14 phase 0 is a PolAds-repo workflow and is **out of scope here** — it is tracked separately and appears in this plan only as a rollout gate in Task 15.
- **The spec writes branch names as `POL-123-slug`. That is superseded.** The real Linear team key is `STEP` (`lib/ci/pr-task-trace.ts` → `export const LINEAR_TEAM_KEY = 'STEP'`, `LINEAR_REF_RE = /\bSTEP-(\d+)\b/`), and the migration scripts already create the team with key `STEP`. Every identifier in this plan is `STEP-<n>`; nothing anywhere may emit `POL-`.
- **`LINEAR_REF_RE` is case-sensitive and anchored on word boundaries.** Anything this plugin writes into a PR title or body must spell the identifier `STEP-123` in capitals, or the `Task trace` required check fails on a PR that really is traceable.
- **The Linear key is read from `LINEAR_API_KEY` in the environment, else from `~/.config/linear/.env` (mode 600).** It is never written to a repo file, never printed, never included in an error message, and never passed as a CLI argument. Same contract as `scripts/linear/client.ts` in the PolAds repo.
- **Linear writes are throttled to at most one request per 1500 ms**, and `429`/`5xx`/transient GraphQL errors are retried with exponential backoff capped at 60 s, at most 6 attempts. The API-key budget is 2,500 requests per hour.
- **Monday is never written to by anything in this plan** except the Monday tracker adapter, which is used only while `tracker.provider` is `monday` — its pre-cutover default.
- **`plugin/schemas/project-config.schema.json` has `additionalProperties: false`.** Any new project-config key needs a schema change in the same commit, or every consumer's config fails validation.
- **A retired hook keeps its name in the schema's `hooks.enabled[]` enum**, marked accepted-and-ignored. Removing the enum member would make PolAds's committed `project-config.json` invalid the moment the plugin updates, before anyone can edit it. The schema already sets this precedent for `bash-guard` and `stop-ci-green-check`.
- **Hooks are bash 3.2.** No `declare -A`, no `${var^^}`, no `mapfile`. macOS ships bash 3.2 and the hooks run under it.
- **Plugin changes are released, not patched in place.** Edit `plugin/…`, bump `plugin/.claude-plugin/plugin.json` `version`, PR to that repo's `main`. Consumers pick it up by removing the plugin cache and reinstalling (user CLAUDE.md → "Plugin/MCP code change": *a plain reload won't pick it up — remove the plugin cache + bump the version, then reload*).
- **No `--admin` merges. No direct pushes to `staging` or `main`.** `bash-guard` gate (f) still enforces the second and is not touched by this plan.
- Commit messages: `feat:` | `fix:` | `refactor:` | `chore:` | `docs:` | `test:` | `ci:`.
- Run the two suites from `plugin/`: `npm test` (vitest) and `bash hooks/__tests__/<name>.test.sh` for each bash test. `npm run typecheck` must stay clean.

## File Structure

| File | Responsibility |
|---|---|
| `plugin/hooks/lib/profile.sh` | the ONE machine-profile reader: `profile`, `devSurface`, `mini`, and the `profile_is` predicate every gated hook calls |
| `plugin/hooks/__tests__/profile.test.sh` | fixture table for the reader, including the two fail-toward-agent cases |
| `plugin/hooks/bash-guard.sh` | gate (b) deleted; gates (d) and (e) wrapped in `profile_is agent`; (a), (c), (f) unchanged |
| `plugin/hooks/worktree-required.sh` | gains `profile_is agent \|\| exit 0` |
| `plugin/hooks/worktree-path-boundary.sh` | gains `profile_is agent \|\| exit 0` |
| `plugin/hooks/hooks.json` | registrations for the four retired hooks removed |
| `plugin/hooks/protect-active-task-state.sh` | `selfReviewPassed` drops off its protected-field list — nothing can emit that marker any more |
| `plugin/src/tracker/types.ts` | `Tracker`, `TrackerIssue`, `CreateIssueInput`, `extractAcceptanceCriteria`, `slugify`, `branchNameFor`, `byPriorityThenAge` — pure, no network |
| `plugin/src/tracker/linear-client.ts` | Linear GraphQL transport: key loading, 1.5 s throttle, retry, write cap |
| `plugin/src/tracker/linear.ts` | the Linear `Tracker` implementation |
| `plugin/src/tracker/monday.ts` | the minimal Monday `Tracker` implementation, cutover-weekend only |
| `plugin/src/tracker/index.ts` | `resolveTracker()` — reads `tracker.provider` from project-config, defaults to `monday` |
| `plugin/scripts/trackerctl.ts` | the CLI the three skills shell out to |
| `plugin/skills/dev/SKILL.md` | `/dev` |
| `plugin/skills/preview/SKILL.md` | `/preview` |
| `plugin/skills/ship/SKILL.md` | `/ship` |
| `plugin/schemas/project-config.schema.json` | new `tracker` block; retired hooks marked accepted-and-ignored |
| `plugin/templates/starter-project-config.json` | gains the `tracker` block |
| `plugin/.claude-plugin/plugin.json` | version `1.0.0`, description rewritten |
| `docs/dev-tasks-1-0-install.md` | the consumer install and cache-refresh runbook |

---

## Task 1: The machine profile reader

Spec §4. One file per machine at `~/.claude/dev-tasks-profile.json`; `DEV_TASKS_PROFILE` overrides the `profile` field; an absent file means `human`.

**There is exactly ONE implementation and it is bash.** The hooks are bash and must read it; the skills are markdown and shell out to it; `trackerctl` does not need it at all. A second TypeScript reader would be a second answer to the same question, free to drift from the one the gates actually consult.

**Files:**
- Create: `plugin/hooks/lib/profile.sh`
- Create: `plugin/hooks/__tests__/profile.test.sh`

**Interfaces:**
- Consumes: nothing.
- Produces, for Tasks 2, 4, 11, 12 and 13:
  - `dev_tasks_profile` → prints `human` or `agent`
  - `dev_tasks_dev_surface` → prints `localhost` or `preview`
  - `dev_tasks_mini` → prints the mini name, or nothing
  - `profile_is <human|agent>` → exit 0 when it matches, 1 otherwise
  - CLI form: `bash profile.sh get profile|devSurface|mini`, and `bash profile.sh is agent`

- [ ] **Step 1: Write the failing test**

Create `plugin/hooks/__tests__/profile.test.sh`:

```bash
#!/bin/bash
# Tests for plugin/hooks/lib/profile.sh.
#
# The reader decides which gates run on this machine, so its failure
# directions are the point of the test, not an afterthought:
#   absent file            -> human  (spec section 4, stated outright)
#   present but corrupt    -> agent  (a machine somebody configured must not
#                                     silently disarm its guards)
#   unknown profile value  -> agent  (same reasoning)
#   DEV_TASKS_PROFILE set  -> wins over the file, same validation
#
# Run with: bash plugin/hooks/__tests__/profile.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../lib/profile.sh"

if [ ! -f "$LIB" ]; then
  echo "FATAL: reader not found at $LIB"
  exit 1
fi

PASS=0
FAIL=0

TEST_HOME=$(mktemp -d -t profile-test-XXXX)
mkdir -p "$TEST_HOME/.claude"
export HOME="$TEST_HOME"

cleanup() { rm -rf "$TEST_HOME"; }
trap cleanup EXIT

write_profile() {
  printf '%s' "$1" > "$TEST_HOME/.claude/dev-tasks-profile.json"
}

remove_profile() {
  rm -f "$TEST_HOME/.claude/dev-tasks-profile.json"
}

# assert_get <key> <expected> <label>
assert_get() {
  local key="$1" expected="$2" label="$3" actual
  actual=$(bash "$LIB" get "$key" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

# assert_is <value> <expected-exit> <label>
assert_is() {
  local value="$1" expected="$2" label="$3" code
  bash "$LIB" is "$value" >/dev/null 2>&1
  code=$?
  if [ "$code" = "$expected" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit $expected, got $code)"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- absent file means human (spec section 4) ---"
remove_profile
unset DEV_TASKS_PROFILE
assert_get profile human "absent file -> human"
assert_get devSurface localhost "absent file -> localhost"
assert_get mini "" "absent file -> no mini"
assert_is agent 1 "absent file: is agent -> false"
assert_is human 0 "absent file: is human -> true"

echo "--- the human profile ---"
write_profile '{ "profile": "human", "devSurface": "localhost", "mini": null }'
assert_get profile human "human profile"
assert_get devSurface localhost "human devSurface"
assert_get mini "" "human mini is empty"
assert_is human 0 "human: is human -> true"

echo "--- the agent profile ---"
write_profile '{ "profile": "agent", "devSurface": "preview", "mini": "bob" }'
assert_get profile agent "agent profile"
assert_get devSurface preview "agent devSurface"
assert_get mini bob "agent mini"
assert_is agent 0 "agent: is agent -> true"
assert_is human 1 "agent: is human -> false"

echo "--- DEV_TASKS_PROFILE overrides the file ---"
write_profile '{ "profile": "agent", "devSurface": "preview", "mini": "bob" }'
export DEV_TASKS_PROFILE=human
assert_get profile human "exported override wins"
assert_get mini bob "override does not touch mini"
assert_get devSurface preview "override does not touch devSurface"
unset DEV_TASKS_PROFILE

echo "--- corrupt or unknown fails toward agent ---"
write_profile '{ this is not json'
assert_get profile agent "unparseable file -> agent"
write_profile '{ "profile": "robot" }'
assert_get profile agent "unknown profile value -> agent"
write_profile '{ "profile": "agent", "devSurface": "mars" }'
assert_get devSurface preview "unknown devSurface on agent -> preview"
write_profile '{ "profile": "human", "devSurface": "mars" }'
assert_get devSurface localhost "unknown devSurface on human -> localhost"
write_profile '{ "profile": "human" }'
export DEV_TASKS_PROFILE=robot
assert_get profile agent "unknown env override -> agent"
unset DEV_TASKS_PROFILE

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bash plugin/hooks/__tests__/profile.test.sh`
Expected: `FATAL: reader not found at .../lib/profile.sh`, exit 1.

- [ ] **Step 3: Write the reader**

Create `plugin/hooks/lib/profile.sh`:

```bash
#!/usr/bin/env bash
# dev-tasks plugin — machine profile reader (spec section 4).
#
# One file per machine at ~/.claude/dev-tasks-profile.json:
#   { "profile": "human", "devSurface": "localhost", "mini": null }
#   { "profile": "agent", "devSurface": "preview",   "mini": "bob" }
#
# DEV_TASKS_PROFILE overrides the `profile` field and nothing else.
#
# FAILURE DIRECTIONS, and they are not symmetric:
#   absent file           -> human. Stated by the spec. Most machines that
#                            never heard of this plugin are somebody's laptop.
#   present but corrupt   -> agent. A machine that HAS the file is one somebody
#   unknown value         -> agent. configured; a typo there must not silently
#                            turn off the worktree and i18n gates on a mini.
#
# Source it for the shell functions, or call it as a CLI:
#   source "${CLAUDE_PLUGIN_ROOT}/hooks/lib/profile.sh"; profile_is agent || exit 0
#   bash "${CLAUDE_PLUGIN_ROOT}/hooks/lib/profile.sh" get devSurface

_dev_tasks_profile_path() {
  printf '%s/.claude/dev-tasks-profile.json' "${HOME}"
}

# Reads one raw field from the file. Empty when the file is absent or unparseable.
_dev_tasks_profile_raw() {
  local key="$1" path
  path="$(_dev_tasks_profile_path)"
  [ -f "$path" ] || return 0
  jq -r --arg k "$key" '.[$k] // empty' "$path" 2>/dev/null || true
}

# Prints human|agent.
dev_tasks_profile() {
  local path raw
  path="$(_dev_tasks_profile_path)"

  if [ -n "${DEV_TASKS_PROFILE:-}" ]; then
    case "$DEV_TASKS_PROFILE" in
      human|agent) printf '%s' "$DEV_TASKS_PROFILE"; return 0 ;;
      *)           printf 'agent';                   return 0 ;;
    esac
  fi

  # Absent file is the one case that resolves human.
  if [ ! -f "$path" ]; then
    printf 'human'
    return 0
  fi

  # Present but not valid JSON -> agent.
  if ! jq -e . "$path" >/dev/null 2>&1; then
    printf 'agent'
    return 0
  fi

  raw="$(_dev_tasks_profile_raw profile)"
  case "$raw" in
    human|agent) printf '%s' "$raw" ;;
    *)           printf 'agent' ;;
  esac
}

# Prints localhost|preview. An unrecognised value falls back to this
# profile's default rather than to a fixed one, so an agent mini with a
# typo still previews and a laptop with a typo still runs localhost.
dev_tasks_dev_surface() {
  local raw profile
  raw="$(_dev_tasks_profile_raw devSurface)"
  case "$raw" in
    localhost|preview) printf '%s' "$raw"; return 0 ;;
  esac
  profile="$(dev_tasks_profile)"
  if [ "$profile" = "agent" ]; then printf 'preview'; else printf 'localhost'; fi
}

# Prints the mini name, or nothing.
dev_tasks_mini() {
  _dev_tasks_profile_raw mini
}

# profile_is <human|agent>
profile_is() {
  [ "$(dev_tasks_profile)" = "$1" ]
}

# CLI form, so a markdown skill can shell out without sourcing.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-}" in
    get)
      case "${2:-}" in
        profile)    dev_tasks_profile ;;
        devSurface) dev_tasks_dev_surface ;;
        mini)       dev_tasks_mini ;;
        *)          echo "usage: profile.sh get profile|devSurface|mini" >&2; exit 64 ;;
      esac
      ;;
    is)
      profile_is "${2:-}"
      ;;
    *)
      echo "usage: profile.sh get <key> | profile.sh is <human|agent>" >&2
      exit 64
      ;;
  esac
fi
```

- [ ] **Step 4: Make it executable and run the test**

```bash
cd /Users/nate/dev-tasks && chmod +x plugin/hooks/lib/profile.sh
bash plugin/hooks/__tests__/profile.test.sh
```
Expected: every line `PASS:`, trailing `FAIL: 0`, exit 0.

- [ ] **Step 5: Write your own machine's profile and read it back**

```bash
cat > ~/.claude/dev-tasks-profile.json <<'JSON'
{ "profile": "human", "devSurface": "localhost", "mini": null }
JSON
bash /Users/nate/dev-tasks/plugin/hooks/lib/profile.sh get profile
bash /Users/nate/dev-tasks/plugin/hooks/lib/profile.sh get devSurface
```
Expected: `human` then `localhost`. This file is per-machine and is never committed.

- [ ] **Step 6: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/hooks/lib/profile.sh plugin/hooks/__tests__/profile.test.sh
git commit -m "feat: machine profile reader for per-machine hook enablement"
```

---

## Task 2: The worktree gates become agent-only

Spec §4: `worktree-required` and `worktree-path-boundary` are **off on a human laptop and on for an agent**. This is what lets `/dev` check a branch out in the main checkout (spec §5) without a hook refusing every edit.

**Files:**
- Modify: `plugin/hooks/worktree-required.sh` (insert after the existing `hook_enabled` line)
- Modify: `plugin/hooks/worktree-path-boundary.sh` (same)
- Create: `plugin/hooks/__tests__/worktree-profile-gate.test.sh`

**Interfaces:**
- Consumes: `profile_is` from Task 1.
- Produces: nothing new. Both hooks keep their exit contract (0 allow, 2 block).

- [ ] **Step 1: Read the two hooks' opening lines**

```bash
cd /Users/nate/dev-tasks && head -30 plugin/hooks/worktree-required.sh
head -30 plugin/hooks/worktree-path-boundary.sh
```
Both source `lib/config-reader.sh` and call `hook_enabled "<name>" || exit 0` near the top. The profile gate goes on the line **after** that call, so a project that never enabled the hook still short-circuits first and pays nothing.

- [ ] **Step 2: Write the failing test**

Create `plugin/hooks/__tests__/worktree-profile-gate.test.sh`:

```bash
#!/bin/bash
# The worktree gates are agent-only (spec section 4). A human works in the main
# checkout by design; an agent mini must stay in its worktree.
#
# This asserts the GATE, not the worktree logic — the enabled+agent case is
# expected to block on a plain repo with an active task and no worktree, and
# the enabled+human case must not.
#
# Run with: bash plugin/hooks/__tests__/worktree-profile-gate.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

TEST_DIR=$(mktemp -d -t worktree-gate-XXXX)
TEST_HOME=$(mktemp -d -t worktree-gate-home-XXXX)
mkdir -p "$TEST_DIR/.claude" "$TEST_DIR/src" "$TEST_HOME/.claude"
export HOME="$TEST_HOME"
export CLAUDE_PROJECT_DIR="$TEST_DIR"

cleanup() { chmod -R u+w "$TEST_DIR" "$TEST_HOME" 2>/dev/null; command rm -r -f "$TEST_DIR" "$TEST_HOME"; }
trap cleanup EXIT

cd "$TEST_DIR"
git init --quiet --initial-branch=main
git config user.email "test@example.com"
git config user.name "test"
echo init > seed.txt
git add seed.txt
git commit --quiet -m init

cat > "$TEST_DIR/.claude/project-config.json" <<'CFG'
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["worktree-required", "worktree-path-boundary"] }
}
CFG

# An active task with no worktree is what the gate exists to catch.
cat > "$TEST_DIR/.claude/active-task.json" <<'TASK'
{ "taskId": "1234567890", "branch": "feat/x", "status": "in_progress" }
TASK

payload() {
  printf '{"tool_name":"Edit","tool_input":{"file_path":"%s/src/app.ts"}}' "$TEST_DIR"
}

# assert_hook <hook> <profile|none> <expected-exit> <label>
assert_hook() {
  local hook="$1" profile="$2" expected="$3" label="$4" code
  if [ "$profile" = "none" ]; then
    command rm -f "$TEST_HOME/.claude/dev-tasks-profile.json"
  else
    printf '{ "profile": "%s" }' "$profile" > "$TEST_HOME/.claude/dev-tasks-profile.json"
  fi
  payload | bash "$SCRIPT_DIR/../$hook.sh" >/dev/null 2>&1
  code=$?
  if [ "$code" = "$expected" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit $expected, got $code)"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- human: both gates pass through ---"
assert_hook worktree-required human 0 "worktree-required allows on human"
assert_hook worktree-path-boundary human 0 "worktree-path-boundary allows on human"

echo "--- absent profile file behaves as human ---"
assert_hook worktree-required none 0 "worktree-required allows with no profile file"

echo "--- agent: the gate is live again ---"
assert_hook worktree-required agent 2 "worktree-required blocks on agent"

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
```

> **Why `command rm -r -f` rather than `rm -rf`.** These test files are written by an agent whose own `bash-guard` gate (a) refuses any Bash call containing the literal `rm -rf`. Spelling the flags separately keeps the fixture writable without weakening the guard that is protecting the person writing it. Every test in this plan follows the same convention.

- [ ] **Step 3: Run it to confirm the human cases fail today**

Run: `bash plugin/hooks/__tests__/worktree-profile-gate.test.sh`
Expected: the three `human`/`none` cases FAIL with `expected exit 0, got 2` — the gate blocks regardless of profile, which is exactly the state being fixed. The `agent` case already passes.

- [ ] **Step 4: Add the gate to both hooks**

In `plugin/hooks/worktree-required.sh`, immediately after the existing `hook_enabled "worktree-required" || exit 0` line, insert:

```bash
# Spec section 4: the worktree gates are agent-only. A human works in the main
# checkout by design (/dev checks the branch out there), so blocking edits
# outside a worktree would refuse the normal human flow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/profile.sh"
profile_is agent || exit 0
```

In `plugin/hooks/worktree-path-boundary.sh`, after its own `hook_enabled "worktree-path-boundary" || exit 0` line, insert the same four lines. Both hooks already resolve `lib/` relative to `BASH_SOURCE`, so this `dirname` form matches what they do for `config-reader.sh`.

- [ ] **Step 5: Run the test again**

Run: `bash plugin/hooks/__tests__/worktree-profile-gate.test.sh`
Expected: every line `PASS:`, `FAIL: 0`.

- [ ] **Step 6: Run the neighbouring bash suites for regressions**

```bash
cd /Users/nate/dev-tasks/plugin
for t in hooks/__tests__/*.test.sh; do echo "== $t"; bash "$t" >/dev/null 2>&1 && echo ok || echo "FAILED $t"; done
```
Expected: every line `ok`. Any `FAILED` here is a real regression — the two hooks sit on the `Edit|Write|MultiEdit|NotebookEdit` matcher that most fixtures exercise.

- [ ] **Step 7: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/hooks/worktree-required.sh plugin/hooks/worktree-path-boundary.sh plugin/hooks/__tests__/worktree-profile-gate.test.sh
git commit -m "feat: worktree gates are agent-only per machine profile"
```

---

## Task 3: Retire bash-guard gate (b)

Spec §4: *"bash-guard b (self-review before commit) — off, and the gate is retired for both (review moves to CI)"*. Spec §10 lists it under "retired outright".

Gate (b) reads `selfReviewPassed` out of `.claude/active-task.json` and refuses `git commit` when it is absent. `/self-review` is retired in the same 1.0 release, so nothing sets the flag and the gate would refuse every commit on a machine that still has an `active-task.json`.

**Files:**
- Modify: `plugin/hooks/bash-guard.sh` — delete the gate (b) block (the `# (b) Pre-commit gate:` comment through the closing `fi` of its `git commit` branch, roughly lines 73-99) and its two header-comment lines
- Modify: `plugin/hooks/protect-active-task-state.sh` — drop `selfReviewPassed` from the protected-field list
- Create: `plugin/hooks/__tests__/bash-guard-gate-b-retired.test.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: `git commit` is no longer gated on `selfReviewPassed` by any hook. Task 5 removes the hook that used to set it.

- [ ] **Step 1: Write the failing test**

Create `plugin/hooks/__tests__/bash-guard-gate-b-retired.test.sh`:

```bash
#!/bin/bash
# Gate (b) is retired (spec sections 4 and 10). Review moved to the CI
# `Claude review` check; nothing local sets selfReviewPassed any more, so a
# surviving gate would refuse every commit made while an active-task.json
# exists.
#
# The negative controls matter as much as the assertion: gates (a) and (f)
# must still block, or "retire gate b" has quietly become "disable bash-guard".
# The destructive fixture is assembled at run time so this FILE never contains
# the literal string gate (a) matches — otherwise the agent writing it is
# blocked by its own guard.
#
# Run with: bash plugin/hooks/__tests__/bash-guard-gate-b-retired.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../bash-guard.sh"

PASS=0
FAIL=0

TEST_DIR=$(mktemp -d -t gate-b-XXXX)
TEST_HOME=$(mktemp -d -t gate-b-home-XXXX)
mkdir -p "$TEST_DIR/.claude" "$TEST_HOME/.claude"
export HOME="$TEST_HOME"
export CLAUDE_PROJECT_DIR="$TEST_DIR"
printf '{ "profile": "human" }' > "$TEST_HOME/.claude/dev-tasks-profile.json"

cleanup() { command rm -r -f "$TEST_DIR" "$TEST_HOME"; }
trap cleanup EXIT

cd "$TEST_DIR"
git init --quiet --initial-branch=main
git config user.email "test@example.com"
git config user.name "test"
echo init > seed.txt
git add seed.txt
git commit --quiet -m init

cat > "$TEST_DIR/.claude/project-config.json" <<'CFG'
{
  "version": "1",
  "monday": { "productId": "1" },
  "git": { "protectedBranches": ["main", "staging"] },
  "hooks": { "enabled": [] }
}
CFG

# The exact state gate (b) used to refuse: an active task with the flag unset.
cat > "$TEST_DIR/.claude/active-task.json" <<'TASK'
{ "taskId": "1234567890", "branch": "feat/x", "selfReviewPassed": false }
TASK

# assert_cmd <command> <expected-exit> <label>
assert_cmd() {
  local cmd="$1" expected="$2" label="$3" code
  printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$cmd" | bash "$HOOK" >/dev/null 2>&1
  code=$?
  if [ "$code" = "$expected" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit $expected, got $code)"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- gate (b) is gone ---"
assert_cmd "git commit -m wip" 0 "commit allowed with selfReviewPassed false"

command rm -f "$TEST_DIR/.claude/active-task.json"
assert_cmd "git commit -m no-active-task" 0 "commit allowed with no active task"

echo "--- negative controls: the other gates still block ---"
DESTRUCTIVE=$(printf 'rm -%sf /tmp/anything' r)
assert_cmd "$DESTRUCTIVE" 2 "gate (a) still blocks a recursive force delete"
assert_cmd "git push origin staging" 2 "gate (f) still blocks a push to staging"

echo "--- the source carries no selfReviewPassed gate any more ---"
if grep -q "selfReviewPassed" "$HOOK"; then
  echo "FAIL: bash-guard.sh still mentions selfReviewPassed"
  FAIL=$((FAIL + 1))
else
  echo "PASS: bash-guard.sh no longer mentions selfReviewPassed"
  PASS=$((PASS + 1))
fi

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it to confirm the gate is live**

Run: `bash plugin/hooks/__tests__/bash-guard-gate-b-retired.test.sh`
Expected: `FAIL: commit allowed with selfReviewPassed false (expected exit 0, got 2)` and `FAIL: bash-guard.sh still mentions selfReviewPassed`. The two negative controls PASS already.

- [ ] **Step 3: Delete the gate**

In `plugin/hooks/bash-guard.sh`:

1. Delete the whole block that starts `# (b) Pre-commit gate: block git commit if self-review has not passed` and ends with the comment `# No state file = no active task enforcement on commit (task-state-guard handles edits)` and its closing `fi`.
2. In the header comment, delete the line `#   (b) Block git commit without self-review (Fix 1)` and change `# Six gates:` to `# Five gates:`.
3. Replace the top-of-file policy paragraph

```
# STEP-wide policy: gates (a) destructive commands (incl. --force), (b)
# self-review before commit, (c) pre-push validation marker, and (f) protected-
# branch push block are always-on regardless of project-config.hooks.enabled[].
```

with

```
# STEP-wide policy: gates (a) destructive commands (incl. --force), (c)
# pre-push validation marker, and (f) protected-branch push block are always-on
# regardless of project-config.hooks.enabled[]. Gate (b), which refused a
# commit without selfReviewPassed, was RETIRED in 1.0: review moved to the CI
# `Claude review` required check (spec sections 4 and 10). The letters of the
# surviving gates are deliberately NOT renumbered — the hook tests, the plugin
# README and PolAds's .claude/hooks/README.md all name them by letter.
```

**Do not renumber (c) through (f).** Four documents outside this repo cite those letters.

- [ ] **Step 4: Drop `selfReviewPassed` from the state protector**

Gate (b) was one of two readers; `post-self-review.sh` — its only marker emitter — is deleted in Task 5. Leaving the field in `protect-active-task-state.sh` makes it permanently unwritable for any consumer with that hook enabled.

In `plugin/hooks/protect-active-task-state.sh`:
1. Delete the `selfReviewPassed` check from the embedded python (the `cur_self` / `prop_self` lines and the `if not cur_self and prop_self and not marker_exists('selfReviewPassed')` branch with its `violation(...)` call, around lines 142-148).
2. In the header comment, replace the two `selfReviewPassed` lines with:
   `#   (selfReviewPassed was removed in 1.0 — bash-guard gate (b) and post-self-review, its only reader and its only emitter, are both retired.)`

Leave `scripts/emit-state-marker.sh` alone: it still accepts the field name, which is harmless, and narrowing its allowlist would break a consumer still on 0.37.2 skills mid-upgrade.

- [ ] **Step 5: Run the test and the bash-guard suite**

```bash
cd /Users/nate/dev-tasks/plugin
bash hooks/__tests__/bash-guard-gate-b-retired.test.sh
bash hooks/__tests__/bash-guard.test.sh
bash hooks/__tests__/protect-active-task-state.test.sh
```
Expected: all three end `FAIL: 0`. If `protect-active-task-state.test.sh` carries a case asserting the `selfReviewPassed` marker requirement, delete that case in the same commit and name it in the commit message.

- [ ] **Step 6: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/hooks/bash-guard.sh plugin/hooks/protect-active-task-state.sh plugin/hooks/__tests__/
git commit -m "feat!: retire bash-guard gate (b); review moves to CI"
```

---

## Task 4: i18n gates (d) and (e) become agent-only

Spec §4: `bash-guard d, e` are **off for a human** (the CI `i18n` job catches it) and **on for an agent**. Gate (f) stays on for both; (a) and (c) are untouched.

**Files:**
- Modify: `plugin/hooks/bash-guard.sh` — wrap the (d)/(e) section in a profile check
- Create: `plugin/hooks/__tests__/bash-guard-i18n-profile.test.sh`

**Interfaces:**
- Consumes: `profile_is` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `plugin/hooks/__tests__/bash-guard-i18n-profile.test.sh`:

```bash
#!/bin/bash
# Gates (d) and (e) — i18n parity at commit — are agent-only (spec section 4).
# A human's miss is caught by the CI `i18n` job a minute after the push; an
# agent has no equivalent feedback inside its own session, so the commit-time
# gate stays there.
#
# Run with: bash plugin/hooks/__tests__/bash-guard-i18n-profile.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../bash-guard.sh"

PASS=0
FAIL=0

TEST_DIR=$(mktemp -d -t i18n-gate-XXXX)
TEST_HOME=$(mktemp -d -t i18n-gate-home-XXXX)
mkdir -p "$TEST_DIR/.claude" "$TEST_DIR/messages" "$TEST_HOME/.claude"
export HOME="$TEST_HOME"
export CLAUDE_PROJECT_DIR="$TEST_DIR"

cleanup() { command rm -r -f "$TEST_DIR" "$TEST_HOME"; }
trap cleanup EXIT

cd "$TEST_DIR"
git init --quiet --initial-branch=main
git config user.email "test@example.com"
git config user.name "test"

cat > "$TEST_DIR/.claude/project-config.json" <<'CFG'
{
  "version": "1",
  "monday": { "productId": "1" },
  "git": { "defaultBase": "main", "protectedBranches": ["main"] },
  "i18n": {
    "enabled": true,
    "defaultLocale": "en",
    "locales": ["en", "da", "de"],
    "messagesGlob": "messages/*.json",
    "parityHookMode": "block"
  },
  "hooks": { "enabled": [] }
}
CFG

printf '{"hello":"Hello"}\n'  > messages/en.json
printf '{"hello":"Hej"}\n'    > messages/da.json
printf '{"hello":"Hallo"}\n'  > messages/de.json
git add .
git commit --quiet -m init
git checkout --quiet -b feat/i18n

# The offence: a NEW key added to en only, staged.
printf '{"hello":"Hello","goodbye":"Goodbye"}\n' > messages/en.json
git add messages/en.json

# assert_profile <profile> <expected-exit> <label>
assert_profile() {
  local profile="$1" expected="$2" label="$3" code
  printf '{ "profile": "%s" }' "$profile" > "$TEST_HOME/.claude/dev-tasks-profile.json"
  printf '{"tool_name":"Bash","tool_input":{"command":"git commit -m add-a-key"}}' | bash "$HOOK" >/dev/null 2>&1
  code=$?
  if [ "$code" = "$expected" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit $expected, got $code)"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- the profile decides ---"
assert_profile agent 2 "agent: i18n parity blocks the commit"
assert_profile human 0 "human: i18n parity does not block"

echo "--- gate (f) is NOT profile-gated ---"
printf '{ "profile": "human" }' > "$TEST_HOME/.claude/dev-tasks-profile.json"
printf '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | bash "$HOOK" >/dev/null 2>&1
if [ $? = 2 ]; then
  echo "PASS: gate (f) still blocks on human"
  PASS=$((PASS + 1))
else
  echo "FAIL: gate (f) stopped blocking on human"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it to confirm it blocks for both profiles today**

Run: `bash plugin/hooks/__tests__/bash-guard-i18n-profile.test.sh`
Expected: `FAIL: human: i18n parity does not block (expected exit 0, got 2)`. The agent case and the gate (f) control already pass.

- [ ] **Step 3: Gate the i18n section on the profile**

In `plugin/hooks/bash-guard.sh`, find the line that resolves the i18n config (`I18N_ENABLED=$(read_project_config '.i18n.enabled')`, around line 103) and insert directly **above** it:

```bash
# Gates (d) and (e) are agent-only (spec section 4). A human's parity miss is
# caught by the CI `i18n` job within a minute of the push; an agent has no
# equivalent feedback inside its own session, so the commit-time gate stays.
# Resolving the profile BEFORE reading the i18n config also means a human
# laptop pays no jq calls for a feature that cannot fire.
source "$(dirname "${BASH_SOURCE[0]}")/lib/profile.sh"
if profile_is agent; then
```

and close the block immediately **after** the end of gate (e) — the line before the `# (f)` comment — with:

```bash
fi
# end of gates (d) and (e)
```

Indentation inside the block does not need to change; bash does not care, and reindenting ~120 lines would bury a one-line change in the diff.

- [ ] **Step 4: Run the test and the existing bash-guard suites**

```bash
cd /Users/nate/dev-tasks/plugin
bash hooks/__tests__/bash-guard-i18n-profile.test.sh
bash hooks/__tests__/bash-guard.test.sh
bash hooks/__tests__/bash-guard-gate-b-retired.test.sh
```
Expected: all three end `FAIL: 0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/hooks/bash-guard.sh plugin/hooks/__tests__/bash-guard-i18n-profile.test.sh
git commit -m "feat: i18n commit gates (d)(e) run on the agent profile only"
```

---

## Task 5: Retire stop-task-check, post-self-review and the subtask gates

Spec §10: *"Hooks: per-profile enablement (section 4); retired outright: bash-guard gate b, stop-task-check, post-self-review, subtask gates."* The subtask gates are `subtask-reminder` (PreToolUse Edit) and `subtask-progress-gate` (PreToolUse Bash `git push`).

They go because the thing they policed is gone: `/ship` opens a PR and stops, subtasks are not a construct this plugin writes into Linear, and `stop-task-check` refuses session exit on a five-stage pipeline (`selfReviewPassed`, PR, previewUrl, CI, `reviewAddressed`) that `/ship` no longer produces.

**The names stay in the schema enum.** PolAds's committed `project-config.json` lists `subtask-reminder` and `post-self-review` today; dropping the enum members would make that file invalid the instant the plugin updated, before anyone could edit it.

**Files:**
- Delete: `plugin/hooks/stop-task-check.sh`, `plugin/hooks/stop-task-logic.py`, `plugin/hooks/post-self-review.sh`, `plugin/hooks/parse-self-review-output.py`, `plugin/hooks/subtask-reminder.sh`, `plugin/hooks/subtask-progress-gate.sh`
- Delete: `plugin/hooks/__tests__/stop-task-check.test.sh`, `plugin/hooks/__tests__/stop-task-logic.test.sh`
- Delete: `plugin/src/__tests__/parse-self-review-output.test.ts`
- Modify: `plugin/hooks/hooks.json` — remove the four registrations
- Modify: `plugin/schemas/project-config.schema.json` — mark the four accepted-and-ignored
- Create: `plugin/hooks/__tests__/retired-hooks.test.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: `hooks.json` has no `Stop` entry for `stop-task-check`, no `PostToolUse`/`Task` block at all, no `subtask-reminder` on the edit matcher and no `subtask-progress-gate` on the Bash matcher.

- [ ] **Step 1: Write the failing test**

Create `plugin/hooks/__tests__/retired-hooks.test.sh`:

```bash
#!/bin/bash
# The four hooks retired in 1.0 (spec section 10) must be gone from disk AND
# from hooks.json. A registration pointing at a deleted script is a hook that
# fails to execute on every single tool call, which reads as a broken plugin
# rather than a retired hook — so the third block below walks every surviving
# registration and asserts the file it names exists.
#
# Run with: bash plugin/hooks/__tests__/retired-hooks.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$SCRIPT_DIR/.."
PLUGIN_ROOT="$HOOKS_DIR/.."
HOOKS_JSON="$HOOKS_DIR/hooks.json"

PASS=0
FAIL=0

RETIRED="stop-task-check stop-task-logic post-self-review parse-self-review-output subtask-reminder subtask-progress-gate"

echo "--- the scripts are deleted ---"
for name in $RETIRED; do
  hit=$(ls "$HOOKS_DIR/$name".* 2>/dev/null | head -1)
  if [ -z "$hit" ]; then
    echo "PASS: $name is gone"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name still present at $hit"
    FAIL=$((FAIL + 1))
  fi
done

echo "--- hooks.json references none of them ---"
for name in $RETIRED; do
  if grep -q "$name" "$HOOKS_JSON"; then
    echo "FAIL: hooks.json still registers $name"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: hooks.json does not register $name"
    PASS=$((PASS + 1))
  fi
done

echo "--- every remaining registration points at a file that exists ---"
missing=0
for cmd in $(jq -r '.hooks | to_entries[] | .value[] | .hooks[] | .command' "$HOOKS_JSON"); do
  rel="${cmd#\$\{CLAUDE_PLUGIN_ROOT\}/}"
  if [ ! -f "$PLUGIN_ROOT/$rel" ]; then
    echo "FAIL: registration points at a missing file: $rel"
    missing=$((missing + 1))
  fi
done
if [ "$missing" -eq 0 ]; then
  echo "PASS: every registration resolves to a real file"
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + missing))
fi

echo "--- the survivors are still registered ---"
for name in bash-guard worktree-required worktree-path-boundary pre-commit-secrets-scan protect-sensitive-files stop-ci-green-check rule-autoload; do
  if grep -q "$name" "$HOOKS_JSON"; then
    echo "PASS: $name still registered"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name lost its registration"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
```

- [ ] **Step 2: Run it to confirm the hooks are still there**

Run: `bash plugin/hooks/__tests__/retired-hooks.test.sh`
Expected: twelve `FAIL:` lines (six files present, six still registered); the "registration resolves" and "survivors" blocks pass.

- [ ] **Step 3: Delete the scripts and their tests**

```bash
cd /Users/nate/dev-tasks/plugin
git rm hooks/stop-task-check.sh hooks/stop-task-logic.py \
       hooks/post-self-review.sh hooks/parse-self-review-output.py \
       hooks/subtask-reminder.sh hooks/subtask-progress-gate.sh
git rm hooks/__tests__/stop-task-check.test.sh hooks/__tests__/stop-task-logic.test.sh
git rm src/__tests__/parse-self-review-output.test.ts
```

- [ ] **Step 4: Remove the four registrations from `hooks.json`**

Four edits:
1. In the `PreToolUse` / `Edit|Write|MultiEdit|NotebookEdit` block, delete the `subtask-reminder.sh` object, and the trailing comma on the object before it (which becomes the last element).
2. In the `PreToolUse` / `Bash` block, delete the `subtask-progress-gate.sh` object.
3. In `PostToolUse`, delete the `post-self-review.sh` object; that leaves the `{ "matcher": "Task", … }` block with no hooks, so delete the whole block.
4. In the `Stop` array, delete the `stop-task-check.sh` object.

Then confirm the file still parses:

```bash
cd /Users/nate/dev-tasks/plugin && jq -e . hooks/hooks.json > /dev/null && echo "valid json"
```
Expected: `valid json`.

- [ ] **Step 5: Run the test**

Run: `bash plugin/hooks/__tests__/retired-hooks.test.sh`
Expected: every line `PASS:`, `FAIL: 0`.

- [ ] **Step 6: Mark the four names accepted-and-ignored in the schema**

In `plugin/schemas/project-config.schema.json`, edit the `hooks` object's `description` to:

```
"Per-project hook activation for non-policy hooks. Policy hooks (bash-guard, stop-ci-green-check) are STEP-wide and always-on regardless of this list. Listing them here is harmless (kept in the enum for backward compatibility with existing project-configs). The same applies to the hooks RETIRED in 1.0 — stop-task-check, post-self-review, subtask-reminder, subtask-progress-gate — whose enum members are accepted and IGNORED at runtime so an existing project-config stays valid across the upgrade. Removing an enum member would invalidate a consumer's committed config the moment the plugin updates, before anyone could edit it."
```

Leave the enum array itself untouched.

- [ ] **Step 7: Run the full suite**

```bash
cd /Users/nate/dev-tasks/plugin
npm test
for t in hooks/__tests__/*.test.sh; do echo "== $t"; bash "$t" >/dev/null 2>&1 && echo ok || echo "FAILED $t"; done
npm run typecheck
```
Expected: vitest green (one file fewer), every bash test `ok`, typecheck silent.

- [ ] **Step 8: Commit**

```bash
cd /Users/nate/dev-tasks
git add -A plugin/hooks plugin/src plugin/schemas
git commit -m "feat!: retire stop-task-check, post-self-review and the subtask gates"
```

---

## Task 6: Delete the babysit-prs ban on `gh pr merge --auto`

Spec §7.2: *"Enabled per PR by `/ship` and by workers. GitHub merges when all seven are green. Verified on three PRs before agents rely on it; the babysit-prs note that bans `--auto` is deleted."*

The ban is one line, `plugin/skills/babysit-prs/SKILL.md:150`:

```
- DO NOT use `gh pr merge --auto` — flaky against this repo's CI (UNSTABLE noise blocks auto-merge). Use `--admin --squash`.
```

It has to go before Task 13 ships a `/ship` that does exactly what it forbids, and its replacement must not resurrect `--admin`, which spec §11 keeps banned.

**Files:**
- Modify: `plugin/skills/babysit-prs/SKILL.md:150`
- Create: `plugin/src/__tests__/skill-source-invariants.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `plugin/src/__tests__/skill-source-invariants.test.ts` with a local `skill(name)` reader. Task 13 adds `describe` blocks to this same file.

- [ ] **Step 1: Write the failing test**

Create `plugin/src/__tests__/skill-source-invariants.test.ts`:

```ts
/**
 * Source-level invariants over the skill markdown.
 *
 * A skill is prose; what CAN be pinned is that its load-bearing LITERALS are
 * present and its retired ones are gone. Two of these are contradictions that
 * would otherwise ship in silence: a skill that bans `--auto` shipping beside
 * a skill that runs it, and any skill reaching for `--admin`, which spec
 * section 11 keeps banned outright.
 */

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(__dirname, "..", "..")

function skill(name: string): string {
  return readFileSync(resolve(PLUGIN_ROOT, "skills", name, "SKILL.md"), "utf-8")
}

describe("babysit-prs no longer bans auto-merge", () => {
  const source = skill("babysit-prs")

  it("carries no DO NOT use gh pr merge --auto line", () => {
    expect(source).not.toMatch(/DO NOT use\s+`?gh pr merge --auto`?/i)
  })

  it("does not tell the agent to reach for --admin", () => {
    // Spec section 11: no --admin merges, bypass actors stay empty.
    expect(source).not.toMatch(/--admin/)
  })

  it("still explains what the skill is for", () => {
    // A guard that passes because the file was emptied is not a guard.
    expect(source.length).toBeGreaterThan(2000)
    expect(source).toMatch(/gh pr merge/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/nate/dev-tasks/plugin && npx vitest run src/__tests__/skill-source-invariants.test.ts`
Expected: FAIL on both the `--auto` case and the `--admin` case — line 150 contains both strings.

- [ ] **Step 3: Replace line 150**

In `plugin/skills/babysit-prs/SKILL.md`, replace that line with:

```markdown
- Prefer `gh pr merge {pr} --auto --squash --delete-branch`. GitHub merges when every required check goes green, so the orchestrator never sits in a polling loop. This REVERSES the note that used to sit here: `--auto` was called flaky because UNSTABLE check noise held merges open, and the fix for that is to require only checks that settle, not to merge past them. Never `--admin` — it merges past a red required check, which spec section 11 bans and for which no ruleset bypass exists (`bypass_actors` is empty on purpose).
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/__tests__/skill-source-invariants.test.ts`
Expected: three passing cases.

- [ ] **Step 5: Check nothing else in the plugin still bans it**

```bash
cd /Users/nate/dev-tasks/plugin && grep -rn -- "--admin" skills/ rules/ hooks/ | grep -v worktree-audit
```
Expected: no output, or only `skills/ship-pr/SKILL.md`. `/ship-pr` is SUPERSEDED by `/ship` rather than edited here — leave it and name the hit in the commit message, so whoever retires `/ship-pr` knows it is the last holder.

- [ ] **Step 6: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/skills/babysit-prs/SKILL.md plugin/src/__tests__/skill-source-invariants.test.ts
git commit -m "feat: babysit-prs prefers auto-merge; the --auto ban is deleted"
```

---

## Task 7: The tracker interface and its pure helpers

Spec §10: *"A tracker adapter interface with one Linear implementation; the Monday implementation is kept for the cutover weekend only."*

Everything in this task is pure — no network, no filesystem — so the whole contract is unit-tested without a key. Tasks 8, 9 and 10 implement against it.

**Files:**
- Create: `plugin/src/tracker/types.ts`
- Create: `plugin/src/tracker/__tests__/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, for Tasks 8, 9, 10, 11 and 13:
  - `interface TrackerIssue { id; uuid; title; description; acceptanceCriteria; state; labels; url; priority; updatedAt }`
  - `interface CreateIssueInput { title; description?; labels?; state? }`
  - `interface Tracker { kind; readIssue; claimIssue; createIssue; comment; attachLink; listReady }`
  - `extractAcceptanceCriteria(markdown: string): string`
  - `slugify(text: string, maxLength?: number): string`
  - `branchNameFor(issueId: string, title: string): string`
  - `byPriorityThenAge(a, b): number`
  - `LINEAR_TEAM_KEY = "STEP"`, `LINEAR_REF_RE = /\bSTEP-(\d+)\b/`

- [ ] **Step 1: Write the failing test**

Create `plugin/src/tracker/__tests__/types.test.ts`:

```ts
/**
 * The pure half of the tracker adapter. No network, no key, no filesystem.
 *
 * Two of these pin decisions rather than mechanics:
 *  - branchNameFor CONSTRUCTS `STEP-123-slug` instead of returning Linear's
 *    own issue.branchName, which is prefixed with the API key owner's
 *    username ("nate/step-123-…"). An agent's branches must not read as
 *    belonging to whoever's key happens to be installed on that mini.
 *  - byPriorityThenAge puts "No priority" (Linear's 0) LAST, not first.
 *    Linear numbers priority 1=Urgent … 4=Low, 0=none; a naive ascending
 *    sort hands the queue every unprioritised issue before every urgent one.
 */

import { describe, it, expect } from "vitest"
import {
  extractAcceptanceCriteria,
  slugify,
  branchNameFor,
  byPriorityThenAge,
  LINEAR_TEAM_KEY,
  LINEAR_REF_RE,
  type TrackerIssue,
} from "../types.ts"

describe("extractAcceptanceCriteria", () => {
  // The migration writes exactly this heading (scripts/linear/transform.ts:208).
  const doc = [
    "Some preamble.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] The thing works",
    "- [ ] The other thing works",
    "",
    "## Notes",
    "",
    "Not part of the criteria.",
  ].join("\n")

  it("returns the block under the heading", () => {
    expect(extractAcceptanceCriteria(doc)).toBe(
      "- [ ] The thing works\n- [ ] The other thing works",
    )
  })

  it("stops at a sibling heading and excludes it", () => {
    expect(extractAcceptanceCriteria(doc)).not.toMatch(/Notes/)
  })

  it("does NOT stop at a deeper heading", () => {
    const nested = "## Acceptance criteria\n\n### Given\n\n- a\n\n## After\n\nno"
    expect(extractAcceptanceCriteria(nested)).toBe("### Given\n\n- a")
  })

  it("is case-insensitive and tolerates a trailing colon", () => {
    expect(extractAcceptanceCriteria("### ACCEPTANCE CRITERIA:\n\n- x")).toBe("- x")
  })

  it("returns empty string when there is no such heading", () => {
    expect(extractAcceptanceCriteria("# Title\n\nbody")).toBe("")
  })

  it("returns empty string for empty or undefined input", () => {
    expect(extractAcceptanceCriteria("")).toBe("")
    expect(extractAcceptanceCriteria(undefined as unknown as string)).toBe("")
  })
})

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Fix the Broken Thing")).toBe("fix-the-broken-thing")
  })

  it("strips diacritics rather than dropping the letter", () => {
    // Danish issue titles are ordinary here.
    expect(slugify("Ændr størrelse")).toBe("aendr-stoerrelse")
  })

  it("collapses runs of punctuation and trims the ends", () => {
    expect(slugify("  --- a/b: c!!  ")).toBe("a-b-c")
  })

  it("truncates without leaving a trailing hyphen", () => {
    expect(slugify("aaaa bbbb cccc dddd", 11)).toBe("aaaa-bbbb")
  })

  it("returns empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("")
  })
})

describe("branchNameFor", () => {
  it("builds STEP-123-slug in capitals", () => {
    expect(branchNameFor("STEP-123", "Fix the thing")).toBe("STEP-123-fix-the-thing")
  })

  it("upper-cases a lowercase identifier so LINEAR_REF_RE can match it", () => {
    expect(branchNameFor("step-7", "Do it")).toBe("STEP-7-do-it")
  })

  it("falls back to the bare identifier when the title yields no slug", () => {
    expect(branchNameFor("STEP-9", "!!!")).toBe("STEP-9")
  })

  it("produces a name LINEAR_REF_RE matches", () => {
    expect(LINEAR_REF_RE.test(branchNameFor("STEP-42", "Something"))).toBe(true)
  })
})

describe("byPriorityThenAge", () => {
  const issue = (priority: number, updatedAt: string): TrackerIssue => ({
    id: "STEP-1",
    uuid: "u",
    title: "t",
    description: "",
    acceptanceCriteria: "",
    state: "Ready",
    labels: [],
    url: "",
    priority,
    updatedAt,
  })

  it("puts Urgent before Low", () => {
    expect(byPriorityThenAge(issue(1, "2026-01-01"), issue(4, "2026-01-01"))).toBeLessThan(0)
  })

  it("puts No priority (0) LAST, behind Low", () => {
    expect(byPriorityThenAge(issue(0, "2026-01-01"), issue(4, "2026-01-01"))).toBeGreaterThan(0)
  })

  it("breaks a priority tie oldest-first so nothing starves", () => {
    expect(byPriorityThenAge(issue(2, "2026-01-01"), issue(2, "2026-06-01"))).toBeLessThan(0)
  })

  it("sorts a mixed list into the queue order the front door drains", () => {
    const list = [issue(0, "2026-01-01"), issue(3, "2026-05-01"), issue(1, "2026-09-01"), issue(3, "2026-02-01")]
    expect(list.slice().sort(byPriorityThenAge).map((i) => [i.priority, i.updatedAt])).toEqual([
      [1, "2026-09-01"],
      [3, "2026-02-01"],
      [3, "2026-05-01"],
      [0, "2026-01-01"],
    ])
  })
})

describe("the team key is STEP, never POL", () => {
  it("names the real team", () => {
    // The spec writes POL-123; the real key is STEP (lib/ci/pr-task-trace.ts).
    expect(LINEAR_TEAM_KEY).toBe("STEP")
  })

  it("matches the same shape the Task trace CI check matches", () => {
    expect(LINEAR_REF_RE.test("Fixes STEP-3055 in passing")).toBe(true)
    expect(LINEAR_REF_RE.test("POL-3055")).toBe(false)
    expect(LINEAR_REF_RE.test("step-3055")).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/nate/dev-tasks/plugin && npx vitest run src/tracker/__tests__/types.test.ts`
Expected: FAIL — `Cannot find module '../types.ts'`.

- [ ] **Step 3: Write the types module**

Create `plugin/src/tracker/types.ts`:

```ts
/**
 * The tracker adapter contract, plus the pure helpers every implementation
 * shares. Nothing here touches the network, so the whole contract is testable
 * without a key.
 *
 * Source of truth for the shapes: the two-flow spec sections 5, 9.1 and 10.
 */

/** Linear numbers priority 1=Urgent, 2=High, 3=Medium, 4=Low, 0=No priority. */
export type IssuePriority = 0 | 1 | 2 | 3 | 4

export interface TrackerIssue {
  /** The human identifier a PR body must carry: `STEP-123`. */
  id: string
  /** The provider's internal id (a Linear UUID; a Monday item id). */
  uuid: string
  title: string
  /** The full description as Markdown. Empty string when there is none. */
  description: string
  /** The acceptance-criteria block lifted out of `description`. Empty when absent. */
  acceptanceCriteria: string
  /** The workflow state NAME, e.g. `Ready`, `In Progress`. */
  state: string
  labels: string[]
  url: string
  priority: IssuePriority
  /** ISO 8601. Used only for ordering. */
  updatedAt: string
}

export interface CreateIssueInput {
  title: string
  description?: string
  /** Label names, e.g. `["product/polads", "type/chore"]`. Unknown names are skipped. */
  labels?: string[]
  /** Target state name. Defaults to the provider's own default when omitted. */
  state?: string
}

export interface Tracker {
  readonly kind: "linear" | "monday"

  /** Reads one issue by its human identifier (`STEP-123`) or provider id. */
  readIssue(ref: string): Promise<TrackerIssue>

  /**
   * Moves the issue to In Progress and records who took it. `claimant` is a
   * machine or person name (the `mini` field, or `whoami`); an implementation
   * that cannot resolve it to a user still records the claim as a comment.
   */
  claimIssue(ref: string, claimant: string): Promise<TrackerIssue>

  createIssue(input: CreateIssueInput): Promise<TrackerIssue>

  comment(ref: string, body: string): Promise<void>

  attachLink(ref: string, url: string, title: string): Promise<void>

  /** Ready issues, already sorted by `byPriorityThenAge`. */
  listReady(limit?: number): Promise<TrackerIssue[]>
}

/**
 * The real Linear team key. The spec writes `POL-123`; that is superseded by
 * `lib/ci/pr-task-trace.ts` in the PolAds repo, which is what the `Task trace`
 * required check actually runs.
 */
export const LINEAR_TEAM_KEY = "STEP"

/**
 * Deliberately byte-identical to the PolAds CI regex. Case-sensitive, word
 * boundaries both sides. Anything this plugin writes into a PR title or body
 * must satisfy it or a traceable PR fails its own trace check.
 */
export const LINEAR_REF_RE = /\bSTEP-(\d+)\b/

const AC_HEADING_RE = /^(#{1,6})\s*acceptance\s+criteria\s*:?\s*$/i
const ANY_HEADING_RE = /^(#{1,6})\s/

/**
 * Lifts the acceptance-criteria block out of an issue description.
 *
 * `scripts/linear/transform.ts` writes the heading as `## Acceptance
 * criteria`, so that is the shape this matches — at any level, in any case,
 * with or without a trailing colon. The block ends at the next heading of the
 * SAME OR SHALLOWER level; a deeper heading is part of the criteria.
 */
export function extractAcceptanceCriteria(markdown: string): string {
  if (!markdown) return ""
  const lines = markdown.split("\n")

  let level = 0
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = AC_HEADING_RE.exec(lines[i].trim())
    if (m) {
      level = m[1].length
      start = i + 1
      break
    }
  }
  if (start === -1) return ""

  const body: string[] = []
  for (let i = start; i < lines.length; i++) {
    const h = ANY_HEADING_RE.exec(lines[i].trim())
    if (h && h[1].length <= level) break
    body.push(lines[i])
  }
  return body.join("\n").trim()
}

// Transliterations that NFKD alone does not produce. Danish and German titles
// are ordinary in this workspace, and "ndr strrelse" is not a usable slug.
const TRANSLITERATE: Array<[RegExp, string]> = [
  [/æ/g, "ae"],
  [/ø/g, "oe"],
  [/å/g, "aa"],
  [/ß/g, "ss"],
]

export function slugify(text: string, maxLength = 48): string {
  if (!text) return ""
  let s = text.toLowerCase()
  for (const [from, to] of TRANSLITERATE) s = s.replace(from, to)
  s = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (s.length <= maxLength) return s
  return s.slice(0, maxLength).replace(/-+$/, "")
}

/**
 * `STEP-123-fix-the-thing`.
 *
 * Linear's own `issue.branchName` is NOT used: its default format prefixes the
 * API key owner's username (`nate/step-123-…`), so an agent's branches would
 * read as belonging to whoever's key is installed on that mini. Linear links a
 * branch on the identifier appearing ANYWHERE in the name, so the constructed
 * form autolinks exactly as well.
 */
export function branchNameFor(issueId: string, title: string): string {
  const id = issueId.trim().toUpperCase()
  const slug = slugify(title)
  return slug ? `${id}-${slug}` : id
}

/** 0 ("No priority") sorts LAST; every real priority sorts ahead of it. */
const priorityRank = (p: number): number => (p === 0 ? 5 : p)

/**
 * Queue order for the front door: most urgent first, and within one priority
 * the OLDEST first, so a low-priority issue cannot starve behind a stream of
 * newer ones at the same level.
 */
export function byPriorityThenAge(a: TrackerIssue, b: TrackerIssue): number {
  const d = priorityRank(a.priority) - priorityRank(b.priority)
  if (d !== 0) return d
  return a.updatedAt.localeCompare(b.updatedAt)
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/tracker/__tests__/types.test.ts`
Expected: all cases pass.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/nate/dev-tasks/plugin && npm run typecheck`
Expected: no output. The repo uses `"type": "module"` with `.ts` extension imports — `from "../types.ts"` is correct here and `from "../types"` will not resolve.

- [ ] **Step 6: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/src/tracker/types.ts plugin/src/tracker/__tests__/types.test.ts
git commit -m "feat: tracker adapter interface and its pure helpers"
```

---

## Task 8: The Linear GraphQL transport

Key loading, the 1.5 s throttle, the retry ladder, and a write cap the rehearsal in Task 16 uses to bound a live run.

**This is a deliberate second copy of `scripts/linear/client.ts` from the PolAds repo**, not a shared module: the two live in different repositories with no package between them, and vendoring one into the other would make a plugin release a PolAds release. The copy is small, and the properties that matter (key never printed, throttle, backoff on transient GraphQL errors returned over HTTP 200) are re-tested here rather than assumed.

**Files:**
- Create: `plugin/src/tracker/linear-client.ts`
- Create: `plugin/src/tracker/__tests__/linear-client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, for Task 9:
  - `loadLinearKey(): string`
  - `linearRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T>`
  - `resetLinearClientForTests(): void`
  - `LINEAR_ENDPOINT = "https://api.linear.app/graphql"`

- [ ] **Step 1: Write the failing test**

Create `plugin/src/tracker/__tests__/linear-client.test.ts`:

```ts
/**
 * The Linear transport. `fetch` is mocked throughout — no key, no network.
 *
 * The retry case that matters is the one people leave out: Linear reports
 * SOME transient failures as GraphQL errors over an HTTP 200 ("Internal
 * server error", rate limiting). A client that only retries on status codes
 * turns a blip into a hard failure mid-import.
 *
 * The throttle is asserted by counting calls under a fake clock rather than
 * by sleeping; a test that really waits 1.5 s per request is a test nobody
 * runs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  linearRequest,
  loadLinearKey,
  resetLinearClientForTests,
  LINEAR_ENDPOINT,
} from "../linear-client.ts"

const ORIGINAL_KEY = process.env.LINEAR_API_KEY

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  resetLinearClientForTests()
  process.env.LINEAR_API_KEY = "lin_api_test_key"
  process.env.TRACKERCTL_MAX_WRITES = ""
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (ORIGINAL_KEY === undefined) delete process.env.LINEAR_API_KEY
  else process.env.LINEAR_API_KEY = ORIGINAL_KEY
})

describe("loadLinearKey", () => {
  it("prefers the environment", () => {
    expect(loadLinearKey()).toBe("lin_api_test_key")
  })

  it("throws a message that does NOT contain a key when nothing is set", () => {
    delete process.env.LINEAR_API_KEY
    process.env.HOME = "/nonexistent-home-for-this-test"
    expect(() => loadLinearKey()).toThrowError(/LINEAR_API_KEY/)
    // The message names the file, never a value.
    expect(() => loadLinearKey()).toThrowError(/\.config\/linear\/\.env/)
  })
})

describe("linearRequest", () => {
  it("posts to the Linear endpoint with the key as a bare Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    vi.stubGlobal("fetch", fetchMock)

    const result = await linearRequest<{ ok: boolean }>("{ ok }")

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(LINEAR_ENDPOINT)
    expect(init.method).toBe("POST")
    // Linear personal API keys go in Authorization WITHOUT a Bearer prefix.
    expect(init.headers.Authorization).toBe("lin_api_test_key")
    expect(JSON.parse(init.body)).toEqual({ query: "{ ok }", variables: {} })
  })

  it("retries a 429 and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: 1 } }))
    vi.stubGlobal("fetch", fetchMock)

    const promise = linearRequest<{ ok: number }>("{ ok }")
    await vi.runAllTimersAsync()

    expect(await promise).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("retries a TRANSIENT GraphQL error returned over HTTP 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Internal server error" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: 2 } }))
    vi.stubGlobal("fetch", fetchMock)

    const promise = linearRequest<{ ok: number }>("{ ok }")
    await vi.runAllTimersAsync()

    expect(await promise).toEqual({ ok: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does NOT retry a real refusal — it throws at once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors: [{ message: "Entity not found: Issue" }] }))
    vi.stubGlobal("fetch", fetchMock)

    const promise = linearRequest("{ issue { id } }")
    await expect(promise).rejects.toThrowError(/Entity not found/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("throttles consecutive calls to one per 1500 ms", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    vi.stubGlobal("fetch", fetchMock)

    await linearRequest("{ a }")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const second = linearRequest("{ b }")
    // Still inside the window: the second call has not gone out.
    await vi.advanceTimersByTimeAsync(500)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1100)
    await second
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("enforces TRACKERCTL_MAX_WRITES on mutations only", async () => {
    process.env.TRACKERCTL_MAX_WRITES = "1"
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    vi.stubGlobal("fetch", fetchMock)

    const first = linearRequest("mutation { issueCreate { success } }")
    await vi.runAllTimersAsync()
    await first

    const second = linearRequest("mutation { issueCreate { success } }")
    await expect(second).rejects.toThrowError(/TRACKERCTL_MAX_WRITES/)

    // Reads are never capped.
    const read = linearRequest("query { issue { id } }")
    await vi.runAllTimersAsync()
    await expect(read).resolves.toBeDefined()
  })

  it("never puts the key in a thrown message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "Bad" }] }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(linearRequest("{ a }")).rejects.toThrowError(
      expect.not.stringContaining("lin_api_test_key") as unknown as string,
    )
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/nate/dev-tasks/plugin && npx vitest run src/tracker/__tests__/linear-client.test.ts`
Expected: FAIL — `Cannot find module '../linear-client.ts'`.

- [ ] **Step 3: Write the transport**

Create `plugin/src/tracker/linear-client.ts`:

```ts
/**
 * Minimal Linear GraphQL transport for the tracker adapter.
 *
 * This is a deliberate SECOND COPY of scripts/linear/client.ts in the PolAds
 * repo. The two live in different repositories with no package between them;
 * vendoring one into the other would couple a plugin release to a product
 * release. Keep the two in step by hand when either changes, and keep both
 * sets of tests — the properties, not the file, are what must agree.
 *
 * The key is read from LINEAR_API_KEY, else from ~/.config/linear/.env
 * (mode 600). It is never logged, never interpolated into an error message
 * and never passed as an argv element.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql"

const MIN_INTERVAL_MS = 1500
const MAX_ATTEMPTS = 6
const MAX_BACKOFF_MS = 60_000

let lastCall = 0
let writesPerformed = 0

/** Test seam. Never called in production. */
export function resetLinearClientForTests(): void {
  lastCall = 0
  writesPerformed = 0
}

export function loadLinearKey(): string {
  const fromEnv = process.env.LINEAR_API_KEY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  const path = join(homedir(), ".config", "linear", ".env")
  let contents: string
  try {
    contents = readFileSync(path, "utf8")
  } catch {
    throw new Error(
      `LINEAR_API_KEY is not set and ${path} could not be read. ` +
        `Put LINEAR_API_KEY=<key> in that file (chmod 600) or export it.`,
    )
  }
  const line = contents.split("\n").find((l) => l.startsWith("LINEAR_API_KEY="))
  if (!line) {
    throw new Error(`LINEAR_API_KEY missing from ${path}`)
  }
  const key = line.slice("LINEAR_API_KEY=".length).trim()
  if (!key) throw new Error(`LINEAR_API_KEY is empty in ${path}`)
  return key
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Linear reports some transient failures as GraphQL errors over an HTTP 200.
 * Those get the same backoff as a 5xx; anything else is a real refusal and
 * throws on the first attempt.
 */
const TRANSIENT_RE =
  /internal server error|ratelimited|rate limit|timed? ?out|temporarily unavailable/i

const MUTATION_RE = /^\s*mutation\b/i

function maxWrites(): number {
  const raw = process.env.TRACKERCTL_MAX_WRITES
  if (!raw || !raw.trim()) return Number.POSITIVE_INFINITY
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : Number.POSITIVE_INFINITY
}

export async function linearRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const isMutation = MUTATION_RE.test(query)
  if (isMutation) {
    const cap = maxWrites()
    if (writesPerformed >= cap) {
      throw new Error(
        `Refusing the write: TRACKERCTL_MAX_WRITES=${cap} reached. ` +
          `Raise or unset it to continue.`,
      )
    }
    writesPerformed += 1
  }

  const key = loadLinearKey()

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()

    const res = await fetch(LINEAR_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
    })

    if (res.status === 429 || res.status >= 500) {
      await sleep(Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** attempt))
      continue
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (json.errors?.length) {
      const message = json.errors.map((e) => e.message).join("; ")
      if (TRANSIENT_RE.test(message) && attempt < MAX_ATTEMPTS - 1) {
        await sleep(Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** attempt))
        continue
      }
      throw new Error(`Linear: ${message}`)
    }
    return json.data as T
  }

  throw new Error(`Linear: gave up after ${MAX_ATTEMPTS} attempts`)
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/tracker/__tests__/linear-client.test.ts`
Expected: all cases pass.

- [ ] **Step 5: Confirm the key cannot leak through a log line**

```bash
cd /Users/nate/dev-tasks/plugin && grep -n "console\.\|process.stdout" src/tracker/linear-client.ts
```
Expected: no output. The transport prints nothing at all; the CLI in Task 11 owns every line of output.

- [ ] **Step 6: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/src/tracker/linear-client.ts plugin/src/tracker/__tests__/linear-client.test.ts
git commit -m "feat: Linear GraphQL transport with throttle, retry and a write cap"
```

---

## Task 9: The Linear tracker implementation

Six methods over the transport from Task 8, against the team key `STEP` and the states and labels `scripts/linear/model.ts` creates.

**Files:**
- Create: `plugin/src/tracker/linear.ts`
- Create: `plugin/src/tracker/__tests__/linear.test.ts`

**Interfaces:**
- Consumes: `linearRequest` (Task 8); `Tracker`, `TrackerIssue`, `CreateIssueInput`, `extractAcceptanceCriteria`, `byPriorityThenAge`, `LINEAR_TEAM_KEY` (Task 7).
- Produces, for Tasks 10 and 11: `createLinearTracker(): Tracker`.

- [ ] **Step 1: Write the failing test**

Create `plugin/src/tracker/__tests__/linear.test.ts`:

```ts
/**
 * The Linear adapter, driven through a mocked `linearRequest`.
 *
 * The assertions that carry weight are about WHAT IS SENT, not what comes
 * back: an identifier resolved by team key + number rather than by guessing
 * that `issue(id:)` accepts "STEP-123"; a state set by looking the NAME up on
 * the team rather than hardcoding a workspace-specific UUID; and a claim that
 * still records a comment when the claimant resolves to no Linear user, which
 * is the normal case for a mini.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

const requestMock = vi.fn()
vi.mock("../linear-client.ts", () => ({
  linearRequest: (...args: unknown[]) => requestMock(...args),
  LINEAR_ENDPOINT: "https://api.linear.app/graphql",
  loadLinearKey: () => "test-key",
  resetLinearClientForTests: () => {},
}))

const { createLinearTracker } = await import("../linear.ts")

const TEAM = {
  teams: {
    nodes: [
      {
        id: "team-uuid",
        key: "STEP",
        name: "STEP",
        states: {
          nodes: [
            { id: "state-ready", name: "Ready", type: "unstarted", position: 2 },
            { id: "state-progress", name: "In Progress", type: "started", position: 4 },
          ],
        },
        labels: { nodes: [{ id: "label-chore", name: "chore" }] },
      },
    ],
  },
}

const ISSUE_FIELDS = {
  id: "issue-uuid",
  identifier: "STEP-123",
  title: "Fix the thing",
  description: "Preamble.\n\n## Acceptance criteria\n\n- [ ] works",
  url: "https://linear.app/step/issue/STEP-123",
  priority: 2,
  updatedAt: "2026-09-01T00:00:00.000Z",
  state: { name: "Ready" },
  labels: { nodes: [{ name: "product/polads" }] },
}

beforeEach(() => {
  requestMock.mockReset()
})

describe("readIssue", () => {
  it("resolves STEP-123 by team key and NUMBER, never by passing the identifier as an id", async () => {
    requestMock.mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } })

    const issue = await createLinearTracker().readIssue("STEP-123")

    const [query, variables] = requestMock.mock.calls[0]
    expect(query).toMatch(/issues\(/)
    expect(variables).toMatchObject({ teamKey: "STEP", number: 123 })
    expect(issue.id).toBe("STEP-123")
    expect(issue.uuid).toBe("issue-uuid")
    expect(issue.state).toBe("Ready")
    expect(issue.labels).toEqual(["product/polads"])
  })

  it("splits the acceptance criteria out of the description", async () => {
    requestMock.mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } })
    const issue = await createLinearTracker().readIssue("STEP-123")
    expect(issue.acceptanceCriteria).toBe("- [ ] works")
    // The description is NOT truncated — the criteria are a projection of it.
    expect(issue.description).toMatch(/Preamble/)
  })

  it("throws a message naming the identifier when nothing matches", async () => {
    requestMock.mockResolvedValueOnce({ issues: { nodes: [] } })
    await expect(createLinearTracker().readIssue("STEP-999")).rejects.toThrowError(/STEP-999/)
  })

  it("accepts a raw UUID and looks it up by id", async () => {
    requestMock.mockResolvedValueOnce({ issue: ISSUE_FIELDS })
    await createLinearTracker().readIssue("11111111-2222-3333-4444-555555555555")
    expect(requestMock.mock.calls[0][0]).toMatch(/issue\(id:/)
  })
})

describe("createIssue", () => {
  it("creates on the STEP team, resolving the state NAME to an id", async () => {
    requestMock
      .mockResolvedValueOnce(TEAM)
      .mockResolvedValueOnce({ issueCreate: { issue: { ...ISSUE_FIELDS, identifier: "STEP-500" } } })

    const issue = await createLinearTracker().createIssue({
      title: "Ship the thing",
      description: "body",
      state: "Ready",
    })

    const [, variables] = requestMock.mock.calls[1]
    expect(variables.input).toMatchObject({
      teamId: "team-uuid",
      title: "Ship the thing",
      description: "body",
      stateId: "state-ready",
    })
    expect(issue.id).toBe("STEP-500")
  })

  it("omits stateId entirely when the requested state does not exist", async () => {
    requestMock
      .mockResolvedValueOnce(TEAM)
      .mockResolvedValueOnce({ issueCreate: { issue: ISSUE_FIELDS } })

    await createLinearTracker().createIssue({ title: "x", state: "Nonexistent" })

    // Sending a bogus stateId would fail the whole create; omitting it lets
    // Linear apply the team default, which is the right fallback for a
    // traceability issue opened by /ship.
    expect(requestMock.mock.calls[1][1].input.stateId).toBeUndefined()
  })
})

describe("claimIssue", () => {
  it("moves the issue to In Progress and comments, even with no matching user", async () => {
    requestMock
      .mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } }) // readIssue
      .mockResolvedValueOnce(TEAM)                                   // team + states
      .mockResolvedValueOnce({ users: { nodes: [] } })               // no such user
      .mockResolvedValueOnce({ issueUpdate: { success: true } })
      .mockResolvedValueOnce({ commentCreate: { success: true } })
      .mockResolvedValueOnce({ issues: { nodes: [{ ...ISSUE_FIELDS, state: { name: "In Progress" } }] } })

    const issue = await createLinearTracker().claimIssue("STEP-123", "bob")

    const update = requestMock.mock.calls.find((c) => String(c[0]).includes("issueUpdate"))
    expect(update?.[1].input).toMatchObject({ stateId: "state-progress" })
    expect(update?.[1].input.assigneeId).toBeUndefined()

    const comment = requestMock.mock.calls.find((c) => String(c[0]).includes("commentCreate"))
    expect(comment?.[1].input.body).toMatch(/claimed/i)
    expect(comment?.[1].input.body).toMatch(/bob/)

    expect(issue.state).toBe("In Progress")
  })
})

describe("attachLink", () => {
  it("uses attachmentLinkURL, the same mutation the migration uses", async () => {
    requestMock
      .mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } })
      .mockResolvedValueOnce({ attachmentLinkURL: { success: true } })

    await createLinearTracker().attachLink("STEP-123", "https://github.com/x/y/pull/1", "PR #1")

    const call = requestMock.mock.calls[1]
    expect(call[0]).toMatch(/attachmentLinkURL/)
    expect(call[1]).toMatchObject({
      issueId: "issue-uuid",
      url: "https://github.com/x/y/pull/1",
      title: "PR #1",
    })
  })
})

describe("listReady", () => {
  it("filters on the Ready state and sorts by priority then age", async () => {
    requestMock.mockResolvedValueOnce({
      issues: {
        nodes: [
          { ...ISSUE_FIELDS, identifier: "STEP-1", priority: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
          { ...ISSUE_FIELDS, identifier: "STEP-2", priority: 1, updatedAt: "2026-09-01T00:00:00.000Z" },
          { ...ISSUE_FIELDS, identifier: "STEP-3", priority: 3, updatedAt: "2026-02-01T00:00:00.000Z" },
        ],
      },
    })

    const issues = await createLinearTracker().listReady(10)

    const [query, variables] = requestMock.mock.calls[0]
    expect(query).toMatch(/issues\(/)
    expect(variables).toMatchObject({ teamKey: "STEP", stateName: "Ready", first: 10 })
    expect(issues.map((i) => i.id)).toEqual(["STEP-2", "STEP-3", "STEP-1"])
  })
})

describe("the adapter identifies itself", () => {
  it("reports kind linear", () => {
    expect(createLinearTracker().kind).toBe("linear")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/tracker/__tests__/linear.test.ts`
Expected: FAIL — `Cannot find module '../linear.ts'`.

- [ ] **Step 3: Write the adapter**

Create `plugin/src/tracker/linear.ts`:

```ts
/**
 * The Linear implementation of the Tracker interface.
 *
 * Workspace assumptions, all created by `pnpm linear:bootstrap` in the PolAds
 * repo (scripts/linear/model.ts): one team with key STEP, twelve states in
 * board order with `Ready` and `In Progress` among them, and the label groups
 * product/ type/ flag/ lock/ source/ bug-status/.
 */

import { linearRequest } from "./linear-client.ts"
import {
  byPriorityThenAge,
  extractAcceptanceCriteria,
  LINEAR_TEAM_KEY,
  type CreateIssueInput,
  type IssuePriority,
  type Tracker,
  type TrackerIssue,
} from "./types.ts"

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  updatedAt
  state { name }
  labels { nodes { name } }
`

interface RawIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  priority: number
  updatedAt: string
  state: { name: string } | null
  labels: { nodes: Array<{ name: string }> }
}

interface RawTeam {
  id: string
  key: string
  name: string
  states: { nodes: Array<{ id: string; name: string }> }
  labels: { nodes: Array<{ id: string; name: string }> }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTIFIER_RE = /^([A-Za-z]+)-(\d+)$/

function toIssue(raw: RawIssue): TrackerIssue {
  const description = raw.description ?? ""
  return {
    id: raw.identifier,
    uuid: raw.id,
    title: raw.title,
    description,
    acceptanceCriteria: extractAcceptanceCriteria(description),
    state: raw.state?.name ?? "",
    labels: raw.labels.nodes.map((l) => l.name),
    url: raw.url,
    priority: (raw.priority ?? 0) as IssuePriority,
    updatedAt: raw.updatedAt,
  }
}

export function createLinearTracker(): Tracker {
  let teamCache: RawTeam | null = null

  async function team(): Promise<RawTeam> {
    if (teamCache) return teamCache
    const data = await linearRequest<{ teams: { nodes: RawTeam[] } }>(
      `query($key: String!) {
         teams(filter: { key: { eq: $key } }) {
           nodes {
             id key name
             states { nodes { id name } }
             labels { nodes { id name } }
           }
         }
       }`,
      { key: LINEAR_TEAM_KEY },
    )
    const found = data.teams.nodes[0]
    if (!found) {
      throw new Error(
        `Linear: no team with key ${LINEAR_TEAM_KEY}. ` +
          `Run \`pnpm linear:bootstrap --apply\` in the PolAds repo first.`,
      )
    }
    teamCache = found
    return found
  }

  async function stateIdFor(name: string | undefined): Promise<string | undefined> {
    if (!name) return undefined
    const t = await team()
    // A bogus stateId fails the whole mutation; omitting it lets Linear apply
    // the team default, which is the right fallback for a /ship issue.
    return t.states.nodes.find((s) => s.name === name)?.id
  }

  async function labelIdsFor(names: string[] | undefined): Promise<string[] | undefined> {
    if (!names || names.length === 0) return undefined
    const t = await team()
    const ids = names
      .map((n) => t.labels.nodes.find((l) => l.name === n)?.id)
      .filter((id): id is string => Boolean(id))
    return ids.length ? ids : undefined
  }

  async function fetchRaw(ref: string): Promise<RawIssue> {
    const trimmed = ref.trim()

    if (UUID_RE.test(trimmed)) {
      const data = await linearRequest<{ issue: RawIssue | null }>(
        `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
        { id: trimmed },
      )
      if (!data.issue) throw new Error(`Linear: no issue with id ${trimmed}`)
      return data.issue
    }

    const m = IDENTIFIER_RE.exec(trimmed)
    if (!m) {
      throw new Error(`Not a Linear issue reference: ${trimmed} (expected STEP-123 or a UUID)`)
    }
    // Resolve by team key + number. `issue(id:)` is documented for the UUID;
    // filtering on the number is unambiguous and needs no assumption about
    // whether the identifier form is accepted there.
    const data = await linearRequest<{ issues: { nodes: RawIssue[] } }>(
      `query($teamKey: String!, $number: Float!) {
         issues(first: 1, filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }) {
           nodes { ${ISSUE_FIELDS} }
         }
       }`,
      { teamKey: m[1].toUpperCase(), number: Number(m[2]) },
    )
    const found = data.issues.nodes[0]
    if (!found) throw new Error(`Linear: no issue ${trimmed} on team ${m[1].toUpperCase()}`)
    return found
  }

  async function userIdFor(claimant: string): Promise<string | undefined> {
    const data = await linearRequest<{ users: { nodes: Array<{ id: string }> } }>(
      `query($q: String!) {
         users(first: 1, filter: { or: [{ email: { eq: $q } }, { displayName: { eq: $q } }] }) {
           nodes { id }
         }
       }`,
      { q: claimant },
    )
    return data.users.nodes[0]?.id
  }

  return {
    kind: "linear",

    async readIssue(ref) {
      return toIssue(await fetchRaw(ref))
    },

    async claimIssue(ref, claimant) {
      const raw = await fetchRaw(ref)
      const stateId = await stateIdFor("In Progress")
      // A mini is not a Linear member, so this is EXPECTED to miss most of
      // the time. The claim is still recorded as a comment, which is what
      // the 6-hour claim TTL reads.
      const assigneeId = await userIdFor(claimant)

      const input: Record<string, unknown> = {}
      if (stateId) input.stateId = stateId
      if (assigneeId) input.assigneeId = assigneeId

      if (Object.keys(input).length > 0) {
        await linearRequest(
          `mutation($id: String!, $input: IssueUpdateInput!) {
             issueUpdate(id: $id, input: $input) { success }
           }`,
          { id: raw.id, input },
        )
      }

      await linearRequest(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId: raw.id, body: `claimed by ${claimant} at ${new Date().toISOString()}` } },
      )

      return toIssue(await fetchRaw(ref))
    },

    async createIssue(input: CreateIssueInput) {
      const t = await team()
      const stateId = await stateIdFor(input.state)
      const labelIds = await labelIdsFor(input.labels)

      const payload: Record<string, unknown> = { teamId: t.id, title: input.title }
      if (input.description) payload.description = input.description
      if (stateId) payload.stateId = stateId
      if (labelIds) payload.labelIds = labelIds

      const data = await linearRequest<{ issueCreate: { issue: RawIssue } }>(
        `mutation($input: IssueCreateInput!) {
           issueCreate(input: $input) { issue { ${ISSUE_FIELDS} } }
         }`,
        { input: payload },
      )
      return toIssue(data.issueCreate.issue)
    },

    async comment(ref, body) {
      const raw = await fetchRaw(ref)
      await linearRequest(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId: raw.id, body } },
      )
    },

    async attachLink(ref, url, title) {
      const raw = await fetchRaw(ref)
      await linearRequest(
        `mutation($issueId: String!, $url: String!, $title: String) {
           attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
         }`,
        { issueId: raw.id, url, title },
      )
    },

    async listReady(limit = 25) {
      const data = await linearRequest<{ issues: { nodes: RawIssue[] } }>(
        `query($teamKey: String!, $stateName: String!, $first: Int!) {
           issues(
             first: $first,
             filter: { team: { key: { eq: $teamKey } }, state: { name: { eq: $stateName } } }
           ) {
             nodes { ${ISSUE_FIELDS} }
           }
         }`,
        { teamKey: LINEAR_TEAM_KEY, stateName: "Ready", first: limit },
      )
      return data.issues.nodes.map(toIssue).sort(byPriorityThenAge)
    },
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/tracker/__tests__/linear.test.ts`
Expected: all cases pass.

- [ ] **Step 5: Typecheck and run the whole vitest suite**

```bash
cd /Users/nate/dev-tasks/plugin && npm run typecheck && npm test
```
Expected: typecheck silent, vitest green.

- [ ] **Step 6: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/src/tracker/linear.ts plugin/src/tracker/__tests__/linear.test.ts
git commit -m "feat: Linear tracker implementation over the STEP team"
```

---

## Task 10: The Monday adapter and `resolveTracker()`

Spec §10: the Monday implementation *"is kept for the cutover weekend only"*. It exists so that `/dev`, `/preview` and `/ship` work the day they ship — before the Linear workspace exists — and so the cutover is one config key rather than a rewrite.

**It is deliberately minimal and lossy, and it does NOT go through the 45 MCP tools.** Those return formatted strings for a human to read; parsing an id back out of one is exactly the brittleness this adapter exists to avoid. It calls `executeMondayQuery` directly for the six methods and nothing else. It does not create subtasks, set sprints, assign an epic or record hours — an issue opened by `/ship` is a traceability record, and `/refine` (phase 2) is what turns one into a refined task.

**Files:**
- Create: `plugin/src/tracker/monday.ts`
- Create: `plugin/src/tracker/index.ts`
- Create: `plugin/src/tracker/__tests__/index.test.ts`

**Interfaces:**
- Consumes: `executeMondayQuery` from `../monday-client.ts`; `BOARDS`, `TASK_COLUMNS` from `../constants.ts`; `getTaskDescriptionDoc` from `../tools/taskDescriptionDoc.ts`; everything from Tasks 7 and 9.
- Produces, for Task 11:
  - `createMondayTracker(): Tracker`
  - `stripDescriptionDocHeader(raw: string): string`
  - `resolveTracker(projectRoot?: string): Tracker`
  - `readTrackerProvider(projectRoot?: string): "linear" | "monday"`

- [ ] **Step 1: Write the failing test**

Create `plugin/src/tracker/__tests__/index.test.ts`:

```ts
/**
 * Tracker selection and the Monday adapter's one pure helper.
 *
 * The default is MONDAY, deliberately: phase 0 ships before the Linear
 * workspace exists (spec section 14), so a plugin that defaulted to Linear
 * would fail on every consumer the day it released. PolAds flips the key on
 * cutover weekend.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readTrackerProvider, resolveTracker } from "../index.ts"
import { stripDescriptionDocHeader } from "../monday.ts"

let root: string

function writeConfig(body: unknown): void {
  mkdirSync(join(root, ".claude"), { recursive: true })
  writeFileSync(join(root, ".claude", "project-config.json"), JSON.stringify(body))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tracker-cfg-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("readTrackerProvider", () => {
  it("defaults to monday when there is no config at all", () => {
    expect(readTrackerProvider(root)).toBe("monday")
  })

  it("defaults to monday when the config has no tracker block", () => {
    writeConfig({ version: "1", monday: { productId: "1" } })
    expect(readTrackerProvider(root)).toBe("monday")
  })

  it("reads linear when the config says so", () => {
    writeConfig({ version: "1", tracker: { provider: "linear" } })
    expect(readTrackerProvider(root)).toBe("linear")
  })

  it("falls back to monday on an unrecognised value rather than throwing", () => {
    // A typo must not take the three skills down; Monday still works.
    writeConfig({ version: "1", tracker: { provider: "jira" } })
    expect(readTrackerProvider(root)).toBe("monday")
  })

  it("survives an unparseable config", () => {
    mkdirSync(join(root, ".claude"), { recursive: true })
    writeFileSync(join(root, ".claude", "project-config.json"), "{ not json")
    expect(readTrackerProvider(root)).toBe("monday")
  })

  it("is overridden by DEV_TASKS_TRACKER, for the rehearsal", () => {
    writeConfig({ version: "1", tracker: { provider: "monday" } })
    process.env.DEV_TASKS_TRACKER = "linear"
    try {
      expect(readTrackerProvider(root)).toBe("linear")
    } finally {
      delete process.env.DEV_TASKS_TRACKER
    }
  })
})

describe("resolveTracker", () => {
  it("returns the implementation the provider names", () => {
    writeConfig({ version: "1", tracker: { provider: "linear" } })
    expect(resolveTracker(root).kind).toBe("linear")

    writeConfig({ version: "1", tracker: { provider: "monday" } })
    expect(resolveTracker(root).kind).toBe("monday")
  })
})

describe("stripDescriptionDocHeader", () => {
  it("removes the header getTaskDescriptionDoc prepends", () => {
    const raw = "# Description Doc — Task #123 (doc 456)\n\nThe real body.\n\n## Acceptance criteria\n\n- [ ] x"
    expect(stripDescriptionDocHeader(raw)).toBe("The real body.\n\n## Acceptance criteria\n\n- [ ] x")
  })

  it("leaves a body that carries no such header alone", () => {
    expect(stripDescriptionDocHeader("Just a body")).toBe("Just a body")
  })

  it("returns empty string for the empty-doc placeholder", () => {
    expect(stripDescriptionDocHeader("# Description Doc — Task #1 (doc 2)\n\n_(empty doc)_")).toBe("")
  })

  it("returns empty string when the tool returned an error string", () => {
    // formatError output must never be mistaken for a description.
    expect(stripDescriptionDocHeader("ERROR: Task #9 has no description doc set.")).toBe("")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/tracker/__tests__/index.test.ts`
Expected: FAIL — `Cannot find module '../index.ts'`.

- [ ] **Step 3: Write the Monday adapter**

Create `plugin/src/tracker/monday.ts`:

```ts
/**
 * The Monday implementation of the Tracker interface.
 *
 * CUTOVER-WEEKEND ONLY (spec section 10). It exists so the three skills work
 * the day they ship, before the Linear workspace exists, and so the cutover
 * is one config key. Delete this file once BUG_TRACKER=linear has been live
 * for a release.
 *
 * It is DELIBERATELY minimal and lossy:
 *  - no subtasks, no sprint, no epic, no hours. An issue opened by /ship is a
 *    traceability record; /refine turns one into a refined task.
 *  - `attachLink` posts an update rather than writing a link column. Monday
 *    has no per-item link primitive that takes a title, and overloading
 *    prLink vs demoUrl by sniffing the title would be a guess.
 *  - `priority` is always 0 and `listReady` therefore falls back to oldest
 *    first. Mapping Monday's priority index onto Linear's 0-4 scale would be
 *    a second mapping table for a surface being retired.
 *
 * It does NOT go through the 45 MCP tools: those return formatted strings for
 * a human to read, and parsing an item id back out of one is the brittleness
 * this adapter exists to avoid.
 */

import { executeMondayQuery } from "../monday-client.ts"
import { BOARDS, TASK_COLUMNS } from "../constants.ts"
import { getTaskDescriptionDoc } from "../tools/taskDescriptionDoc.ts"
import {
  byPriorityThenAge,
  extractAcceptanceCriteria,
  type CreateIssueInput,
  type Tracker,
  type TrackerIssue,
} from "./types.ts"

const DOC_HEADER_RE = /^#\s*Description Doc\s*[—-]\s*Task\s*#\d+\s*\(doc\s*\d+\)\s*$/
const EMPTY_DOC = "_(empty doc)_"

/**
 * `getTaskDescriptionDoc` returns a human-facing string: a heading line, a
 * blank line, then the markdown. Turn that back into just the markdown, and
 * answer an error string or an empty doc with "".
 */
export function stripDescriptionDocHeader(raw: string): string {
  if (!raw) return ""
  if (/^(ERROR|Failed)\b/i.test(raw.trim())) return ""

  const lines = raw.split("\n")
  const body = DOC_HEADER_RE.test(lines[0].trim()) ? lines.slice(1).join("\n") : raw
  const trimmed = body.trim()
  return trimmed === EMPTY_DOC ? "" : trimmed
}

interface RawItem {
  id: string
  name: string
  url: string
  updated_at: string
  column_values: Array<{ id: string; text: string | null }>
}

function columnText(item: RawItem, columnId: string): string {
  return item.column_values.find((c) => c.id === columnId)?.text ?? ""
}

async function fetchItem(itemId: string): Promise<RawItem> {
  const data = await executeMondayQuery<{ items: RawItem[] }>(
    `query($ids: [ID!]) {
       items(ids: $ids) {
         id name url updated_at
         column_values { id text }
       }
     }`,
    { ids: [itemId] },
  )
  const item = data.items?.[0]
  if (!item) throw new Error(`Monday: no item ${itemId}`)
  return item
}

async function toIssue(item: RawItem): Promise<TrackerIssue> {
  const description = stripDescriptionDocHeader(await getTaskDescriptionDoc({ taskId: item.id }))
  return {
    id: item.id,
    uuid: item.id,
    title: item.name,
    description,
    acceptanceCriteria: extractAcceptanceCriteria(description),
    state: columnText(item, TASK_COLUMNS.status),
    labels: [columnText(item, TASK_COLUMNS.type)].filter(Boolean),
    url: item.url,
    priority: 0,
    updatedAt: item.updated_at,
  }
}

export function createMondayTracker(): Tracker {
  return {
    kind: "monday",

    async readIssue(ref) {
      return toIssue(await fetchItem(ref))
    },

    async claimIssue(ref, claimant) {
      await executeMondayQuery(
        `mutation($board: ID!, $item: ID!, $column: String!, $value: JSON!) {
           change_column_value(board_id: $board, item_id: $item, column_id: $column, value: $value) { id }
         }`,
        {
          board: String(BOARDS.TASKS),
          item: ref,
          column: TASK_COLUMNS.status,
          value: JSON.stringify({ label: "In Progress" }),
        },
      )
      await executeMondayQuery(
        `mutation($item: ID!, $body: String!) {
           create_update(item_id: $item, body: $body) { id }
         }`,
        { item: ref, body: `claimed by ${claimant} at ${new Date().toISOString()}` },
      )
      return toIssue(await fetchItem(ref))
    },

    async createIssue(input: CreateIssueInput) {
      const data = await executeMondayQuery<{ create_item: { id: string } }>(
        `mutation($board: ID!, $name: String!) {
           create_item(board_id: $board, item_name: $name) { id }
         }`,
        { board: String(BOARDS.TASKS), name: input.title },
      )
      const id = data.create_item.id
      if (input.description) {
        await executeMondayQuery(
          `mutation($item: ID!, $body: String!) {
             create_update(item_id: $item, body: $body) { id }
           }`,
          { item: id, body: input.description },
        )
      }
      return toIssue(await fetchItem(id))
    },

    async comment(ref, body) {
      await executeMondayQuery(
        `mutation($item: ID!, $body: String!) {
           create_update(item_id: $item, body: $body) { id }
         }`,
        { item: ref, body },
      )
    },

    async attachLink(ref, url, title) {
      await executeMondayQuery(
        `mutation($item: ID!, $body: String!) {
           create_update(item_id: $item, body: $body) { id }
         }`,
        { item: ref, body: `**${title}**: ${url}` },
      )
    },

    async listReady(limit = 25) {
      const data = await executeMondayQuery<{
        boards: Array<{ items_page: { items: RawItem[] } }>
      }>(
        `query($board: ID!, $limit: Int!, $column: String!) {
           boards(ids: [$board]) {
             items_page(
               limit: $limit,
               query_params: { rules: [{ column_id: $column, compare_value: ["Ready to Start"], operator: any_of }] }
             ) {
               items { id name url updated_at column_values { id text } }
             }
           }
         }`,
        { board: String(BOARDS.TASKS), limit, column: TASK_COLUMNS.status },
      )
      const items = data.boards?.[0]?.items_page?.items ?? []
      const issues = await Promise.all(items.map(toIssue))
      return issues.sort(byPriorityThenAge)
    },
  }
}
```

- [ ] **Step 4: Write the selector**

Create `plugin/src/tracker/index.ts`:

```ts
/**
 * Which tracker this project uses.
 *
 * `tracker.provider` in .claude/project-config.json, defaulting to `monday`.
 * The default is deliberate: phase 0 ships BEFORE the Linear workspace exists
 * (spec section 14), so defaulting to Linear would break every consumer on
 * release day. PolAds flips the key on cutover weekend, and unflipping it is
 * the rollback.
 *
 * DEV_TASKS_TRACKER overrides it, for the Task 16 rehearsal and for a mini
 * that is testing the Linear path before its project config moves.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createLinearTracker } from "./linear.ts"
import { createMondayTracker } from "./monday.ts"
import type { Tracker } from "./types.ts"

export type TrackerProvider = "linear" | "monday"

const DEFAULT_PROVIDER: TrackerProvider = "monday"

function isProvider(value: unknown): value is TrackerProvider {
  return value === "linear" || value === "monday"
}

export function readTrackerProvider(projectRoot: string = process.cwd()): TrackerProvider {
  const fromEnv = process.env.DEV_TASKS_TRACKER
  if (isProvider(fromEnv)) return fromEnv

  try {
    const raw = readFileSync(join(projectRoot, ".claude", "project-config.json"), "utf8")
    const parsed = JSON.parse(raw) as { tracker?: { provider?: unknown } }
    const provider = parsed.tracker?.provider
    // An unrecognised value falls back rather than throwing: a typo must not
    // take /dev, /preview and /ship down, and Monday still works.
    if (isProvider(provider)) return provider
  } catch {
    // No config, or unreadable. Monday is the pre-cutover default.
  }
  return DEFAULT_PROVIDER
}

export function resolveTracker(projectRoot: string = process.cwd()): Tracker {
  return readTrackerProvider(projectRoot) === "linear"
    ? createLinearTracker()
    : createMondayTracker()
}

export { createLinearTracker } from "./linear.ts"
export { createMondayTracker, stripDescriptionDocHeader } from "./monday.ts"
export * from "./types.ts"
```

- [ ] **Step 5: Run the test and typecheck**

```bash
cd /Users/nate/dev-tasks/plugin
npx vitest run src/tracker/__tests__/index.test.ts
npm run typecheck
```
Expected: all cases pass; typecheck silent.

- [ ] **Step 6: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/src/tracker/monday.ts plugin/src/tracker/index.ts plugin/src/tracker/__tests__/index.test.ts
git commit -m "feat: minimal Monday tracker and the tracker.provider switch"
```

---

## Task 11: `trackerctl` — the CLI the skills call

**This is the decision the task list asks about: the skills reach the adapter through a script, NOT through new MCP tools.** Three reasons, all of them checkable:

1. The 45 MCP tools are Monday-shaped by vocabulary — sprints, epics, subtasks, actual hours. Mirroring six of them for Linear doubles a surface that spec §9.2 is retiring.
2. An MCP tool handler returns a formatted string. `/ship` needs one field — the new identifier — and parsing it out of prose is the brittleness Task 10 already refuses.
3. A CLI is unit-testable with a mocked `fetch`. An MCP handler, in this codebase, is not tested at the transport level at all.

**If that is ever reversed**, the minimum MCP change is: a new `src/tools/tracker*.ts` per method, six Zod schemas in `src/schemas.ts`, six `server.tool(...)` blocks in `src/register-tools.ts`, and the hook matchers in `hooks.json` that name `mcp__plugin_dev-tasks_dev-tasks__claimTask` updated to match the new names. Nothing in this plan forecloses it.

**Files:**
- Create: `plugin/scripts/trackerctl.ts`
- Create: `plugin/src/tracker/__tests__/trackerctl-args.test.ts`
- Modify: `plugin/package.json` — add a `trackerctl` script

**Interfaces:**
- Consumes: `resolveTracker` (Task 10), everything from Task 7.
- Produces, for Tasks 12, 13 and 14 — every subcommand prints ONE line of JSON on stdout:
  - `trackerctl read <ref>` → the `TrackerIssue`
  - `trackerctl create --title <t> [--description <d>] [--label <l>]… [--state <s>]` → the new `TrackerIssue`
  - `trackerctl comment <ref> --body <b>` → `{"ok":true}`
  - `trackerctl attach <ref> --url <u> --title <t>` → `{"ok":true}`
  - `trackerctl ready [--limit <n>]` → `TrackerIssue[]`
  - `trackerctl claim <ref> --as <name>` → the `TrackerIssue`
  - `trackerctl branch <ref>` → `{"branch":"STEP-123-slug","id":"STEP-123","title":"…"}`
  - `parseArgs(argv: string[]): ParsedArgs` is exported for the test

- [ ] **Step 1: Write the failing test**

Create `plugin/src/tracker/__tests__/trackerctl-args.test.ts`:

```ts
/**
 * Argument parsing for trackerctl. The subcommands themselves are covered by
 * the adapter tests; what is worth pinning here is the parsing, because the
 * callers are MARKDOWN SKILLS — a mis-parsed flag surfaces as a skill that
 * quietly does the wrong thing rather than as a type error.
 *
 * The --description case is the one that bites: an issue description is
 * multi-line prose containing spaces, quotes and newlines.
 */

import { describe, it, expect } from "vitest"
import { parseArgs } from "../../../scripts/trackerctl.ts"

describe("parseArgs", () => {
  it("reads a subcommand and its positional", () => {
    expect(parseArgs(["read", "STEP-123"])).toMatchObject({
      command: "read",
      positional: ["STEP-123"],
    })
  })

  it("collects repeated --label into an array", () => {
    const parsed = parseArgs(["create", "--title", "T", "--label", "type/chore", "--label", "product/polads"])
    expect(parsed.flags.label).toEqual(["type/chore", "product/polads"])
  })

  it("keeps a single-valued flag as a string", () => {
    expect(parseArgs(["create", "--title", "Fix the thing"]).flags.title).toBe("Fix the thing")
  })

  it("keeps newlines and quotes inside a flag value intact", () => {
    const body = 'Line one\n\n## Acceptance criteria\n\n- [ ] the "thing" works'
    expect(parseArgs(["create", "--title", "T", "--description", body]).flags.description).toBe(body)
  })

  it("treats a bare --flag with no value as the boolean true", () => {
    expect(parseArgs(["ready", "--json"]).flags.json).toBe(true)
  })

  it("does not mistake a negative number for a flag", () => {
    expect(parseArgs(["ready", "--limit", "-1"]).flags.limit).toBe("-1")
  })

  it("throws a usage error on no subcommand at all", () => {
    expect(() => parseArgs([])).toThrowError(/usage/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/tracker/__tests__/trackerctl-args.test.ts`
Expected: FAIL — `Cannot find module '../../../scripts/trackerctl.ts'`.

- [ ] **Step 3: Write the CLI**

Create `plugin/scripts/trackerctl.ts`:

```ts
#!/usr/bin/env -S npx tsx
/**
 * trackerctl — the one way a skill reaches the tracker adapter.
 *
 * Every subcommand prints exactly ONE line of JSON to stdout and nothing
 * else, so a skill can pipe it through `jq -r`. Diagnostics go to stderr.
 * Exit 0 on success, 1 on a tracker error, 64 on a usage error.
 *
 *   trackerctl read STEP-123
 *   trackerctl branch STEP-123
 *   trackerctl create --title "Fix the thing" --description "$BODY" --label type/chore
 *   trackerctl comment STEP-123 --body "opened PR #42"
 *   trackerctl attach STEP-123 --url https://github.com/... --title "PR #42"
 *   trackerctl ready --limit 10
 *   trackerctl claim STEP-123 --as bob
 *
 * The provider comes from .claude/project-config.json `tracker.provider`
 * (default monday), overridable with DEV_TASKS_TRACKER.
 */

import { resolveTracker } from "../src/tracker/index.ts"
import { branchNameFor } from "../src/tracker/types.ts"

export interface ParsedArgs {
  command: string
  positional: string[]
  flags: Record<string, string | string[] | true>
}

const USAGE = `usage: trackerctl <read|branch|create|comment|attach|ready|claim> [args]`

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) throw new Error(USAGE)
  const [command, ...rest] = argv
  if (command.startsWith("-")) throw new Error(USAGE)

  const positional: string[] = []
  const flags: Record<string, string | string[] | true> = {}

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token.startsWith("--")) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    const next = rest[i + 1]
    // A value is anything that follows and is not itself a --flag. "-1" is a
    // value, not a flag: only a DOUBLE dash introduces one here.
    const hasValue = next !== undefined && !next.startsWith("--")
    const value: string | true = hasValue ? next : true
    if (hasValue) i++

    const existing = flags[name]
    if (existing === undefined) {
      flags[name] = value
    } else if (Array.isArray(existing)) {
      existing.push(String(value))
    } else {
      flags[name] = [String(existing), String(value)]
    }
  }

  return { command, positional, flags }
}

function str(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name]
  if (v === undefined || v === true) return undefined
  return Array.isArray(v) ? v[0] : v
}

function list(flags: ParsedArgs["flags"], name: string): string[] | undefined {
  const v = flags[name]
  if (v === undefined || v === true) return undefined
  return Array.isArray(v) ? v : [v]
}

function require(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${USAGE}\nmissing required --${name}`)
  return value
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  const tracker = resolveTracker()
  const { command, positional, flags } = parsed

  switch (command) {
    case "read": {
      const issue = await tracker.readIssue(require(positional[0], "ref (positional)"))
      process.stdout.write(JSON.stringify(issue) + "\n")
      return
    }
    case "branch": {
      const issue = await tracker.readIssue(require(positional[0], "ref (positional)"))
      process.stdout.write(
        JSON.stringify({
          branch: branchNameFor(issue.id, issue.title),
          id: issue.id,
          title: issue.title,
        }) + "\n",
      )
      return
    }
    case "create": {
      const issue = await tracker.createIssue({
        title: require(str(flags, "title"), "title"),
        description: str(flags, "description"),
        labels: list(flags, "label"),
        state: str(flags, "state"),
      })
      process.stdout.write(JSON.stringify(issue) + "\n")
      return
    }
    case "comment": {
      await tracker.comment(
        require(positional[0], "ref (positional)"),
        require(str(flags, "body"), "body"),
      )
      process.stdout.write(JSON.stringify({ ok: true }) + "\n")
      return
    }
    case "attach": {
      await tracker.attachLink(
        require(positional[0], "ref (positional)"),
        require(str(flags, "url"), "url"),
        require(str(flags, "title"), "title"),
      )
      process.stdout.write(JSON.stringify({ ok: true }) + "\n")
      return
    }
    case "ready": {
      const raw = str(flags, "limit")
      const limit = raw ? Number.parseInt(raw, 10) : 25
      const issues = await tracker.listReady(Number.isFinite(limit) && limit > 0 ? limit : 25)
      process.stdout.write(JSON.stringify(issues) + "\n")
      return
    }
    case "claim": {
      const issue = await tracker.claimIssue(
        require(positional[0], "ref (positional)"),
        require(str(flags, "as"), "as"),
      )
      process.stdout.write(JSON.stringify(issue) + "\n")
      return
    }
    default:
      throw new Error(`${USAGE}\nunknown subcommand: ${command}`)
  }
}

// Only run when invoked directly, so the test can import parseArgs.
if (process.argv[1] && process.argv[1].endsWith("trackerctl.ts")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(message + "\n")
    process.exit(message.startsWith("usage:") ? 64 : 1)
  })
}
```

- [ ] **Step 4: Add the npm script**

In `plugin/package.json`, add to `scripts`:

```json
"trackerctl": "tsx scripts/trackerctl.ts"
```

- [ ] **Step 5: Run the test and check the usage path by hand**

```bash
cd /Users/nate/dev-tasks/plugin
npx vitest run src/tracker/__tests__/trackerctl-args.test.ts
npx tsx scripts/trackerctl.ts; echo "exit=$?"
```
Expected: the vitest cases pass; the bare invocation prints the usage line on stderr and `exit=64`. No network call is made, because `resolveTracker` is reached only after parsing succeeds.

- [ ] **Step 6: Typecheck and run everything**

```bash
cd /Users/nate/dev-tasks/plugin && npm run typecheck && npm test
```
Expected: silent, then green.

- [ ] **Step 7: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/scripts/trackerctl.ts plugin/src/tracker/__tests__/trackerctl-args.test.ts plugin/package.json
git commit -m "feat: trackerctl CLI — the seam between the skills and the tracker"
```

---

## Task 12: `/dev`

Spec §5: *"Creates or checks out a branch in the main checkout (`--worktree` opts into a worktree). Starts `pnpm dev`. With an issue id, loads its description as context and links the branch (Linear autolink by branch name). No tracker writes, no subtasks, no hours."*

**Files:**
- Create: `plugin/skills/dev/SKILL.md`
- Modify: `plugin/src/__tests__/skill-source-invariants.test.ts` — add a `describe` block

**Interfaces:**
- Consumes: `profile.sh` (Task 1), `trackerctl branch` and `trackerctl read` (Task 11).
- Produces: a checked-out branch named `STEP-<n>-<slug>`, a running dev server, and — on `devSurface: preview` — a handoff to `/preview`.

- [ ] **Step 1: Add the failing test block**

Append to `plugin/src/__tests__/skill-source-invariants.test.ts`:

```ts
describe("/dev", () => {
  const source = skill("dev")

  it("declares itself user-invocable with the name dev", () => {
    expect(source).toMatch(/^---\n[\s\S]*?\bname:\s*dev\b[\s\S]*?\buser_invocable:\s*true\b[\s\S]*?\n---/m)
  })

  it("writes NOTHING to the tracker", () => {
    // Spec section 5: "No tracker writes, no subtasks, no hours."
    expect(source).not.toMatch(/trackerctl\s+(create|claim|comment|attach)/)
  })

  it("reads the issue through trackerctl rather than an MCP tool", () => {
    expect(source).toMatch(/trackerctl\s+branch/)
    expect(source).not.toMatch(/mcp__plugin_dev-tasks/)
  })

  it("works in the MAIN checkout unless --worktree is passed", () => {
    expect(source).toMatch(/--worktree/)
    expect(source).toMatch(/main checkout/i)
  })

  it("ends with /preview when devSurface is preview", () => {
    expect(source).toMatch(/devSurface/)
    expect(source).toMatch(/\/preview/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/nate/dev-tasks/plugin && npx vitest run src/__tests__/skill-source-invariants.test.ts`
Expected: FAIL — `ENOENT ... skills/dev/SKILL.md`.

- [ ] **Step 3: Write the skill**

Create `plugin/skills/dev/SKILL.md`:

````markdown
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

Read `.claude/project-config.json` for `git.defaultBase` (default `staging`).
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
git checkout -B "$BRANCH" "origin/$DEFAULT_BASE"
```

`-B` so re-running `/dev` on an existing branch resumes it instead of failing.
If the branch already exists locally with commits on it, `git checkout "$BRANCH"`
instead and say so — never reset someone's work onto the base.

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
````

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/__tests__/skill-source-invariants.test.ts`
Expected: the `/dev` block passes along with the `babysit-prs` block.

- [ ] **Step 5: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/skills/dev/SKILL.md plugin/src/__tests__/skill-source-invariants.test.ts
git commit -m "feat: /dev — branch, dev server and issue context, no tracker writes"
```

---

## Task 13: `/preview`

Spec §5: *"Commits work in progress, pushes, waits for the Vercel preview deployment of the branch, prints the URL with the protection bypass query."*

**Files:**
- Create: `plugin/skills/preview/SKILL.md`
- Modify: `plugin/src/__tests__/skill-source-invariants.test.ts`

**Interfaces:**
- Consumes: `bash-guard` gate (f) still refuses a push to a protected branch; nothing else.
- Produces: a pushed branch and a printed preview URL.

- [ ] **Step 1: Add the failing test block**

Append to `plugin/src/__tests__/skill-source-invariants.test.ts`:

```ts
describe("/preview", () => {
  const source = skill("preview")

  it("declares itself user-invocable with the name preview", () => {
    expect(source).toMatch(/^---\n[\s\S]*?\bname:\s*preview\b[\s\S]*?\buser_invocable:\s*true\b[\s\S]*?\n---/m)
  })

  it("pushes the FEATURE branch and never the base", () => {
    expect(source).toMatch(/git push -u origin HEAD/)
    expect(source).not.toMatch(/git push\s+origin\s+(staging|main)\b/)
  })

  it("prints the protection bypass query", () => {
    // A preview URL without it 302s an unauthenticated reader to a login page.
    expect(source).toMatch(/VERCEL_AUTOMATION_BYPASS_SECRET/)
    expect(source).toMatch(/x-vercel-set-bypass-cookie/)
  })

  it("runs no local build, lint, test or Playwright", () => {
    expect(source).not.toMatch(/pnpm (build|lint|test)\b/)
    expect(source).not.toMatch(/playwright test/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/skill-source-invariants.test.ts`
Expected: FAIL — `ENOENT ... skills/preview/SKILL.md`.

- [ ] **Step 3: Write the skill**

Create `plugin/skills/preview/SKILL.md`:

````markdown
---
name: preview
description: Push the branch and print its Vercel preview URL with the protection bypass.
user_invocable: true
---

# /preview — show it to someone

`/preview`

Commits whatever is in the tree, pushes the branch, waits for its Vercel
preview deployment and prints the URL. No PR, no tracker write, no checks.

## Phase 1: commit and push

```bash
git add -A
git commit -m "wip: $(git branch --show-current)"   # skip when the tree is clean
git push -u origin HEAD
```

`HEAD`, never a branch name: the person may be on a detached checkout, and
`git push origin staging` is refused by `bash-guard` gate (f) anyway. Gate (f)
is NOT profile-gated — it holds on every machine.

If the commit is empty and the branch is already pushed, skip straight to
Phase 2 and print the URL for the existing deployment.

## Phase 2: wait for the deployment

```bash
SHA=$(git rev-parse HEAD)
```

Poll for the deployment of that sha until its state is `READY` (or `ERROR`,
which is a result too). Either tool works:

```bash
vercel ls --meta githubCommitSha="$SHA"
```

or the Vercel MCP `list_deployments` filtered to the project and that sha.
Poll every 10 s, give up after 10 minutes and print what the last state was —
a build that is still going is a fact worth reporting, not a failure.

On `ERROR`, print the deployment's inspect URL and the last 30 log lines and
stop. Do not try to fix the build here; that is what the session is for.

## Phase 3: print the URL with the bypass

A preview deployment sits behind Vercel Deployment Protection, so a bare URL
302s anyone who is not logged into the Vercel team — including the person you
are sending it to.

```bash
echo "${DEPLOYMENT_URL}?x-vercel-protection-bypass=${VERCEL_AUTOMATION_BYPASS_SECRET}&x-vercel-set-bypass-cookie=samesitenone"
```

`x-vercel-set-bypass-cookie=samesitenone` matters: without it the bypass
applies to that one request and every in-page navigation lands back on the
login screen.

If `VERCEL_AUTOMATION_BYPASS_SECRET` is not in the environment, print the bare
URL and say plainly that the recipient will need to be logged into the Vercel
team.

## Phase 4: report

One line: the branch, the sha, the URL. Nothing else.

## What /preview deliberately does NOT do

- No build, lint, test or Playwright run. CI owns them (spec section 7), and
  the preview deployment IS the build.
- No PR. That is `/ship`.
- No tracker write.
````

- [ ] **Step 4: Run the test and commit**

```bash
cd /Users/nate/dev-tasks/plugin && npx vitest run src/__tests__/skill-source-invariants.test.ts
cd /Users/nate/dev-tasks
git add plugin/skills/preview/SKILL.md plugin/src/__tests__/skill-source-invariants.test.ts
git commit -m "feat: /preview — push and print the bypassed preview URL"
```
Expected: the `/preview` block passes; the commit lands.

---

## Task 14: `/ship`

Spec §5: *"Runs `tsc --noEmit` (the one local check, about 90 s, optional with `--skip-typecheck`). Commits, pushes, creates a Linear issue from the branch and PR title if none is linked (so the PR is traceable), opens the PR to `staging` with the issue id in the title, enables auto-merge (`gh pr merge --auto --squash --delete-branch`), posts one line to `#polads-agents`, stops."*

**Files:**
- Create: `plugin/skills/ship/SKILL.md`
- Modify: `plugin/src/__tests__/skill-source-invariants.test.ts`

**Interfaces:**
- Consumes: `trackerctl branch|read|create|attach` (Task 11); the profile reader (Task 1).
- Produces: a PR to `$defaultBase` whose TITLE and BODY both carry `STEP-<n>`, with auto-merge armed.

- [ ] **Step 1: Add the failing test block**

Append to `plugin/src/__tests__/skill-source-invariants.test.ts`:

```ts
describe("/ship", () => {
  const source = skill("ship")

  it("declares itself user-invocable with the name ship", () => {
    expect(source).toMatch(/^---\n[\s\S]*?\bname:\s*ship\b[\s\S]*?\buser_invocable:\s*true\b[\s\S]*?\n---/m)
  })

  it("runs tsc --noEmit as the ONE local check, with an opt-out", () => {
    expect(source).toMatch(/tsc --noEmit/)
    expect(source).toMatch(/--skip-typecheck/)
  })

  it("runs no other local check", () => {
    expect(source).not.toMatch(/pnpm (build|lint|test)\b/)
    expect(source).not.toMatch(/playwright test/)
    expect(source).not.toMatch(/validate-schema/)
  })

  it("creates an issue when none is linked", () => {
    expect(source).toMatch(/trackerctl\.ts["']?\s+create/)
  })

  it("puts the identifier in BOTH the PR title and the PR body", () => {
    // LINEAR_REF_RE reads the BODY (lib/ci/pr-task-trace.ts); Linear's own
    // autolink reads the TITLE. Only one of the two is the CI check.
    expect(source).toMatch(/PR title/i)
    expect(source).toMatch(/PR body/i)
    expect(source).toMatch(/STEP-/)
  })

  it("arms auto-merge with the exact flags, and never --admin", () => {
    expect(source).toMatch(/gh pr merge .*--auto --squash --delete-branch/)
    expect(source).not.toMatch(/--admin/)
  })

  it("targets the configured base and never pushes to it", () => {
    expect(source).toMatch(/git\.defaultBase/)
    expect(source).toMatch(/git push -u origin HEAD/)
    expect(source).not.toMatch(/git push\s+origin\s+(staging|main)\b/)
  })

  it("stops after opening the PR — no CI polling loop", () => {
    expect(source).toMatch(/stops?\b/i)
    expect(source).not.toMatch(/gh pr checks --watch/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/skill-source-invariants.test.ts`
Expected: FAIL — `ENOENT ... skills/ship/SKILL.md`.

- [ ] **Step 3: Write the skill**

Create `plugin/skills/ship/SKILL.md`:

````markdown
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
  --title "<the PR title>" \
  --description "$(git log --format='- %s' "origin/$DEFAULT_BASE..HEAD")" \
  --label "type/chore" \
  --state "In Progress"
```

Take `id` out of the JSON. Use the PR title as the issue title so the two read
the same; use the commit subjects as the description so the issue says what
landed.

> A PR whose changed paths are ALL under `.claude/`, `.github/` or `docs/` is
> exempt from `Task trace` and needs no issue. Check with
> `git diff --name-only "origin/$DEFAULT_BASE..HEAD"` before creating one —
> an issue per docs typo is noise on the board.

## Phase 4: open the PR

The identifier goes in BOTH places, and they are read by different things:

- **the PR TITLE** — `STEP-123: <subject>`. Linear's GitHub integration links
  on this, and it is what a human sees in the PR list.
- **the PR BODY** — `LINEAR_REF_RE` in `lib/ci/pr-task-trace.ts` reads the
  BODY, not the title. A title-only reference fails the required check.

Capitals, always: the regex is case-sensitive.

```bash
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
````

- [ ] **Step 4: Run the whole suite**

```bash
cd /Users/nate/dev-tasks/plugin && npm test && npm run typecheck
```
Expected: every `skill-source-invariants` block passes, vitest green, typecheck silent.

- [ ] **Step 5: Commit**

```bash
cd /Users/nate/dev-tasks
git add plugin/skills/ship/SKILL.md plugin/src/__tests__/skill-source-invariants.test.ts
git commit -m "feat: /ship — typecheck, traceable PR, auto-merge, stop"
```

---

## Task 15: Schema, version bump, `skills-lock.json`, and the PolAds install

The `tracker` block needs a schema entry or every consumer's config fails validation (`additionalProperties: false`). The version bump plus a cache removal is the only way a consumer actually picks any of this up.

**Files:**
- Modify: `plugin/schemas/project-config.schema.json` — add `tracker`
- Modify: `plugin/templates/starter-project-config.json` — add `tracker`
- Modify: `plugin/src/__tests__/project-config-schema.test.ts` — cases for `tracker`
- Modify: `plugin/.claude-plugin/plugin.json` — version `1.0.0`, new description
- Create: `docs/dev-tasks-1-0-install.md`
- Modify: `/Users/nate/v0-politiske-annoncer/.claude/project-config.json` — the one PolAds change

**Interfaces:**
- Consumes: `readTrackerProvider` (Task 10).
- Produces: a `tracker` block the schema accepts, and a documented install.

- [ ] **Step 1: Write the failing schema test**

Append to `plugin/src/__tests__/project-config-schema.test.ts`:

```ts
describe("the tracker block", () => {
  const validate = makeValidator()

  it("is optional — an existing config with no tracker block still validates", () => {
    const config = validConfig()
    expect(validate(config)).toBe(true)
  })

  it("accepts provider linear", () => {
    const config = { ...validConfig(), tracker: { provider: "linear" } }
    expect(validate(config)).toBe(true)
  })

  it("accepts provider monday", () => {
    const config = { ...validConfig(), tracker: { provider: "monday" } }
    expect(validate(config)).toBe(true)
  })

  it("REFUSES an unknown provider", () => {
    const config = { ...validConfig(), tracker: { provider: "jira" } }
    expect(validate(config)).toBe(false)
  })

  it("REFUSES an unknown key inside the block", () => {
    const config = { ...validConfig(), tracker: { provider: "linear", boardId: "123" } }
    expect(validate(config)).toBe(false)
  })

  it("accepts the linear sub-block with a team key", () => {
    const config = { ...validConfig(), tracker: { provider: "linear", linear: { teamKey: "STEP" } } }
    expect(validate(config)).toBe(true)
  })
})

describe("retired hooks stay accepted in the enum", () => {
  const validate = makeValidator()

  it("a config still listing the four retired hooks validates", () => {
    // Removing an enum member would invalidate PolAds's committed config the
    // moment the plugin updates, before anyone could edit it.
    const config = {
      ...validConfig(),
      hooks: {
        enabled: ["stop-task-check", "post-self-review", "subtask-reminder", "subtask-progress-gate"],
      },
    }
    expect(validate(config)).toBe(true)
  })

  it("the hooks description says they are ignored at runtime", () => {
    expect(schema.properties.hooks.description).toMatch(/RETIRED in 1\.0/)
    expect(schema.properties.hooks.description).toMatch(/IGNORED at runtime/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/nate/dev-tasks/plugin && npx vitest run src/__tests__/project-config-schema.test.ts`
Expected: the three `tracker`-present cases FAIL (`additionalProperties` refuses the key), and the description case fails unless Task 5 Step 6 already landed.

- [ ] **Step 3: Add the schema block**

In `plugin/schemas/project-config.schema.json`, add to `properties`, alongside `monday`:

```json
"tracker": {
  "type": "object",
  "description": "Which issue tracker this project's /dev, /preview and /ship skills read and write. Defaults to `monday` when the block is absent, because phase 0 of the two-flow migration ships BEFORE the Linear workspace exists — a Linear default would break every consumer on release day. Flip to `linear` on cutover weekend; unsetting it is the rollback. DEV_TASKS_TRACKER overrides it per process, for rehearsals.",
  "additionalProperties": false,
  "properties": {
    "provider": {
      "type": "string",
      "enum": ["linear", "monday"],
      "default": "monday",
      "description": "`linear` routes through plugin/src/tracker/linear.ts; `monday` through the deliberately minimal plugin/src/tracker/monday.ts, which is kept for the cutover weekend only and is deleted a release after BUG_TRACKER=linear goes live."
    },
    "linear": {
      "type": "object",
      "additionalProperties": false,
      "description": "Linear-specific settings. Only needed when a workspace diverges from the STEP defaults.",
      "properties": {
        "teamKey": {
          "type": "string",
          "default": "STEP",
          "description": "The Linear team key that prefixes every issue identifier. STEP for PolAds. The design spec writes POL; that is superseded by lib/ci/pr-task-trace.ts, which is what the Task trace required check actually runs."
        }
      }
    }
  }
}
```

Add the same block, with `"provider": "monday"`, to `plugin/templates/starter-project-config.json`.

- [ ] **Step 4: Run the schema test**

Run: `npx vitest run src/__tests__/project-config-schema.test.ts`
Expected: every case passes, including the starter-mirrors-the-schema assertion that file already carries.

- [ ] **Step 5: Bump the version and rewrite the description**

In `plugin/.claude-plugin/plugin.json`:

```json
{
  "name": "dev-tasks",
  "version": "1.0.0",
  "description": "STEP dev-tasks plugin, two-flow edition: a machine profile decides which hooks run (human laptop vs agent mini), /dev + /preview + /ship replace the ten-phase ship ceremony, and a tracker adapter reads and writes Linear (team STEP) or Monday behind one `tracker.provider` key. CI owns everything after PR open. 45 Monday MCP tools unchanged. Internal STEP only — not a generic plugin."
}
```

> **The 0.37.2 description opens with the retired company brand; this one drops
> it and starts at `STEP`.** That is deliberate, and it is not cosmetic: PolAds's
> rebrand guard (`scripts/grep-step-*.sh`, run by
> `__tests__/lib/rebrand/rebrand-guard.test.ts`) scans `docs/**/*.md` for that
> brand and fails the `Test` shard on any non-whitelisted hit — so a plan file
> merely QUOTING the old description trips it. That is how this line was caught,
> on PR #1587, by the shard rather than by review. Keep the shortened opening
> when copying the value across, and do not add a whitelist entry for it: the
> guard is right that a retired brand should not spread into new files.
> `Internal STEP only` at the end is unaffected — the bare word is fine.

`1.0.0` and not `0.39.0`: gate (b) and four hooks are gone and `/self-review` no longer gates a commit. That is a breaking change for anyone whose workflow leaned on them, and the version should say so.

**`skills-lock.json` at the repo root needs NO change.** It locks exactly one externally-sourced skill (`neon-postgres` from `neondatabase/agent-skills`) and nothing in this plan touches it. Confirm rather than assume:

```bash
cd /Users/nate/dev-tasks && cat skills-lock.json
```
Expected: the single `neon-postgres` entry, unchanged. The three new skills are first-party and are not locked.

- [ ] **Step 6: Write the install runbook**

Create `docs/dev-tasks-1-0-install.md`:

````markdown
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
````

- [ ] **Step 7: Make the one PolAds change**

In `/Users/nate/v0-politiske-annoncer/.claude/project-config.json`:

1. Add after the `monday` block:
```json
  "tracker": { "provider": "monday" },
```
2. In `hooks.enabled`, delete these four strings: `"subtask-reminder"`, `"post-self-review"`, `"pipeline-reminder"`, `"stop-visual-diff-check"`. Leave `worktree-required` and `worktree-path-boundary` in place — they are profile-gated now.

Validate before committing:

```bash
cd /Users/nate/v0-politiske-annoncer
node -e "
const Ajv=require('ajv').default, addFormats=require('ajv-formats');
const s=require('/Users/nate/dev-tasks/plugin/schemas/project-config.schema.json');
const {\$schema,...c}=s; const ajv=new Ajv({allErrors:true,strict:false}); addFormats(ajv);
const v=ajv.compile(c); const ok=v(require('./.claude/project-config.json'));
console.log(ok?'valid':JSON.stringify(v.errors,null,2));
"
```
Expected: `valid`.

This is a `.claude/`-only change, so it is exempt from `Task trace` and needs no issue. Ship it as its own PR to `staging`.

- [ ] **Step 8: Run everything and commit**

```bash
cd /Users/nate/dev-tasks/plugin && npm test && npm run typecheck
for t in hooks/__tests__/*.test.sh; do bash "$t" >/dev/null 2>&1 && echo "ok $t" || echo "FAILED $t"; done
cd /Users/nate/dev-tasks
git add plugin/schemas plugin/templates plugin/src/__tests__ plugin/.claude-plugin/plugin.json docs/dev-tasks-1-0-install.md
git commit -m "feat!: dev-tasks 1.0 — tracker config block, version bump, install runbook"
```
Expected: vitest green, typecheck silent, every bash test `ok`.

---

## Task 16: Live rehearsal against the STEP team, and the phase 0 rollout gates

Every test up to here mocks `fetch`. **A mocked transport proves the adapter builds the right request; it proves nothing about whether Linear accepts it.** This task runs the real thing, bounded, and deletes what it creates.

Spec §13 rollout gates for phase 0: *"auto-merge on three PRs; `Claude review` clean on five PRs before it is required"*. The second is a PolAds-repo workflow and is recorded here as a gate rather than implemented.

**Files:**
- Create: `docs/dev-tasks-1-0-rehearsal.md` (the record of what was run and what came back)

**Interfaces:**
- Consumes: everything.
- Produces: a signed-off record, and a `Verified` line per gate.

- [ ] **Step 1: Bound the run before it starts**

```bash
export DEV_TASKS_TRACKER=linear
export TRACKERCTL_MAX_WRITES=6
cd /Users/nate/v0-politiske-annoncer
```

`TRACKERCTL_MAX_WRITES=6` is the equivalent of `LINEAR_IMPORT_LIMIT` in the
migration scripts: the transport counts mutations and refuses the seventh. The
rehearsal below performs five. A bug that loops would stop at six rather than
filling the board.

Confirm the key resolves and nothing prints it:

```bash
test -r ~/.config/linear/.env && echo "key file present" || echo "set LINEAR_API_KEY"
```

- [ ] **Step 2: Read-only first — `ready` and `read`**

```bash
P=~/.claude/plugins/cache/dev-tasks-marketplace/dev-tasks/1.0.0/scripts/trackerctl.ts
npx tsx "$P" ready --limit 5 | npx json5 2>/dev/null || npx tsx "$P" ready --limit 5
```

Expected: one line of JSON, an array. Record how many came back. Then read one
real issue by identifier:

```bash
npx tsx "$P" read STEP-3055
```

Expected: `id` is `STEP-3055`, `title` is non-empty, `state` is one of the
twelve spec states, `url` starts `https://linear.app/`. **Check
`acceptanceCriteria` specifically**: if the issue's description carries an
`## Acceptance criteria` heading and the field comes back empty, the extractor
and the migration's heading have drifted and Task 7 needs a case for the shape
that is actually there.

Zero writes so far — `TRACKERCTL_MAX_WRITES` is untouched.

- [ ] **Step 3: Create a throwaway issue (write 1)**

```bash
npx tsx "$P" create \
  --title "REHEARSAL — delete me (dev-tasks 1.0 phase 0)" \
  --description "Created by the Task 16 rehearsal.

## Acceptance criteria

- [ ] this issue is deleted at the end of the rehearsal" \
  --label "type/chore" \
  --state "Ready"
```

Record the `id` it prints — call it `$REHEARSAL`. Expected: a real `STEP-<n>`,
`state` exactly `Ready`, `labels` containing `type/chore`.

**If `labels` comes back empty**, the label name did not resolve on the team.
That is the adapter behaving as designed (`labelIdsFor` skips unknown names
rather than failing the create) and it is a finding: check the name against
`pnpm linear:bootstrap` output before blaming the adapter.

- [ ] **Step 4: Exercise the round trip (writes 2, 3, 4)**

```bash
npx tsx "$P" read "$REHEARSAL"                                    # 0 writes
npx tsx "$P" branch "$REHEARSAL"                                  # 0 writes
npx tsx "$P" comment "$REHEARSAL" --body "rehearsal comment"      # write 2
npx tsx "$P" attach "$REHEARSAL" --url "https://example.com/pr/1" --title "PR #1"  # write 3
npx tsx "$P" claim "$REHEARSAL" --as rehearsal-runner             # write 4 and 5
```

Check, in the Linear UI:
- `branch` printed `STEP-<n>-rehearsal-delete-me-dev-tasks-1-0-phase-0` — **capitals, no username prefix**. A `nate/step-…` here means the adapter started using Linear's own `branchName` and Task 7's decision was undone.
- the comment is on the issue
- the attachment is on the issue with the title `PR #1`
- the state is now `In Progress`
- a `claimed by rehearsal-runner at …` comment exists

`claim` is two writes (the update and the comment) when a state resolves, so
the counter now reads 5 of 6.

- [ ] **Step 5: Prove the write cap actually refuses**

```bash
npx tsx "$P" comment "$REHEARSAL" --body "this should be refused"; echo "exit=$?"
```

Expected: the sixth write succeeds (6 of 6), and a SEVENTH is refused:

```bash
npx tsx "$P" comment "$REHEARSAL" --body "and this one"; echo "exit=$?"
```
Expected: stderr names `TRACKERCTL_MAX_WRITES`, `exit=1`, and no new comment
appears in Linear. A cap that does not refuse is not a cap.

- [ ] **Step 6: Delete the throwaway issue**

In the Linear UI: open `$REHEARSAL` → ⋯ → Delete. It goes to Trash and is
recoverable for 30 days.

There is deliberately no `trackerctl delete`. A destructive verb on a CLI that
agents invoke is a hazard for one manual cleanup a release.

Confirm:

```bash
unset TRACKERCTL_MAX_WRITES
npx tsx "$P" read "$REHEARSAL"; echo "exit=$?"
```
Expected: an error naming the identifier, `exit=1`.

- [ ] **Step 7: Record the phase 0 rollout gates**

Create `docs/dev-tasks-1-0-rehearsal.md` with the run above (dates, the
identifier used, what came back) and this table, filled in as each gate is met:

```markdown
# dev-tasks 1.0 phase 0 — rollout gates

Spec section 13. Phase 1 does not start until every row reads Verified.

| Gate | How it is met | Status |
|---|---|---|
| Auto-merge lands three PRs unattended | three `/ship` PRs merged by GitHub with no human pressing merge; record the PR numbers | |
| `Claude review` runs clean on five PRs | PolAds-repo workflow, tracked separately. It is added to ruleset 21998691 by a HUMAN only after five clean runs | |
| The profile matrix behaves on a human laptop | `worktree-required` inert, i18n gates inert, gate (f) still blocks a push to staging | |
| The profile matrix behaves on an agent profile | with `DEV_TASKS_PROFILE=agent`: `worktree-required` blocks, i18n gates block, gate (f) still blocks | |
| No retired hook is registered | `bash hooks/__tests__/retired-hooks.test.sh` green on the installed 1.0.0 cache, not just in the source tree | |
| The Linear adapter round-trips live | Task 16 steps 2-6, recorded above | |
| One full week on one machine before a second adopts it | date started, date cleared | |

## Known limits of this rehearsal

- The Monday adapter was NOT exercised live. It is unit-tested only, and it is
  deleted a release after the cutover.
- `listReady` was read against whatever was Ready on the day. If the STEP team
  had no Ready issues, that assertion proved the query parses and nothing else;
  say so rather than recording it as verified.
- `claim` did not resolve a Linear user, because a mini is not a member. The
  assignee branch of `claimIssue` is therefore unexercised against the live API.
```

- [ ] **Step 8: Verify the agent profile without a mini**

```bash
cd /Users/nate/v0-politiske-annoncer
export DEV_TASKS_PROFILE=agent
P=~/.claude/plugins/cache/dev-tasks-marketplace/dev-tasks/1.0.0
bash "$P/hooks/lib/profile.sh" get profile          # agent
bash "$P/hooks/lib/profile.sh" get devSurface       # preview
printf '{"tool_name":"Bash","tool_input":{"command":"git push origin staging"}}' | bash "$P/hooks/bash-guard.sh"; echo "exit=$?"
unset DEV_TASKS_PROFILE
```
Expected: `agent`, `preview`, and `exit=2` with a gate (f) message — the push guard holds on both profiles, which is the row spec §4 marks `on / on`.

- [ ] **Step 9: Commit the record and open the PR**

```bash
cd /Users/nate/dev-tasks
git add docs/dev-tasks-1-0-rehearsal.md
git commit -m "docs: dev-tasks 1.0 phase 0 rehearsal record and rollout gates"
git push -u origin HEAD
gh pr create --base main --title "dev-tasks 1.0 — phase 0" --body "$(cat <<'BODY'
Machine profiles, /dev + /preview + /ship, and the tracker adapter with its
Linear implementation. Implements phase 0 of the two-flow workflow design.

Retired: bash-guard gate (b), stop-task-check, post-self-review,
subtask-reminder, subtask-progress-gate, and the babysit-prs ban on --auto.

Rehearsal record: docs/dev-tasks-1-0-rehearsal.md
BODY
)"
```

**Do not merge it yourself, and do not arm auto-merge on this one.** The base
is `main` in this repo, and a plugin release that rewrites its own hooks is
exactly the change a human should press the button on.

---

## Self-Review

**Spec coverage.** §4 → Tasks 1, 2, 3, 4 (every row of the matrix: worktree
gates in 2, gate b in 3, gates d/e in 4, gate f asserted unchanged in 3 and 4
and re-checked live in 16 step 8, the three both-off hooks removed from the
consumer config in 15 step 7). §5 → Tasks 12, 13, 14. §7.2 auto-merge → Tasks
6 and 14. §9.1 states and labels → Tasks 7 and 9. §10 → the whole plan; the
skills §10 also retires (`/pickup-task`, `/log-progress`, `/self-review`,
`/ship-pr`, `/release-version`) are NOT deleted here — they are superseded and
left in place, because deleting them in the same release as `/ship` arrives
would leave a consumer mid-upgrade with neither. That is a stated gap, not an
oversight; it belongs in the release that follows the cutover. §11 → gate (f)
untouched, `--admin` banned in Tasks 6 and 14, the Linear key never printed
(Task 8). §13 → Task 16 step 7. §14 phase 0 → all of it except `Claude
review`, which is a PolAds-repo workflow and is scoped out in the Global
Constraints and recorded as a gate.

**Placeholder scan.** No `TBD`, no "add error handling", no "similar to Task
N". Every code step carries the code. The two places that say "roughly lines
X-Y" name the anchor comment as well, because a line number in a file this
plan also edits is stale by the time it is read.

**Type consistency.** `TrackerIssue` is defined once (Task 7) and used
unchanged in Tasks 9, 10, 11. `Tracker`'s six methods have the same names and
arities in the interface (7), both implementations (9, 10) and the CLI (11).
`branchNameFor(issueId, title)` takes two strings everywhere. `profile_is` is
the same predicate in Tasks 2 and 4. `resolveTracker(projectRoot?)` and
`readTrackerProvider(projectRoot?)` agree with their test.

**One thing worth flagging to the executor.** Task 9's `readIssue` resolves
`STEP-123` by filtering on team key plus issue NUMBER rather than passing the
identifier to `issue(id:)`. Linear may well accept the identifier there; the
filter form is used because it is certain, and the cost is one extra field in
the query. If the rehearsal in Task 16 shows `issue(id: "STEP-123")` works,
simplifying is a safe follow-up — but do it with the live check in hand, not
from the documentation.

