#!/bin/bash

# ci-skip-eval.sh [--base <ref>]
#
# Deterministic eligibility check for the per-task CI-gate auto-skip
# ("Skip (agent)" on the Monday CI Gate column, v0.26.0). The LLM never gets
# sole discretion over skipping CI — this script is the hard boundary. Only
# when it prints ELIGIBLE may the agent (after its own visual/copy-only
# confirmation) set ciGate to "Skip (agent)" via updateTask.
#
# Evaluates the COMMITTED diff (merge-base of <base>...HEAD) against
# .claude/project-config.json → ci.autoSkip:
#
#   enabled          (default false)  — master switch; absent block = never eligible
#   maxChangedLines  (default 50)     — total added+deleted lines across the diff
#   pathAllowlist    (default [])     — fnmatch globs; EVERY changed path must
#                                       match at least one. Empty = nothing
#                                       eligible (allowlists are explicit opt-in).
#   pathDenylist     (default migrations/db/auth/api/sql) — ANY changed path
#                                       matching one = not eligible. Configured
#                                       lists REPLACE the default (set the
#                                       defaults explicitly if you extend).
#
# Glob semantics: python fnmatch — `*` crosses directory separators, so
# `*.css` matches `src/a/b.css` and `**/api/**` matches `src/api/x.ts`.
# CAVEAT: `**/api/**` does NOT match root-level `api/x.ts` (no prefix to
# consume the leading `**/`). The default denylist therefore carries both
# forms (`api/**` AND `**/api/**`) for each guarded directory — do the same
# when configuring pathDenylist in project-config.
#
# Renames are evaluated with --no-renames (full add+delete) — conservative on
# purpose: a rename "costs" its full line count. Binary files count 0 lines
# but their paths still go through allow/deny matching.
#
# Output contract (stdout, first line is the verdict):
#   ELIGIBLE                      → exit 0
#   NOT_ELIGIBLE: <reason>        → exit 1
# Detail lines (changed files, line totals) follow the verdict.
#
# Re-run on EVERY push — scope creep revokes a previously-granted auto-skip
# (the /ship-pr Phase 2 integration reverts the column to Full when a later
# eval returns NOT_ELIGIBLE).

set -u

BASE_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_OVERRIDE="${2:-}"; shift 2 ;;
    *) echo "NOT_ELIGIBLE: unknown argument '$1' (usage: ci-skip-eval.sh [--base <ref>])"; exit 1 ;;
  esac
done

ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$ROOT" ]; then
  echo "NOT_ELIGIBLE: not inside a git repository"
  exit 1
fi

CONFIG="$ROOT/.claude/project-config.json"

CI_SKIP_CONFIG="$CONFIG" CI_SKIP_BASE="$BASE_OVERRIDE" python3 <<'PYEOF'
import fnmatch
import json
import os
import subprocess
import sys

# Both forms per directory: `**/x/**` misses root-level `x/...` under fnmatch
# (the leading `**/` must consume at least a prefix), so `x/**` covers it.
DEFAULT_DENYLIST = [
    "migrations/**", "**/migrations/**",
    "db/**", "**/db/**",
    "auth/**", "**/auth/**",
    "api/**", "**/api/**",
    "*.sql",
]

def verdict(ok, reason="", details=None):
    if ok:
        print("ELIGIBLE")
    else:
        print(f"NOT_ELIGIBLE: {reason}")
    for line in (details or []):
        print(line)
    sys.exit(0 if ok else 1)

config_path = os.environ["CI_SKIP_CONFIG"]
base_override = os.environ.get("CI_SKIP_BASE", "")

try:
    with open(config_path) as f:
        config = json.load(f)
except FileNotFoundError:
    verdict(False, "no .claude/project-config.json — auto-skip requires explicit project opt-in")
except Exception as e:
    verdict(False, f"unreadable project-config.json ({e})")

auto = (config.get("ci") or {}).get("autoSkip") or {}
if not auto.get("enabled"):
    verdict(False, "ci.autoSkip.enabled is not true")

max_lines = auto.get("maxChangedLines", 50)
allowlist = auto.get("pathAllowlist") or []
denylist = auto.get("pathDenylist")
if denylist is None:
    denylist = DEFAULT_DENYLIST

if not allowlist:
    verdict(False, "ci.autoSkip.pathAllowlist is empty — allowlists are explicit opt-in")

base = base_override or (config.get("git") or {}).get("defaultBase") or "main"
# Prefer the remote-tracking ref so a stale local base branch can't shrink the diff.
probe = subprocess.run(
    ["git", "rev-parse", "--verify", "--quiet", f"origin/{base}"],
    capture_output=True, text=True,
)
diff_base = f"origin/{base}" if probe.returncode == 0 else base

result = subprocess.run(
    ["git", "diff", "--numstat", "--no-renames", f"{diff_base}...HEAD"],
    capture_output=True, text=True,
)
if result.returncode != 0:
    verdict(False, f"git diff against {diff_base} failed: {result.stderr.strip()}")

total = 0
paths = []
for line in result.stdout.splitlines():
    parts = line.split("\t")
    if len(parts) != 3:
        continue
    added, deleted, path = parts
    paths.append(path)
    # Binary files report "-" — count 0 lines, but the path is still matched.
    if added != "-":
        total += int(added)
    if deleted != "-":
        total += int(deleted)

if not paths:
    verdict(False, "no committed changes against the base — nothing to evaluate")

denied = [p for p in paths if any(fnmatch.fnmatch(p, pat) for pat in denylist)]
if denied:
    verdict(False, f"denylisted path(s) changed: {', '.join(denied[:5])}",
            [f"  denylist: {denylist}"])

outside = [p for p in paths if not any(fnmatch.fnmatch(p, pat) for pat in allowlist)]
if outside:
    verdict(False, f"path(s) outside allowlist: {', '.join(outside[:5])}",
            [f"  allowlist: {allowlist}"])

if total > max_lines:
    verdict(False, f"{total} changed lines exceeds maxChangedLines={max_lines}")

verdict(True, details=[
    f"  base: {diff_base}",
    f"  files: {len(paths)}",
    f"  changed lines: {total} (cap {max_lines})",
])
PYEOF
