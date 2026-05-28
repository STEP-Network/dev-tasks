#!/usr/bin/env python3
"""
Parse a Task(self-reviewer) tool result into a reviews.jsonl row.

Reads JSON from stdin (the PostToolUse hook input). Writes ONE JSON object to
stdout, suitable for piping into scripts/append-review-memory.ts.

Defensive: on any parse failure, emits a minimal but schema-valid row rather
than crashing. This way Loop 1 captures *something* for every review iteration,
even if the agent output is unusual.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

# Shared tool_response → text helper. Co-located in lib/ so post-self-review.sh
# can also import it from its inline python3 -c block. Single source of truth
# for the Claude Code PostToolUse payload shape variants.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from tool_response_helpers import extract_text  # noqa: E402


# Severity tokens are case-sensitive. Reviewer prose consistently uses
# UPPERCASE for severity (BLOCKER / IMPROVEMENT / POLISH / FAIL / PASS / N/A);
# matching lowercase would mis-fire on narrative ("if this should fail or pass").
SEVERITY_PATTERN = re.compile(r"\b(BLOCKER|IMPROVEMENT|POLISH|FAIL|PASS|N/?A)\b")
# `tsx` and `yaml` come before their shorter cousins so the regex doesn't
# greedy-match `Button.ts` when the file is actually `Button.tsx`.
LINE_REF_PATTERN = re.compile(
    r"([A-Za-z0-9_/.\-]+\.(?:tsx|ts|yaml|yml|md|json|sh|sql|py))(?::(\d+))?"
)
ROUND_PATTERN = re.compile(r"iteration\s+(\d+)|round\s+(\d+)", re.IGNORECASE)

# PII redaction patterns — strip likely-PII shapes from finding `message` before
# the row gets committed. Reviewer prose occasionally quotes file snippets that
# may include test fixtures with email addresses, phone numbers, etc. The 1000-char
# cap limits exposure but doesn't prevent it. These regexes neutralize the worst.
_PII_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # Email addresses (anywhere in the line).
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), "[EMAIL_REDACTED]"),
    # Long bearer-token-shaped strings (32+ chars of base64-ish).
    (re.compile(r"\b[A-Za-z0-9_\-]{32,}\b"), "[TOKEN_REDACTED]"),
    # Phone numbers (E.164-ish: optional + with 8-15 digits).
    (re.compile(r"\+?\d[\d\s\-]{7,14}\d"), "[PHONE_REDACTED]"),
    # Common secret env-var assignments (leave the var name, redact the value).
    (re.compile(r"(?i)(api[_-]?key|secret|token|password|passwd|pwd)\s*[=:]\s*['\"]?[A-Za-z0-9._\-/]+['\"]?"),
     r"\1=[REDACTED]"),
]


def redact_pii(text: str) -> str:
    """Strip likely-PII / secrets from a finding message before persisting.

    Defense-in-depth — reviews.jsonl is committed, so we err on the side of
    over-redacting. Token redaction will hit some legitimate hashes/SHAs but
    the cost is "review-memory entry says [TOKEN_REDACTED] instead of a Git SHA",
    which is acceptable.
    """
    for pattern, repl in _PII_PATTERNS:
        text = pattern.sub(repl, text)
    return text


def normalize_severity(raw: str) -> str:
    raw = raw.upper().replace("N/A", "NA")
    if raw == "FAIL":
        return "BLOCKER"  # Reviewer's "FAIL" maps to ship-readiness BLOCKER.
    if raw in ("BLOCKER", "IMPROVEMENT", "POLISH", "PASS", "NA"):
        return raw
    return "PASS"


def categorize(message: str) -> str:
    """Best-effort signature for grouping. Free-text-but-stable per schema."""
    m = message.lower()
    if "i18n" in m or "locale" in m or "translation" in m:
        return "i18n_completeness"
    if "snapshot" in m and ("immutable" in m or "confirmed" in m or "mutation" in m):
        return "snapshot_immutability"
    if "auth" in m and ("bypass" in m or "missing" in m):
        return "auth_check"
    if "secret" in m or "api key" in m or "credential" in m:
        return "secret_exposure"
    if "broken" in m and ("path" in m or "reference" in m):
        return "broken_path_reference"
    if "type" in m and ("any" in m or "implicit" in m):
        return "typescript_any"
    if "test" in m and ("missing" in m or "regression" in m):
        return "missing_test"
    if "docs" in m or "documentation" in m or "rag" in m:
        return "docs_drift"
    if "ui" in m or "themed" in m or "shadcn" in m:
        return "ui_consistency"
    if "schema" in m or "migration" in m:
        return "schema_change"
    return "uncategorized"


def safe_get_active_task() -> dict:
    state_file = os.environ.get("STATE_FILE")
    if not state_file or not os.path.exists(state_file):
        return {}
    try:
        with open(state_file) as f:
            return json.load(f)
    except Exception:
        return {}


def safe_run(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


def count_bot_review_comments(pr_number: int | None) -> int:
    """Count claude-bot review comments on the PR via `gh pr view`.

    Each round of bot review posts one comment whose body contains some
    variant of "Code Review" — historically both `## Code Review` and
    `**Code Review` heading styles have appeared. The filter matches the
    bare substring "Code Review" to catch all variants without
    undercounting. Round N self-review fires AFTER N-1 bot comments
    exist (the bot reviews the fix push, then the agent runs self-review
    on round N's fix delta). Returns 0 if PR doesn't exist, gh isn't
    available, or any error — the caller falls back to other heuristics.

    Test override: set BOT_REVIEW_COUNT_OVERRIDE to an integer to bypass
    the gh call and return that value directly. Production callers leave
    it unset.
    """
    override = os.environ.get("BOT_REVIEW_COUNT_OVERRIDE")
    if override is not None:
        try:
            return int(override)
        except ValueError:
            return 0
    if pr_number is None:
        return 0
    output = safe_run([
        "gh", "pr", "view", str(pr_number), "--json", "comments",
        "--jq", '[.comments[] | select(.author.login == "claude" and (.body | contains("Code Review")))] | length',
    ])
    if not output:
        return 0
    try:
        return int(output)
    except ValueError:
        return 0


def extract_round(text: str, active_task: dict, pr_number: int | None) -> int:
    """Determine the current self-review round.

    Priority order:
    1. Explicit `iteration N` / `round N` in agent output (most reliable when present).
    2. Count of claude-bot `## Code Review` comments on the PR + 1 (the
       agent's self-review fires AFTER bot reviews; so round N means N-1
       bot comments already landed).
    3. `round N` markers in active-task.json's reviewAddressed.
    4. Default: round 1.

    Pre-#122, only paths 1 and 3 existed and most rows ended up with round=1
    because the agent rarely writes "iteration N" in the prose. Path 2 (PR
    comment count) is the new authoritative signal — it's deterministic and
    grounded in observable PR state, which is what GAP-K's grouping needs.
    """
    m = ROUND_PATTERN.search(text or "")
    if m:
        return int(m.group(1) or m.group(2))

    bot_count = count_bot_review_comments(pr_number)
    if bot_count > 0:
        return bot_count + 1

    review_addressed = active_task.get("reviewAddressed", "") or ""
    if "round" in review_addressed.lower():
        rounds = re.findall(r"round[\s\-_]*(\d+)", review_addressed, flags=re.IGNORECASE)
        if rounds:
            return max(int(r) for r in rounds) + 1
    return 1


def sha256_short(text: str) -> str:
    """SHA-256 of `text` truncated to 16 hex chars — enough for dedup keys without bloat."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def extract_findings(text: str, pr_number: int | None, round_num: int) -> list[dict]:
    """Extract findings from the agent's prose output.

    The reviewer typically emits lines like:
      ✓ Types — PASS
      ❌ Docs — FAIL: file.md line 73 — broken reference
      🟠 IMPROVEMENT — file.ts line 42 — missing edge case
    We scan each line and best-effort match severity + file:line.
    """
    findings: list[dict] = []
    lines = (text or "").split("\n")
    idx = 0
    pr_id = pr_number if pr_number is not None else "local"
    for line in lines:
        sev_match = SEVERITY_PATTERN.search(line)
        if not sev_match:
            continue
        severity = normalize_severity(sev_match.group(1))
        # Skip PASS-only lines unless they mention a specific file (they're noise).
        if severity in ("PASS", "NA") and not LINE_REF_PATTERN.search(line):
            continue

        path_match = LINE_REF_PATTERN.search(line)
        file_path = path_match.group(1) if path_match else None
        line_no = int(path_match.group(2)) if (path_match and path_match.group(2)) else None

        # Redact likely-PII / secrets, then truncate (schema cap = 1000).
        msg = redact_pii(line.strip())[:1000]

        idx += 1
        findings.append({
            "id": f"{pr_id}-r{round_num}-{idx}",
            "severity": severity,
            "category": categorize(msg),
            "file": file_path,
            "line": line_no,
            "outcome": "pending",
            "message": msg,
            # Stable hash of the post-redaction message + file:line. GAP-K uses
            # this to dedup identical findings across rounds (e.g. same lint
            # error caught twice if the agent didn't actually fix it).
            "raw_text_sha256": sha256_short(
                f"{file_path or ''}:{line_no or ''}:{msg}"
            ),
        })
    return findings


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        # Can't parse hook input — emit nothing (hook will skip the append).
        return

    # The Task tool result is in `tool_response`. Shape-handling for str / dict
    # (with content|output|text) / list-of-parts lives in `tool_response_helpers`.
    text = extract_text(payload.get("tool_response", {}))

    active_task = safe_get_active_task()
    branch = safe_run(["git", "rev-parse", "--abbrev-ref", "HEAD"]) or active_task.get("branch", "unknown")
    sha = safe_run(["git", "rev-parse", "--short", "HEAD"])

    pr_number_raw = active_task.get("prUrl", "")
    pr_number: int | None = None
    if pr_number_raw:
        m = re.search(r"/pull/(\d+)", pr_number_raw)
        if m:
            pr_number = int(m.group(1))

    round_num = extract_round(text, active_task, pr_number)
    findings = extract_findings(text, pr_number, round_num)

    row = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "self-review",
        "pr": pr_number,
        "branch": branch,
        "round": round_num,
        "reviewer_prompt_version": "v1",  # Bump when self-review SKILL.md changes substantively.
        "findings": findings,
    }
    if sha:
        row["commit_sha"] = sha

    json.dump(row, sys.stdout)


if __name__ == "__main__":
    main()
