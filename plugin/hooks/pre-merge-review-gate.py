"""
Pre-merge review gate — validates reviewAddressed in active-task.json before
allowing `gh pr merge`.

Called by pre-merge-review-gate.sh with:
  sys.argv[1] = path to active-task.json
  sys.argv[2] = project root
  sys.argv[3] = PR number (may be empty)
  sys.argv[4] = comma-separated configured review sources

Exit codes:
  0 = allow merge
  2 = block merge (reason on stderr)
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from typing import Optional

STATE_FILE = sys.argv[1]
PROJECT_ROOT = sys.argv[2]
PR_NUMBER = sys.argv[3] if len(sys.argv) > 3 else ""
CONFIGURED_SOURCES = sys.argv[4].split(",") if len(sys.argv) > 4 and sys.argv[4] else ["claudeBot", "corridor", "selfReview"]

VALID_TERMINAL_STATUSES = ("fixed", "accepted")
ALLOWED_ESCAPE_VALUES = ("handoff-to-orchestrator",)


def block(reason: str) -> None:
    print(f"BLOCKED: pre-merge-review-gate — {reason}", file=sys.stderr)
    sys.exit(2)


def load_state() -> dict:
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        block(f"cannot read active-task.json: {e}")
        return {}


def get_review_addressed(state: dict):
    ra = state.get("reviewAddressed")
    if ra is None:
        return None
    if isinstance(ra, (str, dict)):
        return ra
    return None


def parse_iso(ts: str) -> datetime:
    ts = ts.replace("Z", "+00:00")
    return datetime.fromisoformat(ts)


def get_latest_review_created_at(pr_number: str) -> Optional[str]:
    """Fetch the createdAt of the latest Claude bot review comment on the PR."""
    if not pr_number:
        return None

    try:
        result = subprocess.run(
            ["gh", "pr", "view", pr_number, "--json", "comments"],
            capture_output=True, text=True, timeout=30,
            cwd=PROJECT_ROOT
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        block("reviews unreachable — gh command timed out or not found. Retry in 30s.")
        return None

    if result.returncode != 0:
        block(f"reviews unreachable — `gh pr view` failed (exit {result.returncode}). "
              f"Cannot verify review state. Retry in 30s.")
        return None

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        block("reviews unreachable — cannot parse gh output. Retry in 30s.")
        return None

    comments = data.get("comments", [])
    review_comments = [
        c for c in comments
        if c.get("author", {}).get("login") == "claude"
        and "## Code Review" in c.get("body", "")
    ]

    if not review_comments:
        return None

    latest = max(review_comments, key=lambda c: c.get("createdAt", ""))
    return latest.get("createdAt")


def main():
    state = load_state()
    ra = get_review_addressed(state)

    # Gate 0: reviewAddressed missing entirely
    if ra is None:
        block(
            "reviewAddressed is not set in active-task.json.\n"
            "  The /ship-pr Phase 6 triage loop must populate this field before merge.\n"
            "  Run the review triage (poll reviews → classify → fix/decline → record) first."
        )

    # Legacy string values
    if isinstance(ra, str):
        if ra in ALLOWED_ESCAPE_VALUES:
            sys.exit(0)
        if ra in VALID_TERMINAL_STATUSES:
            sys.exit(0)
        if ra.startswith("stuck:") or ra.startswith("timeout:"):
            block(
                f"reviewAddressed = \"{ra}\" — cannot merge in a stuck/timeout state.\n"
                "  Resolve the underlying issue and re-run the triage loop."
            )
        block(
            f"reviewAddressed = \"{ra}\" — not a valid terminal status for merge.\n"
            "  Valid: \"fixed\", \"accepted\". Escape: \"handoff-to-orchestrator\"."
        )

    # Structured format (dict) — full validation
    if isinstance(ra, dict):
        status = ra.get("status", "")
        triaged_at = ra.get("triagedAt", "")
        sources = ra.get("sources", {})

        # Gate 1: status must be terminal
        if status not in VALID_TERMINAL_STATUSES:
            block(
                f"reviewAddressed.status = \"{status}\" — not ready for merge.\n"
                "  Must be \"fixed\" or \"accepted\" (zero BLOCKERs across all sources)."
            )

        # Gate 2: triagedAt must exist
        if not triaged_at:
            block(
                "reviewAddressed.triagedAt is empty — triage timestamp missing.\n"
                "  The triage loop must record when it completed."
            )

        # Gate 3: triagedAt must post-date latest review comment (race prevention)
        if PR_NUMBER:
            latest_review_ts = get_latest_review_created_at(PR_NUMBER)
            if latest_review_ts:
                try:
                    triage_dt = parse_iso(triaged_at)
                    review_dt = parse_iso(latest_review_ts)
                    if triage_dt < review_dt:
                        block(
                            f"reviewAddressed.triagedAt ({triaged_at}) is OLDER than "
                            f"the latest review comment ({latest_review_ts}).\n"
                            "  A reviewer posted after triage completed — re-run triage to "
                            "  evaluate the new findings."
                        )
                except (ValueError, TypeError) as e:
                    block(f"cannot parse timestamps for race check: {e}")

        # Gate 4: POLISH findings must have decline replies for configured sources.
        # localReview (v0.28.0) is the pre-push panel — its POLISH declines live
        # in the PR body (no PR comments exist pre-push), so it may satisfy the
        # gate with declinedInPrBody: true instead of comment-ID replies.
        for source_name in CONFIGURED_SOURCES:
            source_data = sources.get(source_name)
            if source_data is None:
                continue
            polish_count = source_data.get("polish", 0)
            replies = source_data.get("replies", [])
            if polish_count > 0 and len(replies) == 0:
                if source_name == "localReview" and source_data.get("declinedInPrBody") is True:
                    continue
                if source_name == "localReview":
                    block(
                        f"Source \"localReview\" has {polish_count} POLISH finding(s) "
                        f"but neither replies[] nor declinedInPrBody: true recorded.\n"
                        "  The local panel's POLISH declines belong in the PR body's\n"
                        "  'Local review: declined as POLISH' section — add it, then set\n"
                        "  reviewAddressed.sources.localReview.declinedInPrBody = true."
                    )
                block(
                    f"Source \"{source_name}\" has {polish_count} POLISH finding(s) "
                    f"but no decline replies recorded.\n"
                    "  Per ship-readiness.md, POLISH items must be declined via PR comment.\n"
                    "  Post decline comments, then record their IDs in "
                    "  reviewAddressed.sources.{source}.replies[]."
                )

        sys.exit(0)

    block("reviewAddressed has unexpected type — must be string or object.")


if __name__ == "__main__":
    main()
