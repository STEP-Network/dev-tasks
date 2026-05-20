---
name: investigate-request
description: Pre-mutation investigation of any incoming request — finds related work, in-flight overlap, and ambiguity before a task is created, refined, or claimed
user_invocable: true
---

# /investigate-request — Pre-Mutation Investigation

Tasks decay. Tasks duplicate. Agents collide on the same file scope. This skill runs a read-only investigation before any task-mutating action so the agent (or human caller) sees duplicate-or-near-duplicate existing work, recently-merged PRs that may have shipped the work already, in-flight agents touching the same file scope, and ambiguity that needs a human decision.

Output is structured markdown with explicit **BLOCKING** vs **OPTIONAL** open questions. Calling skills MUST resolve BLOCKING questions via `AskUserQuestion` before any Monday write.

## Modes

| Mode | When | Focus |
|---|---|---|
| `--mode=dedup` | Filing time (called by `/create-task`; usable by future `/file-bug`, `/file-retro`, `/triage-feedback`) | "Is this new, or does it duplicate existing work? Any in-flight agent on the same scope? Has this been silently shipped recently?" |
| `--mode=relevance` | Refine/claim time (called by `/refine-task`, `/pickup-task`) | "Has anything shifted since this task was filed? Are subtask file paths still valid? Has a related PR partially or fully shipped this?" |

If `--mode` is omitted, infer from context: `--taskId=<N>` present → relevance; otherwise → dedup.

## Tool surface

Delegate the actual investigation to a `dev-tasks:codebase-researcher` subagent (existing read-only agent: Read / Glob / Grep / Bash / WebSearch). The subagent must NOT call any Monday-write MCP tool or use Edit/Write. The skill's job is to assemble the subagent prompt + parse the report — no new tool surface introduced.

Reads issued by the subagent:
- `getBacklog({ query, productId })` × 3–5 keyword strategies
- `listVersions({ search, productId })` for recently-shipped checks
- `listEpics({ productId })` when epic context is unclear
- `gh pr list --state merged --search "<keywords>" --limit 20` for recent merges
- `gh pr list --state open` for in-flight overlap (cross-reference with `getTask` on claimed items)
- `Grep` / `Glob` over the codebase for likely-affected files

## Time budget

Default `--depth=standard` ~60–90s. Override via `--depth=quick` (~30s; one keyword strategy, no PR cross-check) or `--depth=deep` (~3–5min; all strategies + cross-cutting analysis across multi-item requests).

## Workflow

1. **Parse input.** Decompose multi-item requests (paragraph boundaries, `Also:` / `And:` / numbered list separators, distinct-entity boundaries). Investigate each independently and emit one block per item. If item-boundaries are unclear, default to one item.
2. **Extract search inputs** per item:
   - **Entities** (e.g. "publisher", "country picker", "place-autocomplete")
   - **Verbs** (e.g. "validate", "cascade", "filter")
   - **File hints** (paths or component names mentioned)
3. **Run searches in parallel**:
   - 3–5 `getBacklog` queries with different keyword strategies (entities-only, verbs+entities, file-path stems)
   - `gh pr list --search` for merged (last 14 days) + open PRs
   - `Grep`/`Glob` over the codebase for likely-affected files
4. **Synthesize**: build the report sections (Related / Files / In-flight / Recent merges / Recommendation / Open questions / Recall caveat).
5. **Apply BLOCKING/OPTIONAL heuristic** to open questions (see below).
6. **Emit markdown** in the exact schema below. Don't omit sections — write `none` if empty.

## Output schema

```markdown
## Investigation report

### Item N: <one-line summary of the request item>

#### Related existing tasks
- #<id> "Title" — <Status> — <one-line note on overlap>
- (or: none found via [k1, k2, k3] queries)

#### Likely-affected files
- `path/to/file.tsx` — <why relevant>
- (or: none identified)

#### In-flight overlap
- PR #<n> (agent <name> / branch <branch>) — touching same file scope — coordinate via rebase or sequencing
- (or: none)

#### Recent merges possibly explaining the symptom
- PR #<n> (merged YYYY-MM-DD) — changed Y; possibly the cause / partial fix / regression
- (or: none in last 14 days matching keywords)

#### Recommendation
NEW task — priority <X>, epic <Y>, proposed scope: ...
- OR -
REFINE existing #<n> — proposed additions: ...
- OR -
SKIP — already covered by #<n> (PR #<m>) — no action needed
- OR -
DECLINE — task is superseded / no longer relevant — propose status: Declined with rationale <...>
- OR -
ROUTE — this should be a Bug / Feedback / Retro instead of a Task — suggested target: `createBug` / `createFeedback` / `/dev-tasks:file-retro` with rationale

#### Open questions for human

**BLOCKING** (must answer before any Monday write):
- <question 1>
- <question 2>

**OPTIONAL** (will proceed with default if unanswered; flagged for visibility):
- <question 3> — defaulting to <X>

(or: none — proceed with recommendation as-is)

#### Recall caveat
Searched [<keyword strategy 1>, <strategy 2>, <strategy 3>]. Closed-task and bug-board items not searched in this pass. Semantic dupes with different wording may not appear.
```

## BLOCKING vs OPTIONAL heuristic

A question is **BLOCKING** when both hold:
- No reasonable default can be derived from the input, task body, or codebase state, AND
- Choosing wrong costs more than the ask-friction (≥ 30 min of wasted work to undo, or affects a downstream task / PR / shipped behavior)

A question is **OPTIONAL** when both hold:
- A sensible default exists, AND
- Choosing wrong is cheap to reverse later (priority level, exact phrasing, included-as-subtask vs folded-into-description)

