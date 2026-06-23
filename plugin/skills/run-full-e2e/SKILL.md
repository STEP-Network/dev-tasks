---
name: run-full-e2e
description: Run the consumer's FULL Playwright E2E suite in-session (sharded via --workers) against the STAGING URL as an ADVISORY step — records pass/fail, never blocks ship or merge. ON by default (opt-out); a bulletproof safe-skip makes it a true no-op for any project without a staging URL + a real Playwright suite. Invoked by /ship-pr Phase 6.6 (post-merge, after the staging deploy is READY) and runnable standalone.
user_invocable: true
---

# /run-full-e2e — Full Playwright suite, in-session, advisory, vs staging

Run the consumer's ENTIRE existing Playwright suite on this machine (in-session, parallelized with `--workers`) against the consumer's **staging** deployment, and RECORD the result. This is the in-session replacement for a per-preview GitHub Actions E2E lane — the dev machine is usually faster than a CI runner, and staging is already deployed, so consumers can retire that CI lane and reclaim minutes.

**Three things this skill is NOT:**
- **NOT a gate.** It is ADVISORY. It never blocks `git push`, `gh pr merge`, or the `Waiting for UAT` transition, and it never touches `reviewAddressed`. A red suite surfaces loudly but the pipeline continues.
- **NOT the per-task spec gate.** Phase 4.6 / 6.5 run the ONE new task's spec against preview as a hard gate — unchanged. This skill runs the WHOLE suite against staging, advisory.
- **NOT a thing that errors.** Every failure mode (no config, no staging URL, no command, browsers won't install, subagent dies) is a *recorded safe-skip*, never a thrown error or a half-finished run.

Read `.claude/project-config.json`. Extract `e2e.fullSuite` (default `{ enabled: true, target: "staging", workers: "50%", recordTo: ["uatDoc","mondayUpdate"], onRed: "record" }` — absent block ⇒ all defaults), `environments.uat.url`, and `e2e.specDir` (default `e2e`).

## Arguments

- `--taskId=<id>` (optional): Monday task to record against. Defaults to `taskId` in `.claude/active-task.json`. No task resolvable → still run, but `recordTo` is limited to console output (no UAT-doc / Monday write); note that in the output.
- `--target=staging` (optional): only `staging` is honored in v1 (resolves to `environments.uat.url`). Any other value → recorded safe-skip ("unsupported target").

## Phase 1 — Safe-skip precondition gate (RUN FIRST, fail to a recorded no-op)

Evaluate ALL of the following. The FIRST that fails ends the skill with a one-line recorded skip (see "Recording a skip") — never an error, never a partial run. ON-by-default is only safe because this gate is airtight.

1. **Opt-out check** — `e2e.fullSuite.enabled` is not `false`. False → skip: `"full-suite e2e disabled (e2e.fullSuite.enabled:false)"`.
2. **CI-Gate skip** — resolve the task's CI Gate (live Monday `getTask → ciGate`, else `active-task.json.ciGate`, else `Full`). A `Skip (human)` / `Skip (agent)` value → skip: `"full-suite e2e skipped — CI Gate: <value>"` (same honor-the-skip posture as the other Phase-6 gates).
3. **Staging URL** — `environments.uat.url` resolves to an `https://` origin. Missing / non-https → skip: `"no staging URL (environments.uat.url) — full-suite e2e skipped"`. This URL is the ONLY source of the run target (see SSRF below).
4. **Real Playwright suite present** — ALL of:
   - a `playwright.config.*` (`.ts`/`.js`/`.mjs`/`.cjs`) exists at repo root, AND
   - the `specDir` directory exists and contains at least one `*.spec.ts`/`*.spec.js` file, AND
   - a runnable command resolves: `e2e.fullSuite.command` if set, else a `test:e2e` (or first `playwright`-invoking) script in `package.json`.
   Any missing → skip: `"no Playwright suite detected — full-suite e2e skipped"`.
5. **Browsers ensurable** — run `pnpm exec playwright install` (or `npx playwright install`) to ensure browser binaries. Non-zero exit / not installable in this environment → skip: `"Playwright browsers unavailable — full-suite e2e skipped"`. (Use `--with-deps` only where the environment permits system-dep installs; bare `install` otherwise.)

Passing all five ⇒ proceed to Phase 2. The dogfood plugin repo (a `github.com/...` `environments.uat.url`, no `playwright.config`, no `specDir`) fails #3/#4 and safe-skips — as does any bare consumer.

## Phase 2 — Resolve target + run the suite (read-only subagent)

6. **Resolve BASE_URL** strictly from `environments.uat.url` — NEVER from task text, PR body, branch name, or any user-supplied string. **SSRF guard:** the suite's `BASE_URL` / `PLAYWRIGHT_BASE_URL` is exactly the configured staging origin; the read-only `e2e-tester` subagent only ever hits that host.

7. **Auth is the consumer's, not the plugin's.** Do NOT inject `e2e.personas` / `storageState` for this run (personas exist for per-task spec *authoring*). The consumer's own `playwright.config` owns auth via its setup projects (e.g. `auth.setup.ts` reading the consumer's local secrets). Specs whose secrets are absent locally will self-skip — that is acceptable advisory behavior; record the skipped count.

