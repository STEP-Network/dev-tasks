# Task Lifecycle

Monday.com task lifecycle: statuses, subtask types, dependencies, gates.

## Status flow

```text
Needs Refinement → Ready to Start → In Progress → Waiting for UAT → Pending Deploy to Prod → Done
                                          │
                                          └─→ Stuck (escapes on blockers)
```

**Never set status to `Done` directly** — Monday automation does it when the last subtask flips Done (default flow), `/release-version` does (release ceremony), or `/ship-pr` Phase 10 does (hotfix-to-`main` only).

| Status | Set by | Gate on `updateTask` |
|---|---|---|
| **Needs Refinement** | Default at `createTask` | None |
| **Ready to Start** | `createTask`/`updateTask` after refinement | `type` + `priority` + `epicId` + `description` + `acceptanceCriteria` + ≥1 subtask with `name`+`description`+`type`+`estimatedHours` |
| **In Progress** | `claimTask` | Task in active sprint; all `dependencyIds` (column `dependency_mm0pwbxn`) `Done` |
| **Waiting for UAT** | `/ship-pr` Phase 6.5 after review loop | All subtasks `Done` + UAT doc set via `createTaskUatDoc` on column `doc_mm3adfdg` (warns on missing GitHub / branch / demo / PR links) |
| **Pending Deploy to Prod** | Human after UAT sign-off on `test.polads.eu` | All subtasks `Done` |
| **Done** | `/release-version` (default) or `/ship-pr` Phase 10 (hotfix-to-`main` only) | Agents never set directly under staging flow |
| **Stuck** | Any skill, on unresolvable blocker | None |

## Subtask types

`Backend` · `Test` · `Documentation` · `UX-UI` · `Database` · `To Do`. Every subtask MUST have `name` + `description` + `type` + `estimatedHours`.

| Type | Use for |
|---|---|
| **Backend** | API routes, server actions, business logic, hooks, scripts, MCP/AI integrations |
| **Test** | Unit / integration / E2E coverage (Jest, Playwright, MCP-driven) |
| **Documentation** | CLAUDE.md, `.claude/rules/`, `docs/`, README, user guides, RAG content |
| **UX-UI** | React components, page layouts, styling, a11y, theming |
| **Database** | Drizzle schema changes, migrations, indexes, query tuning |
| **To Do** | Catchall — sparingly when no other type fits |

Pick the dominant work type. Backend route + one-line test stays `Backend`; split off `Test` only when coverage is non-trivial.

**No human-test subtasks.** Human verification is the parent's `Waiting for UAT` + auto-generated UAT doc on `doc_mm3adfdg` (written by `/ship-pr` Phase 4.5).

## Subtask statuses

`Needs Refinement` → `In Progress` → `Done` (+ `Stuck`). No `Ready to Start`. When all subtasks `Done`, `/ship-pr` transitions parent to `Waiting for UAT`.

## Dependencies

A task may declare `dependencyIds` on `dependency_mm0pwbxn`. `claimTask` refuses to start a task whose dependencies aren't all `Done`. `/pickup-task` Phase 4.6 surfaces as soft warning.

### Implementation-done semantics

A dependency is satisfied when its IMPLEMENTATION is on staging, not when it has reached production. Under staging-as-base (per `release-flow.md`):

```
Implementation done → Waiting for UAT → Pending Deploy to Prod → Done
                      (code on staging)   (UAT signed off)        (released to prod)
```

The contract is "code available on staging" — happens at `Waiting for UAT`. UAT + release are downstream human steps that don't gate code composability.

**Clear `dependencyIds` once the predecessor hits `Waiting for UAT`**, not `Done`. The MCP "hard gate" is too strict for actual implementation-availability semantics. Don't wait for `Done` — prod deploys are batched, may take days. Document the code-availability contract in the task description (e.g. "depends on `complaints.sla_deadline` column from PR #267").

To clear a misfiled / resolved dependency: `updateTask(itemId, dependencyIds: [])`.

## Lifecycle phases

