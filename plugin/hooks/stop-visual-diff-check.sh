#!/bin/bash
# .claude/hooks/stop-visual-diff-check.sh
#
# Hook: Stop (chains AFTER the other plugin Stop gates).
#
# Refuses session exit when this branch CHANGED UI source files but the active
# task has NO visual-diff record — neither a captured before-pass route list
# nor an explicit, audited skip reason. Closes the gap behind the 2026-06-23
# incident: a pure UI/UX task (a delete-button hover CSS fix across ~17
# component files) reached "Waiting for UAT" with ZERO screenshots in its
# Monday "Visual Changes" doc, because VisualDiff capture was agent-discretion
# prose in /ship-pr (Phase 6.8) with no enforcement and an LLM "is this UI?"
# judgment that the agent self-skipped ("no local build possible").
#
# This gate makes the skip non-silent: a UI diff must leave EITHER
#   active-task.json visualDiff.routes      (a before pass actually ran), OR
#   active-task.json visualDiff.skipReason  (an explicit, recorded skip)
# before the session may stop. /ship-pr Phase 6.8 writes exactly those fields.
#
# UX-UI subtask override: "UI" here is not only the path classifier's verdict.
# A task carrying a UX-UI-typed subtask (or an explicit visualDiff.forceUi flag
# recorded by /ship-pr) forces the UI verdict even when the diff is NON_UI by
# path — e.g. an i18n-only diff (messages/*.json) on UX-UI work. This mirrors
# ui-diff-eval.sh --force-ui and makes the override real, not skill-prose. The
# subtask types come from active-task.json (written by /pickup-task), so this
# gate enforces independently of whether /ship-pr judged the override correctly.
#
# Honest caveat: visualDiff.skipReason is self-attested (the agent writes the
# string; the PR body carries the same note as the human-visible audit). This
# hook makes the omission visible and forces a deliberate, recorded decision —
# it does not cryptographically prove a capture happened. The durable record is
# the Monday "Visual Changes" doc (doc_mm4jkk92) itself.
#
# Pass-through cases (all fail-OPEN — a visual-diff gate must never trap a
# session):
#   - hook not enabled in project-config hooks.enabled[]
#   - no active-task.json / unparseable JSON
#   - reviewAddressed in {handoff-to-orchestrator, stuck:*, timeout:*}
#   - project-config visualDiff.enabled === false (feature opted out)
#   - environments.uat.url is not an https:// URL (no staging to capture on)
#   - running under CI (a runner can't reach a browser/staging — mirrors
#     stop-task-check Stage 3 relaxation)
#   - branch diff is NON_UI (ui-diff-eval.sh)
#   - visualDiff.routes non-empty OR visualDiff.skipReason non-empty
#   - any unexpected error

# Redirect stdout to stderr.
exec >&2

# Opt-in gate: silent no-op unless the consumer enabled this hook.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"
hook_enabled "stop-visual-diff-check" || exit 0

# CI relaxation: a CI runner spawned by the autonomous fix-loop has no browser
# / staging access and can never produce a visual diff, so the gate would hang
# the run to its timeout. Mirrors stop-task-logic.py running_in_ci().
if [ "${GITHUB_ACTIONS:-}" = "true" ] || [ "${CI:-}" = "true" ]; then
  exit 0
fi

INPUT=$(cat 2>/dev/null || echo "")
AGENT_CWD=$(resolve_agent_cwd "$INPUT")

PROJECT_ROOT=""
if [ -n "$AGENT_CWD" ] && [ -d "$AGENT_CWD/.claude" ]; then
  PROJECT_ROOT="$AGENT_CWD"
elif [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "$CLAUDE_PROJECT_DIR/.claude" ]; then
  PROJECT_ROOT="$CLAUDE_PROJECT_DIR"
elif git_top=$(git rev-parse --show-toplevel 2>/dev/null); then
  PROJECT_ROOT="$git_top"
else
  PROJECT_ROOT="$PWD"
fi

STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"
[ ! -f "$STATE_FILE" ] && exit 0

# Validate JSON — fail open on parse error.
if ! STATE_FILE_PATH="$STATE_FILE" python3 -c "import json, os; json.load(open(os.environ['STATE_FILE_PATH']))" 2>/dev/null; then
  exit 0
fi

# Escape hatches shared with the other Stop gates.
REVIEW_ADDRESSED=$(jq -r '.reviewAddressed // ""' "$STATE_FILE" 2>/dev/null)
case "$REVIEW_ADDRESSED" in
  handoff-to-orchestrator|stuck:*|timeout:*)
    exit 0
    ;;
esac

# Feature opt-out: visualDiff.enabled === false.
CONFIG="$PROJECT_ROOT/.claude/project-config.json"
if [ -f "$CONFIG" ]; then
  VD_ENABLED=$(jq -r '.visualDiff.enabled' "$CONFIG" 2>/dev/null)
  [ "$VD_ENABLED" = "false" ] && exit 0

  # No https staging URL → nothing to capture against (matches the /ship-pr
  # Phase 6.8 gate condition). github.com etc. is technically https but a
  # consumer that hasn't set a real staging app simply won't have the feature
  # do anything; treat any non-https value as "no staging".
  UAT_URL=$(jq -r '.environments.uat.url // ""' "$CONFIG" 2>/dev/null)
  case "$UAT_URL" in
    https://*) ;;
    *) exit 0 ;;
  esac
