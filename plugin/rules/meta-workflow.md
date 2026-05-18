# Meta-Workflow Tooling

When the agent files improvements to its own workflow tooling (hooks, skills, rules, MCP tools). Loaded on demand when hitting a tooling friction point.

## TL;DR

You hit friction in a hook / skill / rule / MCP tool during normal work. File it.

| Symptom | Board | Tool |
|---|---|---|
| Broken (wrong behavior, hard error) | **Bugs Queue** (5091706353) | `mcp__plugin_dev-tasks_dev-tasks__createBug` |
| Noisy but correct (UX, ergonomics, edge case) | **Retrospectives** (`Improve`) | `mcp__plugin_dev-tasks_dev-tasks__createRetro` |
| Missing capability in MCP | **Tasks Backlog** (workflow-tooling epic) | `mcp__plugin_dev-tasks_dev-tasks__createTask` |
| Cross-cutting rule needing alignment | **Retrospectives** (`Discussion`) | `mcp__plugin_dev-tasks_dev-tasks__createRetro` |

**File autonomously** (no user gating) when: observed this session + not a 5-line obvious fix + includes concrete reproduction (PR / turn / what triggered it).

**Bug vs Retro heuristic**: *"if I left this alone, would the system produce wrong output for a real user?"* — Yes → Bug. No → Retro.

## When to apply

Friction in the workflow tooling itself (hooks firing wrong, skills not matching behavior, rule contradictions, MCP tool errors, manual workarounds the user keeps compensating for). Not for product bugs (those go to Bugs Queue against the product) or new feature work (normal Tasks pipeline).

## Specific triggers — file immediately

| Trigger | What to file |
|---|---|
| You write `/tmp/.claude-ci-ack-*` to acknowledge CI failure as flake | Bug with suite name + error excerpt + root-cause hypothesis |
| MCP tool error indicating its own bug (stale field names, schema mismatch) | Bug against MCP / Internal Tooling |
| `gh run rerun --failed` >1x on same suite | Bug — flake confirmed repeating |
| Hook fires when it shouldn't, OR misses something it should | Bug if broken / Retro `Improve` if noisy-but-correct |
| Self-review surfaces a finding OUTSIDE this PR's diff | Retro or Task — do NOT fix in current PR |
| Dead code, stale config, deprecated patterns spotted while editing | Retro `Improve` or Task |
| Skill output doesn't match its description | Bug against the skill |
| Manual workaround applied (raw `gh api`, direct SQL) where helper should exist | Retro `Improve` |
| TODO comment in code outside this PR's scope | Task (if scoped) or Retro (if open-ended) — file before commit |
| Pattern divergence between two areas of the codebase | Retro `Discussion` for team alignment |
| Clear improvement (>10 lines or contract change) outside current scope | Task under appropriate epic |

`.claude/hooks/auto-file-followup-nudge.sh` (PostToolUse) surfaces non-blocking nudges for common patterns (CI ack writes, `gh run rerun --failed`, `git revert`). Safety net; discipline is primary.

## When to fix inline instead

All three must apply:

1. Fix is <10 lines
2. Doesn't change a workflow contract (hooks, skill phases, rule semantics)
3. Doesn't need user approval (no security boundary, no spend implications)

Typo in skill comment → fix inline. Hook silencing rule → file as retrospective.

## Dedupe before create — universal rule

**Always search before any `create*` MCP tool.** Duplicates split owner attention.

| Creating | Dedupe call | Filter |
|---|---|---|
| Task (`createTask`) | `getBacklog({ query, productId })` | name + description keyword, scoped to product |
| Bug (`createBug`) | `getBugs({ search, productId })` | name + description keyword |
| Retro (`createRetro`) | `listRetros({ activeSprint: true, search })` | scope to current sprint by default |
| Feedback (`createFeedback`) | `listFeedback({ search, productId })` | name + description keyword |
| Epic (`createEpic`) | `listEpics({ productId })` then filter client-side | no server-side text search yet |
| Version (`createVersion`) | `listVersions({ search, productId })` | versionNumber + name |

Triage results:

- **Exact-name match** → stop. Update or comment on existing.
- **>50% keyword overlap + same scope (epic/product/sprint)** → near-duplicate. Default to enriching existing; surface both to user.
- **No match** → proceed.

**Cross-surface check** — same friction can land in wrong queue. Order: "produces wrong output for a real user?" YES = Bug, NO continue → "workflow/tooling friction?" Retro → "stakeholder input or feature request?" Feedback (`createFeedback`; `/triage-feedback` routes later) → "missing capability needing a sprint slot?" Task. If two queues fit: file in most authoritative (Bug > Task > Retro > Feedback), cross-link.

## After-filing follow-through

- Reference filed item ID in conversation summary
- If `Improve` with `Repeating: true`, mention "this is the Nth time we've hit this; tracking on retro #X"

## Anti-patterns

- Filing the same friction twice — search the target board first.
- Filing speculative future-friction — only file what was actually hit this session.
- Filing instead of fixing — if it meets inline-fix criteria, fix it.
- Mixing categories — broken AND noisy = two items (one bug, one retro).
- Skipping dedupe to save time — every "save time" dupe costs 10x at reconciliation.
