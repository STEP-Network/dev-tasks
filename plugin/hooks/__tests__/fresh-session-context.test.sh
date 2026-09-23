#!/usr/bin/env bash
# A fresh session plus one Edit must add no plugin rule text to the model's
# context (STEP-3088). Rules are read on demand: a skill names the rule it
# needs, and no hook pushes one in.
#
# Replays a session the way Claude Code would: every hook hooks.json registers
# for SessionStart, then UserPromptSubmit, then PreToolUse and PostToolUse for
# an Edit of lib/example.ts. It keeps only what reaches the model:
#   SessionStart, UserPromptSubmit  stdout, as plain text or JSON additionalContext
#   PreToolUse, PostToolUse         hookSpecificOutput.additionalContext, a deny
#                                   reason, or a block reason from JSON stdout
#   any event                       stderr of a hook that exits 2
# Everything else (other stdout, stderr on exit 0) goes to Claude Code's debug
# log only. Hooks with an `if` filter are skipped: those filters name .env,
# lockfiles, secrets and Bash commands, never a lib/*.ts edit.
#
# Two projects, each run from the main checkout and from a worktree:
#   linear  tracker.provider linear, PolAds' hooks.enabled[] (2026-09-23), no
#           active task. Must add 0 bytes.
#   monday  the starter template's config. Must add no rule text. Case D from
#           active-task-recon is expected in the worktree session.
#
# No network: MONDAY_API_KEY is unset and gh/curl are stubs that fail.
# Run with: bash plugin/hooks/__tests__/fresh-session-context.test.sh

set -u
unset MONDAY_API_KEY DEV_TASKS_TRACKER DEV_TASKS_PROFILE

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TEST_DIR/../.." && pwd)"
HOOKS_JSON="$ROOT/hooks/hooks.json"

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d -t fresh-session-XXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/tmp" "$WORK/bin"
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/gh"
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/curl"
chmod +x "$WORK/bin/gh" "$WORK/bin/curl"

POLADS_ENABLED='["worktree-required","worktree-path-boundary","protect-sensitive-files","pre-commit-secrets-scan","auto-file-followup-nudge","post-merge-postmortem","post-push-track","post-push-review-check","pre-compact-task-snapshot","user-prompt-task-context","subprocess-failure","build-failure-advisor"]'

# new_project <name> <project-config-json> → echoes the repo dir. The repo has a
# worktree at .claude/worktrees/feat-example whose branch is one commit ahead,
# so the janitor classifies it IN-FLIGHT and leaves it alone.
new_project() {
  local repo="$WORK/$1"
  mkdir -p "$repo/lib" "$repo/.claude"
  printf '%s\n' "$2" > "$repo/.claude/project-config.json"
  printf 'export const a = 1\n' > "$repo/lib/example.ts"
  printf '.claude/worktrees/\n' > "$repo/.gitignore"
  git -C "$repo" init -q -b main
  git -C "$repo" add -A
  git -C "$repo" -c user.email=t@example.com -c user.name=t commit -q -m init
  git -C "$repo" worktree add -q -b feat/example "$repo/.claude/worktrees/feat-example"
  printf 'export const b = 2\n' >> "$repo/.claude/worktrees/feat-example/lib/example.ts"
  git -C "$repo/.claude/worktrees/feat-example" -c user.email=t@example.com -c user.name=t \
    commit -q -am wip
  printf '%s' "$repo"
}

