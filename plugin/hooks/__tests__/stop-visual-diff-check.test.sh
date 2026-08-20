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
commit_i18n() { mkdir -p "$TMP/messages"; echo '{"hello":"world"}' > "$TMP/messages/en.json"; git -C "$TMP" add -A; git -C "$TMP" commit -q -m "i18n #1"; }

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

# ---------- UX-UI override: forces UI even on a NON_UI-by-path diff ----------
# Fresh branch with ONLY an i18n diff (messages/en.json → NON_UI by path).
git -C "$TMP" checkout -q main 2>/dev/null
git -C "$TMP" checkout -q -b feat-i18n 2>/dev/null
commit_i18n
write_config
i18n_hook() { ( cd "$TMP" && CLAUDE_PROJECT_DIR="$TMP" "$HOOK" <<<"$INPUT" 2>&1 ); }

# Test 14: i18n-only diff + UX-UI subtask, no visualDiff record → BLOCK (forced UI).
write_state '{"taskId":"77","taskName":"i18n copy","subtasks":[{"id":"1","name":"translate","type":"UX-UI","status":"in_progress"}]}'
OUT=$(i18n_hook); assert "i18n + UX-UI subtask + no record → BLOCK" "$?" "2"
assert_contains "BLOCK notes UX-UI override" "$OUT" "UX-UI"

# Test 15: same diff + UX-UI subtask + skipReason recorded → pass.
write_state '{"taskId":"77","subtasks":[{"id":"1","name":"translate","type":"UX-UI","status":"in_progress"}],"visualDiff":{"skipReason":"copy-only, no rendered route changed"}}'
OUT=$(i18n_hook); assert "i18n + UX-UI subtask + skipReason → pass" "$?" "0"

# Test 16: same diff + visualDiff.forceUi flag (no UX-UI subtask), no record → BLOCK.
write_state '{"taskId":"77","visualDiff":{"forceUi":true}}'
OUT=$(i18n_hook); assert "i18n + forceUi flag + no record → BLOCK" "$?" "2"

# Test 17: same diff + only a non-UI subtask (Backend) → pass (no override, NON_UI by path).
write_state '{"taskId":"77","subtasks":[{"id":"1","name":"api","type":"Backend","status":"in_progress"}]}'
OUT=$(i18n_hook); assert "i18n + Backend subtask → pass (no override)" "$?" "0"

# ---------- empty branch diff: nothing changed, nothing to capture (#3173683437) ----------
# A freshly-claimed UX-UI task has FORCE_UI=YES from the moment /pickup-task records
# its subtask types, before a single line is written. The override used to be evaluated
# INSTEAD OF the diff classifier, so an EMPTY diff was never detected and the gate
# demanded a before-pass capture of a branch byte-identical to base.
git -C "$TMP" checkout -q main 2>/dev/null
git -C "$TMP" checkout -q -b feat-empty 2>/dev/null
write_config
empty_hook() { ( cd "$TMP" && CLAUDE_PROJECT_DIR="$TMP" "$HOOK" <<<"$INPUT" 2>&1 ); }

# Test 18: THE BUG. UX-UI subtask + EMPTY branch diff + no record -> pass-through.
write_state '{"taskId":"99","taskName":"claimed but unstarted","subtasks":[{"id":"1","name":"design","type":"UX-UI","status":"in_progress"}]}'
OUT=$(empty_hook); assert "empty diff + UX-UI subtask -> pass (nothing to capture)" "$?" "0"

# Test 19: same, via the visualDiff.forceUi flag rather than a subtask type.
write_state '{"taskId":"99","visualDiff":{"forceUi":true}}'
OUT=$(empty_hook); assert "empty diff + forceUi flag -> pass" "$?" "0"

# Test 20: NEGATIVE CONTROL. The override is narrowed, not removed - a NON-EMPTY
# NON_UI-by-path diff (i18n only) with a UX-UI subtask must STILL block.
git -C "$TMP" checkout -q feat-i18n 2>/dev/null
write_state '{"taskId":"77","subtasks":[{"id":"1","name":"translate","type":"UX-UI","status":"in_progress"}]}'
OUT=$( ( cd "$TMP" && CLAUDE_PROJECT_DIR="$TMP" "$HOOK" <<<"$INPUT" 2>&1 ) ); RC=$?
assert "non-empty i18n diff + UX-UI subtask -> still BLOCK (override intact)" "$RC" "2"

# Test 21: an uncommitted-only working tree is still an empty COMMITTED diff -> pass.
git -C "$TMP" checkout -q feat-empty 2>/dev/null
mkdir -p "$TMP/src/components"
echo "export const C = () => null" > "$TMP/src/components/Draft.tsx"
write_state '{"taskId":"99","subtasks":[{"id":"1","name":"design","type":"UX-UI","status":"in_progress"}]}'
OUT=$(empty_hook); assert "uncommitted-only change -> pass (no committed diff)" "$?" "0"
rm -f "$TMP/src/components/Draft.tsx"

# Test 22: a dash-leading git.defaultBase is sanitized and never reaches git as an
# option (git option injection). Falls back to main; feat-empty is empty vs main -> pass.
cat > "$CONFIG" <<'EOFC'
{
  "version": "1",
  "git": { "defaultBase": "--output=/tmp/pwned" },
  "monday": { "productId": "1" },
  "environments": { "uat": { "url": "https://staging.example.com" } },
  "visualDiff": { "enabled": true },
  "hooks": { "enabled": ["stop-visual-diff-check"] }
}
EOFC
write_state '{"taskId":"99","subtasks":[{"id":"1","name":"design","type":"UX-UI","status":"in_progress"}]}'
OUT=$(empty_hook); assert "dash-leading defaultBase -> sanitized, no option injection" "$?" "0"
[ ! -e /tmp/pwned ]; assert "dash-leading defaultBase wrote no file" "$?" "0"
write_config

echo ""
echo "==================================================="
echo "stop-visual-diff-check tests: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "==================================================="
[ "$FAIL_COUNT" -eq 0 ]
