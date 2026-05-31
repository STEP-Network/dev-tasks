#!/usr/bin/env python3
"""Stop-goal-persistence hook logic — separated from shell to avoid quoting/JSON issues.

Mirrors stop-task-logic.py's contract:
  - All human-facing output goes to STDERR (so a block message reaches Claude
    Code, which per the hooks spec feeds Stop-hook stderr back to the agent as
    the "keep going" guidance).
  - Blocking is controlled by the EXIT CODE: 0 = allow stop, 2 = block stop
    (prevents Claude from stopping, continues the conversation).

Purpose
-------
Kills the failure mode where an autonomous-mode agent stops PREMATURELY because
it *thinks* the session is too long / context-bloated / laggy — invalid, since
context auto-compacts and durable state persists in Monday / memory / PRs / git.
This is the persistent, plugin-registered analogue of Claude Code's built-in
`/goal` (a session-scoped, prompt-based Stop hook): a `/goal` skill writes a
natural-language completion CONDITION to `.claude/active-goal.json`; this hook
evaluates that condition on every Stop and refuses the stop while it is unmet.

Called by stop-goal-persistence.sh with positional args:
  sys.argv[1] = PROJECT_ROOT          (worktree-aware root, resolved by the .sh)
  sys.argv[2] = HAS_SOURCE_CHANGES     ("1" if source files changed this branch, else "")
  sys.argv[3] = STOP_HOOK_ACTIVE       ("1" if the Stop-hook payload had stop_hook_active:true, else "")
  sys.argv[4] = TRANSCRIPT_PATH        (path to the session transcript .jsonl, or "")

Safety invariants (this hook must NEVER trap the agent):
  1. Respect the 3 legitimate pause reasons via the existing `reviewAddressed`
     escape vocabulary in active-task.json: handoff-to-orchestrator | stuck:* |
     timeout:* -> allow cleanly.
  2. Max-consecutive-blocks escape hatch: a persistent counter in the goal
     marker is bumped on every block; after `maxBlocks` (default 3) the hook
     ALLOWS the stop and warns. A bug in the eval cannot infinite-loop a session.
  3. Claude Code's own `stop_hook_active` flag is honored as a secondary guard:
     if set, we already blocked once in this immediate continuation chain — be
     conservative and lean harder on the counter.
  4. `/goal clear` (marker removed) or a goal that evaluates MET -> clean allow.
  5. Every error path FAILS OPEN (exit 0). A broken eval, missing dependency, or
     malformed marker allows the stop rather than trapping the agent.
"""
import json
import os
import sys


# ---------------------------------------------------------------------------
# The self-check is surfaced on EVERY block, and also once when source changes
# exist but no goal is set. It is the load-bearing nudge the user asked for.
# ---------------------------------------------------------------------------
SELF_CHECK = (
    "SELF-CHECK before you stop: are you stopping because the work is genuinely "
    "DONE or BLOCKED — i.e. one of the 3 legitimate pause reasons:\n"
    "  (1) external blocker (waiting on a system/person you can't unblock),\n"
    "  (2) an irreversible human decision is needed, or\n"
    "  (3) the session-scoped queue is exhausted (no claimable work left)?\n"
    "OR are you stopping because you merely *think* the session is full / laggy / "
    "long / context-bloated?\n"
    "If the latter: that is NOT a valid reason. Context auto-compacts and your "
    "state persists in Monday + memory + the PR + git. KEEP GOING."
)


def err(*args):
    """Print to stderr — shown to the agent on a block; never feeds the loop on allow."""
    print(*args, file=sys.stderr)


def fail_open(msg=None):
    """Allow the stop. Used on every error path so the hook can't trap the agent."""
    if msg:
        err("[stop-goal-persistence] {}".format(msg))
    sys.exit(0)


def load_marker(path):
    """Read .claude/active-goal.json. Returns dict or None (missing/malformed)."""
    try:
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        return data
    except FileNotFoundError:
        return None
    except (json.JSONDecodeError, OSError):
        # Malformed marker -> treat as absent (fail-open: never trap on bad JSON).
        return None


