#!/usr/bin/env bash
# dev-tasks plugin — project-config reader helper
#
# Source this from any plugin hook that needs to read project-config.json.
# Provides:
#   read_project_config <jq-path>   → prints the value of the given jq path
#                                     from $CLAUDE_PROJECT_DIR/.claude/project-config.json
#   project_config_exists           → returns 0 if config exists, 1 otherwise
#   tracker_provider [dir]          → prints linear|monday (fallbacks warn on stderr)
#
# All output goes to stdout; errors are silent (returns empty string on miss).
# Callers should handle empty output appropriately.

# Locate the project config. CLAUDE_PROJECT_DIR is set by Claude Code.
_project_config_path() {
  local project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  printf '%s/.claude/project-config.json' "$project_dir"
}

project_config_exists() {
  local path
  path="$(_project_config_path)"
  [ -f "$path" ]
}

# read_project_config <jq-path>
# Example: read_project_config '.git.defaultBase'
read_project_config() {
  local jq_path="$1"
  local path
  path="$(_project_config_path)"
  [ ! -f "$path" ] && return 0
  jq -r "$jq_path // empty" "$path" 2>/dev/null || true
}

# hook_enabled <hook-name>
# Returns 0 (true) if the hook is listed in project-config's hooks.enabled[] array.
# Returns 1 (false) if no project-config exists or the hook isn't listed.
# Use at the top of each blocking hook: `hook_enabled "task-state-guard" || exit 0`
# Default behavior is OPT-IN — consumer projects must explicitly enable each hook
# to avoid blocking edits in projects that don't follow this workflow.
hook_enabled() {
  local hook_name="$1"
  local path
  path="$(_project_config_path)"
  [ ! -f "$path" ] && return 1
  local result
  result=$(jq -r --arg name "$hook_name" '(.hooks.enabled // []) | index($name) // empty' "$path" 2>/dev/null)
  [ -n "$result" ]
}

# tracker_provider [dir]
# Prints `linear` or `monday`: the answer readTrackerProvider in
# src/tracker/index.ts gives for the same directory, so a hook and trackerctl
# never disagree. DEV_TASKS_TRACKER wins when it is `linear` or `monday`.
# Otherwise it reads .claude/project-config.json at the git toplevel of the
# directory (a worktree's own root, since the config is committed), or in the
# directory itself outside git. The directory defaults to $PWD. No tracker
# block means `monday`. A missing or unparseable file, or a value that is not
# `linear` or `monday`, also means `monday`, with a `dev-tasks:` line on
# stderr worded like the TypeScript one.
# Use it to keep a Monday-only hook quiet in a Linear project:
#   [ "$(tracker_provider "$PWD")" = "monday" ] || exit 0
tracker_provider() {
  local dir="${1:-$PWD}" root path provider
  case "${DEV_TASKS_TRACKER:-}" in
    linear|monday) printf '%s' "$DEV_TASKS_TRACKER"; return 0 ;;
    "") ;;
    *) printf 'dev-tasks: ignoring DEV_TASKS_TRACKER="%s": it must be "linear" or "monday".\n' \
         "$DEV_TASKS_TRACKER" >&2 ;;
  esac

  root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || root=""
  path="${root:-$dir}/.claude/project-config.json"
  if [ ! -f "$path" ] || [ ! -r "$path" ]; then
    printf 'dev-tasks: could not read %s; using the monday tracker. Set tracker.provider there, or DEV_TASKS_TRACKER.\n' \
      "$path" >&2
    printf 'monday'
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    printf 'dev-tasks: jq not found, cannot read %s; using the monday tracker.\n' "$path" >&2
    printf 'monday'
    return 0
  fi

  # tojson keeps a string's quotes, so "linear" and a non-string are told
  # apart, and the warning prints the value the way JSON.stringify does.
  if ! provider=$(jq -s -r 'if length != 1 then error("not one JSON value") else .[0] end
      | .tracker? | select(type == "object") | select(has("provider"))
      | .provider | tojson' "$path" 2>/dev/null); then
    printf 'dev-tasks: %s is not valid JSON; using the monday tracker.\n' "$path" >&2
    printf 'monday'
    return 0
  fi
  case "$provider" in
    '"linear"') printf 'linear' ;;
    '"monday"'|"") printf 'monday' ;;
    *) printf 'dev-tasks: tracker.provider %s in %s is not "linear" or "monday"; using the monday tracker.\n' \
         "$provider" "$path" >&2
       printf 'monday' ;;
  esac
}
