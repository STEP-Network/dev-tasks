#!/usr/bin/env bash
# monday-task-flow plugin — project-config reader helper
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
