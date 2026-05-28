#!/bin/bash

# Opt-in PreToolUse (Edit|Write|MultiEdit): protect .claude/active-task.json
# from manual bypass edits to enforcement-critical fields.
#
# Background: every workflow-enforcement hook reads decision state from
# .claude/active-task.json:
#   selfReviewPassed     ← bash-guard commit gate, ship-pr Phase 1
#   reviewAddressed      ← stop-task-check, pre-merge-review-gate
#   parentStatus         ← stop-waiting-for-uat-stage
#   mondayReconciledShas ← stop-monday-reconciled-check
#   allowMainCheckout    ← worktree-required
#
# An agent that writes the file directly via Edit/Write/MultiEdit can flip
# all of these and sail past every gate. This hook intercepts those tool
# calls; for each protected field whose new value would be a "bypass value",
# it requires a marker /tmp/.claude-state-marker-<field>-<HEAD_SHA> emitted
# by the legitimate write path:
#
#   selfReviewPassed     ← post-self-review.sh on validator PASS
#   reviewAddressed      ← /ship-pr Phase 6.2 (handoff) or Phase 6 (structured)
#   parentStatus         ← /ship-pr Phase 6.5 (after WfUAT transition succeeds)
#   mondayReconciledShas ← /ship-pr Phase 10 + /babysit-prs Phase 3 (after gh pr merge)
#
# allowMainCheckout has NO marker path — it's a user-explicit escape hatch and
# must be set by direct user authorization, never by an agent.
#
# Honest caveat: markers are files in /tmp, which a determined agent can write
# via Bash. This hook makes bypass visible (the bash command appears in the
# transcript) and inconvenient (extra step). The unforgeable complement is
# server-side GitHub branch protection on main/staging — configured per-consumer.

source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "protect-active-task-state" || exit 0

# Block messages must reach Claude Code on stderr.
exec >&2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-project-root.sh"

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)

# Fast path: only fire on edits targeting active-task.json.
case "$FILE_PATH" in
  */.claude/active-task.json) ;;
  *) exit 0 ;;
esac

PROJECT_ROOT=$(resolve_project_root "$FILE_PATH")
STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"

HEAD_SHA=$(cd "$PROJECT_ROOT" && git rev-parse HEAD 2>/dev/null)
if [ -z "$HEAD_SHA" ]; then
  # No git repo — can't compute SHA-scoped marker paths. Better to let the
  # edit through than to hard-block (the rest of the pipeline assumes git).
  exit 0
fi

