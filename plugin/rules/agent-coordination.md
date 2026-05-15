# Agent Coordination — Subagents vs Agent Teams

> **Reference rule** — when to use the `Agent` tool (subagents) vs `TeamCreate` (Agent Teams). Loaded on demand when spawning >1 parallel worker, or when hitting coordination friction.

## TL;DR

- **Subagents** (default): you spawn N independent workers, each reports back to you (parent). They cannot talk to each other. Lower token cost.
- **Agent Teams** (`TeamCreate` + `team_name`): you create a team namespace; agents in it `SendMessage` each other directly + share a task list at `~/.claude/tasks/<team-name>/`. 3–7× higher token cost. Experimental — requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json or env.

**Decision rule: does inter-agent communication add value?** If you'd write "Agent A SendMessages Agent B when X" in a brief, use a Team. If A and B genuinely don't need to know about each other, use subagents.

| | Subagents | Agent Teams |
|---|---|---|
| Communication | Parent ↔ each agent only | Direct agent ↔ agent + shared task list |
| Coordination | You (parent) manage all work | Self-coordinate via task claims |
| Token cost | Lower (results summarized back) | 3–7× higher (each teammate is a full Claude instance) |
| Setup | `Agent({ run_in_background: true })` | `TeamCreate({ team_name })` + `Agent({ team_name, name })` |
| Best for | Fan-out research, independent feature slices, single-task workers, cost control | Cross-cutting refactors, debugging with competing hypotheses, FE+BE+tests slices that share context, parallel reviews with peer challenge |

## Use subagents when

- N independent tasks, each self-contained (one Monday task per agent)
- Parent (you, the main session) is the only coordination point needed
- Side-quest research that would flood parent context (file reads, codebase exploration)
- Verification / self-review of work parent already did
- Cost optimization (delegate cheap work to Haiku-routed subagents)

**Project examples**: Phase 1 four-way fan-out (WS-1A/B/C/D), Phase 2 wave 1 three-way fan-out (Checkly + PostHog + Corridor auto-file). Each agent owned its own Monday task in its own worktree.

## Use Agent Teams when

- Multiple agents need to share intermediate state ("I just merged the contract; you can rebase now")
- Lead needs to spawn its own sub-team (recursive coordination)
- Debugging where agents test competing hypotheses + challenge each other (forced adversarial structure breaks anchoring bias)
- Cross-layer work that shares a task list (research/review on N angles of one problem)
- Audit trail value — the task list at `~/.claude/tasks/<team>/` persists as a record

**Project example**: Phase 3 of epic #2914328299. Team created but lead chose **work alone** (Option A) — confirmed the masterplan's "tightly coupled" prediction. Useful lesson: sometimes the right Agent-Teams decision is "don't spawn a sub-team."

## Anti-patterns

- **Agent Teams for tightly-coupled work** — Phase 3 was tightly coupled on `lib/webhooks/{contract,dedup,monday-close-handler}.ts`; sub-team would have collided on the same files. Cost > benefit.
- **Subagents that share state via main checkout** — Phase 2 wave 1 had 2 subagents accidentally race on main checkout's `.claude/active-task.json` (retro #2915512068). **Always** give each subagent its own worktree: either explicit `git worktree add` in the brief, OR `Agent({ isolation: 'worktree' })`, OR a Team where coordination is explicit.
- **Promoting a teammate to lead** — not supported. Lead is fixed for team's lifetime.
- **Teammates spawning their own teams** — not supported. Only the lead manages the team. Sub-teams require the lead to spawn them directly.
- **Forgetting to enable** — if `TeamCreate` errors, check `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set.
- **One Team can only have one lead** — the session that creates the team is the lead. Use subagents if you want multiple independent orchestrators.

## Sizing

- **Subagents**: 1–6 in parallel is fine. >6 → parent coordination becomes the bottleneck; either batch the work or switch to Agent Teams.
- **Agent Teams**: 3–5 teammates is the sweet spot per official docs. 5–6 tasks per teammate keeps everyone productive. Start with research/review tasks if new to Teams (clear boundaries, no file conflicts).

## Project-specific patterns (this codebase)

- **`/pickup-task` doesn't compose cleanly with subagents** — `EnterWorktree` refuses inside subagent isolation (retro #2914513289). Workarounds: (a) brief instructs subagent to manually `git worktree add` + use absolute paths, OR (b) use `Agent({ isolation: 'worktree' })` to let the harness create the worktree, OR (c) brief the agent to skip `/pickup-task` and use direct MCP calls (`claimTask`, `manageSubtasks`).
- **Per-task isolation is non-negotiable** — every spawned worker MUST get its own worktree. Sharing main checkout races on `.claude/active-task.json` AND working-tree state. Brief every subagent explicitly: "`git worktree add .claude/worktrees/feat-<slug>` BEFORE any other action."
- **Auto-merge to staging gate is the trust boundary** — sub/team agents that ship PRs are authorized to auto-merge after CI green + Corridor clean + bot review addressed (per CLAUDE.md). No human approval step; you stay in control via the dashboard + Stop hooks.

## When this rule is loaded

- Before spawning >1 parallel agent for the same epic
- When deciding between `Agent` and `TeamCreate`
- After hitting a coordination friction (retros: [#2914513289](https://stepas.monday.com), [#2915512068](https://stepas.monday.com))
- When debugging Agent Team failures (resume/rewind issues, orphaned tmux sessions)

## Sources

- [Subagents — code.claude.com](https://code.claude.com/docs/en/sub-agents)
- [Agent Teams — code.claude.com](https://code.claude.com/docs/en/agent-teams)
- [Features overview compare](https://code.claude.com/docs/en/features-overview#compare-similar-features)
- Session experience 2026-05-13/14 (epic #2914328299: 11 PRs, 5 subagent collisions recovered, 1 Team-Lead Option-A decision)
