# Agent dispatch template — fix-class tasks

> Fill-in template for the orchestrator's `Agent(prompt=...)` calls when
> dispatching a subagent to work a refined Monday task. The workflow-enforcement
> hooks (refinement-gate, subtask-progress-gate, stop-waiting-for-uat-stage,
> stop-monday-reconciled-check, demo-url-required) assume the subagent follows
> this workflow. Skipping any step here will surface as a hard block; this
> template is your defense against that.

```
# Implement <one-line task summary> — Monday task #<ID>

You are dispatched in an isolated worktree by the orchestrator. The Monday
task is **already refined** (subtasks have type + description + estimatedHours;
status=Ready to Start). Do NOT re-refine. Read the task via getTask and follow
the subtask order verbatim.

## Monday task

- **ID**: <Monday task ID>
- **Name**: <task name>
- **Branch (already set)**: <branch — set by orchestrator>
- **Epic**: <epic ID> (<epic name>)
- **Sprint**: <sprint ID> (<sprint name>)
- **Subtask IDs** (read full description via getTask):
  1. <Subtask 1 name> — <type>, <hours>h
  2. <Subtask 2 name> — <type>, <hours>h
  …

## Root cause analysis

<2-5 lines naming the root cause WITH file:line refs. Even for a one-line
fix, this section is mandatory — it forces the orchestrator to think before
dispatching. A subagent receiving "make it work" with no diagnosis WILL
under-deliver.>

Example:
> Sentry shows TypeError at lib/parse-config.ts:42 — `config.field` is
> `null` on rows imported pre-migration (no NOT NULL constraint at the
> time). The aggregation helper assumed non-null. Need to coalesce to
> a sensible default + backfill the column at migration time + add Zod
> refine on read.

## Mandatory workflow — NO SHORTCUTS

This task EXISTS BECAUSE workflow shortcuts cost us. Don't repeat them.
Follow every step:

### Phase 0: Pickup
1. `/pickup-task <task-ID>` — sets up worktree active-task.json, sprint
   check, branch.
2. `/plan-task` — reconcile the refinement against the current codebase
   (drift check).

### Phase 1: Per-subtask implementation
For EACH subtask IN ORDER:
1. Mark the Monday subtask `In Progress` via `manageSubtasks`.
2. Implement using the subtask's description as the spec.
3. Add tests as named in the AC.
4. Manually verify the change behaves as expected (don't push from a
   "should work" — actually run it).
5. Mark the Monday subtask `Done` with `actualHours` via `manageSubtasks`.
6. Run `/log-progress SUBTASK_COMPLETED` so Monday gets the timing signal.

### Phase 2: Cross-cutting checks
After all subtasks Done:
1. Run any project-specific verification (tests, lint, type-check).
2. Update related documentation if behaviour changed.

### Phase 3: Self-review (iterative)
1. Run `/self-review` until all checks pass.
2. Pay attention to the project-specific rule(s) for this domain — read
   `<your-project>/.claude/rules/<topic>.md` per the consumer's rule catalog.

### Phase 4: Ship
1. Run `/ship-pr` — full pipeline including `createTaskUatDoc` + status
   flip to `Waiting for UAT` + demoUrl set.
2. The UAT doc should walk through what changed + how to verify.
3. Set `reviewAddressed=handoff-to-orchestrator` in active-task.json
   after CI green.
4. **SendMessage the orchestrator** with the PR URL + a 1-paragraph
   summary. Do NOT merge.

## Anti-shortcuts (the workflow-enforcement hooks block these)

- **NO** skipping `/refine-task` verification (task is pre-refined; just
  read it via getTask).
- **NO** skipping `/log-progress` after each subtask. Monday needs the
  timing signal. The `subtask-progress-gate.sh` hook BLOCKS `git push`
  when no subtasks have Done + actualHours.
- **NO** stopping at PR-open without UAT doc + Waiting-for-UAT. The full
  `/ship-pr` pipeline runs. The `stop-waiting-for-uat-stage.sh` hook
  BLOCKS Stop when subtasks all done but parent not at Waiting for UAT.
- **NO** writing hooks into the plugin cache (`~/.claude/plugins/cache/...`).
  Project-level (`.claude/hooks/`) or via plugin update only.
- **NO** merging. The orchestrator merges. Set
  `reviewAddressed=handoff-to-orchestrator` + SendMessage.
- **NO** transitioning to Waiting for UAT without demoUrl. The
  `demo-url-required.sh` hook BLOCKS this (validated against the
  consumer's `project-config.ci.previewUrlPattern`).

## Hard rules (the workflow-enforcement hooks apply to YOU too)

These ARE the project's quality bar. Going around them just produces a
Monday board that lies about the work done.

- Refinement-gate refuses claims on un-refined tasks. You shouldn't hit
  this because the task is pre-refined — but if you do, that's a signal
  the orchestrator missed something. Investigate, don't bypass.
- The Bugs board (5091706353) refuses direct claims. Run
  `convertBugToTask` if you're given a Bug ID.
- Every subtask must show actualHours when marked Done. Estimate
  honestly — orchestrator uses these for capacity planning.

## When done

Reply with under 200 words:
- PR URL
- Per-subtask hour: estimated vs actual
- 1-sentence smoke-test verdict per gate (if you touched gates)
- Any blockers or scope adjustments

The orchestrator will:
1. CI-poll, claude-bot verdict check, merge with `--admin --squash`.
2. Monday reconciliation: verify task at Waiting for UAT, post merge update.
3. Remove worktree, send agent shutdown signal.

Reference: ${CLAUDE_PLUGIN_ROOT}/rules/agent-orchestration.md "Orchestrator
post-merge checklist".
```

