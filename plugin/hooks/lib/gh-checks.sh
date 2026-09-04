#!/usr/bin/env bash
# Reading a PR's CHECK STATUS needs a token the ambient one may not be.
#
# WHY THIS EXISTS (#3200367976). `gh pr checks`, and any `gh pr view --json
# statusCheckRollup`, resolve through GitHub's GraphQL `statusCheckRollup` field,
# and a FINE-GRAINED personal access token is refused there:
#
#   GraphQL: Resource not accessible by personal access token
#     (repository.pullRequest.statusCheckRollup.nodes.0.commit.statusCheckRollup...)
#
# `gh` EXITS 0 on that refusal, printing the errors to stderr and nothing to
# stdout. Every call site in this plugin was `... 2>/dev/null`, so the failure was
# swallowed whole and the caller saw an EMPTY result — indistinguishable from
# "this PR has no checks yet". `stop-ci-green-check` then took its >60s branch,
# printed "could not query CI" and exited 0. It FAILED OPEN, with a message that
# reads like a transient network blip, so the CI-green gate had never once
# actually read CI. That is the silent-green failure class the gate exists to
# catch, sitting inside the gate.
#
# THE BLAST RADIUS IS NARROW, AND WAS MEASURED RATHER THAN ASSUMED. With the same
# fine-grained token, `gh pr view --json state,mergeable`, `gh run list` and
# `gh api repos/.../rulesets` all SUCCEED. Only statusCheckRollup reads fail. So
# this helper is for check-status reads specifically — do not route every `gh`
# call through it on the assumption that the token is broken generally.
#
# THE FIX IS A RETRY, NOT AN UNSET. Clearing GH_TOKEN unconditionally would be
# wrong inside GitHub Actions, where the injected token is the only credential
# available and no keyring exists. So: try the ambient token first, and only on a
# refusal retry with it cleared so `gh` falls back to its stored (classic)
# credential. Whichever token can answer, answers — correct in both environments.
#
# Usage:
#   source "$HOOK_DIR/lib/gh-checks.sh"
#   if STATUS=$(gh_pr_checks "$PR" --json name,bucket); then
#     ...
#   else
#     # genuine failure — stderr already surfaced. Do NOT treat as "no checks".
#   fi
#
# CONTRACT: prints stdout and returns 0 on success. On failure returns non-zero,
# prints nothing to stdout, and passes the underlying stderr through. Callers
# must surface that rather than discarding it — discarding it is precisely how
# the original hole was dug.

# `gh pr checks ...`
gh_pr_checks() {
  _gh_checks_with_fallback pr checks "$@"
}

# `gh pr view ...` — for calls that request statusCheckRollup.
gh_pr_view_checks() {
  _gh_checks_with_fallback pr view "$@"
}

_gh_checks_with_fallback() {
  local out err rc out2 err2 rc2

  err=$(mktemp) || return 1
  out=$(gh "$@" 2>"$err")
  rc=$?

  # A ZERO EXIT WITH EMPTY STDOUT IS NOT SUCCESS. `gh` returns 0 on a partial
  # GraphQL refusal, so this exact shape is the bug — treating it as success is
  # what made the failure invisible for as long as it lasted.
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
    rm -f "$err"
    printf '%s' "$out"
    return 0
  fi

  if grep -qi "not accessible by personal access token\|Resource not accessible" "$err" 2>/dev/null \
    || { [ "$rc" -eq 0 ] && [ -z "$out" ]; }; then
    # Retry with the ambient token cleared so `gh` falls back to its stored
    # credential. Inside GitHub Actions there IS no stored credential, so this
    # simply fails again and we surface the original error — which is correct.
    err2=$(mktemp) || { rm -f "$err"; return 1; }
    out2=$(GH_TOKEN= GITHUB_TOKEN= gh "$@" 2>"$err2")
    rc2=$?
    if [ "$rc2" -eq 0 ] && [ -n "$out2" ]; then
      rm -f "$err" "$err2"
      printf '%s' "$out2"
      return 0
    fi
    rm -f "$err2"
  fi

  cat "$err" >&2
  rm -f "$err"
  return 1
}
