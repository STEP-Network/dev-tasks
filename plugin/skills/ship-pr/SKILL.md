---
name: ship-pr
description: Build, lint, test, validate schema, push, and create/update PR
user_invocable: true
---

# /ship-pr — Ship Changes (Pre-Push + PR)

## Workflow

### Phase 0: Task & Review Verification
1. **Read state file**: Read `.claude/active-task.json`
   - If missing: BLOCK — do NOT proceed. The agent must run `/pickup-task` first.
   - Note: The Edit/Write guard hook only covers those tools; Bash-based file writes are not guarded, so this check is the safety net.
2. **Check self-review passed**: Verify `"selfReviewPassed": true` exists in the state file.
   - If missing or false: BLOCK — do NOT proceed. Run `/self-review` first.
   - `/self-review` is iterative (fix → re-review → repeat until clean) and sets this flag automatically.
3. **Check in-progress subtasks**: If any subtask has `"status": "in_progress"`:
   - PROMPT: "Subtask '{name}' is still In Progress. Run `/log-progress SUBTASK_COMPLETED` first to record actual hours."
   - Do NOT proceed until resolved
4. **Verify actual hours**: All `"status": "done"` subtasks must have `"actualHours"` recorded
   - If any are missing: PROMPT to confirm before proceeding. Suggest running `/log-progress SUBTASK_COMPLETED` for them.

### Phase 1: Validation
1. **Build**: `pnpm build` — must pass
2. **Lint**: `pnpm lint` — must pass
3. **Test**: `pnpm test` — must pass (unit + integration)
4. **E2E**: `pnpm playwright test` — must pass (if UI/flow changes were made)
5. **Schema validation** (if migration files touched):
   - `pnpm validate-schema --env testing`
6. **Migrations** (if migration files touched):
   - **Do NOT auto-apply migrations to production from `/ship-pr`.** Under the staging-as-base flow (per `.claude/rules/release-flow.md` and `.claude/rules/database.md`), migrations follow this lifecycle:
     - Apply locally via `pnpm migrate:testing` during development.
     - Ship the migration on the same PR that references it (default base `staging`).
     - On PR open/sync, `.github/workflows/preview-staging-migrations.yml` automatically diffs `_drizzle_migrations` between staging and prod, finds the auto-created preview Neon branch, and applies any staging-pending migrations on top — so the preview has prod data + staging schema. **No manual agent action required**.
     - On PR merge to staging, `staging-migrate.yml` applies migrations to the staging Neon branch.
     - At release time, `/release-version` applies migrations to production Neon as part of the FF + tag ceremony.
   - The old "auto-apply additive migrations to prod first" workaround is **retired** — the per-PR preview-layering mechanism replaces it.

### Phase 2: Push Gate
5. **Set pre-push marker**: `touch /tmp/.claude-prepush-$(git rev-parse --abbrev-ref HEAD | tr '/' '-')`
   (This allows the bash-guard.sh hook to permit the push. Branch slashes are replaced with dashes.)
6. **Stage and commit** (if uncommitted changes exist)
7. **Push**: `git push -u origin {branch}`

### Phase 3: PR Management
8. **Check existing PR**: `gh pr view --json number,url` — determine if PR already exists, capture PR number and URL
9. **Determine PR base branch**:
   - **Default**: PR base = `staging` (per `.claude/rules/release-flow.md` — features integrate on staging first, promoted to main at release time).
   - **Hotfix exception**: if the branch was created from `main` (production-blocker bugfix), PR base = `main`. Detect by checking the merge-base: if `git merge-base origin/main HEAD == origin/main HEAD~N` and merge-base with staging is older, the branch was off main → use `--base main`.
10. **If no PR exists**: Create with template (include version info for CI version-check + EXPLICIT base):
   ```
   gh pr create --base {staging|main} --title "{title}" --body "$(cat <<'EOF'
   ## Summary
   {bullet points from git log}

   ## Monday.com Task: #{taskId}
   **Epic:** {epicName} (#{epicId})
   **Version:** {versionName} (#{versionId}) — or "Not linked" if unknown

   ## Pre-Push Checklist
   - [x] Build passes
   - [x] Lint passes
   - [x] Tests pass
   - [x] Schema validated (if applicable)
   - [x] Self-review completed

   ## Test Plan
   {testing steps}

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```
   **IMPORTANT**: The `Monday.com Task: #{taskId}` line enables the CI version-check job
   to verify Task → Epic → Version linkage before merge. Always include the task ID.
   **IMPORTANT**: `--base` MUST be explicit. Default `staging` (the new branching flow). Pass `--base main` ONLY for hotfixes branched from main directly.
11. **If PR exists** (re-push after review feedback):
    - Reset `selfReviewPassed: false` in `.claude/active-task.json` — changes made since last review must be re-reviewed
    - Run `/self-review` again (iterative until clean) before pushing
    - Then push (updates existing PR)

### Phase 4: Preview URL — MANDATORY (hard-enforced by stop hook)

> **CRITICAL**: The stop hook HARD BLOCKS session termination if `previewUrl` is not set
> in `.claude/active-task.json`. This phase is NOT optional.

12. **Wait for Vercel deployment**: Call `mcp__vercel__list_deployments` to find the preview
    deployment for the current branch. Filter by branch name (the `meta.githubCommitRef` field).
    - If not ready yet, wait 30 seconds and retry (max 3 retries)
    - Extract the deployment URL (use the branch alias format: `{project}-git-{branch}-{team}.vercel.app`)

