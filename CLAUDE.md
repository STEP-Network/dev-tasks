# CLAUDE.md — dev-tasks

This repo is a Claude Code plugin marketplace + plugin source. The plugin (`dev-tasks`) packages a Monday.com MCP server, lifecycle rules, skills, and hooks for autonomous coding agents driving development work from a Monday.com board ecosystem.

**The plugin is dogfooded here** — this repo is a consumer of its own plugin. Monday product: **Dev-Tasks Plugin** (#2924964797). Default catch-all epic: **Dev-Tasks Plugin — Maintenance & Hotfixes** (#2924897116). Project-config: `.claude/project-config.json` (committed). All edits to `plugin/src/` go through the full Monday task lifecycle (claim → work → ship → release). Edits to `.claude/`, `memory/`, `CLAUDE.md`, `.gitignore` are exempt from `task-state-guard` for fast infra work.

## Repo layout

```
.
├── .claude-plugin/marketplace.json   # marketplace registry → ./plugin
├── plugin/                           # the plugin itself (see plugin/README.md for full layout)
│   ├── .claude-plugin/plugin.json    # plugin manifest
│   ├── .mcp.json                     # registers the stdio MCP server
│   ├── package.json + tsconfig.json  # plugin deps (@modelcontextprotocol/sdk + zod) + TS build
│   ├── src/                          # MCP TypeScript source (37 tools)
│   ├── dist/                         # tsc output (gitignored)
│   ├── rules/                        # 8 universal lifecycle rules
│   ├── rules-routing.json
│   ├── skills/                       # 8 core lifecycle skills
│   ├── hooks/                        # lifecycle hooks (rule-autoload, task-state guard, worktree enforcement, drift recon, etc.); see plugin/.claude-plugin/plugin.json for the registered list
│   ├── schemas/                      # project-config.schema.json
│   └── templates/                    # starter-project-config.json
├── .claude/                          # project-local Claude Code config
│   ├── project-config.json           # dev-tasks plugin config (committed)
│   ├── active-task.json              # current task state (gitignored, per-session)
│   ├── worktrees/                    # per-task git worktrees (gitignored)
│   └── skills/                       # per-user local skills (gitignored)
├── CLAUDE.md                         # this file
└── .env.example                      # MONDAY_API_KEY example
```

## Commands

```bash
cd plugin
npm install          # also runs `tsc` via prepare hook → produces dist/
npm run build        # rebuild dist/
npm run typecheck    # tsc --noEmit
npm start            # run the stdio MCP server (responds on stdin/stdout)
```

## Install the plugin in a consumer project

```sh
export MONDAY_API_KEY="..."  # add to ~/.zshrc; .mcp.json doesn't interpolate
cd <consumer-project>
claude
```

Then in the Claude Code session:

```
/plugin marketplace add /Users/nate/dev-tasks
/plugin install dev-tasks@dev-tasks-marketplace
/reload-plugins
```

To activate the blocking hooks (task-state-guard, worktree-required, worktree-path-boundary, bash-guard, stop-task-check, stop-ci-green-check), copy `plugin/templates/starter-project-config.json` to `<consumer-project>/.claude/project-config.json` and trim it to what you want enabled. Without that file, only `rule-autoload` runs; all blocking hooks are dormant.

**Worktree lifecycle.** Per-task worktrees accumulate under `.claude/worktrees/`. The `worktree-janitor.sh` SessionStart hook auto-prunes DONE + ABANDONED worktrees and clears stale git locks (`.git/worktrees/<n>/locked` > 24h) on every session start. Silent when nothing to clean. Manual modes: `bash plugin/scripts/worktree-audit.sh` (report) / `--remove` (interactive) / `--auto` (what the hook runs). Full details in `plugin/README.md` under "Worktree lifecycle".

## Board ecosystem (what the MCP wraps)

```
Products (5091839409) [read-only]
  └→ Epics (5091706354) [read-write]
       ├→ Tasks (5091706356) [read-write] ←→ Sprints (5091706352) [read-only]
       │    └→ Product (mirror via Epic)
       ├→ Bugs (5091706353) [read-write] ←→ Epics (two-way relation)
       └→ Versions (5091847257) [read-write]
       Feedback (5091852801) [read-write] ←→ Tasks (two-way relation)
```

**Mirror columns:** Tasks has a Product mirror column (`lookup_mm0vsq7f`) mirrored through the Epic relation (`task_epic`). Mirror columns are read-only and cannot be filtered server-side — `getBacklog` resolves product → epics → tasks instead.

Subtasks board: 5091706366 (linked from Tasks).

## Tools (37)

The plugin's MCP server registers 37 tools in `plugin/src/server.ts`. See that file for current names, descriptions, and Zod schemas. High-level phases:

| Phase | Tools |
|---|---|
| Discovery | `getBacklog`, `getBugs`, `listFeedback` |
| Context | `getTask`, `getSprint`, `listSprints`, `getEpic`, `listEpics`, `listProducts`, `getFeedback`, `listVersions`, `getVersion`, `getUpdates`, `getTaskUatDoc`, `getStructuredChangelog`, `getPublicRoadmap`, `listRetros` |
| Execution | `claimTask`, `updateTask`, `manageSubtasks`, `updateEpic`, `updateFeedback`, `updateVersion`, `updateRetro`, `setPublicTaskName`, `updateStructuredChangelog`, `createTaskUatDoc`, `updateTaskUatDoc` |
| Creation | `createTask`, `convertBugToTask`, `createBug`, `createEpic`, `createFeedback`, `convertFeedbackToTask`, `createRetro`, `createVersion` |
| Shipping | `generateChangelog`, `migrateStructuredChangelog` |
| Communication | `createUpdate` |

After plugin install, tools are namespaced as `mcp__plugin_dev-tasks_dev-tasks__<tool>`.

## Agent workflow

```
1. getBacklog(unclaimedOnly: true)     → find available work
2. getTask(itemId)                      → read full context
3. listEpics()                          → find epic to assign (if needed)
4. claimTask(itemId, agentId, planId)   → claim it (auto-assigns owner)
5. manageSubtasks(parentItemId, ops)    → create/update subtasks as you work
6. updateTask(itemId, prLink, status)   → set PR link, update status
7. listVersions()                       → find or create target version
8. updateVersion(versionId, linkTaskIds) → link to release version
9. generateChangelog(versionId)         → auto-generate changelog doc
```

The 8 plugin skills (`/dev-tasks:pickup-task`, `create-task`, `refine-task`, `log-progress`, `self-review`, `ship-pr`, `release-version`, `write-uat-spec`) wrap most of this flow.

**Default stance: autonomous-by-default.** The lifecycle chain runs end-to-end without permission checks between phases. The rule `plugin/rules/autonomous-by-default.md` defines the six carve-outs that justify a pause (destructive actions, scope expansion, external-system contact, hidden trade-offs, missing context, stuck) and the communication pattern that replaces check-ins (terse status updates, no trailing "want me to continue?" questions). Complements `agent-autonomy.md` (which covers the main-vs-subagent context boundary and the Stuck criterion).

## Claiming protocol

- Agent calls `claimTask` → server validates:
  - Status is "Ready to Start" (tasks in "Needs Refinement" must be refined and sprint-assigned first)
  - Agent ID dropdown is empty
  - All blocked-by dependencies (column `dependency_mm0pwbxn`) are Done
- Sprint membership is no longer a hard block. If the task isn't in the active sprint, `claimTask` **auto-pulls** it into the active sprint and sets `unplanned: true`, surfacing the action in the response. Hard-block only when there is no active sprint at all.
- Success → sets In Progress + Agent ID + Plan ID + Started Date + Owner (auto-assigned)
- Conflict → returns error with current owner

## Owner assignment

Pass your system username (`whoami`) as the `owner` field. The plugin resolves it to a Monday person ID via a live lookup on the People board (`1612664689`), match priority:

1. `text_mm3ffcjd` column — registered whoami username (authoritative, highest priority — set this for each team member)
2. Email local-part (`naref@stepnetwork.dk` → `naref`)
3. `person` column display name
4. `name` column first word

Records with status `Past` are excluded. Lookup is cached per `(boardId, apiKey)` with a 5-min TTL.

Used in `claimTask` (required), `createTask`, `createEpic`, `updateEpic`, `createVersion`, `updateVersion` (all optional). `doctor` Check #6 verifies your `whoami` resolves correctly.

## Key status mappings

**Task Status:** Needs Refinement → Ready to Start → In Progress → Waiting for UAT → Pending Deploy to Prod → Done. Off-ramps: Stuck (unresolved blocker; recoverable), Declined (superseded mid-sprint — terminal, no work shipped; excluded from `getBacklog` defaults; exempt from active-sprint pull). Use Declined when a task is no longer needed: rework merged elsewhere, requirement changed, duplicate discovered.
**Task Priority:** Critical, High, Medium, Low, Missing
**Task Type:** Feature, Fix, Improvement, To Do, Not Set
**Subtask Status:** Needs Refinement → In Progress → Done (+ Stuck) — note: subtasks have no "Ready to Start" intermediate state (the Subtasks board doesn't have that label configured)
**Subtask Type:** To Do, Database, Backend, Documentation, Test, UX-UI
**Epic Status:** Backlog, Planned, Refining, In Progress, Review, On Hold, Done
**Epic Priority:** Critical, High, Medium, Low, Minimal, Not Prioritized
**Version Status:** Planned, In Development, Release Candidate, Released, Hotfix
**Feedback Status:** New → Under Review → Accepted → Converted / Declined / Done
**Feedback Type:** Request, Feedback
**Feedback Priority:** Critical, High, Medium, Low
**Feedback Source:** User, Internal, Support, Partner
**Bug Status (Option C, v0.12.0):** Awaiting Review (default) → Triaged → (Converted to Task | Declined | Cannot Reproduce | Duplicated | Missing Info | Known Bug). Bugs are **intake-only** — once `Converted to Task`, all dev work happens on the linked Task (type: Fix). `convertBugToTask` sets `Converted to Task` automatically. **DO NOT write legacy values (Ready for Dev, Fixing, Fixed, Pending Deploy, Move to Sprints) via the plugin going forward** — they remain readable for historical items but new transitions belong in the intake-only set. `getBugs` filtering on the new statuses (Triaged, Converted to Task, Declined, Cannot Reproduce) returns 0 results until Monday has actually registered each label (first write via `updateBug` or `convertBugToTask` registers them).
**Bug Priority:** Critical, High, Medium, Low
**Retro Type:** Discussion, Keep, Improve (existing — separate from workflow status)
**Retro Status (v0.12.0):** New (default) → Accepted (team agreed, owner assigned) → Implemented (PR merged, `implementedBy` + `resolvedInVersionId` populated) → Validated. Off-ramp: Declined (terminal).
**Agent ID:** Claude Code CLI, Claude Desktop Cloud, Codex Local, Claude Desktop Local, Codex Cloud

## Status transition gates

`updateTask` enforces preconditions before letting status advance:

- **Ready to Start** requires:
  - `type` is set (not "Not Set")
  - `priority` is set (not "Missing")
  - linked to an epic
  - `description` is non-empty
  - acceptance criteria (`long_text_mm0pqaxy`) is non-empty
  - ≥1 subtask with name, description, type (not "Missing Status"), positive estimate

  Same-call args count. `createTask` honors the same gate — if you pass `status: "Ready to Start"`, the task is created at Needs Refinement and promoted to Ready to Start after subitems exist, only if the gate passes.

- **Waiting for UAT** hard-blocks unless:
  - all subtasks are Done
  - UAT testing doc column (`doc_mm3adfdg`) is set (use `createTaskUatDoc` first)

  …and warns (but doesn't block) when missing GitHub link, branch (`text_mm0pvs3n`), demo URL, or PR link.

- **Sprint auto-pull (any status leaving the refinement phase):** any transition to a status other than "Ready to Start", "Needs Refinement", or "Declined" requires active-sprint membership. That includes `In Progress`, `Waiting for UAT`, `Pending Deploy to Prod`, `Done`, and `Stuck`. If the task isn't in the active sprint AND the same `updateTask`/`claimTask` call didn't explicitly pass `sprintId`, the plugin auto-pulls the task into the active sprint and sets the `unplanned` checkbox to `true`. Both column writes land atomically in the same `change_multiple_column_values` mutation as the status change. The tool response surfaces the action so the agent is aware. Hard error only when no active sprint exists.
  - Note on `Done`: usually fires via Monday automation when subtasks complete (no auto-pull involved). A direct `updateTask({status:"Done"})` call DOES trigger auto-pull if the task is out-of-sprint — same rule as every other non-refinement status.
  - Note on `Declined`: terminal off-ramp (task superseded mid-sprint, no work shipped). Exempt from auto-pull — declining a task should not drag it into the active sprint.

Subtasks should describe work-on-code, not human verification (testing belongs in the UAT doc) — otherwise the "all subtasks Done" gate can't ever be satisfied.

## UAT doc tools

`text_mm3adfdg` *(`doc_mm3adfdg`)* is a Monday Doc on each task that describes what a human should verify. Three tools manage it:

- `getTaskUatDoc(taskId)` — returns the doc's markdown (via `export_markdown_from_doc`)
- `createTaskUatDoc(taskId, markdown)` — creates a fresh doc (refuses if one already exists)
- `updateTaskUatDoc(taskId, markdown, overwrite?)` — overwrite (default) or append to an existing doc

## Task dependencies

Tasks can declare blocked-by relationships via the `dependency_mm0pwbxn` column. Pass `dependencyIds: number[]` to `createTask` or `updateTask` (empty array clears). `claimTask` refuses to start a task whose dependencies are not all Done.

## Maintenance epics

Every product should have a permanent "Maintenance & Hotfixes" epic (Status: In Progress, no deadline). This ensures all tasks have an epic — and therefore Product context via the Task mirror column.

- `createBug`, `convertBugToTask`, and `convertFeedbackToTask` auto-assign the maintenance epic when no explicit `epicId` is provided
- The resolver matches epics whose name contains "maintenance" (case-insensitive)
- Convention: name the epic "{Product Name} — Maintenance & Hotfixes"
- Hotfix tasks, tech debt, and miscellaneous work go here

## Product inheritance

Product flows through the hierarchy: **Product → Epic → Task** (mirror column). Bugs, Feedback, and Versions keep direct Product connections because they exist at different lifecycle stages (intake/output) before tasks or epics are assigned.

## Task completion

Monday.com automation auto-completes the parent task when all subtasks are Done:

- Do NOT set task status to `Done` directly
- Mark all subtasks `Done` instead (automation triggers when the last subtask flips Done)
- Delete unwanted subtasks before marking the last one Done

## Shipping conventions

### Deploy-lag gotcha — "PR merged" ≠ "change is live"

`gh pr merge` returning success means the commit landed on `$defaultBase`. The change is NOT yet running in staging or production: CI workflows triggered by the merge (Vercel redeploy, downstream pipelines, edge cache invalidation) need additional time, and browser caches (including Service Workers) routinely serve the pre-deploy version for several minutes after the actual rollout completes.

**The agent must wait for the deploy to complete + cache-bust the verification URL before claiming "verified" / "deployed" / "live".** See `plugin/skills/ship-pr/SKILL.md` Phase 6.6 step 20f.5 for the concrete checklist (poll `mcp__vercel__list_deployments` by merge SHA → wait for `READY` → cache-bust verification URL with `?_t=$(date +%s)` or incognito tab).

**Case study (canonical):** PR #347 (PolAds `fundingSource` fix). The agent merged and immediately tried to verify in staging. It hit the pre-deploy version, mistook the unfixed behavior for "the fix didn't work", and reported a false regression — confusion that took the user a manual round of investigation to untangle. Root cause: stale browser cache + an in-flight redeploy + no wait gate between merge and verification. Retro #2926719311 codified the lesson; this section is its docs landing site.

**Honest wording when in doubt:** "Merged — staging deploy in flight" is correct until the deploy is verified ready. "Verified live in production" requires the deploy poll + cache-bust steps above to have succeeded.

### Autonomous UAT — Phase 4.6 hard gate before `Waiting for UAT`

For consumer projects that opt in (`.claude/project-config.json` → `e2e.enabled: true`), `/ship-pr` runs a per-task Playwright spec against the preview URL as a HARD gate before the `Waiting for UAT` transition. The skill `/dev-tasks:write-uat-spec` writes the spec by delegating to `dev-tasks:e2e-tester`, which inspects the rendered DOM on the preview URL to choose stable selectors, then writes `e2e/<feature-area>/<short-slug>.spec.ts`.

**Per-task spec lifecycle:**
1. Phase 2 (push gate) — if a spec already exists for this task, run it locally against `BASE_URL=<e2e.baseUrl.local>`; block push on red unless `/tmp/.claude-playwright-ack-<slug>` exists.
2. Phase 4.6 (preview gate) — if no spec exists yet, write one. Run against `BASE_URL=<previewUrl>`. PASS → continue. FAIL → loop back to fix mode.
3. CI lane (consumer-side) — full `pnpm playwright test e2e/` runs on every PR to catch cross-feature regressions.
4. Phase 4.5 UAT doc — splits into "Agent-verified by spec X" (from Phase 4.6 output) and "Human-only" (from `e2e.humanOnlyChecks[]` + any AC item the spec doesn't cover).

**Auth-agnostic contract:** the skill is portable across projects. The plugin doesn't ship auth logic — it reads `e2e.personas[]` with `storageState` paths. If a spec needs an authenticated persona AND that persona's storageState is missing, the skill REFUSES with a concrete remediation message (add `e2e/auth.setup.ts` per Playwright docs, declare in `playwright.config.ts`, populate the persona's `storageState`). Same BLOCKING-question pattern as `/dev-tasks:investigate-request`.

**For consumer projects adopting autonomous UAT:**
1. Install Playwright (`@playwright/test`) + write `playwright.config.ts` with `baseURL: process.env.BASE_URL ?? "http://localhost:3000"` and project entries per persona
2. Write `e2e/auth.setup.ts` per persona — log in via the project's actual auth flow, save storage state to `playwright/.auth/<persona>.json`. One-time setup; persists across all specs.
3. Add `e2e` block to `.claude/project-config.json` declaring personas, baseline policy (`commit`), humanOnlyChecks (subjective items)
4. Add a CI lane running `pnpm playwright test e2e/` on every PR
5. Commit baseline images (`e2e/<area>/<slug>.spec.ts-snapshots/*.png`) — **NEVER gitignore them**; doing so silently makes the visual-regression gate a no-op
6. Flake convention: chronically-flaky specs go to `e2e/flaky/` (runs but doesn't fail the gate)

**Honest caveats:**
- Autonomous UAT covers what's *reproducible*. Subjective design quality, copy tone, business-edge cases remain human-only — the UAT doc enumerates both halves so the human knows what was and wasn't verified.
- Local pass ≠ preview pass — cookie domains, OAuth callbacks, env vars all differ. Phase 4.6 always uses `--target=preview` for the hard gate.
- The 5-line cap from PolAds's original brief was rejected; real specs for golden paths run 80–120 lines. Soft guidance only.

See `plugin/skills/write-uat-spec/SKILL.md` for the full contract and `plugin/skills/write-uat-spec/EXAMPLES.md` for two worked walkthroughs (authenticated SaaS flow, public marketing flow).

### Quality over speed

Sourced from a downstream consumer's UAT 2026-05-22 retro: 4 of 5 fan-out agents skipped `/refine-task` verification, `/log-progress`, UAT doc creation, or Monday reconciliation. PRs landed fast; the Monday board lost its audit trail; ~30 min of manual reconciliation followed.

**The four most-skipped steps** — each gets a workflow-enforcement hook (opt-in via `project-config.json` → `hooks.enabled[]`):

1. **`/refine-task` quality** — `refinement-gate` (PreToolUse `claimTask`) refuses claims when the task lacks type, priority, epic, description (<200 chars), AC, OR has subtasks missing type/description/estimatedHours.
2. **`/log-progress` per subtask** — `subtask-progress-gate` (PreToolUse Bash `git push`) refuses push when subtasks exist but none Done-with-actualHours.
3. **UAT doc + Waiting-for-UAT flip** — `stop-waiting-for-uat-stage` (Stop) refuses session exit when all subtasks Done but parent task not at Waiting for UAT. `demo-url-required` (PreToolUse `updateTask`) refuses the WfUAT transition without a valid preview URL (validated against `project-config.ci.previewUrlPattern`).
4. **Monday reconciliation after merge** — `stop-monday-reconciled-check` (Stop) refuses session exit when a merge commit landed but its SHA isn't recorded as reconciled.

**The principle**: a 1-line edit gets the same workflow as a 500-line refactor. The Monday board is the audit trail; gaps in it compound into quality debt. Don't skip steps — the hooks won't let you, and bypassing them ALSO blocks (no `--admin` past CI failures).

Full detail in `plugin/rules/agent-orchestration.md` "Quality-over-speed loop integration".

### Workflow enforcement gates

Five hooks ship in plugin v0.15.0. All are opt-in via `project-config.json` → `hooks.enabled[]`:

- **`refinement-gate`** — refuses `claimTask` on Bugs-board items, un-refined tasks, or under-refined subtasks
- **`subtask-progress-gate`** — refuses `git push` when subtasks exist but none Done-with-actualHours (escape: `allowPushWithoutSubtaskProgress: true` in active-task.json)
- **`demo-url-required`** — refuses `updateTask(status='Waiting for UAT')` without `demoUrl` matching `project-config.ci.previewUrlPattern` (default permits any HTTPS URL)
- **`stop-waiting-for-uat-stage`** — refuses session exit when subtasks all Done but parent not at Waiting for UAT (escape: `reviewAddressed: handoff-to-orchestrator`)
- **`stop-monday-reconciled-check`** — refuses session exit when merge commit landed during session but its SHA isn't in active-task.json `mondayReconciledShas[]` (escape: `reviewAddressed: handoff-to-orchestrator`)

## Active-task.json drift reconciliation

A SessionStart hook (`plugin/hooks/active-task-recon.sh`) runs at every session start. When the working directory is inside a plugin worktree (`.claude/worktrees/*`), the hook reads `.claude/active-task.json`, queries the Monday.com source-of-truth, and surfaces drift as informational notices. Always exits 0 — never blocks session start.

Detected drift cases (3 of 5):

| Case | Trigger | Suggested action |
|---|---|---|
| **A — Done elsewhere** | Monday task is Done, but the worktree still has an `active-task.json` | `ExitWorktree({action:'remove'})` if shipped + verified clean. The worktree-janitor SessionStart hook collects DONE-class worktrees on the next session start anyway |
| **B — Ownership changed** | Monday's Agent ID now points at a different agent than this CLI | Continue at your own risk; `/log-progress TASK_STUCK` if uncertain |
| **D — Missing state file** | A `.claude/worktrees/*` directory has no `.claude/active-task.json` | `/pickup-task <id>` to reattach, OR `ExitWorktree({action:'remove'})` if abandoned |

Deferred (not detected by the current hook):
- **C — Task reassigned epic/sprint** — low signal; intentional refinement looks identical to drift
- **E — Stale claimToken** — would require an extra `getUpdates` API call per session start; cost > benefit

The hook silent-no-ops when: cwd is not under `.claude/worktrees/`, `MONDAY_API_KEY` is unset, `curl`/`jq` missing, or the Monday API returns no response. One non-silent edge case: if `active-task.json` is present but `taskId` is empty/malformed, the hook emits a one-line warning ("active-task.json present but taskId empty/malformed; skipping drift check.") before exiting 0 — surfacing the broken state file is more useful than silently skipping it. Output format: `[active-task-recon] Case X: <one-line summary>` followed by indented suggestion lines. Smoke-tested by `plugin/hooks/__tests__/active-task-recon.test.sh` (6 cases — local-only + Monday round-trip).

## Environment variables

- `MONDAY_API_KEY` — Monday.com API key (required). Must be exported in the parent shell that launches Claude Code; `.mcp.json` does not interpolate env values.

## Migration history (Phase 1–3a, May 2026)

This repo was previously a Next.js app exposing the MCP as an HTTP route (`app/api/mcp/route.ts`). Phase 1 migrated all 37 tools to a stdio MCP inside the plugin; Phases 2a/2b lifted universal rules, lifecycle skills, and the 6 critical blocking hooks from `v0-politiske-annoncer/.claude/`. Phase 3a (this commit) deleted the Next.js scaffolding — the repo is plugin-only now. Branch: `feat/plugin-migration`. Phase 3b/3c open: see tasks #7/#8.
