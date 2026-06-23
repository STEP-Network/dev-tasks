#!/bin/bash
# Tests for hooks/stop-visual-diff-check.sh
#
# Strategy: build a temp git repo on a feature branch with a controlled diff,
# write project-config.json (enabling the hook + visualDiff + https uat url) and
# active-task.json, feed the hook a Stop payload whose cwd points at the repo,
# assert the exit code.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../stop-visual-diff-check.sh"
[ ! -x "$HOOK" ] && { echo "FATAL: hook not executable"; exit 1; }

PASS_COUNT=0
FAIL_COUNT=0
assert() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1));
  else echo "FAIL: $1 (expected '$3', got '$2')"; FAIL_COUNT=$((FAIL_COUNT + 1)); fi
}
assert_contains() {
  if echo "$2" | grep -qF "$3"; then echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1));
  else echo "FAIL: $1 (needle '$3' missing)"; FAIL_COUNT=$((FAIL_COUNT + 1)); fi
}

# ---------- temp git repo with a UI diff on a feature branch ----------
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
git -C "$TMP" init -q
git -C "$TMP" config user.email t@e.com
git -C "$TMP" config user.name t
git -C "$TMP" config commit.gpgsign false 2>/dev/null
mkdir -p "$TMP/src/components" "$TMP/src/lib" "$TMP/.claude"
echo "base" > "$TMP/src/lib/util.ts"
# .claude/ is gitignored in real consumer repos (active-task.json is per-session
# state) — keep it untracked so `git add -A` never sweeps config/state into the
# diff and never blocks branch checkouts.
echo ".claude/" > "$TMP/.gitignore"
git -C "$TMP" add -A && git -C "$TMP" commit -q -m "init"
git -C "$TMP" branch -m main 2>/dev/null
git -C "$TMP" checkout -q -b feat 2>/dev/null

CONFIG="$TMP/.claude/project-config.json"
write_config() { cat > "$CONFIG" <<EOF
{
  "version": "1",
  "git": { "defaultBase": "main" },
  "monday": { "productId": "1" },
  "environments": { "uat": { "url": "${1:-https://staging.example.com}" } },
  "visualDiff": { "enabled": ${2:-true} },
  "hooks": { "enabled": ["stop-visual-diff-check"] }
}
EOF
}
write_state() { echo "$1" > "$TMP/.claude/active-task.json"; }
rm_state() { rm -f "$TMP/.claude/active-task.json"; }

# Stop payload with cwd pointing at the temp repo.
INPUT="{\"cwd\":\"$TMP\"}"
run_hook() { ( cd "$TMP" && CLAUDE_PROJECT_DIR="$TMP" "$HOOK" <<<"$INPUT" 2>&1 ); }

commit_ui() { echo "export const B = () => null" > "$TMP/src/components/Button.tsx"; git -C "$TMP" add -A; git -C "$TMP" commit -q -m "ui #1"; }
commit_nonui() { echo "changed" > "$TMP/src/lib/util.ts"; git -C "$TMP" add -A; git -C "$TMP" commit -q -m "logic #1"; }

# Test 1: hook NOT enabled (no config) → pass-through.
rm -f "$CONFIG"; write_state '{"taskId":"1"}'
OUT=$(run_hook); assert "no config (not enabled) → pass" "$?" "0"

# Test 2: enabled, UI diff, NO visualDiff record → BLOCK.
write_config; commit_ui
write_state '{"taskId":"42","taskName":"Hover fix"}'
OUT=$(run_hook); assert "UI diff + no record → BLOCK" "$?" "2"
assert_contains "BLOCK names the task" "$OUT" "#42"
assert_contains "BLOCK mentions Visual Changes doc" "$OUT" "Visual Changes"

# Test 3: enabled, UI diff, visualDiff.routes recorded → pass.
write_state '{"taskId":"42","visualDiff":{"routes":["/dashboard"]}}'
OUT=$(run_hook); assert "UI diff + routes recorded → pass" "$?" "0"

# Test 4: enabled, UI diff, visualDiff.skipReason recorded → pass.
write_state '{"taskId":"42","visualDiff":{"skipReason":"no resolvable staging URL"}}'
OUT=$(run_hook); assert "UI diff + skipReason recorded → pass" "$?" "0"

# Test 5: empty routes array + empty skipReason → still BLOCK.
write_state '{"taskId":"42","visualDiff":{"routes":[],"skipReason":""}}'
OUT=$(run_hook); assert "empty routes + empty skip → BLOCK" "$?" "2"

# Test 6: handoff-to-orchestrator escape → pass.
write_state '{"taskId":"42","reviewAddressed":"handoff-to-orchestrator"}'
OUT=$(run_hook); assert "handoff escape → pass" "$?" "0"

# Test 7: stuck:* escape → pass.
write_state '{"taskId":"42","reviewAddressed":"stuck:regression-loop"}'
OUT=$(run_hook); assert "stuck escape → pass" "$?" "0"

# Test 8: visualDiff.enabled === false → pass even with UI diff + no record.
write_config "https://staging.example.com" "false"
write_state '{"taskId":"42"}'
OUT=$(run_hook); assert "visualDiff disabled → pass" "$?" "0"

# Test 9: non-https uat url → pass (no staging to capture).
write_config "https://github.com/org/repo"  # https but a repo, still https → does NOT skip
write_config "http://insecure.example.com"   # non-https → skip
write_state '{"taskId":"42"}'
OUT=$(run_hook); assert "non-https uat url → pass" "$?" "0"

# Test 10: NON_UI diff → pass even with no record.
# Fresh repo branch with only a non-UI change.
git -C "$TMP" checkout -q main 2>/dev/null
git -C "$TMP" checkout -q -b feat2 2>/dev/null
commit_nonui
write_config
write_state '{"taskId":"42"}'
# ui-diff-eval resolves base from defaultBase=main; feat2 only changed util.ts.
OUT=$( ( cd "$TMP" && CLAUDE_PROJECT_DIR="$TMP" "$HOOK" <<<"$INPUT" 2>&1 ) ); RC=$?
assert "non-UI diff → pass" "$RC" "0"

# Test 11: malformed active-task.json → fail open (pass).
git -C "$TMP" checkout -q feat 2>/dev/null
write_config
echo "{ bad json" > "$TMP/.claude/active-task.json"
OUT=$(run_hook); assert "malformed JSON → pass (fail-open)" "$?" "0"

# Test 12: running under CI → pass even with UI diff + no record.
write_config; write_state '{"taskId":"42"}'
OUT=$( ( cd "$TMP" && CI=true CLAUDE_PROJECT_DIR="$TMP" "$HOOK" <<<"$INPUT" 2>&1 ) ); RC=$?
assert "CI relaxation → pass" "$RC" "0"

# Test 13: no active-task.json → pass-through.
write_config; rm_state
OUT=$(run_hook); assert "no state file → pass" "$?" "0"

echo ""
echo "==================================================="
echo "stop-visual-diff-check tests: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "==================================================="
[ "$FAIL_COUNT" -eq 0 ]