fi

# UX-UI subtask override: a UX-UI-typed subtask in active-task.json (or an
# explicit visualDiff.forceUi flag from /ship-pr) forces the UI verdict even when
# the path classifier would say NON_UI. Derived locally from the validated state
# file (path via env var — no shell interpolation of JSON content).
FORCE_UI=$(STATE_FILE_PATH="$STATE_FILE" python3 <<'PY' 2>/dev/null
import json, os
with open(os.environ['STATE_FILE_PATH']) as f:
    state = json.load(f)
forced = bool((state.get('visualDiff') or {}).get('forceUi') is True)
for st in (state.get('subtasks') or []):
    if isinstance(st, dict) and str(st.get('type', '')).strip().upper() == 'UX-UI':
        forced = True
        break
print("YES" if forced else "NO")
PY
)

if [ "$FORCE_UI" = "YES" ]; then
  : # UX-UI override → treat as UI regardless of path classifier; require a record.
else
  # Classify the branch diff deterministically. NON_UI → pass-through.
  EVAL_SCRIPT="$(dirname "${BASH_SOURCE[0]}")/../scripts/ui-diff-eval.sh"
  if [ ! -x "$EVAL_SCRIPT" ] && [ ! -f "$EVAL_SCRIPT" ]; then
    # Classifier missing — can't determine UI-ness, fail open.
    exit 0
  fi

  if ( cd "$PROJECT_ROOT" 2>/dev/null && bash "$EVAL_SCRIPT" >/dev/null 2>&1 ); then
    : # exit 0 from ui-diff-eval.sh == UI verdict → keep checking below
  else
    # NON_UI (exit 1) or eval error → pass-through (non-UI work isn't gated).
    exit 0
  fi
fi

# UI diff detected. Require a visual-diff record: routes captured OR an
# explicit skip reason.
HAS_RECORD=$(STATE_FILE_PATH="$STATE_FILE" python3 <<'PY' 2>/dev/null
import json, os
with open(os.environ['STATE_FILE_PATH']) as f:
    state = json.load(f)
vd = state.get('visualDiff') or {}
routes = vd.get('routes')
skip = vd.get('skipReason')
has_routes = isinstance(routes, list) and len(routes) > 0
has_skip = isinstance(skip, str) and skip.strip() != ''
print("YES" if (has_routes or has_skip) else "NO")
PY
)

[ "$HAS_RECORD" = "YES" ] && exit 0
# Unknown / empty verdict from the python block → fail open.
[ "$HAS_RECORD" != "NO" ] && exit 0

TASK_ID=$(jq -r '.taskId // "?"' "$STATE_FILE" 2>/dev/null)
TASK_NAME=$(jq -r '.taskName // "(unnamed)"' "$STATE_FILE" 2>/dev/null)

echo "BLOCKED: UI changed on this branch but task #$TASK_ID '$TASK_NAME' has no visual-diff record."
echo ""
if [ "$FORCE_UI" = "YES" ]; then
  echo "This task carries a UX-UI subtask (or visualDiff.forceUi), which forces UI"
  echo "treatment even if the diff is NON_UI by path (e.g. an i18n-only change)."
else
  echo "This branch changed UI source files (components / app routes / stylesheets /"
  echo "email templates)."
fi
echo "But .claude/active-task.json records neither a captured before-pass route"
echo "list (visualDiff.routes) nor an explicit skip (visualDiff.skipReason)."
echo "The Monday 'Visual Changes' doc would ship empty."
echo ""
echo "To unblock, do ONE of:"
echo "  1. Run /ship-pr Phase 6.8 (VisualDiff BEFORE pass): screenshot the changed"
echo "     routes on staging with a FILE-PRODUCING tool — 'npx playwright screenshot'"
echo "     against environments.uat.url (--load-storage=<e2e persona storageState>"
echo "     for authed routes; chrome-devtools-mcp with file save works for public"
echo "     routes) — call appendTaskVisualSnapshots({ taskId: $TASK_ID, phase: 'before', ... }),"
echo "     and record the captured routes in active-task.json visualDiff.routes."
echo ""
echo "  2. If capture genuinely isn't possible, record WHY in active-task.json"
echo "     visualDiff.skipReason (e.g. 'no resolvable staging URL for this route')."
echo "     NOTE: 'no local build' is NOT a valid skip reason — staging IS"
echo "     screenshot-reachable via 'npx playwright screenshot'; capture there instead."
echo ""
echo "  3. (Handoff) Set reviewAddressed='handoff-to-orchestrator' — the after/before"
echo "     visual pass is then owned by /babysit-prs."
echo ""
echo "Reference: plugin/skills/ship-pr/SKILL.md Phase 6.8 (VisualDiff BEFORE pass)."
exit 2
