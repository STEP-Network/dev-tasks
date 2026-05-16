#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "user-prompt-task-context" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "user-prompt-task-context" || exit 0
# Hook: UserPromptSubmit — inject task + orchestration state as additionalContext
# on every user prompt. Survives compaction by re-injecting after each prompt.
#
# Closes part of GH issue #96 (the inject-on-prompt half).
#
# Two layers of state are injected when present:
#
# 1. **Per-task pipeline state** (`.claude/active-task.json`) — the
#    selfReviewPassed / previewUrl / reviewAddressed flags driven by the
#    /pickup-task → /self-review → /ship-pr pipeline. One task at a time.
#
# 2. **Cross-task orchestration state** (`.claude/orchestration-state.json`)
#    — a multi-task batch plan (e.g. "ship every Sprint 10 task"). Tracks
#    merged PRs, remaining tasks, next-task-pointer, operating rules. Survives
#    compaction so a long-horizon autonomous batch doesn't lose its place.
#    Either layer alone is sufficient — they're independent; both together is
#    the typical "actively-executing-a-plan" shape.
#
# Why both: the per-task state is fine for one-task sessions, but a batched
# autonomous run ("ship the whole sprint") needs cross-task continuity. After
# compaction, the agent's working memory of "what's already shipped, what's
# next" can get summarized away. Re-injecting the orchestration plan on every
# prompt keeps the batch coherent.
#
# PolAds-specific extension: if the active task has a prUrl, also inject a
# cached snapshot of `gh pr view --json state,reviewDecision,statusCheckRollup`.
# Refreshed at most every 5 minutes (cached at .claude/.pr-state-cache.json).
#
# Output: JSON with optional `additionalContext` field on stdout. Empty output
# (or invalid JSON) is silently ignored by the runtime — graceful degradation.
# Exit 0 always — never block the user's prompt.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"
ORCHESTRATION_FILE="$PROJECT_ROOT/.claude/orchestration-state.json"
PR_CACHE="$PROJECT_ROOT/.claude/.pr-state-cache.json"
PR_CACHE_TTL=300  # 5 minutes in seconds

# If neither active task NOR cross-task orchestration state exists, nothing to
# inject. Exit cleanly. (Either file alone is sufficient — they're independent
# layers: per-task pipeline state vs. multi-task batch plan.)
if [ ! -f "$STATE_FILE" ] && [ ! -f "$ORCHESTRATION_FILE" ]; then
  exit 0
fi

# Build the additionalContext via Python for JSON safety. The script must:
#   1. Read active-task.json if present (per-task pipeline state, truncated)
#   2. Read orchestration-state.json if present (multi-task batch plan, compacted)
#   3. If prUrl set + cache stale/missing, refresh PR state via gh
#   4. Emit JSON: { "additionalContext": "<formatted block>" }
#
# Keep the injection compact (~1KB target) — it's prepended to every prompt
# and eats context budget. The orchestration block is the bigger consumer;
# we summarize it, not dump the full JSON.
STATE_FILE_PATH="$STATE_FILE" \
ORCHESTRATION_FILE_PATH="$ORCHESTRATION_FILE" \
PR_CACHE_PATH="$PR_CACHE" \
PR_CACHE_TTL="$PR_CACHE_TTL" \
PROJECT_ROOT_PATH="$PROJECT_ROOT" \
python3 <<'EOF' 2>/dev/null
import json
import os
import subprocess
import sys
import time
import re


def main() -> None:
    state_file = os.environ["STATE_FILE_PATH"]
    orchestration_file = os.environ["ORCHESTRATION_FILE_PATH"]
    pr_cache_path = os.environ["PR_CACHE_PATH"]
    cache_ttl = int(os.environ["PR_CACHE_TTL"])
    project_root = os.environ["PROJECT_ROOT_PATH"]

    blocks: list[str] = []

    # ── Layer 1: per-task pipeline state (active-task.json) ────────────
    active_lines = build_active_task_block(state_file, pr_cache_path, cache_ttl, project_root)
    if active_lines:
        blocks.append("\n".join(active_lines))

    # ── Layer 2: cross-task orchestration plan (orchestration-state.json) ──
    orch_lines = build_orchestration_block(orchestration_file)
    if orch_lines:
        blocks.append("\n".join(orch_lines))

    if not blocks:
        return

    additional_context = "\n\n".join(blocks)
    out = {"additionalContext": additional_context}
    json.dump(out, sys.stdout)


def build_active_task_block(
    state_file: str, pr_cache_path: str, cache_ttl: int, project_root: str,
) -> list:
    try:
        with open(state_file) as f:
            state = json.load(f)
    except Exception:
        return []

    # Extract the fields the agent actually needs. Keep names short and
    # output one-line-per-field for high information density.
    task_id = state.get("taskId") or ""
    task_name = (state.get("taskName") or "")[:80]
    branch = state.get("branch") or ""
    phase = state.get("phase") or ""
    current_subtask = (state.get("currentSubtaskName") or "")[:80]
    self_review_passed = state.get("selfReviewPassed", False)
    pr_url = state.get("prUrl") or ""
    preview_url = state.get("previewUrl") or ""
    review_addressed = state.get("reviewAddressed") or ""

    lines = ["[active-task]"]
    if task_id:
        lines.append(f"task: #{task_id} {task_name}")
    if branch:
        lines.append(f"branch: {branch}")
    if phase:
        lines.append(f"phase: {phase}")
    if current_subtask:
        lines.append(f"current subtask: {current_subtask}")
    lines.append(f"selfReviewPassed: {self_review_passed}")
    if pr_url:
        lines.append(f"PR: {pr_url}")
    if preview_url:
        lines.append(f"preview: {preview_url}")
    if review_addressed:
        # Truncate so a long reviewAddressed doesn't blow out the injection.
        ra = review_addressed[:160]
        if len(review_addressed) > 160:
            ra += "…"
        lines.append(f"reviewAddressed: {ra}")

    # Live PR state — refresh if cache is stale and gh is available.
    pr_state_block = pr_state_for(pr_url, pr_cache_path, cache_ttl, project_root)
    if pr_state_block:
        lines.append("")
        lines.append(pr_state_block)

    return lines


