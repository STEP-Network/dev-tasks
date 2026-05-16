#!/usr/bin/env bash
# dev-tasks plugin — project-config reader helper
#
# Source this from any plugin hook that needs to read project-config.json.
# Provides:
#   read_project_config <jq-path>   → prints the value of the given jq path
#                                     from $CLAUDE_PROJECT_DIR/.claude/project-config.json
#   project_config_exists           → returns 0 if config exists, 1 otherwise
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
