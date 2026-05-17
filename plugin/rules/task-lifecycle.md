# Task Lifecycle Rule

> **Reference rule** — full detail of the Monday.com task lifecycle (statuses,
> subtask types, dependencies, gates, default vs hotfix flow). Loaded on demand
> by `/pickup-task`, `/create-task`, `/refine-task`, `/log-progress`, `/ship-pr`,
> and `/release-version`. CLAUDE.md carries a compact summary + pointer here.

## TL;DR

**Status flow:** Needs Refinement → Ready to Start → In Progress → Waiting for UAT → Pending Deploy to Prod → Done (+ Stuck escapes the flow on blockers).

**Hard gates** (server-enforced by `updateTask`):
- **Ready to Start** ← type + priority + epicId + description + acceptanceCriteria + ≥1 subtask with name+description+type+estimatedHours
- **In Progress** ← task in active sprint + all `dependencyIds` Done
- **Waiting for UAT** ← all subtasks Done + UAT doc set via `createTaskUatDoc`

**Subtask types** (6): `Backend` · `Test` · `Documentation` · `UX-UI` · `Database` · `To Do`. Every subtask MUST have name+description+type+estimatedHours.

**Never set status to `Done` directly** — Monday automation does it when the last subtask flips Done (default flow), or `/release-version` does (release ceremony), or `/ship-pr` Phase 10 does (hotfix-to-`main` only).

## The 7-status flow

```text
Needs Refinement → Ready to Start → In Progress → Waiting for UAT → Pending Deploy to Prod → Done
                                         │
                                         └─→ Stuck (escapes the linear flow on blockers)
```

| Status | Set by | Server-side gate on `updateTask` |
| --- | --- | --- |
| **Needs Refinement** | Default at `createTask` | None |
| **Ready to Start** | `createTask`/`updateTask` after refinement | `type` + `priority` + `epicId` + `description` + `acceptanceCriteria` + ≥1 subtask with `name`+`description`+`type`+`estimatedHours` |
| **In Progress** | `claimTask` | Task must be in the active sprint; all `dependencyIds` (column `dependency_mm0pwbxn`) must be `Done` |
| **Waiting for UAT** | `/ship-pr` Phase 6.5 after review loop passes | All subtasks `Done` + UAT doc set via `createTaskUatDoc` on column `doc_mm3adfdg` (warns on missing GitHub / branch / demo / PR links) |
| **Pending Deploy to Prod** | Human after UAT sign-off on `test.polads.eu` | All subtasks `Done` |
| **Done** | `/release-version` (default flow) or `/ship-pr` Phase 10 (hotfix-to-`main` only) | **Agents never set `Done` directly under the staging flow** — that's the release ceremony's job |
| **Stuck** | Any skill, after 3 consecutive failures or unresolvable blocker | None |

## The 6 subtask types

`Backend` · `Test` · `Documentation` · `UX-UI` · `Database` · `To Do`

Every subtask MUST have `name` + `description` + `type` + `estimatedHours`. The MCP's
`Ready to Start` gate on the parent task rejects subtasks missing any of these fields.

| Type | Use for |
|------|---------|
| **Backend** | API routes, server actions, business logic, hooks, scripts, MCP/AI integrations |
| **Test** | Unit / integration / E2E coverage (Jest, Playwright, MCP-driven) |
| **Documentation** | CLAUDE.md, `.claude/rules/`, `docs/`, README, user guides, RAG content |
| **UX-UI** | React components, page layouts, styling, a11y, theming |
| **Database** | Drizzle schema changes, migrations, indexes, query tuning |
| **To Do** | Catchall — use sparingly when no other type fits |

Pick the dominant work type. A subtask that adds a Backend route plus a one-line
test for it stays typed as `Backend`; split off a `Test` subtask only when test
coverage is non-trivial.

**No human-test subtasks.** Human verification is the parent task's `Waiting for UAT`
status + the auto-generated UAT doc on column `doc_mm3adfdg` (written by `/ship-pr`
Phase 4.5). The legacy "Always add a Testing subitem with owner 48307552" rule is
removed.

## The 5 subtask statuses

`Needs Refinement` → `Ready to Start` → `In Progress` → `Done` (+ `Stuck`)

Subtasks don't have a UAT step — they're agent-completed work units. When all
subtasks are `Done`, `/ship-pr` transitions the parent task to `Waiting for UAT`
(default flow).

## Dependencies (soft warning at `/pickup-task`, hard gate at `claimTask`)

