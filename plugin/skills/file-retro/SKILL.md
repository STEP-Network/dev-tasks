---
name: file-retro
description: File a retrospective item (Discussion / Keep / Improve) on the Retrospectives board. Walks through triage (is this actually a Retro, not a Bug or Task?), dedupe, and a concrete-reproduction-first draft.
user_invocable: true
---

# /file-retro — File a Retrospective Item

## When to apply

Workflow friction worth surfacing for team discussion (not a product bug). Triggers:
- Hook fires when it shouldn't (false positive) or misses something it should catch (if not a hard bug)
- Skill instruction doesn't match observed behavior (style/UX drift, not runtime bug)
- Rule contradicts another rule, or both contradict code
- Tooling friction worth aligning team on but not blocking current PR
- Pattern divergence between codebase parts needing a decision (not a fix)
- Agent applied a manual workaround where a helper should exist

Don't use for: product bugs (`createBug`), missing capabilities (Task with epic), already-in-Retrospectives-for-this-sprint (dedupe → bump existing).

## Triage decision

Ask: *"If I left this alone, would the system produce wrong output for a real user?"*
- **Yes** → Bug, not Retro. `createBug`. STOP.
- **No, but harder work / produces noise** → Retro. Continue.
- **No, and it's a missing capability** → Task under workflow-tooling epic. STOP.

Same heuristic as `.claude/rules/meta-workflow.md`.

## Workflow

### Step 0 — Project context

Read `.claude/project-config.json`. Extract `monday.productId` (required for `listRetros` filtering when retro relates to a specific product).

### Step 1 — Dedupe

```
mcp__plugin_dev-tasks_dev-tasks__listRetros({ activeSprint: true, search: "<keywords>" })
```

For each result:
- Exact-name match → don't duplicate. Update existing (`updateRetro`) or — if repeating issue — confirm `repeating: true` and add comment with new occurrence.
- Near-match (>60% overlap, same scope) → enrich existing unless angle is genuinely different.
- No match → Step 2.

### Step 2 — Decide type

- **Discussion** — open question, decision needed, alignment ask. Often gets follow-up after team discusses.
- **Keep** — something working well; name it so it doesn't get accidentally removed. Often paired with `repeating: true`.
- **Improve** — concrete pain point with sketch of fix. Most retros land here.

Doesn't fit any cleanly → probably Bug or Task. Re-run triage.

### Step 3 — Decide repeating flag

`repeating: true` = "carries over between sprints — surface again next sprint if not resolved". Use when: hit Nth time and pattern is the issue not the instance; Keep is a sprint ritual; Discussion too large for one sprint.

`repeating: false` (default) = "sprint-bound — close or convert by sprint end".

### Step 4 — Draft

Three components in the description:
1. **What happened** — concrete reproduction. PR / turn / file path / trigger. Specific, not abstract.
2. **Why it matters** — the cost. Time, accuracy, signal, etc.
3. **What to try** — at least one concrete next step, even if speculative.

Short headline-style name (5–10 words, action-oriented for Improve, observation for Keep/Discussion).

### Step 5 — File

```
mcp__plugin_dev-tasks_dev-tasks__createRetro({
  name, type, description, repeating, sprintId, submitter
})
```

Reference returned ID in conversation summary.

### Step 6 — Cross-link (optional)

If retro relates to a Monday item:
```
createUpdate({ itemId, body: "<p>Filed retrospective #<retro-id>: <name></p>" })
```

## Arguments

- `<description>` (optional): natural-language description; if omitted, skill prompts.

## Anti-patterns

- Speculative future-friction (file what was actually hit this session)
- Filing same friction twice (dedupe first, enrich existing)
- Filing instead of fixing (<10 lines, in-scope, no contract change → fix inline)
- Mixing categories (broken AND noisy → file two: one Bug, one Retro)
- No concrete repro (abstract retros are unactionable; cite specific PR/commit/file/turn)

## When `auto-file-followup-nudge` hook fires

Hook surfaces non-blocking nudge on CI-ack writes, `gh run rerun --failed` (flake confirmation), `git revert`. Treat as prompt to invoke `/dev-tasks:file-retro` (or `createBug` if heuristic says Bug).

## Reference

- `.claude/rules/meta-workflow.md` — full Bug-vs-Retro-vs-Task triage + "Dedupe before create"
- `mcp__plugin_dev-tasks_dev-tasks__createRetro` / `updateRetro` / `listRetros`
- `auto-file-followup-nudge.sh` — hook surfacing retro-file nudges
