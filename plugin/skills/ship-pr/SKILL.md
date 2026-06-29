---
name: ship-pr
description: Build, lint, test, validate schema, push, and create/update PR
user_invocable: true
---

# /ship-pr — Ship Changes (Pre-Push + PR)

Read `.claude/project-config.json`. Extract `git.defaultBase`, `git.hotfixBase`, `monday.productId`, `monday.v1MilestoneEpicIds`, `environments.uat.url`. Substitute `$defaultBase` / `$hotfixBase` wherever this skill references `staging` / `main`. Projects without a separate staging branch set both to the same branch; FF-promotion in `/release-version` becomes a no-op.

## Workflow

### Phase 0: Task & Review Verification
1. Read `.claude/active-task.json`. Missing → BLOCK, run `/pickup-task` first.
2. Verify `selfReviewPassed: true`. Missing/false → BLOCK, run `/self-review`.
3. Any subtask `status: "in_progress"` → PROMPT to run `/log-progress SUBTASK_COMPLETED`.
4. All `done` subtasks must have `actualHours`. Missing → PROMPT.

### Phase 1: Validation
1. `pnpm build` — must pass
2. `pnpm lint` — must pass
3. `pnpm test` — must pass
4. `pnpm playwright test` — the per-task spec must pass (if UI/flow changes). The FULL suite is NOT a pre-push gate — it runs in-session advisory against staging post-merge (Phase 6.6 step 20f.8 → `/dev-tasks:run-full-e2e`).
5. `pnpm validate-schema --env testing` (if migration files touched)
6. Migrations: do NOT auto-apply to production. Consult consumer's `.claude/rules/database.md`. Generic pattern: apply locally during dev → ship migration on the PR → CI/CD applies to staging on merge → `/release-version` applies to production at release time.

