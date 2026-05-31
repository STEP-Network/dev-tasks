#!/usr/bin/env python3
"""Stop hook logic — separated from shell to avoid quoting/JSON issues.

Called by stop-task-check.sh with args:
  sys.argv[1] = STATE_FILE path
  sys.argv[2] = PROJECT_ROOT path
  sys.argv[3] = COMBINED_CHANGES (empty string if no source changes)

All output goes to stderr to avoid feeding back into the conversation loop.
Blocking is controlled by exit code (0 = allow, 2 = block).
"""
import json
import os
import subprocess
import sys


def err(*args):
    """Print to stderr so messages show in terminal but don't feed back as conversation."""
    print(*args, file=sys.stderr)


def running_in_ci():
    """True when executing inside a CI runner (GitHub Actions or any CI provider).

    `GITHUB_ACTIONS=true` is set by every GitHub Actions runner; `CI=true` is the
    de-facto standard set by virtually every CI provider. Either signal is enough.
    Used ONLY to relax the Stage-3 previewUrl gate (see main()) — a CI runner
    spawned by the autonomous fix-loop has no Vercel access and can never obtain a
    real preview URL, so the gate would otherwise hang the session to the
    workflow's timeout. No other stage is influenced by this signal.
    """
    return os.environ.get("GITHUB_ACTIONS") == "true" or os.environ.get("CI") == "true"