**Derive the answer first; ask only if derivation needs guessing.** Read code, git log, task body, and recent PR descriptions before classifying as BLOCKING. Lazy asking is worse than wrong-defaulting — it trains the user to ignore the prompt.

**BLOCKING examples** (real ambiguity the agent can't resolve):
- "Investigation found 3 tasks that could be the home — which is correct?"
- "Task was filed 6 weeks ago citing a function renamed in PR #X — re-refine to current code, or decline as superseded?"
- "Two open tasks describe overlapping symptoms with different framing — merge into one or keep both?"
- "AC mentions a deprecated library — work around the deprecation or update the AC?"

**OPTIONAL examples** (sensible defaults exist):
- "Priority Low vs Medium?" — default to Medium for non-regression Improvements
- "Subtask included vs folded into description?" — default to subtask if estimate ≥ 0.5h
- "Which epic exactly?" — default to keyword match if confidence ≥ 80%, mention which

## Skip cases per calling skill

The **calling skill** is responsible for the skip-case check. If skipped, this skill is not invoked at all (no half-investigation).

| Caller | Skip when | Rationale |
|---|---|---|
| `/create-task` | Caller arg explicitly cites a Monday task/PR/retro ID (regex `/#\d{7,10}\b|PR\s*#\d+|retro\s*#\d+/i`) | The human has already done the dedup work |
| `/refine-task` | `now - task.updatedAt < 24h` AND `git log origin/$defaultBase --since=task.updatedAt --count` returns 0 | No time for drift |
| `/pickup-task` | `now - task.updatedAt < 24h` AND `git log origin/$defaultBase --since=task.updatedAt --count` returns 0 | Matches existing Phase 15 trigger logic |

`task.updatedAt` resolves to Monday's `last_updated` column on the Tasks board (`pulse_updated_mm0nzv8y` — also surfaced as `updatedAt` in `getTask`'s JSON response). It's the timestamp of the most recent column write — any refinement, status change, or comment touches it.

Skip cases are objective. If the calling skill skips and the agent still wants an investigation, it can invoke `/investigate-request` manually with explicit input.

## Caller integration contract

When invoked from `/create-task`, `/refine-task`, or `/pickup-task`, the caller MUST:

1. Check the skip case for its context. If skip → proceed to existing phases.
2. Otherwise invoke `/investigate-request --mode=<dedup|relevance> [--taskId=<N>]` with the relevant input.
3. Read the report.
4. **Recommendation handling**:
   - `SKIP` → abort. Surface report to user. Do not perform Monday write.
   - `DECLINE` → use `AskUserQuestion` to confirm: "decline as superseded, or claim anyway?" Then act.
   - `REFINE #N` (for `/create-task`) → redirect to `/refine-task <N>`.
   - `NEW task` or proceed-with-refine/claim → continue to step 5.
5. For each **BLOCKING** question: use `AskUserQuestion` BEFORE any Monday-mutating MCP call (`createTask`, `manageSubtasks`, `updateTask` field-write, `claimTask`). Wait for the answer. Inform the subsequent action with the answer.
6. **OPTIONAL** questions: include in the proceed-message ("Defaulting priority to Medium; flag if wrong") but do not gate action.

A skill that calls a Monday-mutating tool while a BLOCKING question is unresolved violates the contract — surface as a self-review FAIL on Check #9 (Docs / Workflow).

## Standalone invocation

The skill is composable. Invoke directly to investigate any incoming request (Slack drop, CI flake observation, retro find):

```text
/investigate-request --mode=dedup "place-autocomplete allows invalid house numbers, falls back to street silently"
/investigate-request --mode=relevance --taskId=2926684317
/investigate-request --mode=dedup --depth=quick "minor copy tweak on settings page"
```

## Worked examples

See [`EXAMPLES.md`](./EXAMPLES.md) for two full input → output walkthroughs (place-autocomplete dedup, validate-sponsor refine-time relevance).

## Constraints

- **Read-only.** No Edit/Write/Monday-write. `Bash` via `gh` CLI is read-only by convention.
- **Time-bounded.** Default ~60–90s; cap via `--depth=quick`.
- **Composable.** Calling skills chain it via Phase 0; usable standalone.
- **Honest recall.** The report includes a self-reported recall caveat. Lexical search misses semantic dupes — say so.
- **No half-investigation.** If a skip case fires, the calling skill skips entirely. If invoked, run full standard depth unless `--depth=quick`.
- **Emit once, complete.** Not a Monitor-style streaming pattern — one assembled report.

## Anti-patterns

- **Asking the human when the answer is in git log** — derive first.
- **Marking everything as BLOCKING** — defeats `autonomous-by-default`. Reserved for "agent cannot proceed without a human decision."
- **Skipping because the agent is confident** — confidence is not a skip case. Only the objective skip cases qualify.
- **Returning a recommendation without the open-questions section** — even if empty, write `none — proceed with recommendation as-is`.
- **Overstating recall** — never say "no duplicates exist." Say "no duplicates found via these queries; semantic dupes may not appear."

## Cross-references

- `plugin/rules/autonomous-by-default.md` — the "Missing context the agent can't derive" carve-out points here as the concrete pattern.
- `plugin/skills/create-task/SKILL.md` Phase 0 — dedup-mode invocation contract.
- `plugin/skills/refine-task/SKILL.md` Phase 0 — relevance-mode invocation contract.
- `plugin/skills/pickup-task/SKILL.md` Phase 0 — relevance-mode invocation contract.
- `plugin/rules/critical-thinking.md` — pushing back on a wrong proposal (different from asking for missing context).