A task may declare `dependencyIds` on the `dependency_mm0pwbxn` column.
`claimTask` refuses to start a task whose dependencies aren't all `Done`.
`/pickup-task` Phase 4.6 surfaces this as a soft warning so the agent sees the
block before calling `claimTask`.

### Dependency semantics — IMPLEMENTATION done, NOT release done

> **A dependency is satisfied as soon as the dependency's IMPLEMENTATION is on
> staging**, not when it has reached production via the release ceremony.

Under the staging-as-base flow (per `.claude/rules/release-flow.md`), a task's
status flow after implementation is:

```
Implementation done → Waiting for UAT → Pending Deploy to Prod → Done
                      (code on staging)    (UAT signed off)        (released to prod)
```

The dependency contract is: **dependent code is available on the integration
branch (staging)**, which happens at the `Waiting for UAT` transition. UAT +
release ceremony are downstream human-validation steps that don't gate code
composability — by the time a task hits `Waiting for UAT`, its primitives
(schema columns, helpers, exported APIs) are live on staging and consumable.

**Therefore, `dependencyIds` should be cleared once the predecessor hits
`Waiting for UAT`**, not when it hits `Done`. The MCP-level "hard gate" rule
("refuses to start a task whose dependencies aren't all Done") is too strict
for the implementation-availability semantics actual developers need.

**Operational rule for orchestrators + agents**:
- If you set `dependencyIds` at task-creation time, expect the orchestrator
  (or you) to clear them once the predecessor reaches `Waiting for UAT`.
- Don't wait for `Done` — production deploys are scheduled, batched, and may
  take days. Holding new work for that is a false-precision blocker.
- Document the actual code-availability contract in the dependent task's
  description (e.g. "depends on `complaints.sla_deadline` column from PR #267")
  rather than relying on `Done` status as the integration signal.

**To clear a misfiled OR resolved-by-implementation dependency**:
`updateTask(itemId, dependencyIds: [])`.

## Lifecycle phases

### Before starting work (entry)

- If user provides a task ID: call `getTask` to load context and subtasks.
- If no task ID: call `getBacklog` to search for an existing task.
- If no matching task: call `createTask` — MUST include `type`, `priority`, `epicId`, `description`, `acceptanceCriteria`, and ≥1 subtask with `name`+`description`+`type`+`estimatedHours`.
- Check for duplicate/related tasks before creating new ones.
- Validate task has an epic. If missing: `listEpics` → ask user to pick → `updateTask` with `epicId`.

### During development

- After claiming: call `manageSubtasks` to create/adjust subtasks reflecting implementation plan (NO human-test subtasks).
- As each piece completes: `/log-progress SUBTASK_COMPLETED` (updates Monday.com, auto-calculates hours, starts next).
- If new work discovered: `manageSubtasks` to add subtask (set `type` + `estimatedHours`), or `createBug` for defects (auto-assigns maintenance epic).

### After finishing work — default staging flow

- All subtasks marked `Done` via `/log-progress SUBTASK_COMPLETED`.
- `/ship-pr` auto-generates the UAT doc via `createTaskUatDoc`, sets `demoUrl` + `prLink` + `branch` + `githubLink` via `updateTask`, and transitions the task to `Waiting for UAT`.
- **Agent auto-merges to `staging`** when CI is green + reviewAddressed set (`/ship-pr` Phase 6.6). Effective 2026-05-13. CI green IS the gate; there is no human approval step for `staging` merges. The merge triggers a Vercel rebuild of `test.polads.eu` where human UAT happens.
- Task stays at `Waiting for UAT` post-merge. **Agent immediately continues to the next session-scoped task — does NOT wait for human UAT.**
- Human signs off on UAT → flips status to `Pending Deploy to Prod`.
- `/release-version` cuts the release → task status → `Done` automatically via the tag-triggered GitHub Action.
- Check version linkage: `listVersions` → link task's epic to target version if not already linked.

### After finishing work — hotfix flow (branched from `main`)

- `/ship-pr` PRs against `main`. UAT doc generation is skipped (hotfix verification is on prod itself).
- **NO auto-merge for hotfixes.** Production-blocker verification by a human is non-negotiable. The agent leaves the PR open and continues to the next task.
- After human merge to `main` → `/ship-pr` Phase 10 (next session or manual re-invocation) sets the task status to `Done` directly (no `Waiting for UAT` step).

## Human-action subtasks — the `[HUMAN]` pattern

When a task's full completion requires a human-only action that no agent can perform (admin-panel click in a third-party dashboard, OAuth grant, signing legal docs, vendor support coordination, manual browser verification distinct from UAT), the agent MUST encode the gap explicitly:

