#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "auto-file-followup-nudge" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "auto-file-followup-nudge" || exit 0
# Hook: PostToolUse (Bash) — non-blocking nudge
# Fires when the agent applies a "should-have-filed-an-issue" pattern (CI ack
# writes, `gh run rerun --failed`, etc.) and reminds it to file the underlying
# Bug / Retro / Task before moving on.
#
# Rationale: the agent's auto-filing discipline (memory:feedback_auto_file_retros.md
# + rules/meta-workflow.md) tells WHEN to file. This hook surfaces specific
# observable triggers in the moment, so the discipline can't be missed
# (demonstrated failure mode: PR #248 had a Test flake acked without underlying
# Bug filing until the user noticed — retroactively filed as #2913552821).
#
# Always exits 0 — never blocks. Output goes to stderr so it surfaces in the
# agent's context without being parsed as a tool result.

INPUT=$(cat)
ACTUAL_CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)
[ -z "$ACTUAL_CMD" ] && exit 0

NUDGE=""

# Trigger 1: CI ack file written → underlying flake should be filed as Bug
if echo "$ACTUAL_CMD" | grep -qE '/tmp/\.claude-ci-ack-[^[:space:]]+' ; then
  NUDGE="${NUDGE}AUTO-FILE NUDGE: CI ack file written. If you haven't already, file the underlying flake as a Bug via mcp__plugin_dev-tasks_dev-tasks__createBug — include suite name + error excerpt + hypothesized root cause. Acking without filing leaves the issue invisible to future maintainers.\n"
fi

# Trigger 2: gh run rerun --failed → confirmed-repeating flake, file Bug if not already
if echo "$ACTUAL_CMD" | grep -qE 'gh run rerun.*--failed' ; then
  NUDGE="${NUDGE}AUTO-FILE NUDGE: re-running a failed CI job. If this is the second+ rerun for the same suite, the flake is confirmed repeating — file a Bug if you haven't (mcp__plugin_dev-tasks_dev-tasks__createBug) so the root cause gets tracked even if the rerun passes.\n"
fi

# Trigger 3: `git revert` or `git push --force` on a published commit → file Retro
# describing what went wrong (not the revert itself — the underlying class of mistake)
if echo "$ACTUAL_CMD" | grep -qE '^git revert ' ; then
  NUDGE="${NUDGE}AUTO-FILE NUDGE: git revert applied. If this is reverting a published commit, file a Retro (mcp__plugin_dev-tasks_dev-tasks__createRetro, type: Improve) describing the class of mistake — not the revert itself, but what process gap allowed the bad commit through (review, gate, test missing?).\n"
fi

# Trigger 4: writing a TODO comment via Edit/Write is not visible here (different
# matcher) — covered by .claude/rules/meta-workflow.md instead.

if [ -n "$NUDGE" ]; then
  # PostToolUse hook output to stderr is visible to the agent as system context
  echo -e "$NUDGE" >&2
fi

exit 0
