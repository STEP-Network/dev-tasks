#!/usr/bin/env bash
# Tests for rule-autoload.sh — plugin-glob rule injection + consumer rules.extraRules.
#
# No network. Builds a throwaway CLAUDE_PLUGIN_ROOT (rules-routing.json + rules/)
# and per-case project dirs (.claude/project-config.json + .claude/rules/).
# The hook emits additionalContext JSON on stdout when it injects, nothing otherwise.
#
# The hook is opt-in since 1.0.1, so new_project lists it in hooks.enabled[]
# unless a case says otherwise. Tests 8-10 cover the default: nothing injected.

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

# new_project <name> [extraRules-json] [hooks-enabled-json]
# → echoes the project dir; seeds .claude/. hooks.enabled defaults to ["rule-autoload"].
new_project() {
  local name="$1" extra="${2:-[]}" enabled="${3:-[\"rule-autoload\"]}"
  local pd="$WORK/$name"
  mkdir -p "$pd/.claude/rules"
  printf '{"rules":{"extraRules":%s},"hooks":{"enabled":%s}}\n' "$extra" "$enabled" \
    > "$pd/.claude/project-config.json"
  printf '%s' "$pd"
}

# run_hook <project_dir> <file_path> <session_id> <tmpdir> [plugin_root]
run_hook() {
  local pd="$1" fp="$2" sid="$3" td="$4" root="${5:-$PLUGIN_ROOT}"
  local input
  input=$(jq -nc --arg fp "$fp" --arg sid "$sid" --arg cwd "$pd" \
    '{tool_input:{file_path:$fp}, session_id:$sid, cwd:$cwd}')
  CLAUDE_PLUGIN_ROOT="$root" CLAUDE_PROJECT_DIR="$pd" TMPDIR="$td" bash "$HOOK" <<<"$input" 2>/dev/null
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
echo "==> Test 8: not in hooks.enabled[] → a matching edit injects nothing (the default)"
pd=$(new_project p8 '["proj.md"]' '[]')
printf 'CONSUMER-EXTRA-RULE\n' > "$pd/.claude/rules/proj.md"
out=$(run_hook "$pd" "$pd/schema.sql" "s8" "$WORK/t8")
if [ -z "$out" ]; then
  pass "opt-in hook stays silent when the project has not listed it"
else
  fail "expected empty output (got: $out)"
fi

# -------------------------------------------------------------------
echo "==> Test 9: no project-config at all → a matching edit injects nothing"
pd="$WORK/p9"; mkdir -p "$pd"
out=$(run_hook "$pd" "$pd/schema.sql" "s9" "$WORK/t9")
if [ -z "$out" ]; then
  pass "no config means no injection, even on a glob match"
else
  fail "expected empty output (got: $out)"
fi

# -------------------------------------------------------------------
# Test 10 runs against the REAL rules-routing.json and rules/, so it asserts on
# the text the plugin ships rather than on a fixture. A fresh session's first
# edit of a .ts file used to pull in task-lifecycle.md, autonomous-by-default.md
# and worktree-discipline.md.
echo "==> Test 10: fresh session + one .ts edit, real plugin rules → no rule text"
REAL_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
LIFECYCLE_H1="$(head -1 "$REAL_ROOT/rules/task-lifecycle.md")"
pd=$(new_project p10 '[]' '[]')
out=$(run_hook "$pd" "$pd/lib/example.ts" "s10" "$WORK/t10" "$REAL_ROOT")
if [ -z "$out" ]; then
  pass "default config: first edit of a .ts file injects no plugin rule text"
else
  fail "expected no output, got ${#out} bytes: $(printf '%s' "$out" | head -c 200)"
fi
# Control, so the assertion above cannot pass vacuously: opting in to the same
# edit does inject the rule the routing names.
pd=$(new_project p10b '[]')
out=$(run_hook "$pd" "$pd/lib/example.ts" "s10b" "$WORK/t10b" "$REAL_ROOT")
if printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null | grep -qxF "$LIFECYCLE_H1"; then
  pass "control: with rule-autoload enabled the same edit injects '$LIFECYCLE_H1'"
else
  fail "control failed: enabled hook did not inject task-lifecycle.md (got ${#out} bytes)"
fi

# -------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