13. **Post preview URL + link metadata to Monday.com**: Call `mcp__dev-tasks__updateTask` with:
    - `itemId`: the task ID from `.claude/active-task.json`
    - `demoUrl`: the Vercel preview URL (column `link_mm0mtyf4`)
    - `prLink`: the PR URL from step 9/10 (column `link_mm0m817p`)
    - `branch`: the current git branch (column `text_mm0pvs3n`)
    - `githubLink`: the GitHub branch URL `https://github.com/STEP-Network/v0-politiske-annoncer/tree/<branch>` (column `link`)
    These four fields are inspected by the `Waiting for UAT` gate (Phase 6.5) — the gate warns but doesn't block if any are missing. Setting them all at Phase 4 keeps the gate quiet.

14. **Persist to state file**: Update `.claude/active-task.json` to include:
    ```json
    {
      "previewUrl": "https://{project}-git-{branch}-{team}.vercel.app",
      "prUrl": "https://github.com/STEP-Network/v0-politiske-annoncer/pull/{N}"
    }
    ```
    **The stop hook checks for `previewUrl` — if missing, the session CANNOT end.**

### Phase 4.5: UAT Doc Generation — MANDATORY (default flow; skipped for hotfixes)

> **Why this phase**: under the lifecycle effective 2026-05-13, the parent task transitions
> to `Waiting for UAT` after the review loop terminates. The `Waiting for UAT` gate on
> `updateTask` REQUIRES a UAT testing doc to be set on column `doc_mm3adfdg`. This phase
> writes that doc autonomously from the task context, so the human UAT can start as soon as
> Phase 6.5 fires.
>
> **Hotfix exception**: PRs targeting `main` skip this phase. Hotfixes verify on production
> after merge, not on a UAT staging environment.

14a. **Decide flow type**: read the PR base from step 9. If `--base main` → skip to Phase 5. If `--base staging` → continue.

14b. **Gather UAT inputs**:
    - Read task `name`, `description`, `acceptanceCriteria` from `mcp__dev-tasks__getTask`.
    - Read subtask list (names + types + status) from `.claude/active-task.json`.
    - Compute git diff summary: `git diff staging...HEAD --stat` and `git log staging..HEAD --oneline`.
    - Note the preview URL from step 12.

14c. **Build UAT doc markdown**: structure as follows. Keep it regulator-readable — the
    UAT doc is also the record-of-what-was-tested for the changelog.

    ```markdown
    # UAT — {task name}

    **Preview URL**: {previewUrl}
    **PR**: {prLink}
    **Branch**: `{branch}`
    **Author summary**: {1–2 sentence summary derived from description}

    ## What changed in this PR

    {bulleted list from git log oneline, grouped by subtask type when possible}

    ## What to test (acceptance criteria)

    {acceptanceCriteria rendered as a checklist}

    ## Test paths

    {grouped by feature area, each with: URL, expected behavior, edge cases. Cover happy path + at least 2 edge cases per area.}

    ## Cross-cutting checks

    - [ ] i18n: at least 2 non-English locales render correctly ({choose 2 from da/de/fr/es/it})
    - [ ] Mobile viewport (375px width)
    - [ ] Empty / error / loading states
    - [ ] If touching auth: verify both authenticated and unauthenticated paths

    ## Out of scope for this PR

    {list anything the diff touches that is NOT part of this task's AC, e.g. pre-existing patterns the agent had to follow}

    ## Sign-off

    - [ ] All acceptance criteria pass
    - [ ] No regressions in unrelated areas
    - [ ] Ready to flip task → `Pending Deploy to Prod`
    ```

14d. **Create or update the UAT doc**:
    - First call attempt: `mcp__dev-tasks__createTaskUatDoc({ taskId, markdown })`.
    - If response indicates a doc already exists (re-push scenario): call `mcp__dev-tasks__updateTaskUatDoc({ taskId, markdown, overwrite: true })` instead.
    - On success, the doc is set on column `doc_mm3adfdg`. The `Waiting for UAT` gate at Phase 6.5 will accept this.

14e. **Log progress**: `/log-progress UAT_DOC_GENERATED` with a one-line summary of what's in the doc.

### Phase 5: Monday.com Event Update
15. **Post event**:
    - New PR → PR_CREATED with preview URL
    - Existing PR → REVIEW_FEEDBACK_FIXED with commit SHA
16. Via /log-progress with structured format including the preview URL

### Phase 6: Hand off post-push polling to orchestrator (policy change 2026-05-15)