**Entry**:
- User provides task ID → `getTask`. Else `getBacklog`. No matching task → `createTask` MUST include `type`, `priority`, `epicId`, `description`, `acceptanceCriteria`, ≥1 valid subtask. Check for duplicates first. Validate epic; missing → `listEpics` → ask user → `updateTask`.

**During development**:
- After claiming: `manageSubtasks` to create/adjust subtasks (no human-test).
- Each piece completes: `/log-progress SUBTASK_COMPLETED`.
- New work: `manageSubtasks` (set `type` + `estimatedHours`), or `createBug` (auto-assigns maintenance epic).

**After finishing — default staging flow**:
- All subtasks `Done`.
- `/ship-pr` auto-generates UAT doc, sets `demoUrl` + `prLink` + `branch` + `githubLink`, transitions to `Waiting for UAT`.
- Agent auto-merges to `staging` when CI green + reviewAddressed set (`/ship-pr` Phase 6.6, effective 2026-05-13). Merge triggers Vercel rebuild of `test.polads.eu`.
- Task stays at `Waiting for UAT`. Agent continues to next session-scoped task — does NOT wait for human UAT.
- Human signs off → `Pending Deploy to Prod` → `/release-version` cuts release → task `Done` via tag-triggered GitHub Action.
- Version linkage: `listVersions` → link task's epic to target version.

**After finishing — hotfix flow (branched from `main`)**:
- `/ship-pr` PRs against `main`. UAT doc skipped.
- NO auto-merge for hotfixes — production-blocker verification by human is non-negotiable. Agent leaves PR open, continues to next task.
- After human merge → `/ship-pr` Phase 10 sets task `Done` directly.

## Human-action subtasks — `[HUMAN]` pattern

When a task requires a human-only action (admin-panel click, OAuth grant, signing legal docs, vendor support, manual browser verification distinct from UAT):

1. Create a `To Do`-type subtask:
   - Name starting `[HUMAN]` prefix
   - Status `Ready to Start` (user can act now) OR `Stuck` (external precondition blocking)
   - Description: brief WHY + expected outcome + block reason (if Stuck). Short.
   - Step-by-step in a Monday Update on the subtask via `createUpdate({ itemId: <subtask_id> })`. **HTML formatting** — Monday strips markdown but renders `<p>`, `<ol>`, `<ul>`, `<li>`, `<strong>`, `<em>`, `<code>`, `<h3>`, `<a href="...">`. Numbered `<ol>` with `<strong>` on key actions, `<code>` on URLs/secrets/event names. Write for "intern who's never seen this UI."
   - `estimatedHours` realistic (most ≤ 0.5h).
2. Set parent task status to `Stuck` — release ceremony MUST NOT promote partially-functional tasks.
3. Post Monday update on parent via `createUpdate` listing every `[HUMAN]` subtask + WHY stuck.
4. Unblocking: human marks `[HUMAN]` subtasks Done. Once ALL are Done, parent flips back to `Waiting for UAT`.

NOT for: actions doable via API/MCP (use regular Backend subtask); UAT itself (`Waiting for UAT` covers it); one-time non-recurring setup (regular subtask). `[HUMAN]` is for ongoing/repeating user dependencies.

Skill coordination: `/ship-pr` Phase 6.5 → if ANY `[HUMAN]` subtask not Done, set parent `Stuck` instead of `Waiting for UAT`. `/log-progress SUBTASK_COMPLETED` → if completing last non-Done `[HUMAN]`, suggest flipping parent to `Waiting for UAT`. `/pickup-task` → skip tasks Stuck on "human action pending."

## Cross-references

- `.claude/skills/{create-task,refine-task,pickup-task,log-progress,ship-pr,release-version}/SKILL.md` — phase mechanics
- `release-flow.md` — staging-as-base branching
- `versioning.md` — semver bump, version lifecycle
- `worktree-discipline.md` — every claimed task edits inside a worktree
- `.claude/hooks/dev-tasks-update-guard.sh` — PreToolUse defense-in-depth gate validation
