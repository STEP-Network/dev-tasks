#!/usr/bin/env bash
# Tests for rule-autoload.sh — plugin-glob rule injection + consumer rules.extraRules.
#
# No network. Builds a throwaway CLAUDE_PLUGIN_ROOT (rules-routing.json + rules/)
# and per-case project dirs (.claude/project-config.json + .claude/rules/).
# The hook emits additionalContext JSON on stdout when it injects, nothing otherwise.

set -u
shopt -s nullglob

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$(cd "$TEST_DIR/.." && pwd)/rule-autoload.sh"
[ -f "$HOOK" ] || { echo "FAIL: hook not found at $HOOK" >&2; exit 1; }

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d -t rule-autoload-XXXX)"
trap 'rm -rf "$WORK"' EXIT

# --- shared throwaway plugin root: one rule (db.md) routed to *.sql -----------
PLUGIN_ROOT="$WORK/plugin"
mkdir -p "$PLUGIN_ROOT/rules"
printf '{"rules":[{"file":"db.md","match":["*.sql"]}]}\n' > "$PLUGIN_ROOT/rules-routing.json"
printf 'PLUGIN-RULE-DB-CONTENT\n' > "$PLUGIN_ROOT/rules/db.md"

# new_project <name> [extraRules-json] → echoes the project dir; seeds .claude/
new_project() {
  local name="$1" extra="${2:-}"
  local pd="$WORK/$name"
  mkdir -p "$pd/.claude/rules"
  if [ -n "$extra" ]; then
    printf '{"rules":{"extraRules":%s}}\n' "$extra" > "$pd/.claude/project-config.json"
  else
    printf '{}\n' > "$pd/.claude/project-config.json"
  fi
  printf '%s' "$pd"
}

# run_hook <project_dir> <file_path> <session_id> <tmpdir>
run_hook() {
  local pd="$1" fp="$2" sid="$3" td="$4"
  local input
  input=$(jq -nc --arg fp "$fp" --arg sid "$sid" --arg cwd "$pd" \
    '{tool_input:{file_path:$fp}, session_id:$sid, cwd:$cwd}')
  CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" TMPDIR="$td" bash "$HOOK" <<<"$input" 2>/dev/null
}

# -------------------------------------------------------------------
echo "==> Test 1: plugin-glob match (*.sql) still injects the plugin rule (regression)"
pd=$(new_project p1)
out=$(run_hook "$pd" "$pd/schema.sql" "s1" "$WORK/t1")
if printf '%s' "$out" | grep -q "PLUGIN-RULE-DB-CONTENT"; then
  pass "plugin rule injected on glob match"
else
  fail "expected plugin rule content (got: $out)"
fi

# -------------------------------------------------------------------
echo "==> Test 2: extraRules surfaced even when no plugin glob matches"
pd=$(new_project p2 '["proj.md"]')
printf 'CONSUMER-EXTRA-RULE\n' > "$pd/.claude/rules/proj.md"
out=$(run_hook "$pd" "$pd/notes.txt" "s2" "$WORK/t2")
if printf '%s' "$out" | grep -q "CONSUMER-EXTRA-RULE"; then
  pass "extra rule surfaced for non-matching edit"
else
  fail "expected extra rule content (got: $out)"
fi

# -------------------------------------------------------------------
echo "==> Test 3: plugin rule + extra rule both injected on a matching edit"
pd=$(new_project p3 '["proj.md"]')
printf 'CONSUMER-EXTRA-RULE\n' > "$pd/.claude/rules/proj.md"
out=$(run_hook "$pd" "$pd/schema.sql" "s3" "$WORK/t3")
if printf '%s' "$out" | grep -q "PLUGIN-RULE-DB-CONTENT" && printf '%s' "$out" | grep -q "CONSUMER-EXTRA-RULE"; then
  pass "both plugin and extra rules injected"
else
  fail "expected both contents (got: $out)"
fi

# -------------------------------------------------------------------
echo "==> Test 4: session dedup — second run with same session injects nothing"
pd=$(new_project p4 '["proj.md"]')
printf 'CONSUMER-EXTRA-RULE\n' > "$pd/.claude/rules/proj.md"
out1=$(run_hook "$pd" "$pd/schema.sql" "sDup" "$WORK/t4")
out2=$(run_hook "$pd" "$pd/schema.sql" "sDup" "$WORK/t4")
if printf '%s' "$out1" | grep -q "CONSUMER-EXTRA-RULE" && [ -z "$out2" ]; then
  pass "second same-session run is a no-op (deduped)"
else
  fail "expected 1st inject + 2nd empty (out1=$out1 || out2=$out2)"
fi

# -------------------------------------------------------------------
echo "==> Test 5: path-traversal entries (../ and sub/) are rejected"
pd=$(new_project p5 '["../evil.md","sub/evil2.md"]')
printf 'EVIL-TRAVERSAL\n' > "$pd/.claude/evil.md"     # one level above rules/
mkdir -p "$pd/.claude/rules/sub"; printf 'EVIL-SUBDIR\n' > "$pd/.claude/rules/sub/evil2.md"
out=$(run_hook "$pd" "$pd/notes.txt" "s5" "$WORK/t5")
if ! printf '%s' "$out" | grep -qE "EVIL-TRAVERSAL|EVIL-SUBDIR"; then
  pass "traversal names rejected (nothing injected)"
else
  fail "traversal content leaked (got: $out)"
fi

# -------------------------------------------------------------------
echo "==> Test 6: extraRules names a missing file → skipped, no injection"
pd=$(new_project p6 '["does-not-exist.md"]')
out=$(run_hook "$pd" "$pd/notes.txt" "s6" "$WORK/t6")
if [ -z "$out" ]; then
  pass "missing extra file skipped silently"
else
  fail "expected empty output (got: $out)"
fi

# -------------------------------------------------------------------
echo "==> Test 7: no project-config + no plugin match → no-op"
pd="$WORK/p7"; mkdir -p "$pd"     # no .claude/ at all
out=$(run_hook "$pd" "$pd/notes.txt" "s7" "$WORK/t7")
if [ -z "$out" ]; then
  pass "no config + no match is a clean no-op"
else
  fail "expected empty output (got: $out)"
fi

# -------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