### Phase 2: Push Gate
5. `touch /tmp/.claude-prepush-$(git rev-parse --abbrev-ref HEAD | tr '/' '-')` — allows `bash-guard.sh` to permit push.
6. Stage and commit if uncommitted changes exist.
6.3. **CI Gate evaluation (per-push, v0.26.0)** — resolve the task's CI Gate (`getTask` → `ciGate`; the Monday column is authoritative). Hotfix-base PRs NEVER honor a skip — treat as `Full` and tell the user if the column says otherwise.
   - **Gate is `Skip (human)`**: honor it. Note in the PR body ("CI Gate: Skip (human) — wait + e2e gates skipped by board authorization").
   - **Gate is `Skip (agent)` (from a previous push)**: re-run `bash $CLAUDE_PLUGIN_ROOT/scripts/ci-skip-eval.sh`. `NOT_ELIGIBLE` → **scope creep revokes the skip**: `updateTask({ ciGate: "Full" })` + set `ciGate: "Full"` in active-task.json (no marker needed — tightening is always allowed), surface the revocation. `ELIGIBLE` → keep.
   - **Gate is `Full`/empty AND `ci.autoSkip.enabled`**: run `ci-skip-eval.sh`. If `ELIGIBLE` AND you judge the diff visual/copy-only with no behavior change (the LLM confirm — when in doubt, DON'T): (1) `updateTask({ ciGate: "Skip (agent)" })` — the board write is the audit trail; (2) `bash $CLAUDE_PLUGIN_ROOT/scripts/emit-state-marker.sh ciGate`; (3) set `ciGate: "Skip (agent)"` in active-task.json. Never write `Skip (human)` — that label is reserved for humans on the board.
6.5. **Local-spec gate (autonomous-UAT pre-flight)**: skip this step entirely when the CI Gate is a Skip value (record "local spec gate skipped — CI Gate: <value>"). Otherwise: if `project-config.json → e2e.enabled` is `true` AND the diff classifier (per [`write-uat-spec`](../write-uat-spec/SKILL.md)) says a spec applies to this task: run `pnpm playwright test e2e/<area>/<slug>.spec.ts --reporter=line` with `BASE_URL=<e2e.baseUrl.local>` (default `http://localhost:3000`). Block push on red unless `/tmp/.claude-playwright-ack-<slug>` exists. If no spec exists yet, defer creation to Phase 4.6 (preview URL is more meaningful for first-write) and skip this step. Classifier "skip / defer-api / defer-integration" → no run.
6.7. **Local review panel (v0.28.0)** — runs when `project-config.review.sources[]` includes `localReview`. The review-fix iteration happens HERE, pre-push, instead of paying push → CI → cloud-bot round-trips per round (15–30 min on a 3-round task).
   - **Panel**: spawn 2–3 FRESH review subagents in parallel via `dev-tasks:self-reviewer` (it has Read/Glob/Grep/Bash). "Fresh/independent" means **no author context** — the reviewer must NOT inherit this session's implementation conversation/rationale — NOT "diff only". Each reviewer gets the diff (`git diff $defaultBase...HEAD`), the task AC, the project rules, AND **full repo read access** — it MUST read the changed files in full and grep for sibling call-sites (other routes/components/schemas that share the changed pattern). The 2026-06-12 parity benchmark (task #2988065489 UAT doc) proved diff-only review misses the bot's class of finding: "the same validation gap exists in another unpatched route" and full-file control-flow/runtime-API-behavior bugs. Repo access is the lever that closes that gap — the GitHub bot has it; the panel must too.
   - **Lenses**: **correctness** (logic, edge cases, regressions, runtime-API-contract behavior), **security** (injection, authz, secrets, gate-bypass), and — when the diff touches test files or test-worthy surface — **tests/coverage**. Each lens MUST include a **sibling-call-site sweep**: grep the repo for other code paths that need the same change (the diff under review may patch only 1 of N sites). Effort scales with task priority: Critical/High → 3 lenses; Medium/Low → 2 (correctness + security).
   - **Quality bar (Nate, 2026-06-12) — HARD GATE**: the panel must be at least GitHub-Claude-code-review quality. A project may set `review.cloudBot: "final-push"` ONLY after the panel passes the parity benchmark — panel covers ALL bot BLOCKERs on ≥5 historical bot-reviewed PRs (record the run in the adopting project's docs; the dev-tasks benchmark lives in task #2988065489's UAT doc). **As of 2026-06-12 the dev-tasks benchmark has NOT passed (2/5) — so `cloudBot` stays `"always"` by default and this restructure ships gated-off until a repo-access + sibling-sweep panel re-runs the benchmark green.**
   - **Triage** all panel findings with the ship-readiness.md rubric (BLOCKER / IMPROVEMENT / POLISH). Fix BLOCKERs + cheap IMPROVEMENTs → re-run the panel on the updated diff (fresh subagents again). Loop until zero BLOCKERs. These local rounds don't count toward Phase 6's 5-round cap (they're cheap); cap local rounds at 5 all the same — persistent new-BLOCKER churn at round 5 → `stuck:regression-loop` per ship-readiness.md.
   - **Record** into active-task.json `reviewAddressed.sources.localReview`: `{ blockers: <fixed count>, improvements: <n>, polish: <n>, replies: [], lenses: ["correctness", ...], rounds: <n> }` (emit the `reviewAddressed` marker first if writing the full structured object now; otherwise record panel results in memory and write once at Phase 6 step 8 as usual). POLISH findings from the local panel are declined in the PR body's review section (no PR comments exist pre-push) — list them under "Local review: declined as POLISH" so the human sees them.
   - **Skip** when `review.sources` lacks `localReview` (default for existing projects — behavior unchanged).
6.8. **VisualDiff BEFORE pass (v0.33.0; deterministic gate + audited skip v0.34.0)** — captures the changed UI on staging *before* this change ships, so the human gets a before/after pair in a Monday doc. Runs HERE (pre-push) because staging still shows the pre-change state until the PR merges + deploys.
   - **Gate** — run only when ALL hold:
     1. `project-config.json → visualDiff.enabled` is not `false` (ON by default — opt-out).
     2. **UI signal is DETERMINISTIC, not a judgment call** — first read the task's subtask types: `getTask` → if ANY `subtasks[].type === "UX-UI"` (or, defensively, the task `type` is `UX-UI` — no such task-type exists today, but future-proof), the diff is UX-UI work and UI is FORCED. Otherwise classify by path. Run `bash $CLAUDE_PLUGIN_ROOT/scripts/ui-diff-eval.sh` (add `--force-ui` when a UX-UI subtask is present) — it classifies the committed diff against `git.defaultBase` via the shared `path_is_ui` globs (`components/**`, app routes, `*.css`/`*.scss`, email templates), and with `--force-ui` always returns UI regardless of path. `UI` (exit 0) → this step is REQUIRED. `NON_UI` (exit 1) → skip with reason `"non-UI diff (ui-diff-eval)"`. **The UX-UI override is additive on top of the path globs — it only ever turns NON_UI into UI (e.g. an i18n-only `messages/*.json` diff on a UX-UI subtask), never the reverse.** When you force UI, record the override in `.claude/active-task.json`: `visualDiff.forceUi: true` and `visualDiff.forceUiReason: "subtask <id/name> typed UX-UI"` (a Monday-derived audit string). `visualDiff` is NOT a `protect-active-task-state` protected field, so no marker is needed. Also ensure each subtask's `type` is mirrored into active-task.json `subtasks[]` (belt-and-suspenders for tasks claimed before this field existed) — `stop-visual-diff-check` reads those types to enforce the same override independently.
     3. `environments.uat.url` resolves to an `https://` URL (this is the staging base).
   - **MANDATORY record (v0.34.0)** — when the gate says UI, you MUST end this step having written EITHER `visualDiff.routes` (the captured route list, below) OR `visualDiff.skipReason` (a one-line, honest reason) into `.claude/active-task.json`. Mirror the skip reason into the PR body. `stop-visual-diff-check` reads exactly these two fields and BLOCKS session exit on a UI diff with neither set — silent self-skip is no longer possible.
     - **"No local build" is NOT a valid skip reason** when an `https://` staging URL is configured: staging IS screenshot-reachable via chrome-devtools-mcp (you don't need a local build to navigate staging). Valid skips are e.g. "no resolvable staging URL for this route", "route requires auth and no persona configured", "diff is non-UI".
   - **Changed routes** — the agent reasons from the diff which routes render the changed components/files and maps them to paths under the staging origin. For routes it can't infer (dynamic/`[param]`), consult `visualDiff.routeMap` (glob → concrete route(s) with real sample params). Cap at `visualDiff.maxRoutes` (default 8); if more routes qualify, capture the top N and LOG which were dropped (don't silently truncate).
   - **SSRF guard** — before navigating, assert each target URL's origin EQUALS the `environments.uat.url` origin; only ever navigate to that host. Never navigate to a host derived from task/PR/user text. (The upload tool independently allowlists local screenshot paths.)
   - **Auth** — public routes need none. For authed routes use `visualDiff.authPersona`'s e2e `storageState` (`e2e.personas[]`). If an authed route needs auth and no persona/storageState is available, SKIP that route with a noted reason (`note: "skipped — auth required, no persona"`) — never guess a login (same contract as `write-uat-spec`).
   - **Capture** — per route × viewport (`visualDiff.viewports`, default desktop 1440×900 + mobile 390×844, full page) via `mcp__claude-in-chrome__*` / `chrome-devtools-mcp` `take_screenshot` (Playwright fallback). Save PNGs under a temp dir (e.g. `mktemp -d` or `.claude/visual-snapshots/<taskId>/before/`). A route that 404s on staging (new route) → record a note-only capture (`note: "no before state — new route"`, no imagePath).
   - **Persist** — call `mcp__plugin_dev-tasks_dev-tasks__appendTaskVisualSnapshots({ taskId, phase: "before", environmentLabel: "staging", captures: [{ route, viewport, imagePath, note? }, …] })`. Record the captured route list in active-task.json `visualDiff.routes` so the AFTER pass re-shoots the SAME routes. Skipped/failed shots never block the push.
7. `git push -u origin {branch}`.

### Phase 3: PR Management
8. `gh pr view --json number,url` — capture PR number/URL if exists.
9. Determine PR base: default `$defaultBase`; if branch's merge-base with `origin/$hotfixBase` is more recent than with `origin/$defaultBase`, use `$hotfixBase` (hotfix exception).
10. If no PR exists: `gh pr create --base <base> --title ... --body ...` with body including `Monday.com Task: #{taskId}` (CI version-check requires this), Epic, Version, pre-push checklist, test plan. `--base` MUST be explicit.
11. If PR exists (re-push): reset `selfReviewPassed: false`; run `/self-review` again; then push.

### Phase 4: Preview URL (hard-enforced by stop hook)

12. Wait for Vercel deployment via `mcp__vercel__list_deployments` filtered by `meta.githubCommitRef`. Retry up to 3× with 30s delay.

13. Post to Monday via `mcp__plugin_dev-tasks_dev-tasks__updateTask` with `itemId`, `demoUrl` (column `link_mm0mtyf4`), `prLink` (column `link_mm0m817p`), `branch` (column `text_mm0pvs3n`), `githubLink` (derive from `git remote get-url origin`, strip `.git`, append `/tree/<branch>` — column `link`). The `Waiting for UAT` gate (Phase 6.7) warns but doesn't block if any are missing.

14. Persist to `.claude/active-task.json`: `previewUrl` + `prUrl`. Stop hook blocks session end if `previewUrl` missing.

### Phase 4.5: UAT Doc Generation (default flow only; hotfix skips)

14a. If PR base is `$hotfixBase` → skip to Phase 5.

14b. Generate UAT doc covering preview URL, AC checklist, edge states, cross-cutting checks (i18n, mobile, empty/error/loading, auth paths if relevant), out-of-scope notes, sign-off checklist.

14b.1. **Agent-verified vs Human-only split** — if `project-config.json → e2e.enabled` is `true`, the UAT doc must have two distinct sections:
- **Agent-verified (autonomous Playwright)**: populated by Phase 4.6 output — spec path, assertions covered, screenshot milestones, console-error count, visual-regression result
- **Human-only (judgment calls)**: union of `project-config.json → e2e.humanOnlyChecks[]` PLUS any task AC item the spec's assertions don't cover

The split is the load-bearing honesty principle: agents claiming coverage they don't have erode the gate's value. Over-flag human-only items rather than under-flag.

When `e2e.enabled: false`: skip the agent-verified section; UAT doc reads "autonomous UAT not configured for this project — full human verification required."

14c. Persist via `createTaskUatDoc({ taskId, markdown })`. On "already exists" error, call `updateTaskUatDoc({ taskId, markdown, overwrite: true })`. Doc lands on column `doc_mm3adfdg`. (STATE write — keep it.)

14d. Progress is tracked in git commits (every commit carries the task `#id`); no narrative Update here — the UAT doc itself is the artifact, and the single summary posts at Phase 7.

### Phase 4.6: Autonomous UAT (default flow only; hotfix skips)

NEW gate between UAT doc generation and the `Waiting for UAT` transition. Runs the per-task Playwright spec against the preview URL as a HARD gate. Skip when `project-config.json → e2e.enabled: false` — UAT doc records "autonomous UAT skipped (disabled in project-config)." Also skip when the task's **CI Gate is a Skip value** (Phase 2 step 6.3) — UAT doc records "autonomous UAT skipped — CI Gate: <value> (authorized by <board column / ci-skip-eval>)" so the human knows which gate didn't run.

14e. **Classifier check**: read task `type` + `git diff $defaultBase...HEAD --stat`. Per [`write-uat-spec`](../write-uat-spec/SKILL.md) classifier table:
- Feature / Bug-fix-extends / Bug-fix-new → spec applies, continue to 14f
- Refactor / API-only / Migration / Docs → no spec required; UAT doc records classification; continue to Phase 5

14f. **Spec presence check**: does `e2e/<feature-area>/<slug>.spec.ts` exist on this branch?
- Yes → 14g
- No → invoke `/dev-tasks:write-uat-spec --target=preview --taskId=<id>`. Skill writes the spec (or REFUSES with auth-remediation if persona's storageState is missing — surface that to the user via `AskUserQuestion`; the task can't proceed to Waiting-for-UAT until either spec exists or `e2e.enabled` is flipped false). Re-push so spec lands on the PR.

14g. **Run the spec against the preview URL**: `pnpm playwright test e2e/<area>/<slug>.spec.ts --reporter=line` with `BASE_URL=<previewUrl from active-task.json>`.

14h. **HARD gate**:
- PASS → record `RUN_RESULT=PASS` in active-task.json under `autonomousUat`. Continue to Phase 5.
- PASS_NEW_BASELINE (first run with `--update-snapshots`) → baselines auto-committed. Re-push. UAT doc notes "first-run baselines captured."
- FAIL → treat as regression. Loop back to fix mode (re-run self-review with the Playwright failure as a finding). Don't transition to Waiting-for-UAT.
- FAIL but `/tmp/.claude-playwright-ack-<slug>` exists → soft-pass. UAT doc explicitly logs "KNOWN-FLAKY: `<slug>` — ack'd by agent at <timestamp>; follow-up task needed to debug." Continue to Phase 5. Ack escape hatch mirrors `/tmp/.claude-ci-ack-<branch>` from Phase 6.

14i. **Output to UAT doc** (consumed by Phase 4.5's agent-verified section): spec path, run target, run result, list of `expect()` assertions, screenshot milestones, selector breakdown, known tech debt. The skill's output contract documents the exact field shape.

**Coordination with Phase 6**: existing CI polling (Phase 6) covers Vercel build + Vercel Preview Comments. Phase 4.6 here runs ONLY the new task's spec against preview (fast, HARD gate). The FULL Playwright suite no longer needs a separate per-preview CI lane: it runs **in-session against staging as an ADVISORY step in Phase 6.6** (post-merge, after the staging deploy is `READY`) via `/dev-tasks:run-full-e2e` — ON by default (opt-out), config-driven by `e2e.fullSuite`. Consumers adopting that step should retire their per-preview CI E2E workflow to avoid double-running (see README "Full-suite E2E in-session"). The advisory full-suite run never gates merge; the per-task spec gate (Phase 4.6) is the only E2E hard gate before merge.

### Phase 5: (no narrative post — PR link recorded as STATE)
15. The PR link, branch, and demo URL are recorded on the Monday task via `updateTask` (state, not narrative) in Phase 4 step 13. Progress is tracked in git commits (every commit carries the task `#id`); no `PR_CREATED` / `REVIEW_FEEDBACK_FIXED` Update here — the single summary posts at Phase 7.

### Phase 6: CI + Review Polling (main session) or Handoff (subagent)

Branch on execution context per `.claude/rules/agent-autonomy.md`. Quick check: is `Monitor` in your tool surface?

**CI Gate Skip path (either context, v0.26.0)**: when the task's CI Gate is `Skip (human)` / `Skip (agent)` (and the PR base is NOT `$hotfixBase`), do NOT sit in the CI polling loop. Instead: (1) run ONE review-triage pass over whatever findings already exist (Corridor + bot review if present — don't wait for them); (2) arm server-side merge with `gh pr merge {prNumber} --auto --squash` IF `git.autoMergePolicy` allows agent merges for the base branch — otherwise leave the PR for `/babysit-prs`/human; (3) emit the reviewAddressed marker and set `reviewAddressed: "handoff-to-orchestrator"`; (4) continue to Phase 6.6. GitHub's branch protection still requires green checks before the auto-merge fires — skip removes the agent's WAIT, never the green-merge requirement. `stop-ci-green-check` allows the session to end with checks pending under this gate; a check that already FAILED still blocks the stop (fix it or ack the flake).

**Subagent handoff path** (no `Monitor`):
1. PR pushed (Phases 2–3).
2. **Emit the reviewAddressed marker** that unlocks `protect-active-task-state` before writing the field:
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/emit-state-marker.sh reviewAddressed
   ```
   Then set `reviewAddressed: "handoff-to-orchestrator"` in state file (escape-hatch for `stop-task-check.sh` and `stop-ci-green-check.sh`).
3. SendMessage main session with PR URL + state summary.
4. Trigger Phase 10 cleanup. End.

**Autonomous merge path** (main session, has `Monitor`):

**cloudBot mode (v0.28.0)** — `project-config.review.cloudBot` governs step 3's bot wait:
- `"always"` (default): wait for + triage the bot review on EVERY push (today's behavior, below unchanged).
- `"final-push"`: the local panel (Phase 2 step 6.7) carried the iteration rounds — do NOT wait for a bot review per round. Wait for exactly ONE bot review on the current (final) push, triage it; if it surfaces a real BLOCKER, the fix push becomes the new final push (wait once again — round cap applies as usual). Requires the parity benchmark to have passed for this project (schema description has the contract).
- `"off"`: skip step 3 entirely (no bot installed). Steps 1–2 + 4–9 unchanged — CI green, Corridor, and the local panel still gate.

1. Poll CI via a `Monitor` that watches `gh pr checks {prNumber}` and emits terminal transitions. Restart the Monitor on each new push — stale events from previous commit confuse triage. See [`monitor-predicate-pattern.md`](../../rules/monitor-predicate-pattern.md) for transition-only emission + immediate-action-on-success patterns.
2. Poll Corridor findings via `mcp__plugin_corridor_corridor__getFindings({ cwd, branch, state: "open", excludeAIFalsePositives: true })`. Retry up to 3× with 60s delay if empty.
3. Fetch GitHub bot review comments per the cloudBot mode above: `gh pr view {prNumber} --json comments` → filter for `author.login == "claude"` and body contains `"## Code Review"`.
4. Triage ALL findings (GitHub bot review + Corridor + /self-review + local panel results from Phase 2 step 6.7) per `ship-readiness.md` (BLOCKER / IMPROVEMENT / POLISH).
5. For each POLISH finding: post a PR-reply declining it (category + reason). Capture the GitHub comment ID returned.
6. For Corridor declines: call `mcp__plugin_corridor_corridor__updateFindingState({ findingId, state: "closed", closedReasonCategory, closedReason })`.
7. Loop: fix BLOCKERs + cheap IMPROVEMENTs → re-push → restart Monitors → re-poll Corridor → re-triage. **Hard cap at 5 rounds — see "Round cap" below.** Early escalation if 3 consecutive rounds each introduce a NEW BLOCKER (regression-loop signal) → `TASK_STUCK` with `reviewAddressed: "stuck:regression-loop"` per `ship-readiness.md`.
8. **Emit the reviewAddressed marker** (`bash ${CLAUDE_PLUGIN_ROOT}/scripts/emit-state-marker.sh reviewAddressed`), then write structured `reviewAddressed` to active-task.json (see schema below). The marker unlocks `protect-active-task-state`.
9. Merge via `gh pr merge --admin --squash` (NEVER `--delete-branch` — collides with worktrees). The `pre-merge-review-gate` hook validates step 8 before allowing this.

**Round cap (5 max — autonomous merge path)**

Track the current round with `/tmp/.claude-ship-pr-round-<branch>` — a single-integer file. Initialize to `1` on the first push, increment on each subsequent re-push during Phase 6. After the 5th re-push completes and the re-triage still surfaces BLOCKERs, do NOT enter round 6 — run the at-cap re-triage protocol below.

The cap is intentional. Without it, the agent chases bot-mislabeled "Critical" findings indefinitely (the GitHub Claude bot is the usual offender). With it, every round-5 BLOCKER gets one strict pass: ship-blocking or not?

**At-cap re-triage protocol** (canonical criteria in [`ship-readiness.md`](../../rules/ship-readiness.md) → "At-cap re-triage"):

1. List remaining BLOCKERs across all sources (`claudeBot`, `corridor`, `selfReview`).
2. For each, apply the strict "actual critical" filter: would this break production for real users (security / data loss / wrong user-visible output / auth bypass / regression introduced this PR)? Bot-mislabeled "Critical" style nits, speculative edge cases, and pattern-consistency complaints do NOT pass.
3. **HALT** (do NOT merge) if ANY remaining BLOCKER passes the filter:
   - `bash ${CLAUDE_PLUGIN_ROOT}/scripts/emit-state-marker.sh reviewAddressed`
   - Set `reviewAddressed: "stuck:max-rounds"` in active-task.json
   - Post `[TASK_STUCK]` to Monday with a numbered list of unresolved actual-critical findings + source attribution (which bot/source flagged each, link to PR comment)
   - Let `stop-task-check.sh` halt the session — user reviews and resumes manually
   - `pre-merge-review-gate` will refuse the merge until the user clears `reviewAddressed` to a terminal value
4. **DEMOTE-AND-MERGE** if NO remaining BLOCKER passes the filter:
   - For each, post a PR-reply demoting to IMPROVEMENT or POLISH with one-line reasoning ("style preference, declined", "speculative edge case without measurable trigger, declined", etc.)
   - Capture comment IDs into the `reviewAddressed.sources.<name>.replies[]` arrays as POLISH/IMPROVEMENT declines
   - Proceed to step 8 (write `reviewAddressed`, then merge)
5. Clear `/tmp/.claude-ship-pr-round-<branch>` on merge or halt (next PR starts fresh).

**`reviewAddressed` structured schema** (written in step 8):

```json
{
  "status": "fixed" | "accepted" | "pending" | "blocker_unaddressed",
  "triagedAt": "2026-05-25T12:34:00Z",
  "sources": {
    "claudeBot": {
      "commentsFound": 1,
      "blockers": 0,
      "improvements": 0,
      "polish": 5,
      "replies": ["IC_kwDOL1234"]
    },
    "corridor": {
      "commentsFound": 3,
      "blockers": 0,
      "improvements": 1,
      "polish": 2,
      "replies": ["IC_kwDOL5678"]
    },
    "selfReview": {
      "commentsFound": 0,
      "blockers": 0,
      "improvements": 0,
      "polish": 0,
      "replies": []
    },
    "localReview": {
      "blockers": 0,
      "improvements": 1,
      "polish": 2,
      "replies": [],
      "declinedInPrBody": true,
      "lenses": ["correctness", "security", "tests"],
      "rounds": 2
    }
  }
}
```

`localReview` (v0.28.0) records the Phase 2 step 6.7 panel outcome: `blockers` = count found-and-FIXED across local rounds (0 outstanding by definition — the panel loops until clean), `rounds` = local iterations, `lenses` = which reviewers ran. Its POLISH declines live in the PR body's "Local review: declined as POLISH" section rather than PR-comment `replies[]` (no comments exist pre-push) — set `declinedInPrBody: true` when that section exists. `pre-merge-review-gate` accepts EITHER non-empty `replies[]` OR `declinedInPrBody: true` for localReview POLISH; other sources still require comment-ID replies.

Field semantics:
- `status`: `"fixed"` (BLOCKERs existed and were resolved), `"accepted"` (only POLISH/IMPROVEMENT, all declined or cheap-fixed), `"pending"` (triage incomplete), `"blocker_unaddressed"` (BLOCKERs remain open).
- `triagedAt`: ISO 8601 UTC timestamp of when triage completed. Must be AFTER the `createdAt` of the latest bot review comment (the `pre-merge-review-gate` hook enforces this to prevent race conditions).
- `sources.<name>.replies[]`: GitHub comment IDs (from `gh pr comment` output or `gh api`) proving POLISH items were declined via PR comment. The hook verifies count > 0 when `polish > 0`.
- Legacy string values (`"fixed"`, `"accepted"`, `"handoff-to-orchestrator"`) are still accepted by the hook for backward compatibility but the structured format is required for new merges going forward.

**Hotfix exception (both paths)**: PRs targeting `$hotfixBase` require human merge. Stop at "CI green + reviews addressed" with a final update.

**Stuck is the only valid early exit** (per `agent-autonomy.md`). CI failures / review BLOCKERs / known flakes are NOT Stuck — diagnose and fix.

**CI flake exception**: `Test`/`Playwright E2E: fail` alone can be a pre-existing flake — verify against staging HEAD before treating as BLOCKER.

**Stop hook gates**: `stop-task-check.sh` requires `reviewAddressed` set; `stop-ci-green-check.sh` requires CI green or the escape-hatch value.

### Phase 6.6: Autonomous merge + verify staging deploy READY (default-flow PRs)

The merge and the staging-deploy-READY verification both happen HERE, **before** the `Waiting for UAT` flip in Phase 6.7. "Waiting for UAT" tells a human the change is testable on staging — flipping it before the post-merge deploy finishes points reviewers at the pre-deploy version (PR #347 / retro #2926719311). So Phase 6.7 is hard-gated on the READY evidence recorded in step 20f.6.

20d. Preconditions: base is `$defaultBase`; CI all-green (or failures acked via `/tmp/.claude-ci-ack-<branch>`); review BLOCKERs resolved.

20e. `gh pr merge {N} --admin --squash` — NEVER `--delete-branch` (collides with worktrees + main checkout).

20f. Verify: `gh pr view {N} --json state --jq .state` returns `"MERGED"`. If `"OPEN"`, diagnose via `gh pr view {N} --json mergeStateStatus,mergeable`.

20f.5. **Wait for the post-merge staging deploy to reach `READY` — this gates the `Waiting for UAT` flip, not just a "verified" caveat.** `gh pr merge` returning success means the commit landed on `$defaultBase`, NOT that the change is live. The Vercel redeploy triggered by the merge takes additional time, and browser caches routinely show the pre-deploy version for several minutes.
- Capture the merge SHA: `mergedSHA=$(gh pr view {N} --json mergeCommit --jq .mergeCommit.oid)`
- Poll `mcp__vercel__list_deployments` filtered by `meta.githubCommitSha = $mergedSHA` until a production-target deployment reaches state `READY`. Non-Vercel projects: substitute the platform's deploy-status check — `gh run watch` for GitHub Actions deploys, `flyctl status` for Fly, etc.
- When inspecting through a browser, cache-bust the verification URL with `?_t=$(date +%s)` or use an incognito tab. Service Worker caches survive plain refresh.
- Word the post-merge Monday update precisely: "Merged — staging deploy in flight" is honest until the deploy is verified; "Verified live in production" is only honest after the steps above succeed.

See `CLAUDE.md` → Shipping conventions for the PR #347 case study that motivated this rule (retro #2926719311).

20f.6. **Record the verified deploy (this is what unlocks Phase 6.7).** Once a production-target deploy for `$mergedSHA` is `READY`, emit the marker and write the flag:
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/emit-state-marker.sh stagingDeployReady
   ```
   Then set `stagingDeployReady: true` in `.claude/active-task.json`. `staging-deploy-ready-gate` reads this to allow the Phase 6.7 transition; the field is marker-protected by `protect-active-task-state` so it can't be self-granted by a direct edit. **Under CI** (`GITHUB_ACTIONS`/`CI`) a runner has no Vercel access — skip the poll; the gate relaxes automatically (no flag needed). Do NOT fabricate `stagingDeployReady` outside CI to dodge the wait — that's the exact lie this gate exists to prevent.

20f.7. **VisualDiff AFTER pass (v0.33.0)** — only when a BEFORE pass ran this task (active-task.json `visualDiff.routes` is non-empty). Once the staging deploy is verified `READY` (step 20f.6) and the URL is cache-busted, re-screenshot the SAME recorded routes × viewports against staging (now showing the change), then call `appendTaskVisualSnapshots({ taskId, phase: "after", environmentLabel: "staging", captures: [...] })`. The doc now holds the before/after pair. Reuse the same SSRF origin-allowlist + auth-persona rules as the before pass. Capture failures are noted in the doc, never block.
   - **Deferred-after caveat**: when the agent does NOT perform/await the merge+deploy in-session (e.g. base is human-merge-only per `git.autoMergePolicy`, or the session handed off at Phase 6.7), the after pass can't run yet. Leave active-task.json `visualDiff.afterPending: true`; the doc shows the before pass plus an implicit gap. `/babysit-prs` or a follow-up captures the after pass once the deploy is verified. Never block the session waiting for a human merge.

20f.8. **Full-suite E2E advisory run (v0.34.0)** — runs the consumer's ENTIRE Playwright suite in-session against staging, ADVISORY (never gates this ship). Same post-deploy timing as the visualDiff after pass: invoke ONLY after the staging deploy is verified `READY` (step 20f.6) — a pre-merge run would test the pre-change code. Invoke `/dev-tasks:run-full-e2e --taskId=<id>`; the skill runs its OWN safe-skip gate first (`e2e.fullSuite.enabled`, an `https` `environments.uat.url`, a real Playwright suite + runnable command, ensurable browsers, CI-Gate not a Skip value) and short-circuits to a recorded no-op when any precondition fails — so this sub-step is a true no-op for projects not set up for it and NEVER errors. It records pass/fail/skip counts to the UAT doc *Agent-verified* section + a Monday update and CONTINUES regardless of the suite result; on red it surfaces loudly (and files a follow-up bug only when `e2e.fullSuite.onRed: "record+file-bug"`). It does NOT touch `reviewAddressed` and does NOT change the merge or the Phase 6.7 transition. Fold its output block (`fullSuiteE2E: { status, passed, failed, skipped, durationSec }`) into the Phase 7 summary.
   - **Deferred caveat**: when the agent doesn't perform/await the merge+deploy in-session (human-merge-only base per `git.autoMergePolicy`, or a Phase 6.7 handoff), the advisory run can't execute yet — `/babysit-prs` runs it once the merged PR's staging deploy is `READY`. Never block on a human merge.

20g. Hotfix exception: skip merge — human merges `$hotfixBase` PRs. No `Waiting for UAT` flip; Phase 10 sets `Done` directly.

### Phase 6.7: Transition task → `Waiting for UAT` (default flow only; hotfix skips)

20h. If PR base is `$hotfixBase` → skip to Phase 7.

20i. Verify gate prereqs (MCP enforces server-side; hooks enforce client-side):
- All subtasks `done` with `actualHours`.
- UAT doc set on `doc_mm3adfdg` (re-run Phase 4.5 if absent).
- `demoUrl`, `prLink`, `branch`, `githubLink` set on task.
- Phase 4.6 autonomous-UAT gate PASSED or skipped per project-config (when `e2e.enabled: true` AND classifier said spec applies, the Playwright run must be `PASS` or `ACK_FLAKY` — not unrun, not FAIL).
- **Staging deploy verified `READY`** — `stagingDeployReady: true` from step 20f.6 (or running under CI). `staging-deploy-ready-gate` hard-blocks this transition otherwise.

20j. `mcp__plugin_dev-tasks_dev-tasks__updateTask({ itemId: taskId, status: "Waiting for UAT" })`. On rejection, fix the named field and retry. (`staging-deploy-ready-gate` + `demo-url-required` fire on this call.)

20k. **Mirror parent status to active-task.json** (required when `stop-waiting-for-uat-stage` is enabled — else the hook fires at session-end because subtasks are all `done` but local state still shows the parent at "In Progress"). Emit the parentStatus marker first, then write the field:
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/emit-state-marker.sh parentStatus
   ```
   Then set `parentStatus: "Waiting for UAT"` in `.claude/active-task.json`. Single jq-style edit; no other fields change.

20l. Continue to Phase 10.

20m. Progress is tracked in git commits (every commit carries the task `#id`); no `TASK_WAITING_FOR_UAT` Update here — the `Waiting for UAT` status change (step 20j) is the signal, and the single summary posts at Phase 7.

### Phase 7: Monday.com Update + Completion (the ONE routine Update)

22. Refresh preview URL via `mcp__vercel__list_deployments`; update `previewUrl` in state + `demoUrl` on Monday if changed.

23. Post the `[PIPELINE_COMPLETE]` summary exactly once by calling `/log-progress PIPELINE_COMPLETE` (which internally does a single `createUpdate`). The summary must include: PR URL, preview URL, merge SHA, CI status, `reviewAddressed` value, and a "what shipped" synthesized from `git log`. When the VisualDiff feature ran, also note the before/after **Visual Changes doc** (column `doc_mm4jkk92`) and whether the after pass is complete or deferred (`visualDiff.afterPending`). When the Phase 6.6 full-suite advisory run executed (step 20f.8), include its one-line result (`fullSuiteE2E` status + counts, or "skipped — <reason>" / "deferred to /babysit-prs"). Do NOT also post a separate `createUpdate` — that would double-post.

### Phase 8: Version Linkage Check (informational)

25. Read `taskId` from state file. Call `getTask` and inspect `targetVersion`. If set, log; if unset, `auto-version.ts` writes it server-side on the `Waiting for UAT` transition. Per `versions-lifecycle.md`, versions are historical — no action needed here.

25b. Update structured Release Summary on the linked version (after version is confirmed). Read current via `getVersion(versionId)`. Map task type to 3-cat: Development → `feature`; Bugfix → `fix`; Maintenance / Refine / Documentation / PM-work → `improvement`. Use `Public Task Name` (column `text_mm349ah6`) if set, else internal name. Parse existing JSON via `parseStructuredChangelog` (auto-migrates legacy 4-cat). Add task to bucket. Update `progress`. Wrap in `STRUCTURED_CHANGELOG_V1` markers. Write via `updateVersion(versionId, releaseSummary)`.

**Auto-bump check** (non-blocking): if `versionNumber` empty AND ≥1 task linked, gather inputs (latest released, tasks classified via `classifyTaskType()`, `v1MilestoneReady` = all `$v1MilestoneEpicIds` epics `Done`), call `computeBumpSuggestion(input)`, log `result.next` + `result.rationale` + `result.gatedByMilestone`. Actual assignment happens at `/release-version`.

### Phase 9: User Acceptance Testing Handoff

26. Generate acceptance testing checklist from git diff (`git diff <base>...HEAD --stat`) + subtask names. Group by feature area; each item is specific, complete, actionable, with URLs.

27. Present to user as `## Acceptance Testing Checklist — PR #{N}` with grouped checkboxes and preview URL.

28. Present the checklist to the user only — do NOT post it as a separate `createUpdate`. The acceptance-testing detail belongs in the task's UAT doc (`doc_mm3adfdg`, written in Phase 4.5 — STATE, kept); the single routine Update is the Phase 7 `[PIPELINE_COMPLETE]` summary. Per v0.22.0 this avoids a second routine post per ship.

### Phase 10: Post-Merge Task Completion

Default flow: parent already at `Waiting for UAT` from Phase 6.7. Phase 10 cleans up; `Done` is set by the release ceremony.
Hotfix flow: parent still at `In Progress`. Phase 10 sets `Done` directly.

30. Post-merge sequence (order matters for `allowMainCheckout: true` — `gh pr merge` switches to `$defaultBase` and deletes local branch):
    1. Mark remaining subtasks `Done` via `manageSubtasks` (MCP call — no Edit/Write hook).
    2. `gh pr merge --admin --squash` (no `--delete-branch`).
    3. **Capture the merge SHA + append to `mondayReconciledShas[]`** (required when `stop-monday-reconciled-check` is enabled — else the hook fires at session-end because a merge landed during the session but the SHA isn't recorded as reconciled). Emit the marker first, then perform the append:
       ```bash
       bash ${CLAUDE_PLUGIN_ROOT}/scripts/emit-state-marker.sh mondayReconciledShas
       mergedSHA=$(gh pr view {N} --json mergeCommit --jq .mergeCommit.oid)
       ```
       Then append `$mergedSHA` to `.claude/active-task.json` `mondayReconciledShas[]` (initialize as `[]` if absent). Do this BEFORE the state-file delete in step 4. The marker unlocks `protect-active-task-state`.
    4. Immediately `rm .claude/active-task.json` — BEFORE any Edit/Write.
    5. No separate completion Update here — the Phase 7 `[PIPELINE_COMPLETE]` summary is the single routine Update for the default flow. Progress is tracked in git commits (every commit carries the task `#id`); the `Done`/`Waiting for UAT` STATE is the signal.
    
    In worktree sessions, `ExitWorktree({ action: "remove" })` in step 31 deletes the state file implicitly.
    
    Read PR base via `gh pr view --json baseRefName --jq .baseRefName`:
    - `$defaultBase`: leave task at `Waiting for UAT`. No `[TASK_COMPLETED]` narrative post — the status (already at `Waiting for UAT` from Phase 6.7) carries the next-transition signal (Waiting for UAT → Pending Deploy to Prod by human; Pending Deploy to Prod → Done by `/release-version`).
    - `$hotfixBase`: BEFORE marking done — wait for the production deploy to complete (poll your deploy platform's status: `mcp__vercel__list_deployments` filtered by merge SHA, `gh run watch`, `flyctl status`, etc.) AND cache-bust the verification URL (`?_t=$(date +%s)` or an incognito tab — Service Worker caches survive plain refresh). The same stale-cache + in-flight-deploy gotcha that caught PR #347 (retro #2926719311) applies to hotfix releases. Then `updateTask({status: "Done"})` (STATE — kept). For the hotfix flow this `Done` transition replaces the default flow's Phase 6.7/Phase 7 path, so post the single `[PIPELINE_COMPLETE]` summary here via `/log-progress PIPELINE_COMPLETE` if it wasn't already posted at Phase 7.

31. Worktree cleanup: if `git rev-parse --git-common-dir` differs from `git rev-parse --git-dir`, call `ExitWorktree({ action: "remove" })`. If refused (uncommitted/unreachable), inspect leftovers, commit/stash, then `ExitWorktree({ action: "remove", discard_changes: true })` only with user confirmation.

### Phase 11: Claim next planned task

Per `agent-autonomy.md`, after merge + cleanup the agent does NOT stop unless: no planned next task, OR Stuck condition + no follow-up queued, OR operator said "end after this one". Otherwise invoke `/dev-tasks:pickup-task <next-task-id>`.

## Failure Handling

- Build/lint/test fails → show error, do NOT push, do NOT set marker.
- CI fails → fix and re-push.
- Regression loop (3 consecutive rounds introducing new BLOCKERs) → `TASK_STUCK`, `reviewAddressed: "stuck:regression-loop"`, alert user. Fires BEFORE the 5-round cap.
- Round cap reached with actual-critical BLOCKER remaining (Phase 6 only) → `TASK_STUCK`, `reviewAddressed: "stuck:max-rounds"`, post unresolved-findings summary to Monday, halt. See Phase 6 "Round cap" + `ship-readiness.md` "At-cap re-triage".
- 3 consecutive failures any stage → `/log-progress TASK_STUCK`.
- Vercel deployment not found after 3 retries → warn but post PR URL to Monday.

## Post-Conditions

- Pre-push marker at `/tmp/.claude-prepush-{branch}`.
- Push, PR created/updated.
- Preview URL on Monday (`demoUrl` / `link_mm0mtyf4`) and in `.claude/active-task.json` (`previewUrl`) — hard-enforced by stop hook.
- `reviewAddressed` persisted — hard-enforced.
- CI at terminal state.
- UAT doc on `doc_mm3adfdg` (default flow).
- Task at `Waiting for UAT` (default) or `Done` (hotfix).
- Autonomous merge done (default; hotfix awaits human).
- State file removed; worktree removed.

## Stop Hook Enforcement

`stop-task-logic.py` 4-stage gate when source files changed:
1. `selfReviewPassed: true`
2. PR exists
3. `previewUrl` exists in state file
4. `reviewAddressed` exists in state file

Valid `reviewAddressed`: `"accepted"`, `"fixed"`, `"stuck:regression-loop"`, `"stuck:max-rounds"`, `"timeout:{reason}"`, `"handoff-to-orchestrator"`.
