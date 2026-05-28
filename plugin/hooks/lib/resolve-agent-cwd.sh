#!/usr/bin/env bash
# dev-tasks plugin — agent cwd resolver
#
# Claude Code passes the agent's actual cwd in every hook payload's `cwd` field.
# Hooks should prefer that over `$CLAUDE_PROJECT_DIR`, which Claude Code sets at
# session start to the main checkout and never updates when the agent enters a
# worktree. Without this preference, hooks that compute SHA-scoped or
# branch-scoped state from `$PROJECT_ROOT = $CLAUDE_PROJECT_DIR` see MAIN's
# state, not the WORKTREE's — causing marker key/value mismatches, stale state
# file reads, and silent bad-paths.
#
# Usage in a hook:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"
#   INPUT=$(cat)
#   AGENT_CWD=$(resolve_agent_cwd "$INPUT")
#   PROJECT_ROOT="${AGENT_CWD:-${CLAUDE_PROJECT_DIR:-$PWD}}"
#
# Returns empty string when the input is not JSON or doesn't contain `cwd`.
# Callers must use the fallback chain shown above.

resolve_agent_cwd() {
  local input="$1"
  # NOTE: the python source below is interpolated as a double-quoted shell
  # string, so backticks and unescaped $ would be evaluated by bash. Keep the
  # python body free of those shell metacharacters.
  printf '%s' "$input" | python3 -c "
import sys, json
try:
    # get(key) defaults to None on missing; for JSON null the value IS None.
    # print(None) emits the literal string None, which callers misinterpret
    # as a valid path. Coerce with 'or empty-string' so missing AND null both
    # produce empty output and the caller fallback chain triggers.
    print(json.load(sys.stdin).get('cwd') or '')
except Exception:
    pass
" 2>/dev/null
}