## How to use this template

1. Open this file, copy the entire fenced block, paste into the orchestrator's
   `Agent(prompt=...)` argument.
2. Fill in the placeholders (`<task-ID>`, `<task-name>`, `<branch>`, etc.) —
   leave the `Anti-shortcuts` + `Hard rules` sections intact.
3. The `Root cause analysis` section is the load-bearing part. Even for a
   one-line edit, write 2-3 sentences. A subagent dispatched with a vague
   prompt produces vague work.

## Variations

Add a short, project-specific section right before "Mandatory workflow" when
relevant:

- **Migration tasks** — point at the consumer's database / migration rule
  (e.g. `<your-project>/.claude/rules/database.md`) and require
  `pnpm migrate:testing` first.
- **i18n-affecting tasks** — point at the consumer's i18n rule (the plugin's
  generic guidance lives in `plugin/rules/testing.md`'s "I18n parity"
  section). Most consumers use `bash-guard.sh` gates (d)+(e) for parity
  enforcement.
- **UI tasks** — point at `/dev-tasks:design-consistency` skill (reuse-before-
  invent) and `/dev-tasks:visual-diff` for self-review.
- **e2e-UAT-eligible tasks** — point at `/dev-tasks:write-uat-spec` (writes
  a Playwright spec that runs as the Phase 4.6 hard gate). Requires the
  consumer to have `e2e.enabled: true` in `project-config.json`.

These are reminders, not new rules — the existing project rules already cover
them. The template just makes them VISIBLE to the subagent in its initial
prompt so it doesn't discover them mid-implementation.

## History

- **2026-05-24**: original template created after a downstream consumer's UAT
  retro identified that 4 of 5 fan-out agents skipped `/refine-task`
  verification, `/log-progress`, or UAT doc creation. The workflow-enforcement
  hooks BLOCK these shortcuts; this template makes the workflow VISIBLE in
  every agent dispatch so the shortcut never gets attempted.
- **2026-05-25**: migrated from project-level to the dev-tasks plugin so all
  consumers get the same dispatch template.
