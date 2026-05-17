---
name: file-retro
description: File a retrospective item (Discussion / Keep / Improve) on the Retrospectives board. Walks through triage (is this actually a Retro, not a Bug or Task?), dedupe, and a concrete-reproduction-first draft.
user_invocable: true
---

# /file-retro — File a Retrospective Item

> **Overlay**: if `.claude/skills/file-retro/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific instructions (extend-only — overlay can append checks/steps but cannot replace plugin behavior).

## When to apply

Use this skill when you encounter friction in the **workflow** (not a product bug) that's worth surfacing for team discussion. Concrete triggers:

- A hook fires when it shouldn't (false positive) or misses something it should catch (false negative — but only if it's not a hard bug)
- A skill instruction doesn't match observed behavior (style/UX drift, not a runtime bug)
- A rule contradicts another rule, or both contradict observed code
- Tooling friction noticed mid-task that's worth aligning the team on but not blocking the current PR
- A pattern divergence between two parts of the codebase that needs a decision (not a fix)
- The agent applied a manual workaround where a helper should exist

Don't use for: **product bugs** (file via `mcp__plugin_dev-tasks_dev-tasks__createBug`), **missing capabilities** (file as a Task with epic), **stuff that's already in the existing Retrospectives board for this sprint** (dedupe → bump existing instead).

## Triage decision (the load-bearing one)

Ask: *"If I left this alone, would the system produce wrong output for a real user?"*

- **Yes** → it's a Bug, not a Retro. Use `createBug` instead. STOP this skill.
- **No, but it makes the agent or user's work harder / produces noise** → it's a Retro. Continue.
- **No, and it's a missing capability** → it's a Task under the workflow-tooling epic. STOP this skill.

This heuristic is the same one in `.claude/rules/meta-workflow.md` — repeated here so the agent doesn't context-switch to read the rule before filing.

## Workflow

### Step 0 — Project context

Read `.claude/project-config.json`. Extract `monday.productId`. Required for `listRetros` filtering when the retro relates to a specific product (most do).

### Step 1 — Dedupe

Before filing, search the Retrospectives board for similar entries:

```
mcp__plugin_dev-tasks_dev-tasks__listRetros({
  activeSprint: true,
  search: "<2-3 keywords from your draft retro name>",
})
```

For each result:

- **Exact-name match**: don't file a duplicate. Either update the existing retro (`updateRetro` to enrich its description with the new instance) or — if it's a repeating issue — confirm the existing has `repeating: true` and just add a comment with the new occurrence.
- **Near-match (>60% keyword overlap, same scope)**: prefer to enrich the existing. Only file new if the angle is genuinely different.
- **No match**: continue to Step 2.

Don't skip the dedupe — duplicate retros split the team's attention and dilute the "this is the Nth time we've hit this" signal that `repeating: true` is supposed to deliver.

### Step 2 — Decide type

Pick one of three:

- **Discussion** — open question, decision needed, alignment ask. No clear action yet. Often gets a follow-up retro after the team discusses.
- **Keep** — something is working well, name it so it doesn't get accidentally removed in a future refactor. Often paired with `repeating: true` (we should keep doing this every sprint).
- **Improve** — concrete pain point with at least a sketch of what the fix would look like. Most retros land here.

If the entry doesn't fit any of the three cleanly, it's probably actually a Bug or Task — re-run the triage in the section above.

### Step 3 — Decide repeating flag

`repeating: true` means "this issue carries over between sprints — surface it again next sprint if not resolved." Use it when:

- You've hit this Nth time and the pattern is the issue, not the specific instance
- The Keep behavior is a sprint-cadence ritual (e.g. "always run /audit-versions at sprint end")
- The Discussion is large enough that it won't get resolved in one sprint

`repeating: false` (default) means "this is sprint-bound — close it or convert it before sprint end."

### Step 4 — Draft

A good retro entry has three components in the description:

1. **What happened** — concrete reproduction. Which PR / turn / file path / what triggered it. NOT abstract ("hooks are noisy") — specific ("`stop-task-check.sh` fires 6× per PR during the Monitor wait, see PR #N comment thread Y").
2. **Why it matters** — the cost. ("Adds ~30s of noise per PR; teaches agents to mute Stop-hook signals which is dangerous.")
3. **What to try** — at least one concrete next step, even if speculative. ("Add an idle-window suppression to stop-task-check that mutes when the agent is on an active Monitor.")

Pick a short headline-style name (5-10 words, action-oriented for Improve, observation-style for Keep/Discussion).

### Step 5 — File

```
mcp__plugin_dev-tasks_dev-tasks__createRetro({
  name: "<headline>",
  type: "Improve" | "Keep" | "Discussion",
  description: "<the 3-component draft from step 4>",
  repeating: <boolean from step 3>,
  sprintId: <active sprint ID — listSprints(activeOnly: true) to discover>,
  submitter: <your Monday person ID — getPersonByUsername(whoami) resolves this; the plugin can do it automatically>,
})
```

The MCP returns the retro ID. Reference it in the conversation summary so the user can find it.

### Step 6 — Cross-link (optional)

If the retro relates to a specific Monday task / bug / PR, leave a brief Monday update on that item pointing at the retro:

```
mcp__plugin_dev-tasks_dev-tasks__createUpdate({
  itemId: <related task/bug ID>,
  body: "<p>Filed retrospective #<retro-id>: <retro name></p>",
})
```

## Arguments

- `<description>` (optional): natural-language description of what to file. If omitted, the skill prompts the user for content.

## Anti-patterns

- **Filing speculative future-friction**: only file what was actually hit this session.
- **Filing the same friction twice**: dedupe with `listRetros` first. If you find a match, enrich the existing.
- **Filing instead of fixing**: if the fix is <10 lines, in scope, and doesn't change a workflow contract, just fix it inline in the current PR. Filing creates backlog noise.
- **Mixing categories**: if a hook is both broken AND noisy, file two items — one Bug for the broken behavior, one Retro for the noise.
- **No concrete repro**: an abstract retro ("the agent is too verbose") is unactionable. Always cite a specific PR / commit / file / agent turn.

## When the auto-file-followup-nudge hook fires

The `auto-file-followup-nudge.sh` hook surfaces a non-blocking nudge on three triggers: CI-ack writes, `gh run rerun --failed` (flake confirmation), `git revert`. When it fires, treat the nudge as a prompt to invoke `/dev-tasks:file-retro` (or `createBug` if the heuristic says Bug).

## Reference

- `.claude/rules/meta-workflow.md` — full Bug-vs-Retro-vs-Task triage matrix + "Dedupe before create" rule
- `mcp__plugin_dev-tasks_dev-tasks__createRetro` / `updateRetro` / `listRetros` — the MCP tools this skill orchestrates
- `auto-file-followup-nudge.sh` — the hook that surfaces retro-file nudges automatically
