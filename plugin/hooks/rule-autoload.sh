#!/usr/bin/env bash
# dev-tasks plugin — PreToolUse rule-autoload hook
#
# Fires on Edit|Write|MultiEdit|NotebookEdit. Reads the target file path from
# tool_input, matches it against rules-routing.json globs, and injects the
# matching rule markdown files via PreToolUse hookSpecificOutput.additionalContext.
#
# Session-scoped dedup: each rule file is injected at most ONCE per session
# (tracked via a marker file in $TMPDIR keyed by session_id). Subsequent edits
# matching the same rule do not re-inject — keeps token cost bounded.
#
# Fail-open: any error / missing config / empty match → exits 0 silently and
# does NOT block the Edit/Write.

set -uo pipefail
# extglob enables extended patterns; globstar (** crosses dirs) only exists in bash 4+,
# but bash 3.2's [[ ]] pattern matching treats * as "any chars including slashes" anyway,
# so ** in our routing globs works either way. Silence the warning on 3.2.
shopt -s extglob nullglob
shopt -s globstar 2>/dev/null || true

# --- read input --------------------------------------------------------------
INPUT=$(cat) || exit 0
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null || printf '')
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || printf '')

[ -z "$FILE_PATH" ] && exit 0

# --- locate plugin assets ----------------------------------------------------
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -z "$PLUGIN_ROOT" ] && exit 0

ROUTING_FILE="$PLUGIN_ROOT/rules-routing.json"
RULES_DIR="$PLUGIN_ROOT/rules"
[ ! -f "$ROUTING_FILE" ] && exit 0
[ ! -d "$RULES_DIR" ] && exit 0

# --- session-scoped dedup setup ----------------------------------------------
MARKER_FILE=""
if [ -n "$SESSION_ID" ]; then
  MARKER_DIR="${TMPDIR:-/tmp}/dev-tasks"
  MARKER_FILE="$MARKER_DIR/injected-${SESSION_ID}.list"
  mkdir -p "$MARKER_DIR" 2>/dev/null || MARKER_FILE=""
fi

ALREADY_INJECTED=""
if [ -n "$MARKER_FILE" ] && [ -f "$MARKER_FILE" ]; then
  ALREADY_INJECTED="$(cat "$MARKER_FILE" 2>/dev/null || printf '')"
fi

# --- find matching rule files ------------------------------------------------
# Read rules-routing.json as TSV: <file>\t<json-array-of-globs>
declare -a TO_INJECT=()
while IFS=$'\t' read -r rule_file patterns_json; do
  [ -z "$rule_file" ] && continue

  # Skip if already injected this session
  if [ -n "$ALREADY_INJECTED" ]; then
    if printf '%s\n' "$ALREADY_INJECTED" | grep -qxF "$rule_file"; then
      continue
    fi
  fi

  # Check if any glob matches the file path
  matched=0
  while IFS= read -r pattern; do
    [ -z "$pattern" ] && continue
    if [[ "$FILE_PATH" == $pattern ]]; then
      matched=1
      break
    fi
  done < <(printf '%s' "$patterns_json" | jq -r '.[]' 2>/dev/null || printf '')

  if [ "$matched" -eq 1 ]; then
    TO_INJECT+=("$rule_file")
  fi
done < <(jq -r '.rules[] | [.file, (.match | @json)] | @tsv' "$ROUTING_FILE" 2>/dev/null || printf '')

[ ${#TO_INJECT[@]} -eq 0 ] && exit 0

# --- read rule files + concatenate -------------------------------------------
CONTENT=""
for rule_file in "${TO_INJECT[@]}"; do
  rule_path="$RULES_DIR/$rule_file"
  if [ -f "$rule_path" ]; then
    CONTENT+="$(cat "$rule_path")"
    CONTENT+=$'\n\n---\n\n'
  fi
done

[ -z "$CONTENT" ] && exit 0

# --- record what we're about to inject ---------------------------------------
if [ -n "$MARKER_FILE" ]; then
  for rule_file in "${TO_INJECT[@]}"; do
    printf '%s\n' "$rule_file" >> "$MARKER_FILE"
  done
fi

# --- emit additionalContext JSON ---------------------------------------------
jq -n --arg ctx "$CONTENT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'