> **Replaces the old review loop.** Effective 2026-05-15, agents no longer wait for CI or
> the bot review themselves. Steps 17–20 of the original review loop are deprecated.
>
> **Why**: agent-side polling (`gh pr checks` Monitor, `gh pr view --json comments` Monitor)
> kept stalling on stream-watchdog timeouts or never-firing predicates — the silent-after-CI
> pattern that bit ≥7 agents across Sprint 10 + follow-through. The structural fix is to
> move ALL post-push polling out of agent scope entirely.
>
> **What the agent does now**:
> 1. Push PR (already done in Phase 2-3)
> 2. Set `reviewAddressed: "handoff-to-orchestrator"` in `.claude/active-task.json`
>    — this is the escape-hatch value both stop hooks recognize (`stop-task-check.sh`
>    Stage 4+5 and `stop-ci-green-check.sh`) to allow exit BEFORE CI completes
> 3. Proceed to Phase 6.5 (Waiting for UAT) + Phase 6.6 (SendMessage handoff)
> 4. End the session
>
> **What the orchestrator does** (in its own session, via `/babysit-prs`):
> - Arms a Monitor that emits on each new Claude review comment, exits on
>   "ship-ready"/"no BLOCKERs"/"🟢" or "🔴 BLOCKER" in the body text
> - On READY: merges via `gh pr merge --admin --squash`
> - On BLOCKER: triages — fixes inline if <10 lines + low-risk, OR spawns a small
>   fixup subagent for larger work (the PR #286 BotID fix is the reference pattern)
> - Polls Corridor findings independently and triages alongside the Claude review
>
> **Hotfix exception**: PRs targeting `main` still require human merge — orchestrator
> doesn't auto-merge them. The handoff-to-orchestrator value still applies though
> (just means "agent done; human merges").

Steps 17–20 below are kept as ARCHIVED REFERENCE for the legacy review-loop pattern,
which a future task might restore if the orchestrator-merge model proves insufficient.
Skip directly to **Phase 6.5** under the new policy.

---

#### LEGACY (archived) — Phase 6 Review Loop — superseded 2026-05-15

> **CRITICAL**: The stop hook HARD BLOCKS session termination if `reviewAddressed` is not set
> in `.claude/active-task.json`. This phase is NOT optional. The agent MUST wait for,
> retrieve, and address review feedback from BOTH sources before the session can end:
>
> 1. **GitHub bot review** (`claude-review` workflow comment on PR) — covered by Steps 17-18.
> 2. **Corridor security findings** (static-analysis scanner findings on this branch) — covered by Step 18b.
>
> Both sources feed into the same triage in Step 19. `reviewAddressed` is only set once both
> are clean of BLOCKERs (or remaining items are explicitly declined as POLISH).

**Step 17: Wait for CI — use a background Monitor, don't block foreground**

> **Why a Monitor, not `gh pr checks --watch`**: blocking the foreground for up to 10 min
> ties the agent up doing nothing useful. A Monitor streams events as checks change state,
> lets the agent keep working in parallel (e.g. drafting follow-up commits, reading docs,
> updating Monday), and fires only when there's something to act on.

Arm a Monitor that polls `gh pr checks {prNumber}` every 30 s and emits one stdout line per
terminal check transition. Exit when no checks are pending. Example invocation:

> **Substitution note**: `{prNumber}` in the snippet below is a placeholder. The agent must
> replace it with the actual PR number captured in Phase 3 (Step 8) before arming the Monitor —
> a literal `{prNumber}` would silently poll the wrong endpoint.


```
Monitor(
  description: "CI status on PR #{prNumber}",
  timeout_ms: 900000,  # 15 min — covers Build + Vercel + claude-review tail
  command: 'PR={prNumber}
    # Fail loud if the agent forgot to substitute the placeholder. A literal
    # "{prNumber}" passed to gh would silently poll an invalid endpoint.
    if [ "$PR" = "{prNumber}" ]; then
      echo "ERROR: substitute the actual PR number for {prNumber} before arming this Monitor" >&2
      exit 1
    fi
    prev=""
    while true; do
      s=$(gh pr checks "$PR" --json name,bucket 2>/dev/null || echo "[]")
      cur=$(jq -r ".[] | select(.bucket!=\"pending\") | \"\\(.name): \\(.bucket)\"" <<<"$s" | sort)
      comm -13 <(echo "$prev") <(echo "$cur")
      prev=$cur
      # `length > 0` guards against vacuous-truth: jq `all(...)` on an empty array
      # returns true, so without this the Monitor would exit immediately if polled
      # in the 5–15 s window after a push before GitHub has registered any checks.
      # 2-arg form `all(.[]; pred)` is explicit about iterating elements (the 1-arg
      # form also works on arrays here since jq iterates them, but 2-arg is clearer
      # at a glance and harder to misread).
      jq -e "(length > 0) and all(.[]; .bucket != \"pending\")" <<<"$s" >/dev/null 2>&1 && break
      sleep 30
    done
    echo "---DONE---"'
)
```

**While the Monitor runs, the agent SHOULD continue with productive work** — e.g. drafting
the next subtask's plan, reviewing related PRs, updating Monday — instead of polling the
output file. Each terminal check transition fires a notification.

**On notifications** — terminal bucket values are `pass`, `fail`, `skipping`, `cancelled`, `timed_out`, `neutral`. Disposition table:

- `claude-review: pass` → fetch the bot's review comment via `gh pr view {prNumber} --json comments`. Go to Step 19.
- `Build: fail`, `Lint: fail`, `Apply staging-pending migrations to preview: fail` → fetch the failure log, fix locally, re-push (Step 20).
- `Test: fail` and/or `Playwright E2E: fail` ALONE → check if the same tests fail on staging HEAD; if yes, treat as pre-existing flake (do not block the PR).
- `*: skipping` → soft pass when the skip is intentional (e.g. `Vercel Agent Review` skips on the staging base; `claude` skips when the PR title doesn't trigger a re-run). If a check that's normally `pass`/`fail` shows `skipping`, investigate the workflow's `if:` to confirm the skip was intended.
- `*: cancelled` → typically caused by `cancel-in-progress: true` on a newer push. Wait for the new run's events; the cancelled run isn't authoritative.
- `*: timed_out` → escalate. Re-running the job once is fine; if it times out again, fix the underlying long-running step or split it.
- `*: neutral` → bot-defined neutral conclusion. Check the workflow logic to interpret.
- `---DONE---` → all checks settled. If only POLISH classifications remain, proceed to triage (Step 19) using the bot review fetched on `claude-review: pass`.

**On 3 consecutive CI failures (same root cause)**: post `/log-progress TASK_STUCK`, alert user.

**Caveat — "stale prev state" after a new push**: when a new commit lands (Step 20.h), the same
checks revert to `pending` and re-terminate as `pass`/`fail`. The Monitor's `comm -13` diff
against the previous commit's terminal states will emit them again. **Don't conflate these with
new findings** — only the bot's NEW comment text in `gh pr view --json comments` matters for
classification. Restart the Monitor on each push if you want a clean event stream.

**Step 18: Wait for the bot's review comment — use a separate Monitor**

> **Why separate from Step 17**: `gh pr checks` reports the `claude-review` workflow's *status*
> (in_progress / completed). It does NOT report the *content* of the bot's review comment.
> A common failure mode: the workflow shows "completed/success" but doesn't post a new comment
> (e.g. when the bot judges the diff doesn't materially change its earlier verdict). Watching
> `gh pr view --json comments` independently catches this.

In most cases, the `claude-review: pass` event from Step 17 lands at the same time the bot
posts its comment (within seconds). Just fetch the latest `claude` author comment after that
event fires:

```bash
gh pr view {prNumber} --json comments \
  --jq '[.comments[] | select(.author.login == "claude")] | last | .body'
```

**If `claude-review: pass` fired but the bot did not post a new comment** (rare — happens when
the diff is too similar to the prior round): the existing review verdict still applies. Re-read
the previous review comment, classify, and proceed.

**Optional second Monitor — for fresh-comment notifications when waiting independently**:

```
Monitor(
  description: "New Claude review comments on PR #{prNumber}",
  timeout_ms: 600000,
  command: 'last_seen=$(gh pr view {prNumber} --json comments --jq "[.comments[] | select(.author.login==\"claude\")] | last | .createdAt // \"\"")
    while true; do
      cur=$(gh pr view {prNumber} --json comments --jq "[.comments[] | select(.author.login==\"claude\")] | last | .createdAt // \"\"")
      if [ -n "$cur" ] && [ "$cur" != "$last_seen" ]; then
        echo "new claude review at $cur"
        last_seen=$cur
        break
      fi
      sleep 30
    done'
)
```

Use this only when you need notification timing precision finer than the Step 17 monitor.
**Launch this Monitor concurrently with Step 17's** if review-comment timing matters; otherwise
rely on the `claude-review: pass` event for a one-shot fetch. Launching Step 18's Monitor
sequentially after Step 17 completes defeats the purpose — comments usually land within seconds
of the workflow's terminal state, so by the time you arm Step 18 the comment is already there.

**Timeout fallback**: if neither monitor fires within 10 min after CI completes, set
`reviewAddressed: "timeout:no review comment after 10 min"` in state file and proceed to Phase 7
(the bot may have failed to post; ship-readiness is determined by CI + self-review, not the
bot's existence).

**Step 18b: Poll Corridor security findings — second review source**

Corridor scans every PR for security issues. Findings are independent of the GitHub bot review,
so they must be fetched and triaged separately (but feed into the SAME triage in Step 19).

Call once after the push commit lands on the branch:

```
mcp__corridor__getFindings({
  cwd: "<absolute project root>",
  branch: "<current branch name>",
  state: "open",
  excludeAIFalsePositives: true
})
```

Corridor's PR scan typically completes within 1–3 min of the push. If the response is empty,
either there are no findings OR the scan hasn't run yet. Wait 60s and retry up to 3 times.

For each finding returned:
- Note `id`, `severity`, `filePath`, `title`, `description`.
- These feed directly into Step 19 triage alongside the GitHub bot's findings.

**Setting reviewAddressed requires BOTH sources to be clean** of BLOCKERs (or POLISH-declined
with `updateFindingState`). See Step 20 for the loop.

If Corridor MCP is unreachable (network error, project not yet onboarded, etc.), set
`reviewAddressed: "timeout:corridor-unreachable"` and proceed — Corridor's own Stop hook
(`CORRIDOR_BLOCKING_STOP_HOOKS=true`) provides a separate safety net.

**Step 19: Triage review comments + Corridor findings — THE MOST IMPORTANT STEP**

> The reviewer bot generates nits indefinitely. Fixing everything it finds leads to
> 4+ round review loops with diminishing value. See `.claude/rules/ship-readiness.md`
> for the governing principle: **a PR is ship-ready when it's correct, safe, and tested —
> not when it's polished to perfection.**

**First filter — in scope vs out of scope:**
- **In scope**: files this PR actually modified
- **Out of scope**: pre-existing code in untouched files → **do NOT fix**, note in PR reply

**Then triage each in-scope issue into exactly one of three tiers:**

**🔴 BLOCKER — MUST fix before merge.** Applies when:
- **Security**: auth bypass, secret exposure, injection, client-controlled auth data
- **Correctness**: wrong logic that produces incorrect output for a real input
- **Data integrity**: mutation of immutable state, dropped writes, confirmed race condition
- **Privacy/GDPR**: PII leaked to a public surface, consent/retention violation
- **User-facing breakage**: crashes, broken flows, wrong emails sent to real users
- **Legal/compliance**: EU Reg 2024/900 or 2025/1410 non-compliance, retention-rule violation
- **Silent misconfiguration risk**: configuration that looks correct but causes prod breakage
  (e.g. two env vars where setting one silently breaks the other's behavior)

**🟠 IMPROVEMENT — Fix only if change is <10 lines AND low-risk.** Applies when:
- Genuine code-quality win in a pattern this PR already touched (consistency with surrounding code)
- Missing edge case with plausible real-world trigger (not "what if someone sets `   null   `")
- Minor DX issue on a public API this PR introduced (missing docstring, unclear param name)
- Pre-existing bug in a file this PR already modifies, where the fix is small
- Infra robustness (e.g. CI secret guard that clarifies a setup failure)

**🟡 POLISH — Decline via PR comment. Do NOT fix in this PR.** Applies when:
- Style preference (split tests, rename variable, reorder imports)
- Speculative defensive code ("what if env var has whitespace?")
- Documentation of already-obvious behavior
- Premature optimization (memoization, caching, paths filters)
- Comment polish, JSDoc additions on code that's self-documenting
- Pattern consistency nitpicks on unrelated code
- "Would be nice" suggestions without concrete harm

**Heuristic — ask two questions per issue:**
1. **What fails if we don't fix this?** If the answer is "nothing concrete" or "hypothetical scenario" → POLISH.
2. **Does a reasonable engineer read this and think "I'd want to ship as-is"?** If yes → POLISH.

When in doubt, lean POLISH. The downside of over-fixing (review-loop addiction, commit noise)
is worse than the downside of under-fixing (follow-up ticket).

**Decisions recorded in the state file** for auditability:
```json
{
  "reviewTriage": {
    "blockers": ["Issue title 1", "Issue title 2"],
    "improvements": ["Issue title 3"],
    "declined": [
      {"issue": "Issue title 4", "reason": "Style preference — no concrete harm", "source": "github-bot"},
      {"issue": "Issue title 5", "reason": "Speculative edge case — no evidence of occurrence", "source": "corridor", "findingId": "<uuid>"}
    ]
  }
}
```

**For each Corridor finding being declined, also call `mcp__corridor__updateFindingState`:**
```
mcp__corridor__updateFindingState({
  findingId: "<finding uuid>",
  state: "closed",
  closedReasonCategory: "risk_accepted" | "false_positive",
  closedReason: "<one-line rationale matching the PR comment>"
})
```
This keeps the Corridor dashboard in sync with the PR's triage decisions — without it, the
declined finding stays "open" forever and noise accumulates.

**Set `reviewAddressed` immediately if no BLOCKERs and no cheap IMPROVEMENTs across BOTH sources:**
- `"accepted"` — review was all POLISH (from both sources). Post a PR comment listing what's
  declined + why. For Corridor declines, the `updateFindingState` calls above replace the
  PR comment for THOSE items (Corridor dashboard is the audit log). Go to Phase 7.

If BLOCKERs or IMPROVEMENTs exist (from either source) → go to step 20.

**Step 20: Fix + reply + re-review** (loop — terminates when zero BLOCKERs remain across BOTH sources)

**There is NO hard round cap.** A later round can legitimately surface a new BLOCKER introduced
by an earlier fix — capping rounds by number would ship real bugs. The loop terminates when
the per-round triage finds zero BLOCKERs and no cheap IMPROVEMENTs worth addressing FROM EITHER
SOURCE (GitHub bot review + Corridor findings).

**Each round, critically re-evaluate:**
  a. Apply the triage from step 19 to the new review's findings (both bot review + Corridor)
  b. Is every item POLISH? → post decline comment for bot-review items, call
     `updateFindingState` for Corridor items being declined, set `reviewAddressed: "fixed"`
     (or `"accepted"` if nothing was ever fixed), go to Phase 7
  c. Any BLOCKER (including regression from an earlier round, from either source)? → fix it
  d. Any cheap IMPROVEMENT worth bundling (from either source)? → fix it
  e. Post a PR comment listing what this round fixes vs declines (both sources, side by side)
  f. Reset `selfReviewPassed: false` in state file
  g. Run `/self-review` (per its own rules) against the fix delta — its Check #11 will re-poll
     Corridor and confirm the fixes resolved the open findings before allowing the push
  h. Stage, commit, push — re-triggers CI + review + Corridor scan
  i. **Restart** the Step 17 + 18 Monitors (do NOT reuse the prior round's). The new commit
     resets all checks to `pending`, and a stale Monitor will emit the previous round's
     terminal states a second time before catching up — which can confuse triage.
  j. **Re-poll Corridor** (Step 18b) on the new commit — fixes may resolve old findings AND
     introduce new ones. Triage the FULL current finding list, not just the delta.
  k. Continue with productive work while the new round runs (don't poll Monitor output);
     when `claude-review: pass` fires, repeat from (a) against the NEW comment + new findings.

**The triage tightens over rounds — not because of a cap, but because of diminishing returns:**
- Round 1: fix BLOCKERs + cheap IMPROVEMENTs, decline POLISH
- Round 2+: same, but an item previously classified as IMPROVEMENT that was declined shouldn't
  be re-opened. Only new findings get fresh triage.

**Regression-loop escalation (not a cap)**: if three consecutive rounds each introduce a NEW
BLOCKER (not a stale finding being repeated — a genuinely new issue from the latest fix),
the implementation may be architecturally wrong. Stop iterating, post `/log-progress TASK_STUCK`,
and ask the user. A legitimate security-fix-cascade where each round finds something real is
fine to continue; detect the anti-pattern where fixes actively create new problems.

**Setting reviewAddressed:**
- `"fixed"` — BLOCKERs/IMPROVEMENTs were addressed across one or more rounds, loop terminated
  because only POLISH remained
- `"accepted"` — initial review was all POLISH, nothing was fixed, ship directly
- `"stuck:regression-loop"` — escalated after 3 consecutive rounds introducing new BLOCKERs

### Phase 6.5: Transition task → `Waiting for UAT` (default flow only; skipped for hotfixes)

> **Why this phase**: the parent task has been at `In Progress` throughout development.
> All subtasks are now `Done`, the UAT doc was generated in Phase 4.5, and the review loop
> has terminated with `reviewAddressed` set. This is the moment the human takes over for
> UAT. Flipping the status surfaces the task on the "Waiting for UAT" board view, the
> right signal for the human to start UAT.
>
> **Hotfix exception**: hotfix PRs (base = `main`) keep the parent at `In Progress` through
> merge. Phase 10 then sets `Done` directly. Hotfixes have no UAT step because they're
> verified on production after merge.

20a. **Decide flow type**: if PR base is `main` → skip to Phase 7 (hotfix). If PR base is `staging` → continue.

20b. **Verify gate prereqs** (the MCP enforces these server-side; this is early validation for clearer errors):
    - All subtasks in `.claude/active-task.json` have `"status": "done"` and `"actualHours"` set.
    - UAT doc exists on column `doc_mm3adfdg` — verify via `mcp__dev-tasks__getTaskUatDoc(taskId)`. If absent, re-run Phase 4.5.
    - `demoUrl`, `prLink`, `branch`, `githubLink` set on the task (Phase 4 already did this; the gate warns but doesn't block if any are missing).

20c. **Transition status**:
    ```
    mcp__dev-tasks__updateTask({
      itemId: taskId,
      status: "Waiting for UAT"
    })
    ```
    On rejection, the MCP returns a structured error listing the failing gate condition.
    Fix the named field and retry.

### Phase 6.6: Hand off to orchestrator — DO NOT auto-merge (policy change 2026-05-15)

> **Why this phase changed**: Effective 2026-05-15, agents NEVER call `gh pr merge`.
> The silent-after-CI failure pattern — agents go idle after `/ship-pr` finishes
> because their tool loop ends, leaving the PR open at `mergeStateStatus: CLEAN`
> until orchestrator manually merges — bit us across ≥6 Sprint 10 agents.
>
> **Root cause**: agents have no event loop. They can either (a) poll-inline
> synchronously (burning tokens + hitting watchdog timeouts) or (b) end their
> turn and never wake up. Async monitoring is the trap.
>
> **The fix**: agents do all the work up to "PR open + clean", then SendMessage
> the orchestrator/team-lead with the PR URL. Orchestrator (a persistent
> main-session loop, see `/babysit-prs` skill) owns ALL merges + ALL Monday
> reconciliation. This puts the polling responsibility on the only entity that
> CAN poll across turns — the orchestrator session.
>
> **Hotfix exception (NON-NEGOTIABLE)**: hotfix PRs (base = `main`) MUST be
> merged by a human. Same as before — production-blocker changes require human
> eyes on the merge button.

20d. **Verify base + CI green** (informational, not gating):
    - Base must be `staging` (read via `gh pr view {PR} --json baseRefName --jq .baseRefName`).
    - All CI checks at terminal state per Step 17 disposition.

20e. **DO NOT call `gh pr merge`.** Removed. The orchestrator owns merging.

20f. **SendMessage the orchestrator/team-lead** with the handoff:
    ```
    SendMessage({
      to: "team-lead",
      summary: "PR #{N} ready for merge",
      message: "PR opened: {PR URL}\nBase: {staging|main}\nBranch: {branch}\nMonday task: #{taskId}\nCI/review state: {summary — pass/fail/skipping per check}\nreviewAddressed: {accepted|fixed|stuck:...}\nUAT doc: {created|skipped (hotfix)}\nNotes for merge: {anything orchestrator needs — known-flake check names, etc.}"
    })
    ```
    For solo subagents (no team), still send the same message — the orchestrator handles routing.

20g. **Trigger Phase 10 cleanup** immediately. The orchestrator will merge; agent's
    work is done. State file cleanup + worktree removal happen now.

20h. **Log progress**: `/log-progress TASK_WAITING_FOR_UAT` with:
    ```
    [TASK_WAITING_FOR_UAT] Agent Progress Update
    Time: {ISO 8601} | Branch: {branch}
    Event: Review loop terminated, parent task → Waiting for UAT
    Details:
      UAT doc: posted on column doc_mm3adfdg
      Preview URL: {previewUrl}
      Test on: {previewUrl} now, then test.polads.eu after PR merges to staging
    Ready for human UAT.
    ```

### Phase 7: Monday.com Update + Completion

22. **Refresh Vercel preview URL**: Use `mcp__vercel__list_deployments` to get the latest
    deployment URL (may have changed after review fixes). Update `previewUrl` in state file
    and `demoUrl` on Monday.com via `mcp__dev-tasks__updateTask` if it changed.

23. **Update Monday.com parent task**: Use `mcp__dev-tasks__createUpdate` to post:
    ```
    [PIPELINE_COMPLETE] Agent Progress Update
    Time: {ISO 8601} | Branch: {branch}
    Event: PR created and review addressed
    Details:
      PR: {PR URL}
      Preview: {Vercel preview URL}
      CI: {status}
      Review: {reviewAddressed value} (iteration {N})
    Ready for demo testing.
    ```

24. **Post pipeline complete**: `/log-progress PIPELINE_COMPLETE`

### Phase 8: Version Linkage Check (HARD BLOCK)

25. **Check version linkage**:
    - Read `epicId` from `.claude/active-task.json`
    - Call `mcp__dev-tasks__getEpic(epicId)` to check if epic is already linked to a version
    - **If linked**: log "Task's epic ({epicName}) is linked to version {name}" — done
    - **If NOT linked**: HARD BLOCK — do NOT complete the pipeline until resolved:
      a. Call `mcp__dev-tasks__listVersions(status: "Planned", group: "upcoming")` to show upcoming versions
      b. Ask user: "This task's epic ({epicName}) is not linked to any version. Which version should it belong to?"
      c. Present version list with IDs
      d. If user selects a version → call `mcp__dev-tasks__updateVersion(versionId, linkEpicIds: [epicId])`
      e. If no upcoming versions exist → ask user if they want to create one via `mcp__dev-tasks__createVersion`
    - **Every shipped task must trace to a version. No orphaned work.**

25b. **Update structured Release Summary** (after version is confirmed linked):
    - Read `versionId` from state file (set in step 25a or from `/pickup-task`)
    - Call `mcp__dev-tasks__getVersion(versionId)` to get current Release Summary and task details
    - Read current Release Summary text from the version

    **3-category mapping (Feature / Improvement / Fix)** — established 2026-05-07:
    - Task type "Development" → add to `feature`
    - Task type "Bugfix" → add to `fix`
    - Task type "Maintenance" / "Refine" / "Documentation" / "PM-work" → add to `improvement`
    - Use the task's `Public Task Name` (column `text_mm349ah6`) if filled; otherwise fall back to the internal task name. Stakeholder-facing wording belongs in Public Task Name.

    - **If structured format exists** (has `STRUCTURED_CHANGELOG_V1` markers):
      a. Parse existing JSON via `parseStructuredChangelog` from `lib/services/monday.ts` — the parser auto-migrates legacy 4-cat data to the canonical 3-cat shape, so old versions written before 2026-05-07 are upgraded transparently.
      b. Add the just-shipped task to its 3-cat bucket per the mapping above.
      c. Update progress: `{ totalTasks, doneTasks, totalBugs, fixedBugs }` from version data.
      d. Write back: `mcp__dev-tasks__updateVersion(versionId, releaseSummary: updatedJSON)`.
    - **If plain text or empty** (first task shipped for this version):
      a. Create initial structured JSON with the task in its 3-cat bucket.
      b. Set summary from version name or "In development".
      c. Set progress counts from version data.
      d. Wrap in `STRUCTURED_CHANGELOG_V1` markers.
      e. Write back: `mcp__dev-tasks__updateVersion(versionId, releaseSummary: structuredContent)`.

    **Auto-bump check** (NON-BLOCKING — informational suggestion only):
    - If the version's `versionNumber` is empty AND the version has at least 1 task:
      a. Gather inputs (latest released, linked tasks classified via `classifyTaskType()`, `v1MilestoneReady` from getEpic(2833952138)+getEpic(2738006659)).
      b. Call `computeBumpSuggestion(input)` from `lib/services/version-bump.ts` — handles breaking-change detection, v1.0 milestone gating, and rationale generation in one call.
      c. Log `result.next` + `result.rationale` (and `result.gatedByMilestone` if non-null) in the task's update — actual version-number assignment happens at `/release-version` time, not at PR ship time.
    - This ensures the roadmap page always shows up-to-date progress after each PR ships, and the structured Release Summary stays canonical (3-cat) going forward.

### Phase 9: User Acceptance Testing Handoff — MANDATORY

> **CRITICAL**: After completing all pipeline phases, you MUST present the user with a
> structured acceptance testing checklist. Never end a session silently after pipeline
> completion — the user needs to know exactly what to test and verify.

26. **Generate acceptance testing checklist** based on what changed in this PR:
    - Read the git diff (`git diff <base>...HEAD --stat` where `<base>` is the PR base — `staging` by default, `main` for hotfixes per Phase 3 step 9) to understand all changed areas
    - Read subtask names from `.claude/active-task.json` for feature context
    - Build a checklist grouped by feature area, with:
      - Specific pages/URLs to visit (using the preview URL)
      - Expected behavior to verify
      - Edge cases to check (validation, error states, empty states)
      - Cross-cutting concerns (i18n, mobile, accessibility)

27. **Present to user** in this format:
    ```
    ## Acceptance Testing Checklist — PR #{N}

    ### {Feature Area 1}
    - [ ] {Specific thing to test with URL if applicable}
    - [ ] {Expected behavior to verify}

    ### {Feature Area 2}
    - [ ] ...

    ### Cross-cutting
    - [ ] {i18n, responsive, edge cases}

    **Preview URL**: {url}
    ```

28. **Post checklist to Monday.com**: Use `mcp__dev-tasks__createUpdate` to post the same
    checklist (HTML-formatted) as an update on the task. This lets the user (and team) see
    the test plan directly on the Monday.com task board without needing the terminal.

29. **The checklist must be**:
    - **Specific** — not generic "test the feature". Include exact URLs, form values, expected outcomes.
    - **Complete** — cover every changed feature area, not just the primary one.
    - **Actionable** — each item is a single verifiable action with a clear pass/fail.
    - **Grouped** — organized by feature/subtask, not a flat list.

**This phase is MANDATORY. The agent must ALWAYS present the checklist to the user AND post it to Monday.com.**

### Phase 10: Post-Merge Task Completion

> Under the lifecycle effective 2026-05-13, post-merge behavior is flow-dependent:
>
> - **Default flow (PR merged to `staging`)**: parent task was already flipped to `Waiting for UAT` in Phase 6.5. Phase 10 does NOT set `Done` — that's the release ceremony's job (`/release-version` after `Pending Deploy to Prod`). Phase 10 just cleans up.
> - **Hotfix flow (PR merged to `main`)**: parent task is still `In Progress` (Phase 6.5 was skipped). Phase 10 sets `Done` directly because hotfixes ship to prod at merge time.

30. **After `gh pr merge` succeeds** (or when the agent detects the PR state is "MERGED"):
    - **Determine flow type**: read the PR base. `gh pr view --json baseRefName --jq .baseRefName`.
    - **Default flow (`baseRefName == "staging"`)**:
      a. Leave the task at `Waiting for UAT` (Phase 6.5 already set it). Do **NOT** call `updateTask({status: "Done"})`.
      b. Post final update:
        ```
        [TASK_COMPLETED] Agent Progress Update
        Time: {ISO 8601} | Branch: {branch}
        Event: PR merged to staging. Task remains at Waiting for UAT; human UATs on test.polads.eu.
        Next status transitions:
          Waiting for UAT → Pending Deploy to Prod  (human, after UAT signoff)
          Pending Deploy to Prod → Done             (/release-version → tag → GitHub Action)
        ```
      c. Delete `.claude/active-task.json` (cleanup for next task).
    - **Hotfix flow (`baseRefName == "main"`)**:
      a. Call `mcp__dev-tasks__updateTask(itemId, status: "Done")`. The MCP gate accepts this because all subtasks are `Done` (hotfix had no UAT doc requirement).
      b. Post final update:
        ```
        [TASK_COMPLETED] Agent Progress Update
        Time: {ISO 8601} | Branch: {branch}
        Event: Hotfix merged to main, task marked Done (no UAT step — verified on prod).
        ```
      c. Delete `.claude/active-task.json` (cleanup for next task).
    - Note: under the staging-as-base branching flow, default PRs merge to `staging`. The promotion to `main` happens later via `/release-version`. Hotfix PRs merge directly to `main`.

31. **Worktree cleanup (HARD requirement when started via `/pickup-task` Phase 0)**:
    - If the current session is running in a worktree (i.e. `git rev-parse --git-common-dir`
      differs from `git rev-parse --git-dir`), call `ExitWorktree({ action: "remove" })`.
    - The tool will refuse to remove if the worktree has uncommitted files or commits not
      reachable from the original branch — that's the safety property. If it refuses:
      a. Inspect the listed leftovers
      b. Either commit + push (if they belong on this PR) or stash (if they're for a
         different task)
      c. Re-invoke `ExitWorktree({ action: "remove", discard_changes: true })` only after
         confirming with the user that nothing of value will be lost
    - On success, the session's CWD is restored to the main checkout. Subsequent work
      goes through `/pickup-task` again, which re-enters a fresh worktree.

32. **This is safe because** `/pickup-task` is enforced before any new work can begin —
    deleting the state file does not allow orphaned work, and the next `/pickup-task`
    Phase 0 will spin up a clean worktree for the next task.

**The agent must always clean up the worktree after merge. For default-flow PRs the task stays at `Waiting for UAT` (the release ceremony sets `Done`); for hotfix-flow PRs the task is set `Done` directly.**

## Failure Handling

- If build/lint/test fails: Show error, do NOT push, do NOT set marker
- If CI fails: Show failure details, fix and re-push. Do NOT proceed to review loop.
- If the review loop enters a regression-loop (3 consecutive rounds each introducing a NEW BLOCKER from the prior round's fix): Post TASK_STUCK, set `reviewAddressed: "stuck:regression-loop"`, alert user. This is not a round cap — legitimate multi-round security-fix cascades continue freely.
- After 3 consecutive failures at any stage: Suggest /log-progress TASK_STUCK
- If Vercel deployment not found: Retry 3 times with 30s delay. If still missing, warn user but still attempt to post PR URL to Monday.com.

## Post-Conditions

- Pre-push marker set at `/tmp/.claude-prepush-{branch}` (slashes replaced with dashes)
- Changes pushed to remote
- PR created or updated
- **Preview URL posted to Monday.com** (`demoUrl` field on task) — **HARD-ENFORCED by stop hook**
- **`previewUrl` persisted in `.claude/active-task.json`** — **HARD-ENFORCED by stop hook**
- **GitHub review addressed** — **HARD-ENFORCED by stop hook**
- **`reviewAddressed` persisted in `.claude/active-task.json`** — **HARD-ENFORCED by stop hook**
- **Task's epic linked to a version** — **HARD BLOCK in Phase 8**
- CI checks at terminal state (pass / pre-existing flake / documented skip)
- Review comments addressed (if any)
- Monday.com updated with PR URL + Vercel preview link
- PIPELINE_COMPLETE event posted
- **User acceptance testing checklist presented** — specific, grouped, actionable items with preview URLs
- **UAT doc generated** — `createTaskUatDoc`/`updateTaskUatDoc` called for default-flow PRs; column `doc_mm3adfdg` populated
- **Task transitioned to `Waiting for UAT`** — Phase 6.5 default-flow only; hotfix-flow keeps `In Progress` through merge
- **Handoff sent to orchestrator** — Phase 6.6 SendMessage with PR URL + state summary; agent DOES NOT merge
- **State file cleaned up** — `.claude/active-task.json` deleted after handoff
- **Worktree removed** — `ExitWorktree({ action: "remove" })` called after handoff if the session was started in a worktree (Phase 0). Orchestrator's `/babysit-prs` will merge the PR and reconcile Monday post-merge.

## Stop Hook Enforcement

The stop hook (`stop-task-logic.py`) enforces 4 stages when source files are changed:
1. `selfReviewPassed` must be `true` → otherwise HARD BLOCK
2. PR must exist for the branch → otherwise HARD BLOCK
3. `previewUrl` must exist in state file → otherwise HARD BLOCK
4. `reviewAddressed` must exist in state file → otherwise HARD BLOCK

Valid `reviewAddressed` values:
- `"accepted"` — initial review had no BLOCKERs or cheap IMPROVEMENTs; declined items documented in PR comment; zero fix rounds run
- `"fixed"` — one or more fix rounds addressed BLOCKERs/IMPROVEMENTs; loop terminated because latest review has only POLISH remaining
- `"stuck:regression-loop"` — three consecutive rounds each introduced a new BLOCKER; escalated to user
- `"timeout:{reason}"` — review could not be retrieved (e.g. bot didn't post within polling window)

**The agent CANNOT end the session without completing all 4 stages.**