1. **Create a `To Do`-type subtask** under the parent task with:
   - **Name** starting with `[HUMAN]` prefix — scannable on the board, no need to read every task description.
   - **Status** = `Ready to Start` (user can act now) OR `Stuck` (blocked on an external precondition like vendor support response).
   - **Description** = brief WHY + expected outcome + block reason (if Stuck). Keep it short — the user shouldn't read a paragraph to know what this task is about.
   - **Step-by-step goes in a Monday Update on the subtask** (via `mcp__plugin_dev-tasks_dev-tasks__createUpdate({ itemId: <subtask_id> })`). **Use HTML formatting** — Monday strips markdown but renders a subset of HTML (`<p>`, `<ol>`, `<ul>`, `<li>`, `<strong>`, `<em>`, `<code>`, `<h3>`, `<a href="...">`). Numbered `<ol>` list with `<strong>` on key actions and `<code>` on URLs/secrets/event names; sub-bullets via nested `<ul>`. Write for an "intern who's never seen this UI" — link to the relevant `.claude/rules/*.md` section if the steps are documented there.
   - **estimatedHours** = realistic (most should be ≤ 0.5h).

2. **Set parent task status to `Stuck`** — the task is not fully functional until the human acts; the release ceremony MUST NOT promote a partially-functional task to `Pending Deploy to Prod`.

3. **Post a Monday update on the parent** via `mcp__plugin_dev-tasks_dev-tasks__createUpdate` listing every `[HUMAN]` subtask + WHY stuck. Captures the agent's reasoning for audit; the user has one place to scan instead of multiple subtasks.

4. **Unblocking**: when the human completes a `[HUMAN]` subtask, they mark it Done. Once ALL `[HUMAN]` subtasks on a task are Done, the parent task flips back to `Waiting for UAT` (default flow). Either the user or the next agent picking up the task does this transition.

### When NOT to use `[HUMAN]`

- **The action could be done via API/MCP but you skipped it** — file as a regular Backend subtask, not human-action. Don't outsource agent-doable work.
- **The "human action" is just UAT** — `Waiting for UAT` already covers stakeholder validation on test.polads.eu; no `[HUMAN]` ceremony needed.
- **One-time setup that won't recur** — fine as a regular subtask; `[HUMAN]` pattern is for ongoing/repeating user dependencies where the user must learn the path.

### Examples in this codebase (2026-05-14)

| Task | `[HUMAN]` subtask | Why |
|---|---|---|
| #2914333287 PostHog enablement | Configure PostHog Insight alert in dashboard | Webhook receiver is live; the alert config is UI-only |
| #2914336966 Sentry bundle | Configure Sentry Workflow Engine rules | Auto-tag + dedup window + escalate — GUI-managed |
| #2914356674 Autonoma | Configure webhook destination + trigger synthetic failure | Both Stuck on Autonoma support permission grant |
| #2915993291 Autonoma onboarding | 6× [HUMAN] subtasks for active product usage | Ongoing user-side onboarding gap |

### Coordination with skills

- `/ship-pr` Phase 6.5 (status → Waiting for UAT): if ANY subtask name starts with `[HUMAN]` and is not Done, set parent to `Stuck` instead of `Waiting for UAT` and post the why-stuck Monday update.
- `/log-progress` SUBTASK_COMPLETED: if completing a `[HUMAN]` subtask was the last non-Done `[HUMAN]` task, suggest flipping parent back to `Waiting for UAT`.
- `/pickup-task`: skip tasks whose Stuck reason is "human action pending" — the agent can't make progress on those.

## Cross-references

- `.claude/skills/{create-task,refine-task,pickup-task,log-progress,ship-pr,release-version}/SKILL.md` — phase-by-phase mechanics
- `.claude/rules/release-flow.md` — staging-as-base branching, default vs hotfix
- `.claude/rules/versioning.md` — semver bump rules, version lifecycle, "Relationship between task status and release ceremony"
- `.claude/rules/worktree-discipline.md` — every claimed task edits inside a worktree
- `.claude/hooks/dev-tasks-update-guard.sh` — PreToolUse hook with defense-in-depth gate validation
- CLAUDE.md "Task lifecycle" section — compact summary + pointer back here

## When this rule is loaded

- Any skill in the task lifecycle pipeline references this file directly.
- Auto-loadable when editing files matching `.claude/skills/**`, `.claude/active-task.json`, or task-status-touching scripts.