# Diff + marker-check happens in python for proper JSON handling.
DECISION=$(STATE_FILE="$STATE_FILE" \
           HEAD_SHA="$HEAD_SHA" \
           TOOL_NAME="$TOOL_NAME" \
           HOOK_INPUT="$INPUT" \
           python3 <<'PYEOF' 2>/dev/null
import json, os, sys

state_file = os.environ['STATE_FILE']
head_sha = os.environ['HEAD_SHA']
tool_name = os.environ['TOOL_NAME']
hook_input = os.environ.get('HOOK_INPUT', '{}')

try:
    payload = json.loads(hook_input)
except Exception:
    print('ALLOW'); sys.exit(0)

tool_input = payload.get('tool_input', {}) or {}

# Load current state (may not exist on initial pickup-task Write).
current_text = ''
current = {}
if os.path.exists(state_file):
    try:
        with open(state_file) as f:
            current_text = f.read()
        current = json.loads(current_text) if current_text.strip() else {}
    except Exception:
        current = {}

def apply_edit(text, old_string, new_string, replace_all=False):
    if not old_string:
        return text
    if replace_all:
        return text.replace(old_string, new_string)
    return text.replace(old_string, new_string, 1)

if tool_name == 'Write':
    new_text = tool_input.get('content', '')
elif tool_name == 'Edit':
    new_text = apply_edit(
        current_text,
        tool_input.get('old_string', ''),
        tool_input.get('new_string', ''),
        bool(tool_input.get('replace_all', False)),
    )
elif tool_name == 'MultiEdit':
    new_text = current_text
    for edit in (tool_input.get('edits', []) or []):
        new_text = apply_edit(
            new_text,
            edit.get('old_string', ''),
            edit.get('new_string', ''),
            bool(edit.get('replace_all', False)),
        )
else:
    print('ALLOW'); sys.exit(0)

try:
    proposed = json.loads(new_text)
except Exception:
    # Proposed content isn't valid JSON — let the tool through; downstream
    # readers will fail loudly. The hook's job is bypass detection, not
    # syntax validation.
    print('ALLOW'); sys.exit(0)

def marker_path(field):
    return f"/tmp/.claude-state-marker-{field}-{head_sha}"

def marker_exists(field):
    return os.path.exists(marker_path(field))

blocks = []

cur_self = bool(current.get('selfReviewPassed'))
prop_self = bool(proposed.get('selfReviewPassed'))
if not cur_self and prop_self and not marker_exists('selfReviewPassed'):
    blocks.append((
        'selfReviewPassed',
        f"Setting selfReviewPassed=true requires marker {marker_path('selfReviewPassed')}.\n"
        "Run /self-review to completion — post-self-review.sh emits the marker when\n"
        "the self-reviewer subagent's output contains 'Self-Review PASSED'."
    ))

cur_ra = current.get('reviewAddressed') or ''
prop_ra = proposed.get('reviewAddressed') or ''
# Stringify dicts/objects so the comparison is meaningful (reviewAddressed can
# be a structured object per /ship-pr Phase 6 schema).
if isinstance(cur_ra, (dict, list)): cur_ra = json.dumps(cur_ra, sort_keys=True)
if isinstance(prop_ra, (dict, list)): prop_ra = json.dumps(prop_ra, sort_keys=True)
if cur_ra != prop_ra and prop_ra and not marker_exists('reviewAddressed'):
    blocks.append((
        'reviewAddressed',
        f"Setting reviewAddressed requires marker {marker_path('reviewAddressed')}.\n"
        "Run /ship-pr (Phase 6 structured review or Phase 6.2 handoff-to-orchestrator) —\n"
        "the skill emits the marker before instructing the agent to write the field."
    ))

cur_ps = current.get('parentStatus') or ''
prop_ps = proposed.get('parentStatus') or ''
if prop_ps == 'Waiting for UAT' and cur_ps != 'Waiting for UAT' and not marker_exists('parentStatus'):
    blocks.append((
        'parentStatus',
        f"Setting parentStatus='Waiting for UAT' requires marker {marker_path('parentStatus')}.\n"
        "Run /ship-pr Phase 6.5 — the skill emits the marker after the WfUAT transition\n"
        "on the Monday task succeeds."
    ))

cur_shas = current.get('mondayReconciledShas') or []
prop_shas = proposed.get('mondayReconciledShas') or []
if isinstance(cur_shas, list) and isinstance(prop_shas, list) and len(prop_shas) > len(cur_shas):
    if not marker_exists('mondayReconciledShas'):
        blocks.append((
            'mondayReconciledShas',
            f"Appending to mondayReconciledShas requires marker {marker_path('mondayReconciledShas')}.\n"
            "Run /ship-pr Phase 10 or /babysit-prs Phase 3 — the skill emits the marker\n"
            "after gh pr merge succeeds, before the SHA is appended."
        ))

cur_amc = bool(current.get('allowMainCheckout'))
prop_amc = bool(proposed.get('allowMainCheckout'))
if not cur_amc and prop_amc:
    # NO marker bypass for allowMainCheckout — explicit user action only.
    blocks.append((
        'allowMainCheckout',
        "Setting allowMainCheckout=true bypasses worktree-required (the discipline that\n"
        "prevents parallel sessions from clobbering each other). NO marker can unlock this.\n"
        "Surface the situation to the user and ask them to set the flag manually."
    ))

if blocks:
    print('BLOCK')
    for field, msg in blocks:
        print(f"---FIELD:{field}")
        print(msg)
else:
    print('ALLOW')
PYEOF
)

if echo "$DECISION" | head -1 | grep -q "^BLOCK"; then
  echo "BLOCKED: Manual edit to .claude/active-task.json mutates protected enforcement field(s)."
  echo ""
  echo "$DECISION" | python3 -c "
import sys
for line in sys.stdin:
    line = line.rstrip()
    if line == 'BLOCK':
        continue
    if line.startswith('---FIELD:'):
        print()
        print(f'### {line[len(\"---FIELD:\"):]}')
    else:
        print(f'  {line}')
"
  echo ""
  echo "Why this gate exists: every workflow-enforcement hook reads decision state"
  echo "from .claude/active-task.json. Manual edits to the fields above let an agent"
  echo "bypass self-review, push to staging without a PR, skip CI checks, etc."
  echo "See plugin/rules/agent-orchestration.md 'Protected state fields' for the full list."
  exit 2
fi

exit 0