def main():
    if len(sys.argv) < 4:
        err("WARNING: stop-task-logic.py called with insufficient arguments")
        sys.exit(0)

    state_file = sys.argv[1]
    project_root = sys.argv[2]
    combined_changes = sys.argv[3]

    # Load state file
    try:
        with open(state_file) as f:
            state = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        err("WARNING: Could not read task state: {}".format(e))
        sys.exit(0)

    task_name = state.get("taskName", "Unknown")
    self_review_passed = state.get("selfReviewPassed", False)

    # No source file changes -> allow stop silently
    if not combined_changes:
        sys.exit(0)

    # Source files WERE changed -- enforce pipeline stages

    # Stage 1: Self-review must have passed
    if not self_review_passed:
        err('BLOCKED: Source files changed but self-review has NOT passed on task "{}".'.format(task_name))
        err("The post-implementation pipeline MUST complete before stopping:")
        err("  1. Run /self-review (iterative until all 10 checks pass)")
        err("  2. Run /ship-pr (build + lint + test + push + PR)")
        err("")
        err("Pipeline is MANDATORY when source files are modified. Continue working.")
        sys.exit(2)

    # Stage 2: PR must exist (changes pushed)
    # Also check state file prUrl as fallback — gh may fail due to network issues
    pr_url_in_state = state.get("prUrl")
    try:
        result = subprocess.run(
            ["gh", "pr", "view", "--json", "state"],
            capture_output=True,
            text=True,
            cwd=project_root,
            timeout=10,
        )
        pr_exists = result.returncode == 0
    except Exception:
        pr_exists = False

    if not pr_exists and not pr_url_in_state:
        err('BLOCKED: Self-review passed but no PR exists for task "{}".'.format(task_name))
        err("The post-implementation pipeline requires a PR before stopping:")
        err("  Run /ship-pr (build + lint + test + push + PR creation)")
        err("")
        err("Pipeline is MANDATORY when source files are modified. Continue working.")
        sys.exit(2)

    # Stage 3: Preview URL must be posted to Monday.com
    #
    # CI BYPASS (2026-05-31): a CI runner spawned by the autonomous fix-loop has
    # NO Vercel access, so it can never obtain/set a real previewUrl. Without this
    # relaxation the gate hard-blocks session-stop and the run hangs to the
    # workflow's timeout-minutes on every tick. Under CI we log a note and fall
    # through to Stage 4 instead of exit(2). The gate stays fully intact for
    # local/dev sessions, where a real Vercel preview URL IS obtainable. Stages
    # 1+2 already ran above (a CI session still needs self-review + a PR); Stages
    # 4+5 still run below. This only governs the SELF-stop convenience gate — the
    # merge gate (pre-merge-review-gate.py) is separate and unaffected, so no
    # production boundary is crossed.
    preview_url = state.get("previewUrl")
    if not preview_url:
        if running_in_ci():
            err('NOTE: previewUrl unset but running under CI (GITHUB_ACTIONS/CI) — '
                'relaxing Stage 3 for task "{}". CI runners have no Vercel access; '
                "this unblocks autonomous-loop sessions. Stages 4+5 still apply.".format(task_name))
        else:
            err('BLOCKED: PR exists but preview URL has NOT been posted to Monday.com for task "{}".'.format(task_name))
            err("The pipeline requires a demo/preview URL before stopping:")
            err("  1. Fetch Vercel preview URL via mcp__vercel__list_deployments")
            err("  2. Post to Monday.com via mcp__plugin_dev-tasks_dev-tasks__updateTask with demoUrl field")
            err("  3. Save previewUrl in .claude/active-task.json")
            err("")
            err("Run /ship-pr to complete the pipeline, or do these steps manually.")
            sys.exit(2)

    # Stage 4: CI checks must be green (LIVE verification — cannot be faked)
    # ESCAPE HATCHES:
    #   - "handoff-to-orchestrator" (2026-05-15): agent handed off post-push
    #     polling to the orchestrator session per the no-merge policy. Skip
    #     Stages 4 + 5 — orchestrator's /babysit-prs handles CI gating + review
    #     triage + merge from there.
    #   - "stuck:*" / "timeout:*" (2026-05-28): agent halted intentionally
    #     (regression-loop, max-rounds, etc.) and is waiting for user. Blocking
    #     on CI green or set-reviewAddressed here creates an impossible state
    #     when the halt itself was triggered by failing/pending CI plus
    #     unresolvable BLOCKERs. pre-merge-review-gate.py still refuses the
    #     merge for any stuck:*/timeout:* (line 118), so this escape only
    #     governs the session-stop gate. Mirrors the stop-ci-green-check.sh
    #     and stop-monday-reconciled-check.sh escape pattern.
    ra = state.get("reviewAddressed") or ""
    if ra == "handoff-to-orchestrator" or ra.startswith("stuck:") or ra.startswith("timeout:"):
        sys.exit(0)

    try:
        ci_result = subprocess.run(
            ["gh", "pr", "checks", "--json", "name,state,conclusion"],
            capture_output=True,
            text=True,
            cwd=project_root,
            timeout=15,
        )
        if ci_result.returncode == 0:
            checks = json.loads(ci_result.stdout)
            failing = [c for c in checks if c.get("conclusion") == "FAILURE"]
            pending = [c for c in checks if c.get("state") in ("QUEUED", "IN_PROGRESS", "PENDING", "WAITING")]
            # Filter out non-blocking checks (Vercel Agent Review is always skipping)
            pending = [c for c in pending if c.get("name") not in ("Vercel Agent Review",)]

            if failing:
                names = ", ".join(c.get("name", "?") for c in failing)
                err('BLOCKED: CI checks FAILING on task "{}": {}'.format(task_name, names))
                err("Fix failing checks before stopping. Run: gh run view <run-id> --log-failed")
                sys.exit(2)

            if pending:
                names = ", ".join(c.get("name", "?") for c in pending)
                err('BLOCKED: CI checks still PENDING on task "{}": {}'.format(task_name, names))
                err("Wait for CI to complete (including claude-review). Poll with: gh pr checks")
                err("")
                err("You MUST wait for ALL checks including claude-review before stopping.")
                sys.exit(2)
    except Exception as e:
        err("WARNING: Could not verify CI status: {}. Skipping CI gate.".format(e))

    # Stage 5: GitHub code review must be addressed
    review_addressed = state.get("reviewAddressed")
    if not review_addressed:
        err('BLOCKED: CI green but GitHub code review has NOT been addressed for task "{}".'.format(task_name))
        err("The pipeline requires the GitHub review to be checked and addressed:")
        err("  1. Check PR review comments: gh api repos/{owner}/{repo}/pulls/{pr}/comments")
        err("  2. If review has actionable feedback: fix issues, self-review, push")
        err("  3. If review is clean: set reviewAddressed in .claude/active-task.json")
        err("")
        err('  Valid values: "accepted", "fixed", "timeout:{reason}", "handoff-to-orchestrator", "stuck:regression-loop", "stuck:max-rounds"')
        err("")
        err("The /ship-pr skill handles this automatically in Phase 6.")
        sys.exit(2)

    # All stages passed -- allow stop silently
    sys.exit(0)


if __name__ == "__main__":
    main()
