#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "pre-commit-secrets-scan" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "pre-commit-secrets-scan" || exit 0
# Hook: PreToolUse Bash — block git commits whose staged diff contains secret-looking
# patterns. Reduces the chance of accidentally committing API keys, tokens, or DB
# URLs with passwords.
#
# Closes part of GH issue #112 (GAP-F — secrets scan at commit time).
#
# Why: We caught a leaked Neon API key in `.mcp.json` (commit 0a3f568a in April 2026)
# only because someone happened to notice. A real gate prevents the next leak. This
# hook is a self-contained regex-based scanner — no external dependency on gitleaks
# or trufflehog. Patterns are conservative (false-negatives over false-positives) but
# cover the common cases for this codebase: Neon API keys, OpenAI keys, AWS keys,
# JWT tokens, generic high-entropy assignments.
#
# ⚠️  SCOPE LIMITATION (file in follow-up tracking):
#   This hook only fires when **Claude Code** issues a `git commit`. A developer
#   who commits directly from the terminal (`git commit -m "..."` outside Claude
#   Code) gets ZERO protection from this hook. The April 2026 Neon leak presumably
#   came from a human commit, so this hook would NOT have caught that specific
#   incident.
#
#   For full coverage, also wire up a `.git/hooks/pre-commit` (per-clone) or
#   adopt husky/lefthook (committed) that delegates to this same script. That
#   work is filed as a follow-up since it touches per-developer setup and
#   shouldn't be conflated with this hook's PreToolUse scope.
#
# Behavior:
# - Triggered on `git commit *` PreToolUse
# - Inspects `git diff --cached --no-color` (staged content)
# - On match: prints the offending line + pattern name, exits 2 (blocks tool use)
# - On clean: exits 0 (allows commit)
#
# Bypass: a commit message containing the literal token `[allow-secret]` (case-
# insensitive) lets the commit through. Use only when intentionally checking in
# a fixture or example value (e.g. a test secret of obvious-fake form like
# "sk-test-fake-12345").

INPUT=$(cat)
# Use python3 (not jq) for command extraction — python3 is on every dev machine
# and CI runner; jq isn't guaranteed. If jq were missing, COMMAND would silently
# become empty → the case below wouldn't match → the hook would no-op on every
# commit (a security gate that fails open is worse than no gate). python3
# matches the convention in bash-guard and protect-sensitive-files.sh.
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)

# Only inspect actual commit invocations.
case "$COMMAND" in
  *"git commit "*) ;;
  *) exit 0 ;;
esac

# Bypass token: the commit message author can override with [allow-secret].
# Logged to stderr so Claude Code surfaces it (stdout is sometimes suppressed by
# the runtime); keeping the bypass auditable was the whole point.
if echo "$COMMAND" | grep -qiE '\[allow-secret\]'; then
  echo "🔓 [allow-secret] bypass detected in commit command — skipping secrets scan." >&2
  exit 0
fi

# Get staged diff. `--no-color` keeps the output clean for grep.
# Pre-filter to ADDITION LINES ONLY: `^\+` matches added lines, but we must
# exclude the diff's own `+++ b/path` header lines (they also start with +).
# A simple `grep -v '^+++'` does this without polluting the per-pattern regex.
DIFF=$(git diff --cached --no-color 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+')

if [ -z "$DIFF" ]; then
  exit 0
fi

# Patterns: name|regex pairs. Case-insensitive grep. Conservative on entropy.
# False-positives are worse than false-negatives here — every alarm trains the
# user to ignore the hook, eroding its value.
FINDINGS=""

# Each pattern checks the pre-filtered addition lines. We don't anchor the
# pattern (no `^\+`) — the diff is already lines-of-additions only, and
# anchoring tripped on the case where the secret token starts immediately
# after the leading `+` (e.g. `+PASSWORD=...`).
check() {
  local name="$1" regex="$2"
  # `-i` for case-insensitive match: token prefixes (napi_/sk-/AKIA/gh[pousr]_)
  # already specify case in their character classes, so -i is a no-op for them,
  # but the generic password-assignment pattern needs to catch UPPERCASE
  # and Mixed_Case forms (e.g. `PASSWORD = "..."` in shell, `SECRET_KEY = "..."`
  # in Python constants).
  local hits
  hits=$(echo "$DIFF" | grep -niE "${regex}" 2>/dev/null | head -3)
  if [ -n "$hits" ]; then
    FINDINGS="${FINDINGS}\n[${name}]\n${hits}\n"
  fi
}

# Neon API keys (real ones look like 64+ hex/base64 chars after a `napi_` prefix)
check "neon-api-key" 'napi_[A-Za-z0-9_-]{32,}'

# OpenAI keys
check "openai-key" 'sk-[a-zA-Z0-9]{20,}'

# Anthropic keys
check "anthropic-key" 'sk-ant-[a-zA-Z0-9_-]{20,}'

# AWS access key IDs
check "aws-access-key" 'AKIA[0-9A-Z]{16}'

# Vercel API tokens (24 hex chars after `vercel_`)
check "vercel-token" 'vercel_[a-zA-Z0-9]{20,}'

# GitHub tokens (gh[pousr]_...)
check "github-token" 'gh[pousr]_[A-Za-z0-9]{36,}'

# Resend API keys (codebase uses Resend for email — see lib/email/*.tsx)
check "resend-key" 're_[A-Za-z0-9_-]{20,}'

# Upstash Redis URL with token (codebase uses Upstash for rate limiting —
# see lib/rate-limit.ts). Connection strings include the token after the host.
check "upstash-url" '(upstash-redis|rediss?)://[^:/@[:space:]]*:[^@[:space:]]+@[^[:space:]]*upstash'

# JWTs (three base64 segments separated by dots)
check "jwt" 'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_=-]+'

# postgres:// or postgresql:// URLs containing a non-empty password
# (passwords are between : and @ after the user). Catches connection strings
# with secrets in line.
check "postgres-url-with-password" 'postgres(ql)?://[^:/@[:space:]]+:[^@[:space:]]+@'

# Generic high-entropy assignment: `password = "..."` or `secret = "..."` with
# a value of >= 12 chars. Prone to false-positives, so we keep the threshold
# conservative. We use a double-quoted regex (so the shell doesn't strip
# backslashes) and pre-build a quote class with both ' and " literal.
QUOTE_CLASS="[\"']"
NOT_QUOTE_CLASS="[^\"']"
check "password-assignment" "(password|api[_-]?key|secret[_-]?key)[[:space:]]*[:=][[:space:]]*${QUOTE_CLASS}${NOT_QUOTE_CLASS}{12,}${QUOTE_CLASS}"

if [ -n "$FINDINGS" ]; then
  echo "" >&2
  echo "🚫 Secrets scan blocked the commit." >&2
  echo "   The staged diff contains lines that look like secrets." >&2
  echo "   Review the findings below and either:" >&2
  echo "     • Remove the secret + rotate it (if real)" >&2
  echo "     • Use \`git restore --staged <file>\` to unstage" >&2
  echo "     • Add \`[allow-secret]\` to the commit message if it's a known fixture" >&2
  echo "" >&2
  printf "%b\n" "$FINDINGS" >&2
  exit 2
fi

exit 0