def build_orchestration_block(orchestration_file: str) -> list:
    """Compact summary of cross-task orchestration state.

    Goal: enough information for the agent to know what plan it's executing,
    what's already shipped, what's next, and key operating rules — survives
    auto-compaction because it's re-injected on every prompt.
    """
    try:
        with open(orchestration_file) as f:
            orch = json.load(f)
    except Exception:
        return []

    lines = ["[orchestration-state]"]

    plan = orch.get("active_plan") or {}
    plan_name = plan.get("name", "")
    if plan_name:
        lines.append(f"plan: {plan_name[:120]}")
    user_directive = (plan.get("user_directive") or "")[:240]
    if user_directive:
        lines.append(f"directive: {user_directive}")

    merged = orch.get("merged") or []
    if merged:
        # One-line PR ledger (compact).
        ledger = ", ".join(f"#{m.get('pr')}" for m in merged if m.get("pr"))
        lines.append(f"merged ({len(merged)}): {ledger}")

    remaining = orch.get("remaining") or []
    if remaining:
        # Show the first 4 + count. Full list is in the JSON file the agent
        # can Read for detail.
        lines.append(f"remaining ({len(remaining)}):")
        for item in remaining[:4]:
            tid = item.get("task_id", "?")
            title = (item.get("title") or "")[:80]
            wave = item.get("wave", "?")
            size = item.get("size", "?")
            lines.append(f"  - W{wave} [{size}] #{tid} {title}")
        if len(remaining) > 4:
            lines.append(f"  … {len(remaining) - 4} more in .claude/orchestration-state.json")

    nxt = orch.get("next_task_pointer") or {}
    if nxt.get("candidate"):
        cand = nxt.get("candidate", "")
        reason = (nxt.get("reasoning") or "")[:160]
        lines.append(f"next-pointer: #{cand} — {reason}")

    rules = orch.get("operating_rules_quick_reference") or []
    if rules:
        # Show only the count + a hint to read the file. Each rule is too long
        # to inject literally and would balloon the prompt budget.
        lines.append(
            f"operating-rules: {len(rules)} entries — Read .claude/orchestration-state.json for full text"
        )

    return lines


def pr_state_for(
    pr_url: str, cache_path: str, cache_ttl: int, project_root: str,
) -> str:
    """Return a compact PR-state block, or empty string if unavailable."""
    if not pr_url:
        return ""

    # Extract PR number from URL like
    # https://github.com/STEP-Network/v0-politiske-annoncer/pull/127
    m = re.search(r"/pull/(\d+)", pr_url)
    if not m:
        return ""
    pr_num = m.group(1)

    cached = read_cache(cache_path, pr_num, cache_ttl)
    if cached is not None:
        return format_pr_state(cached)

    fresh = fetch_pr_state(pr_num, project_root)
    if fresh is None:
        return ""
    write_cache(cache_path, pr_num, fresh)
    return format_pr_state(fresh)


def read_cache(cache_path: str, pr_num: str, cache_ttl: int):
    try:
        with open(cache_path) as f:
            cache = json.load(f)
    except Exception:
        return None
    if cache.get("pr") != pr_num:
        return None
    fetched_at = cache.get("fetched_at", 0)
    if time.time() - fetched_at > cache_ttl:
        return None
    return cache.get("data")


def fetch_pr_state(pr_num: str, project_root: str):
    try:
        result = subprocess.run(
            [
                "gh",
                "pr",
                "view",
                pr_num,
                "--json",
                "state,reviewDecision,statusCheckRollup,mergeable",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=project_root,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except Exception:
        return None


def write_cache(cache_path: str, pr_num: str, data) -> None:
    try:
        cache = {"pr": pr_num, "fetched_at": time.time(), "data": data}
        tmp = cache_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cache, f)
        os.replace(tmp, cache_path)
    except Exception:
        pass


def format_pr_state(data) -> str:
    state = data.get("state", "?")
    review = data.get("reviewDecision") or "no-review-yet"
    mergeable = data.get("mergeable") or "?"

    # Summarize CI checks: count passed / failed / pending.
    rollup = data.get("statusCheckRollup") or []
    passed = sum(1 for c in rollup if (c.get("conclusion") == "SUCCESS"))
    failed = sum(1 for c in rollup if (c.get("conclusion") == "FAILURE"))
    skipped = sum(
        1 for c in rollup if c.get("conclusion") in ("SKIPPED", "NEUTRAL")
    )
    pending = sum(
        1
        for c in rollup
        if c.get("status") in ("IN_PROGRESS", "QUEUED", "PENDING")
    )

    return (
        f"[live-pr] state={state} review={review} mergeable={mergeable} "
        f"checks: {passed}✓ {failed}✗ {pending}⋯ {skipped}↷"
    )


main()
EOF

exit 0