def write_marker(path, data):
    """Persist the marker atomically (tmp + rename). Best-effort; never raises."""
    try:
        tmp = "{}.tmp.{}".format(path, os.getpid())
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except OSError:
        pass  # best-effort; a write failure must not block the stop path


def clear_marker(marker_path):
    """Remove the goal marker. Best-effort; never raises."""
    try:
        os.remove(marker_path)
    except OSError:
        pass


def review_addressed_escape(project_root):
    """Return True if active-task.json carries a legit-pause escape value.

    Mirrors the escape vocabulary already honored by stop-task-logic.py,
    stop-ci-green-check.sh, and stop-monday-reconciled-check.sh:
      handoff-to-orchestrator | stuck:* | timeout:*
    These are the encodings of the 3 legitimate pause reasons. When present,
    the agent has DELIBERATELY halted — never trap it behind a goal.
    """
    state_file = os.path.join(project_root, ".claude", "active-task.json")
    try:
        with open(state_file) as f:
            state = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False
    ra = state.get("reviewAddressed") or ""
    if not isinstance(ra, str):
        return False
    return ra == "handoff-to-orchestrator" or ra.startswith("stuck:") or ra.startswith("timeout:")


# ---------------------------------------------------------------------------
# Goal evaluation. Two paths:
#   * MODEL path (preferred): a fast model judges met/not-met from the goal +
#     recent transcript. Gated on ANTHROPIC_API_KEY (Claude Code uses OAuth, so a
#     raw key is usually ABSENT and the deterministic path runs; headless/CI
#     setups that export a key get the smarter check).
#   * DETERMINISTIC path (fallback): block while the active-task pipeline is
#     incomplete OR claimable Ready-to-Start work remains in the active sprint.
# evaluate_goal_model returns (met, reason) on success or None on "unavailable".
# evaluate_goal_deterministic always returns (met, reason).
# ---------------------------------------------------------------------------
def evaluate_goal_model(goal_text, transcript_path, api_key):
    """Ask a fast model whether the goal is met. Returns (met, reason) or None on failure.

    Returns None (not a tuple) to signal "model path unavailable / errored" so the
    caller falls through to the deterministic path rather than failing open on a
    transient model hiccup.
    """
    try:
        import urllib.request

        context = recent_transcript_text(transcript_path, max_chars=6000)
        if not context:
            # No transcript to judge against — let the deterministic path decide.
            return None

        model = os.environ.get("ANTHROPIC_SMALL_FAST_MODEL") or "claude-3-5-haiku-latest"
        base_url = (os.environ.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com").rstrip("/")

        system = (
            "You judge whether a stated GOAL/completion-condition for a coding "
            "session has been MET, based on the recent transcript. The goal is a "
            "natural-language condition the user set. Respond with STRICT JSON only: "
            '{"met": true|false, "reason": "<one short sentence: if not met, the '
            'concrete next step remaining>"}. Bias toward NOT met if work the goal '
            "names is still clearly outstanding."
        )
        user = "GOAL:\n{}\n\nRECENT TRANSCRIPT (tail):\n{}".format(goal_text, context)

        payload = json.dumps({
            "model": model,
            "max_tokens": 256,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }).encode("utf-8")

        req = urllib.request.Request(
            "{}/v1/messages".format(base_url),
            data=payload,
            method="POST",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            body = json.loads(resp.read().decode("utf-8"))

        # Anthropic Messages API: content is a list of blocks; take the first text block.
        text = ""
        for block in body.get("content", []):
            if block.get("type") == "text":
                text = block.get("text", "")
                break
        if not text:
            return None

        verdict = extract_json_object(text)
        if verdict is None or "met" not in verdict:
            return None
        met = bool(verdict.get("met"))
        reason = str(verdict.get("reason") or "").strip()
        return (met, reason or ("goal met" if met else "goal not yet met"))
    except Exception:
        # Any model-path failure -> signal unavailable; caller uses deterministic path.
        return None


def evaluate_goal_deterministic(project_root):
    """Deterministic completion check. Returns (met, reason).

    Two signals constitute "work remains" (-> not met -> block):
      A) The active-task pipeline is incomplete (active-task.json exists and
         selfReviewPassed is not yet true). Catches "I claimed a task and
         haven't shipped it".
      B) Claimable Ready-to-Start tasks remain in the active sprint (queried via
         the Monday API, mirroring active-task-recon.sh's curl). Catches "the
         session-scoped queue is NOT exhausted".
    On any error (no API key, network) the queue check contributes nothing
    rather than failing the whole hook.
    """
    # Signal A — active-task pipeline incomplete.
    state_file = os.path.join(project_root, ".claude", "active-task.json")
    try:
        with open(state_file) as f:
            state = json.load(f)
        if not state.get("selfReviewPassed", False):
            tn = state.get("taskName", "the active task")
            return (False, 'active task "{}" is not shipped yet (self-review/PR pipeline incomplete)'.format(tn))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass  # no/unreadable active task -> signal A contributes nothing

    # Signal B — claimable Ready-to-Start tasks remain in the active sprint.
    remaining = count_ready_to_start_in_active_sprint()
    if remaining and remaining > 0:
        return (False, "{} Ready-to-Start task(s) remain claimable in the active sprint (queue not exhausted)".format(remaining))

    # Neither signal fired -> deterministically treat the goal as met.
    return (True, "no incomplete pipeline and no claimable queue detected")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def recent_transcript_text(transcript_path, max_chars=6000):
    """Return a plain-text tail of the session transcript for model context.

    The transcript is JSONL (one event per line). We pull the last few
    user/assistant text turns and concatenate, capped at max_chars. Returns ""
    on any error — the caller treats "" as "no context" and falls through.
    """
    if not transcript_path or not os.path.isfile(transcript_path):
        return ""
    try:
        with open(transcript_path, "r", errors="replace") as f:
            lines = f.readlines()
        # Walk backward, extracting human-readable text, until we hit the cap.
        chunks = []
        total = 0
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                continue
            text = event_text(evt)
            if not text:
                continue
            chunks.append(text)
            total += len(text)
            if total >= max_chars:
                break
        chunks.reverse()
        return ("\n".join(chunks))[-max_chars:]
    except OSError:
        return ""


def event_text(evt):
    """Best-effort extraction of human-readable text from one transcript event."""
    msg = evt.get("message") if isinstance(evt, dict) else None
    if not isinstance(msg, dict):
        return ""
    role = msg.get("role", "")
    content = msg.get("content")
    if isinstance(content, str):
        return "{}: {}".format(role, content) if role else content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        if parts:
            return "{}: {}".format(role, " ".join(parts)) if role else " ".join(parts)
    return ""


def extract_json_object(text):
    """Extract the first {...} JSON object from a string. Returns dict or None."""
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None


def count_ready_to_start_in_active_sprint():
    """Query Monday for claimable Ready-to-Start tasks in the active sprint.

    Mirrors active-task-recon.sh's curl approach. Returns an int count, or None
    when the check can't run (no key / network / parse error) — None means
    "unknown", and the caller treats it as "no signal" (does not block on it).

    Board IDs default to the dev-tasks ecosystem but are overridable via env so
    the hook stays project-agnostic.
    """
    api_key = os.environ.get("MONDAY_API_KEY")
    if not api_key:
        return None

    tasks_board_id = os.environ.get("DEV_TASKS_BOARD_ID", "5091706356")
    sprints_board_id = os.environ.get("DEV_TASKS_SPRINTS_BOARD_ID", "5091706352")

    active_sprint_id = monday_find_active_sprint(api_key, sprints_board_id)
    if not active_sprint_id:
        # No active sprint resolvable -> can't make a queue claim; contribute
        # nothing (signal A still governs). Treated as "unknown" by the caller.
        return None

    return monday_count_ready_tasks(api_key, tasks_board_id, active_sprint_id)


def monday_graphql(api_key, query, variables):
    """Minimal Monday GraphQL POST. Returns parsed JSON dict or None on failure."""
    try:
        import urllib.request
        payload = json.dumps({"query": query, "variables": variables}).encode("utf-8")
        req = urllib.request.Request(
            "https://api.monday.com/v2",
            data=payload,
            method="POST",
            headers={"Authorization": api_key, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def monday_find_active_sprint(api_key, sprints_board_id):
    """Return the active sprint item id (as str) or None.

    The activation flag is a SPECIFIC checkbox column (`sprint_activation` on the
    STEP Sprints board) — NOT just "any checkbox". Matching any checkbox would
    falsely match the separate `sprint_completion` checkbox, which is set on every
    *completed* sprint, and return the wrong (first-completed) sprint. The column
    id is env-overridable so the hook stays project-agnostic.
    """
    activation_col = os.environ.get("DEV_TASKS_SPRINT_ACTIVATION_COL", "sprint_activation")
    query = (
        "query($board: [ID!], $cols: [String!]) { boards(ids: $board) { "
        "items_page(limit: 100) { items { id name "
        "column_values(ids: $cols) { id text type } } } } }"
    )
    data = monday_graphql(api_key, query, {"board": [sprints_board_id], "cols": [activation_col]})
    if not data:
        return None
    try:
        items = data["data"]["boards"][0]["items_page"]["items"]
    except (KeyError, IndexError, TypeError):
        return None
    for it in items:
        for cv in it.get("column_values", []):
            if cv.get("id") != activation_col:
                continue
            # Checked renders as non-empty text ("v"); unchecked is "" / None.
            if (cv.get("text") or "").strip():
                return str(it.get("id"))
    return None


def monday_count_ready_tasks(api_key, tasks_board_id, active_sprint_id):
    """Count Ready-to-Start, unclaimed Tasks-board items linked to the sprint.

    Pages through the Tasks board and, for each item, checks:
      - Status column (`task_status`) text == "Ready to Start"
      - Agent ID dropdown (`dropdown_mm0mrcex`) empty (claimable — Ready-to-Start
        tasks may already carry an agent; those are NOT claimable)
      - Sprint board-relation (`task_sprint`) links the active sprint. The match
        is on `linked_item_ids` (a list) via the BoardRelationValue fragment —
        the relation's `.text` is null, so a text match would never fire.
    Column ids are env-overridable. Returns an int, or None on query failure.
    """
    sprint_col = os.environ.get("DEV_TASKS_TASK_SPRINT_COL", "task_sprint")
    status_col = os.environ.get("DEV_TASKS_TASK_STATUS_COL", "task_status")
    agent_col = os.environ.get("DEV_TASKS_TASK_AGENT_COL", "dropdown_mm0mrcex")
    query = (
        "query($board: [ID!], $cursor: String, $cols: [String!]) { boards(ids: $board) { "
        "items_page(limit: 100, cursor: $cursor) { cursor items { id "
        "column_values(ids: $cols) { id text ... on BoardRelationValue { linked_item_ids } } "
        "} } } }"
    )
    cols = [status_col, agent_col, sprint_col]
    count = 0
    cursor = None
    pages = 0
    while pages < 10:  # hard cap — never loop forever in a Stop hook
        data = monday_graphql(api_key, query, {"board": [tasks_board_id], "cursor": cursor, "cols": cols})
        if not data:
            return None
        try:
            page = data["data"]["boards"][0]["items_page"]
        except (KeyError, IndexError, TypeError):
            return None
        for it in page.get("items", []):
            by_id = {cv.get("id"): cv for cv in it.get("column_values", [])}
            status = (by_id.get(status_col, {}).get("text") or "").strip()
            agent = (by_id.get(agent_col, {}).get("text") or "").strip()
            linked = by_id.get(sprint_col, {}).get("linked_item_ids") or []
            linked = [str(x) for x in linked]
            if status == "Ready to Start" and not agent and str(active_sprint_id) in linked:
                count += 1
        cursor = page.get("cursor")
        pages += 1
        if not cursor:
            break
    return count


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    if len(sys.argv) < 3:
        fail_open("called with insufficient arguments")

    project_root = sys.argv[1]
    has_source_changes = bool(sys.argv[2]) if len(sys.argv) > 2 else False
    stop_hook_active = (len(sys.argv) > 3 and sys.argv[3] == "1")
    transcript_path = sys.argv[4] if len(sys.argv) > 4 else ""

    marker_path = os.path.join(project_root, ".claude", "active-goal.json")
    marker = load_marker(marker_path)

    # --- No goal set ------------------------------------------------------
    # When there is no active goal, this hook does NOT block. But if the agent
    # changed source files this branch, surface the SELF-CHECK once (allow=exit 0)
    # so the fake-tiredness reminder still lands even without an explicit goal.
    if marker is None:
        if has_source_changes:
            err("[stop-goal-persistence] No goal set, but source files changed this branch.")
            err("")
            err(SELF_CHECK)
            err("")
            err('(Set a persistent completion condition with /goal "<condition>" to have this')
            err(" hook hold the session until the work is actually done.)")
        sys.exit(0)  # never block when no goal is set

    goal_text = (marker.get("goal") or "").strip()
    if not goal_text:
        # Marker exists but carries no condition -> treat as no goal (clean allow).
        fail_open("active-goal.json present but 'goal' is empty; allowing stop")

    # --- Escape hatch 1: the 3 legitimate pause reasons ------------------
    # If the agent deliberately halted (handoff / stuck / timeout), release the
    # goal cleanly so we never trap a genuine pause. Clear the marker so a later
    # resumed session starts fresh.
    if review_addressed_escape(project_root):
        err('[stop-goal-persistence] Legit pause detected (reviewAddressed). Releasing goal "{}".'.format(goal_text[:80]))
        clear_marker(marker_path)
        sys.exit(0)

    # --- Escape hatch 2: max consecutive blocks --------------------------
    # The counter is the PRIMARY anti-infinite-loop guard (works across Claude
    # Code versions, persists across turns). stop_hook_active is a secondary
    # signal: when set we already blocked in this immediate chain.
    try:
        max_blocks = int(marker.get("maxBlocks"))
    except (TypeError, ValueError):
        max_blocks = 3
    if max_blocks < 1:
        max_blocks = 3

    try:
        consecutive = int(marker.get("consecutiveBlocks", 0))
    except (TypeError, ValueError):
        consecutive = 0

    if consecutive >= max_blocks:
        err('[stop-goal-persistence] Goal "{}" still unmet after {} consecutive blocks — '
            "ALLOWING stop to avoid trapping the session.".format(goal_text[:80], consecutive))
        err("If the goal is genuinely done, run /goal clear. If you stopped for a real")
        err("blocker, that's fine. If you stopped on fake-tiredness, re-set the goal and continue.")
        clear_marker(marker_path)  # reset so a re-set goal starts clean
        sys.exit(0)

    # --- Evaluate the goal -----------------------------------------------
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    met = None
    reason = ""
    if api_key:
        model_result = evaluate_goal_model(goal_text, transcript_path, api_key)
        if model_result is not None:
            met, reason = model_result
    if met is None:
        # Deterministic fallback (no key, or model path unavailable/errored).
        met, reason = evaluate_goal_deterministic(project_root)

    # --- Goal MET -> clean allow -----------------------------------------
    if met:
        err('[stop-goal-persistence] Goal MET — "{}". Releasing. ({})'.format(goal_text[:80], reason))
        clear_marker(marker_path)
        sys.exit(0)

    # --- Goal NOT met -> BLOCK (exit 2) ----------------------------------
    # Bump the persistent counter first so the escape hatch can fire next time.
    marker["consecutiveBlocks"] = consecutive + 1
    write_marker(marker_path, marker)

    err('BLOCKED by /goal: completion condition not yet met — "{}"'.format(goal_text))
    err("")
    err("Keep working. Next step / why not done:")
    err("  -> {}".format(reason or "work toward the stated goal remains"))
    if stop_hook_active:
        err("")
        err("(You already attempted to stop once in this chain. This is block "
            "{} of {} before the safety escape hatch releases the session.)".format(consecutive + 1, max_blocks))
    err("")
    err(SELF_CHECK)
    err("")
    err("To release cleanly: finish the work (the goal auto-clears when met), or run")
    err("/goal clear if the goal is genuinely satisfied / no longer applies. If you hit")
    err("one of the 3 legit pause reasons, set reviewAddressed in .claude/active-task.json")
    err("(handoff-to-orchestrator | stuck:<reason> | timeout:<reason>) to release.")
    sys.exit(2)


if __name__ == "__main__":
    main()
