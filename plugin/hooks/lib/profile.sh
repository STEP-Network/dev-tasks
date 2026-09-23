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
