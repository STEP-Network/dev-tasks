#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "protect-sensitive-files" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "protect-sensitive-files" || exit 0
# Hook: PreToolUse (Edit|Write)
# Block writes to sensitive files, warn on schema changes
# Input: JSON on stdin with tool_input.file_path

# Read tool input from stdin (consumed once)
INPUT=$(cat)

# Extract file_path from JSON
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)
if [ -z "$FILE_PATH" ]; then
  exit 0  # Can't parse input, don't block
fi

# Explicitly allow public template files (committed to git, no secrets).
# Checked BEFORE the blocked-patterns loop so they don't trigger the `.env` block.
ALLOWED_PATTERNS=(
  ".env.example"
  ".env.sample"
  ".env.template"
)
for pattern in "${ALLOWED_PATTERNS[@]}"; do
  if echo "$FILE_PATH" | grep -qF "$pattern"; then
    exit 0
  fi
done

# Block patterns
BLOCKED_PATTERNS=(
  ".env"
  ".env.local"
  ".env.production"
  "pnpm-lock.yaml"
  "node_modules/"
  ".git/"
)

for pattern in "${BLOCKED_PATTERNS[@]}"; do
  # -F: literal string match (not regex). Prevents e.g. `.env` matching any `/env` path.
  if echo "$FILE_PATH" | grep -qF "$pattern"; then
    echo "BLOCKED: Cannot write to sensitive file: $FILE_PATH"
    echo "Pattern matched: $pattern"
    exit 2
  fi
done

# Check for files containing secrets/credentials in name
if echo "$FILE_PATH" | grep -qiE "(secret|credential)"; then
  echo "BLOCKED: File path contains sensitive keyword: $FILE_PATH"
  exit 2
fi

# Advisory warning for schema changes
if echo "$FILE_PATH" | grep -q "registration-schema.ts"; then
  echo "WARNING: You are modifying the database schema."
  echo "Remember to run /migrate-check after making changes."
  echo "Migration workflow: schema change → drizzle-kit generate → migrate:testing → validate-schema"
fi

exit 0