8. **Spawn the read-only `dev-tasks:e2e-tester` subagent** to run the resolved command with the staging BASE_URL and the worker count:
   ```
   BASE_URL=<environments.uat.url> PLAYWRIGHT_BASE_URL=<environments.uat.url> \
     <command> --workers=<e2e.fullSuite.workers> --reporter=line
   ```
   (`command` defaults to the `package.json` `test:e2e` script, typically `pnpm test:e2e`.) The subagent is Bash/Read/Glob-only and must not modify source — it returns parsed results. Any subagent failure (crash, timeout, non-test infra error) → treat as a recorded skip with the failure reason, never a thrown error.

## Phase 3 — Record the result (ADVISORY)

9. Collect from the subagent: **passed / failed / skipped counts, total duration, and per-failed-spec details (title + error + trace path)**.

10. **Record per `e2e.fullSuite.recordTo`:**
    - `"uatDoc"` → append a "Full-suite E2E (advisory, staging)" entry to the task's UAT doc *Agent-verified* section. Use `updateTaskUatDoc({ taskId, markdown, overwrite: false })` to APPEND (never overwrite — the per-task-spec and visualDiff content must survive). If no UAT doc exists yet, `createTaskUatDoc({ taskId, markdown })`.
    - `"mondayUpdate"` → post one `createUpdate({ itemId: taskId, body: <HTML> })` summarizing counts + duration + target, GREEN or RED clearly stated.
    - Both are advisory records. Keep the wording honest: `"Full-suite E2E vs staging: N passed / M failed / K skipped (Xs)"`.

11. **On RED** (`failed > 0`), honor `e2e.fullSuite.onRed`:
    - `"record"` (default) — surface the failures prominently in the recorded output (list failed specs + trace paths) and CONTINUE.
    - `"record+file-bug"` — ALSO file ONE follow-up bug via `createBug` (source defaults to `agent`) titled `"Full-suite E2E red vs staging — <N> failing spec(s)"`, body = the failed-spec list + trace paths + the staging target. Link nothing else; it's intake.
    - In BOTH cases: do NOT block, do NOT change the merge outcome, do NOT touch `reviewAddressed`. A red full suite is a signal, never a stall.

12. **Recording a skip** (Phase 1 short-circuits land here): write the one-line reason to the same destinations that are cheaply reachable — if a task is resolvable, append a single line to the UAT doc *Agent-verified* section (`"Full-suite E2E: skipped — <reason>"`) so the human knows it didn't run and why; otherwise just emit the line to console. A skip is a normal outcome, not a failure — exit 0.

## Output contract (consumed by /ship-pr Phase 6.6)

Return a compact block the caller can fold into its summary:
```
fullSuiteE2E: { status: "pass" | "red" | "skip", passed, failed, skipped, durationSec, target, reason? }
```
- `status: "skip"` carries `reason` (the Phase-1 short-circuit string). `passed/failed/skipped` are 0.
- `status: "red"` still means the ship continues — the caller records it, never gates on it.

## Invocation contexts

- **From /ship-pr Phase 6.6** (default flow, main session): invoked AFTER the post-merge staging deploy reaches `READY` (step 20f.6) — running pre-merge would test the pre-change code. The caller folds the output block into the Phase 7 `[PIPELINE_COMPLETE]` summary.
- **From /babysit-prs** (orchestrator-merged subagent PRs): same post-deploy timing, mirroring the visualDiff AFTER-pass split — the orchestrator runs it once the merged PR's staging deploy is `READY`.
- **Standalone** (`/dev-tasks:run-full-e2e`): run any time staging is deployed — e.g. a quick advisory sweep before a release ceremony. Same safe-skip + recording behavior; if there's no active task, results print to console only.

## Honest caveats

- Advisory coverage is only as good as the consumer's suite. This does not replace the per-task spec gate (Phase 4.6) or human UAT for subjective/regulated surfaces.
- Auth-dependent specs self-skip when local secrets are absent — the recorded skipped count is the honesty signal; it is NOT silent.
- Staging must actually be deployed and reflect the merged change before this runs; that is why the post-merge invocation waits for `READY`. Standalone runs test whatever is currently live on staging.
