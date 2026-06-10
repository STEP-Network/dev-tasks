#!/bin/bash
# Tests for plugin/scripts/ci-skip-eval.sh — the deterministic eligibility
# boundary for the per-task CI-gate auto-skip ("Skip (agent)").
#
# Run with: bash plugin/scripts/__tests__/ci-skip-eval.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/../ci-skip-eval.sh"

if [ ! -f "$SCRIPT" ]; then
  echo "FATAL: script not found at $SCRIPT"
  exit 1
fi

PASS=0
FAIL=0

# run_case <name> <expect_exit> <expect_first_line_prefix>
# Runs the script in $PWD and checks exit code + verdict line.
run_case() {
  local name="$1"
  local expect_exit="$2"
  local expect_prefix="$3"
  local out exit_code first
  out=$(bash "$SCRIPT" 2>&1)
  exit_code=$?
  first=$(echo "$out" | head -1)

  if [ "$exit_code" = "$expect_exit" ] && [[ "$first" == "$expect_prefix"* ]]; then
    echo "  PASS: $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $name"
    echo "         expected exit=$expect_exit verdict='$expect_prefix*'"
    echo "         got exit=$exit_code verdict='$first'"
    FAIL=$((FAIL+1))
  fi
}

write_config() {
  # write_config <autoSkip-json or 'absent'>
  mkdir -p .claude
  if [ "$1" = "absent" ]; then
    echo '{"git":{"defaultBase":"main"}}' > .claude/project-config.json
  else
    printf '{"git":{"defaultBase":"main"},"ci":{"autoSkip":%s}}\n' "$1" > .claude/project-config.json
  fi
}

# --- Fixture repo -----------------------------------------------------------
TEST_DIR=$(mktemp -d -t ci-skip-eval-test-XXXX)
cd "$TEST_DIR"
git init --quiet -b main
git config user.email "test@test.local"
git config user.name "Test"
mkdir -p src/api
echo base > base.txt
git add -A && git commit -qm base

git checkout -qb feat/x
printf '.a{color:red}\n' > style.css
git add style.css && git commit -qm "css change"

echo "ci-skip-eval.sh:"

# 1. No autoSkip block at all → never eligible
write_config absent
run_case "absent autoSkip block → NOT_ELIGIBLE" 1 "NOT_ELIGIBLE: ci.autoSkip.enabled"

# 2. enabled=false → not eligible
write_config '{"enabled":false,"pathAllowlist":["*.css"]}'
run_case "enabled=false → NOT_ELIGIBLE" 1 "NOT_ELIGIBLE: ci.autoSkip.enabled"

# 3. Empty allowlist → not eligible (allowlists are explicit opt-in)
write_config '{"enabled":true,"maxChangedLines":50}'
run_case "empty allowlist → NOT_ELIGIBLE" 1 "NOT_ELIGIBLE: ci.autoSkip.pathAllowlist is empty"

# 4. CSS-only diff within bounds → ELIGIBLE
write_config '{"enabled":true,"maxChangedLines":50,"pathAllowlist":["*.css","*.md"]}'
run_case "css-only within bounds → ELIGIBLE" 0 "ELIGIBLE"

# 5. Denylisted path (src/api/** via default denylist) → not eligible,
#    even though *.ts could be allowlisted
write_config '{"enabled":true,"maxChangedLines":50,"pathAllowlist":["*.css","*.ts"]}'
echo "export {}" > src/api/route.ts
git add src/api/route.ts && git commit -qm "api change"
run_case "default-denylisted api path → NOT_ELIGIBLE" 1 "NOT_ELIGIBLE: denylisted path(s)"
git revert --no-edit HEAD >/dev/null 2>&1

# 6. Path outside allowlist → not eligible
echo "notes" > notes.txt
git add notes.txt && git commit -qm "notes"
write_config '{"enabled":true,"maxChangedLines":50,"pathAllowlist":["*.css"]}'
run_case "path outside allowlist → NOT_ELIGIBLE" 1 "NOT_ELIGIBLE: path(s) outside allowlist"
git rm -q notes.txt && git commit -qm "drop notes"

# 7. Over the line cap → not eligible
write_config '{"enabled":true,"maxChangedLines":5,"pathAllowlist":["*.css"]}'
for i in 1 2 3 4 5 6; do echo ".c$i{}" >> style.css; done
git add style.css && git commit -qm "many css lines"
run_case "over maxChangedLines → NOT_ELIGIBLE" 1 "NOT_ELIGIBLE:"

# 8. Custom denylist replaces default → *.css deniable too
write_config '{"enabled":true,"maxChangedLines":500,"pathAllowlist":["*.css"],"pathDenylist":["*.css"]}'
run_case "custom denylist replaces default → NOT_ELIGIBLE" 1 "NOT_ELIGIBLE: denylisted path(s)"

# 9. Raised cap + default denylist → eligible again
write_config '{"enabled":true,"maxChangedLines":500,"pathAllowlist":["*.css"]}'
run_case "raised cap → ELIGIBLE" 0 "ELIGIBLE"

# 10. No diff vs base (on main itself) → not eligible
git checkout -q main
write_config '{"enabled":true,"maxChangedLines":50,"pathAllowlist":["*.css"]}'
run_case "no committed changes → NOT_ELIGIBLE" 1 "NOT_ELIGIBLE: no committed changes"

# --- Cleanup ----------------------------------------------------------------
cd /
rm -rf "$TEST_DIR"

echo ""
echo "ci-skip-eval.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
