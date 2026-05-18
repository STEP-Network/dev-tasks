# Agent Coordination — Subagents vs Agent Teams

## TL;DR

- **Subagents** (default): N independent workers; each reports to parent. No inter-agent comm. Lower token cost.
- **Agent Teams** (`TeamCreate` + `team_name`): agents in a namespace `SendMessage` each other directly + share `~/.claude/tasks/<team-name>/`. 3–7× higher token cost. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

**Decision rule**: does inter-agent communication add value? If you'd write "Agent A SendMessages Agent B when X" in a brief, use a Team. Else subagents.

| | Subagents | Agent Teams |
|---|---|---|
| Communication | Parent ↔ each agent only | Direct agent ↔ agent + shared task list |
| Coordination | Parent manages all work | Self-coordinate via task claims |
| Token cost | Lower | 3–7× higher |
| Setup | `Agent({ run_in_background: true })` | `TeamCreate({ team_name })` + `Agent({ team_name, name })` |
| Best for | Fan-out research, independent slices, single-task workers, cost control | Cross-cutting refactors, debugging with competing hypotheses, parallel reviews with peer challenge |

## Use subagents when

- N independent tasks, each self-contained
- Parent is the only coordination point
- Side-quest research that would flood parent context
- Verification / self-review of parent's work
- Cost optimization (Haiku-routed cheap delegation)

## Use Agent Teams when

- Multiple agents need to share intermediate state
- Lead needs to spawn its own sub-team (recursive coordination)
- Debugging with competing-hypotheses challenge (breaks anchoring bias)
- Cross-layer work sharing a task list
- Audit trail value — task list at `~/.claude/tasks/<team>/` persists

## Anti-patterns

- **Agent Teams for tightly-coupled work** — sub-team collides on the same files. Cost > benefit.
- **Subagents sharing state via main checkout** — always give each subagent its own worktree (`git worktree add` in brief, `Agent({ isolation: 'worktree' })`, or Team coordination).
- **Promoting a teammate to lead** — not supported. Lead is fixed for team lifetime.
- **Teammates spawning teams** — not supported. Only the lead spawns sub-teams.
- **Forgetting to enable** — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` required.
- **One Team has one lead** — the creating session. Use subagents for multiple orchestrators.

## Sizing

- **Subagents**: 1–6 parallel is fine. >6 → parent coordination becomes bottleneck.
- **Agent Teams**: 3–5 teammates is the sweet spot. 5–6 tasks per teammate. Start with research/review tasks if new.

## Project-specific patterns

- **`/pickup-task` doesn't compose cleanly with subagents** — `EnterWorktree` refuses inside subagent isolation (retro #2914513289). Workarounds: brief subagent to manually `git worktree add` + use absolute paths, OR `Agent({ isolation: 'worktree' })`, OR brief subagent to skip `/pickup-task` and use direct MCP calls (`claimTask`, `manageSubtasks`).
- **Per-task isolation non-negotiable** — every spawned worker gets its own worktree. Brief explicitly: "`git worktree add .claude/worktrees/feat-<slug>` BEFORE any other action."
- **Auto-merge to staging gate is the trust boundary** — sub/team agents shipping PRs are authorized to auto-merge after CI green + Corridor clean + bot review addressed.

## Sources

- [Subagents — code.claude.com](https://code.claude.com/docs/en/sub-agents)
- [Agent Teams — code.claude.com](https://code.claude.com/docs/en/agent-teams)
- Retros: #2914513289, #2915512068
