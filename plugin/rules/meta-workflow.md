# Meta-Workflow Tooling

> **Reference rule** — describes when and how the agent files improvements to
> the agent's own workflow tooling (hooks, skills, rules, MCP tools). Loaded
> on demand when the agent encounters a tooling friction point during normal
> work.

## TL;DR

You hit friction in a hook / skill / rule / MCP tool during normal work. File it:

| Symptom | Board | Tool |
|---|---|---|
| Broken (wrong behavior, hard error) | **Bugs Queue** | `mcp__plugin_dev-tasks_dev-tasks__createBug` |
| Noisy but correct (UX, ergonomics, edge case) | **Retrospectives** (`Improve`) | `mcp__monday__create_item` |
| Missing capability in MCP | **Tasks Backlog** (workflow-tooling epic) | `mcp__plugin_dev-tasks_dev-tasks__createTask` |
| Cross-cutting rule needing alignment | **Retrospectives** (`Discussion`) | `mcp__monday__create_item` |

**File autonomously** (no user gating) when: observed this session + not a 5-line obvious fix + includes concrete reproduction (PR / turn / what triggered it).

**Bug vs Retro heuristic:** *"if I left this alone, would the system produce wrong output for a real user?"* — Yes → **Bug**. No → **Retro**.

## When to apply

Use this rule when **you, the agent, encounter friction in the workflow tooling itself** during normal task execution. Concretely:

- A hook fires when it shouldn't (false positive)
- A hook misses something it should catch (false negative)
- A skill's instructions don't match the actual behaviour it produces
- A rule contradicts another rule, or both contradict observed code
- An MCP tool returns ambiguous data, missing fields, or unexpected errors
- A repeated workflow has obvious structural improvement that the user keeps having to manually compensate for

Do **not** apply this rule for product bugs (those go in the Bugs Queue board) or for new feature work (those go through the normal Tasks board pipeline).

## Where to file

| Friction type | Board | Why |
|---|---|---|
| Hook / skill / rule **broken** (wrong behaviour, hard error) | **Bugs Queue** (5091706353) — `mcp__plugin_dev-tasks_dev-tasks__createBug` with `productId` for "Internal tooling" | Bug semantics: it does the wrong thing |
| Hook / skill / rule **noisy or rough but correct** (UX improvement, ergonomics, edge-case polish) | **Retrospectives** (5091706350) — `mcp__monday__create_item` with `status: 'Improve'` and `check: 'true'` if the issue keeps recurring | Retro semantics: it works, but could be better |
| MCP tool **missing capability** that would unlock further automation | **Tasks Backlog** (existing pipeline) under the workflow-tooling epic | Feature work |
| Cross-cutting workflow rule that needs team alignment | **Retrospectives** as `Discussion` type | Needs vote / discussion |

## How to file (autonomously, no human gating)

The agent **may file these autonomously** without asking the user, as long as:

1. The friction was **actually observed** in this session (not speculative)
2. The fix is **NOT** a no-brainer the agent could ship in 5 lines (those just get fixed in the current PR)
3. The filed item includes a **concrete reproduction** (which PR / which turn / what the user typed) so a future maintainer doesn't have to reconstruct it

## Bug vs Retro decision heuristic

Ask: *if I left this alone, would the system produce wrong output for a real user?*

- **Yes** → Bug (file via `mcp__plugin_dev-tasks_dev-tasks__createBug`)
- **No, but it makes the agent or user's work harder** → Retrospective (`mcp__plugin_dev-tasks_dev-tasks__createRetro`)
- **No, but it's a missing capability** → Task (`mcp__plugin_dev-tasks_dev-tasks__createTask`)

## Specific triggers (file immediately when these happen)

Concrete observable signals — when ANY of these fire, **stop and file** before continuing other work. Mirrors the trigger list in memory `feedback_auto_file_retros.md` for redundancy.

| Trigger | What to file |
|---|---|
| You write `/tmp/.claude-ci-ack-*` to acknowledge a CI failure as flake | **Bug** with suite name + error excerpt + root-cause hypothesis |
| An MCP tool returns an error indicating its own bug (stale field names, schema mismatch) | **Bug** against the MCP / Internal Tooling |
| `gh run rerun --failed` called >1x on the same suite | **Bug** — flake is confirmed repeating |
| A hook fires when it shouldn't, OR misses something it should | **Bug** if broken / **Retro `Improve`** if noisy-but-correct |
| Self-review surfaces a finding OUTSIDE this PR's diff | **Retro** or **Task** — do NOT fix in the current PR |
| Dead code, stale config, deprecated patterns spotted while editing | **Retro `Improve`** or **Task** |
| A skill's output doesn't match its description | **Bug** against the skill |
| You apply a manual workaround (raw `gh api`, direct SQL, etc.) where a helper should exist | **Retro `Improve`** |
| You write any TODO comment in code (other than this PR's scope) | **Task** (if scoped) or **Retro** (if open-ended) — file **before** commit |
| Pattern divergence between two areas of the codebase | **Retro `Discussion`** for team alignment |
| Clear improvement opportunity (>10 lines or contract change) outside current scope | **Task** under appropriate epic |

The `.claude/hooks/auto-file-followup-nudge.sh` PostToolUse hook surfaces a non-blocking nudge for the most common patterns (CI ack writes, `gh run rerun --failed`, `git revert`). The hook is a safety net — the discipline is primary.

## When to fix inline instead of filing

If ALL three apply, fix inline in the current PR/branch:

1. The fix is **<10 lines**
2. The fix doesn't change a workflow contract (hooks, skill phases, rule semantics)
3. The fix doesn't need user approval (no security boundary changes, no spend implications)

Example: a typo in a skill comment → fix inline.
Example: a hook silencing rule → file as retrospective (changes contract, needs alignment).

## After-filing follow-through

- Reference the filed item ID in the conversation summary so the user knows where to find it
- If the filed item is `Improve` with `Repeating: true`, mention "this is the Nth time we've hit this; tracking on retro #X" so the user can prioritise

## Anti-patterns

- **Filing the same friction twice** — search the target board first via `mcp__monday__search` before creating
- **Filing speculative future-friction** — only file what was actually hit in this session
- **Filing instead of fixing** — if it's a 3-line fix and meets the inline-fix criteria, fix it. Filing creates backlog noise.
- **Mixing categories** — a hook that's both broken AND noisy gets two items: one bug for the broken behaviour, one retro for the noise.

## When this rule is loaded

- Agent encounters a hook firing repeatedly with no actionable outcome
- Agent finds a skill instruction that doesn't match observed behaviour
- User explicitly asks "how should we file this?" or "would this be better in a different board?"

## Example: the 2026-05-09 stop-hook noise filing

During the Observability v1 rollout, the `stop-task-check.sh` and `stop-ci-green-check.sh` hooks fired 6–15 times per PR with identical "BLOCKED: …" messages while a Monitor was actively waiting for the bot review. The hooks were correct (they enforce the review-addressed gate); the noise was the friction. Filed as Retrospective #2903271952 with `Improve` + `Repeating`. NOT filed as a bug because nothing was broken.