# commands_for <event> [tool] → one hook command per line, placeholder resolved
commands_for() {
  jq -r --arg ev "$1" --arg tool "${2:-}" '
    .hooks[$ev][]?
    | select($tool == "" or ((.matcher // "") | split("|") | index($tool)) != null)
    | .hooks[] | select(has("if") | not) | .command' "$HOOKS_JSON" \
    | sed "s|\${CLAUDE_PLUGIN_ROOT}|$ROOT|g"
}

# visible <event> <stdout-file> <stderr-file> <exit-code> → what the model sees
visible() {
  local ev="$1" out="$2" err="$3" rc="$4"
  if [ "$rc" -eq 2 ]; then
    cat "$err"
    return
  fi
  if jq -e 'type == "object"' "$out" >/dev/null 2>&1; then
    jq -j '[.hookSpecificOutput.additionalContext,
            (if .hookSpecificOutput.permissionDecision == "deny"
               then .hookSpecificOutput.permissionDecisionReason else empty end),
            (if .decision == "block" then .reason else empty end)]
           | map(select(. != null and . != "")) | join("\n")' "$out"
  elif [ "$ev" = "SessionStart" ] || [ "$ev" = "UserPromptSubmit" ]; then
    cat "$out"
  fi
}

# run_session <label> <cwd> <project-dir> → prints per-hook bytes, writes the
# model-visible text to $WORK/<label>.seen
run_session() {
  local label="$1" cwd="$2" project="$3"
  local seen="$WORK/$label.seen" sid="sess-$label"
  local file="$cwd/lib/example.ts"
  : > "$seen"
  local ev tool payload cmd rc bytes
  for step in SessionStart UserPromptSubmit PreToolUse:Edit PostToolUse:Edit; do
    ev="${step%%:*}"; tool=""
    [ "$ev" != "$step" ] && tool="${step#*:}"
    payload=$(jq -nc --arg sid "$sid" --arg cwd "$cwd" --arg ev "$ev" --arg fp "$file" '
      {session_id: $sid, cwd: $cwd, hook_event_name: $ev}
      + (if $ev == "SessionStart" then {source: "startup"}
         elif $ev == "UserPromptSubmit" then {prompt: "Rename the constant in lib/example.ts"}
         else {tool_name: "Edit",
               tool_input: {file_path: $fp, old_string: "a", new_string: "b"}}
              + (if $ev == "PostToolUse" then {tool_response: {filePath: $fp, success: true}}
                 else {} end)
         end)')
    while IFS= read -r cmd; do
      [ -n "$cmd" ] || continue
      ( cd "$cwd" && HOME="$WORK/home" TMPDIR="$WORK/tmp" PATH="$WORK/bin:$PATH" \
          CLAUDE_PLUGIN_ROOT="$ROOT" CLAUDE_PROJECT_DIR="$project" \
          bash -c "$cmd" <<<"$payload" >"$WORK/out" 2>"$WORK/err" )
      rc=$?
      visible "$ev" "$WORK/out" "$WORK/err" "$rc" > "$WORK/vis"
      bytes=$(wc -c < "$WORK/vis" | tr -d ' ')
      printf '    %-17s %-28s %6s bytes\n' "$ev" "$(basename "${cmd%% *}")" "$bytes"
      cat "$WORK/vis" >> "$seen"
    done < <(commands_for "$ev" "$tool")
  done
}

# no_rule_text <label> → fails if any plugin rule's H1 reached the model
no_rule_text() {
  local label="$1" seen="$WORK/$1.seen" leaked="" h1
  for rule in "$ROOT"/rules/*.md; do
    h1="$(head -1 "$rule")"
    grep -qxF "$h1" "$seen" && leaked="$leaked $(basename "$rule")"
  done
  if [ -z "$leaked" ]; then
    pass "$label: no plugin rule text reached the model"
  else
    fail "$label: rule text reached the model:$leaked"
  fi
}

LINEAR=$(new_project linear \
  "{\"tracker\":{\"provider\":\"linear\"},\"hooks\":{\"enabled\":$POLADS_ENABLED}}")
MONDAY=$(new_project monday "$(cat "$ROOT/templates/starter-project-config.json")")

for spec in "linear-main:$LINEAR:$LINEAR" \
            "linear-worktree:$LINEAR/.claude/worktrees/feat-example:$LINEAR/.claude/worktrees/feat-example" \
            "monday-main:$MONDAY:$MONDAY" \
            "monday-worktree:$MONDAY/.claude/worktrees/feat-example:$MONDAY/.claude/worktrees/feat-example"; do
  IFS=: read -r label cwd project <<<"$spec"
  echo "==> $label: SessionStart + one prompt + one Edit of lib/example.ts"
  run_session "$label" "$cwd" "$project"
  no_rule_text "$label"
  total=$(wc -c < "$WORK/$label.seen" | tr -d ' ')
  case "$label" in
    linear-*)
      if [ "$total" -eq 0 ]; then
        pass "$label: 0 bytes added to the model's context"
      else
        fail "$label: $total bytes added: $(head -c 300 "$WORK/$label.seen")"
      fi
      ;;
    *)
      echo "    total: $total bytes"
      ;;
  esac
done

# The janitor must not have collected the worktrees the sessions ran in.
if [ -d "$LINEAR/.claude/worktrees/feat-example" ] && [ -d "$MONDAY/.claude/worktrees/feat-example" ]; then
  pass "fixture worktrees survived the janitor"
else
  fail "a fixture worktree was removed; the worktree sessions did not run where intended"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
