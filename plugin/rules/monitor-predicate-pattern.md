# Monitor Predicate Pattern

How agents use Claude Code's `Monitor` tool to watch shell commands without flooding the conversation with heartbeats or stalling action when the watched state arrives.

`Monitor` runs a shell command on an interval and turns each stdout line into a notification. The agent constructs the command body — including what to echo and when — so the agent controls emission cadence. Two patterns govern good usage.

## Pattern 1: Emit on state transitions, not on every poll tick

A command that echoes status on every tick — instead of only when status CHANGES — produces one notification per poll cycle for the entire duration the matching state holds. Each notification is one agent turn the next time the session resumes.

**Why it matters:** every emission consumes an agent turn and roughly one context budget unit. A 10-minute CI run polled every 30s emits 20 unnecessary heartbeats if not gated by transition. Across many concurrent PRs and many sessions, this compounds into real wasted context and observable "Routine progress" spam.

**The rule:** keep a `last_seen` variable inside the Monitor body; emit only when current state differs.

```bash
# Bad — Monitor sees a new line every poll, even when nothing changed
while sleep 30; do
  gh pr checks $N --json state | jq -r '[.[].state] | unique | join(",")'
done

# Good — Monitor sees a new line only when state changes
last=""
while sleep 30; do
  state=$(gh pr checks $N --json state \
    | jq -r 'if any(.[].state; . == "FAILURE") then "FAILURE_ANY"
             elif all(.[].state; . == "SUCCESS") then "SUCCESS_ALL"
             else "IN_FLIGHT" end')
  if [ "$state" != "$last" ]; then
    echo "transition: ${last:-<init>} → $state"
    last=$state
    case "$state" in FAILURE_ANY|SUCCESS_ALL) break;; esac
  fi
done
```

Initialize `last=""` (not the current latest). Seeding with the current value waits for a SECOND transition that may never come — see `plugin/skills/babysit-prs/SKILL.md` "Polling pattern" for the same point applied to PR comments.

Most CI predicates only need three meta-states: in-flight, all-success, any-failure. Collapsing per-check status into one of these three keeps transitions sparse.

## Pattern 2: Act in the same response as the success emission

When the Monitor fires the terminal state the agent was waiting for, the next tool call must be in the SAME assistant response — no narrative paragraph in between.

**Why it matters:** narrative interludes between async-wait-end and the action that wait was for cause user-perceived lag. A user watching this lag will manually take the action (merge the PR themselves), defeating the autonomous merge path entirely. The lag has no upside — Monitor already verified the precondition; restating it in prose adds no information.

**The rule:** when the Monitor result indicates the predetermined terminal state, the tool call follows immediately. Brief 1-line acknowledgment is fine. Paragraphs are not.

```
# Bad
Monitor → "transition: IN_FLIGHT → SUCCESS_ALL"
Agent (response 1): <2 paragraphs explaining CI status>
Agent (response 2): gh pr merge $N --admin --squash

# Good
Monitor → "transition: IN_FLIGHT → SUCCESS_ALL"
Agent (response 1, single message):
  "CI green. Merging." + gh pr merge $N --admin --squash
```

This applies symmetrically to failure: Monitor fires `FAILURE_ANY` → next tool call fetches the failed log (`gh run view --log-failed`), no preamble.

## Anti-patterns

- **Heartbeat narration** — narrating each poll tick when nothing changed ("still waiting..." × 6). If there is nothing new, say nothing.
- **Verbose narration after async wait** — restating what Monitor reported before acting on it. Monitor already reported it.
- **Wait-for-confirmation between wait-end and predetermined action** — if the action was predetermined by the skill (e.g. `/ship-pr` Phase 6.6 merges on green), do it. Don't ask the user "should I merge now?" — the autonomous policy already said yes.
- **Seeding `last_seen` with current state** — waits for a SECOND transition. Init to empty so the first tick fires if terminal state is already present.
- **Predicate that echoes identical strings on every tick** — gate by transition, not by match.

## Cross-references

- [`agent-autonomy.md`](./agent-autonomy.md) — when async waits + autonomous merges apply, and the Stuck criterion that overrides them.
- [`ship-readiness.md`](./ship-readiness.md) — triaging the Monitor result when it surfaces a review BLOCKER vs ship-as-is.
- `plugin/skills/babysit-prs/SKILL.md` "Polling pattern" — concrete Monitor usage in the orchestrator merge loop.
- `plugin/skills/ship-pr/SKILL.md` Phase 6 — autonomous merge path that depends on Monitor terminal-state detection.

## Related retros

Sourced from PolAds dogfood retros:

- **#2903271952** — Reduce stop-hook noise during async-wait turns (broader scope; this rule covers the Monitor-emission half).
- **#2922322888** — babysit-prs Monitor predicate misses "Ship as-is" verdict (predicate match correctness — orthogonal to emission cadence).
- **#2922909374** — babysit-prs Monitor predicate matches "🔴 BLOCKER" inside "No 🔴 BLOCKERs".
- **#2923135874** — babysit-prs Monitor predicate misses BLOCKER without 🔴 emoji.
- **#2927918762** — babysit-prs Monitor: heartbeat re-emission + agent action-lag after green (this rule's direct source).
