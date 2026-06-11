# dev-tasks plugin

**Scope**: a Claude Code plugin for STEP Network products using Monday.com + GitHub + Node/TS + pnpm + Vercel. The plugin assumes one shared Monday workspace, one GitHub org (STEP-Network), and one deployment platform (Vercel). It is intentionally **not** a generic dev-tasks plugin — it encodes STEP-Network conventions.

For non-STEP projects, this plugin will fail at first contact (hard-coded board IDs, status enums, etc.). That's by design — abstracting further would dilute what makes it useful inside STEP.

## What ships

- **MCP server** — 44 stdio tools wrapping Monday's GraphQL API (backlog, tasks, sprints, epics, bugs, versions, products, feedback, retros, public roadmap, structured changelog, UAT docs, version timeline).
- **Skills (15)** — workflow: `pickup-task`, `create-task`, `refine-task`, `log-progress`, `self-review`, `ship-pr`, `release-version`, `audit-versions`, `doctor`; posture: `holistic-thinking`, `production-quality-ownership`, `design-consistency`, `triage-feedback`, `goal` (persistent completion condition — see below); orchestration: `babysit-prs`. Invoked as `/dev-tasks:<skill>`.
- **Rules (9)** — auto-injected on Edit/Write via the `rule-autoload.sh` PreToolUse hook based on file globs in `rules-routing.json`.
- **Agents (4)** — `codebase-researcher`, `self-reviewer`, `doc-updater`, `e2e-tester`. Spawned via subagent.
- **Hooks (34)** — STEP-wide policy hooks (always-on, non-overridable) + opt-in workflow hooks gated by `project-config.hooks.enabled[]` + always-on rule-autoload/janitor. Includes `commit-id-gate` (every commit must reference a Monday Tasks-board `#id`) and `stop-goal-persistence` (refuses premature autonomous stops while a `/goal` is unmet — see below).
- **Per-project config** — `.claude/project-config.json` validated against `schemas/project-config.schema.json`.

## Requirements

- Node.js 20+
- `MONDAY_API_KEY` exported in the shell launching Claude Code (`.mcp.json` does not interpolate env). Add to `~/.zshrc` / `~/.bashrc`:
  ```sh
  export MONDAY_API_KEY="..."
  ```
- `whoami` should map to a record on the Monday *People board (`1612664689`) — either by email local-part, person display name, or first-name. Add yourself if missing.

## Install

```sh
/plugin marketplace add STEP-Network/dev-tasks
/plugin install dev-tasks@dev-tasks-marketplace
/reload-plugins
```

(Private repo — needs `gh auth status` showing STEP-Network membership. If unavailable, clone locally and use `/plugin marketplace add /path/to/dev-tasks`.)

After install, the plugin reads `.claude/project-config.json` from each consumer project. Start from the template:

```sh
cp $CLAUDE_PLUGIN_ROOT/templates/starter-project-config.json .claude/project-config.json
```

Required fields to populate: `git.defaultBase`, `monday.productId`, `monday.v1MilestoneEpicIds`, `environments.uat.url`.

Run `/dev-tasks:doctor` after first install to verify the setup.

## STEP-wide policy (non-overridable)

These hooks run for every consumer regardless of config:

| Policy | Hook | Blocks |
|---|---|---|
| No destructive bash (incl. `--force`) | `bash-guard.sh` gate (a) | `git push --force`, `rm -rf`, `git reset --hard`, `git checkout .`, `git clean -f`, `git branch -D` |
| Self-review before commit | `bash-guard.sh` gate (b) | `git commit` when `.claude/active-task.json.selfReviewPassed != true` |
| Pre-push validation marker | `bash-guard.sh` gate (c) | `git push` without a fresh `/tmp/.claude-prepush-<branch>` marker matching HEAD |
| CI green before session exit | `stop-ci-green-check.sh` | `Stop` while a push has happened and CI is not all-green. Per-task exception (v0.26.0): the Monday "CI Gate" column (`color_mm46jxc`) at `Skip (human)` / `Skip (agent)` allows Stop on *pending/unregistered/cancelled* checks — a FAILED check still blocks. Resolution: live Monday column → `active-task.json.ciGate` mirror → Full. See CLAUDE.md "Per-task CI Gate". |

Plus the session-level expectation (not hook-enforced): always run Corridor `analyzePlan` before generating code (declared in user-level `~/.claude/CLAUDE.md`).

## Required companion plugin: Corridor

Corridor is a separate Claude Code plugin (not bundled — owned by Corridor) that provides security/regulatory static analysis. It is the **primary security layer** of the `ai-review-stack.md` framework. STEP-wide policy requires it installed alongside dev-tasks.

**Role** (per `plugin/rules/ai-review-stack.md`):
- `analyzePlan` (plan-time): scans the agent's plan for known anti-patterns before code-gen
- Per-PR scan: posts findings on the PR (BLOCKER on open critical findings — `stop-ci-green-check.sh` blocks session exit until they're fixed or POLISH-declined)
- Stop hook: session can't exit while open BLOCKER findings remain (enforced via Corridor's own hook if `CORRIDOR_BLOCKING_STOP_HOOKS=true` in env)

**Install**: per Corridor's own onboarding docs. STEP-internal: see the team onboarding doc for the marketplace path. The install adds tools under the `mcp__plugin_corridor_corridor__*` namespace:

- `analyzePlan` — call before any code-gen
- `getFindings({ cwd, state, excludeAIFalsePositives })` — fetch open findings for the current branch
- `getFinding({ findingId })` — drill into a single finding
- `updateFindingState({ findingId, state, closedReasonCategory, closedReason })` — close POLISH-declined findings (`risk_accepted` or `false_positive`)
- `createGuardrail` / `getGuardrails` / `listProjects` — for managing the project's guardrail set

**Wired into the workflow**:
- `/self-review` Check #11 — fetches findings + triages
- `/ship-pr` Step 18b — second review source alongside Vercel Agent + Claude bot
- `/dev-tasks:doctor` Check 11 — verifies the companion plugin is installed
- Global `~/.claude/CLAUDE.md` — session-level "always call analyzePlan before code-gen"

Without Corridor, those skills degrade to "Corridor unavailable" mode (still functional, but the security layer is missing). The plugin works without it; STEP policy requires it.

## Per-project config

`.claude/project-config.json` shape (see `schemas/project-config.schema.json` for the authoritative version):

For editor validation, reference the schema by its **GitHub raw URL** rather than a relative local path (a relative path breaks across consumer repo layouts, since the `dev-tasks` checkout isn't a fixed distance away):

```jsonc
"$schema": "https://raw.githubusercontent.com/STEP-Network/dev-tasks/main/plugin/schemas/project-config.schema.json"
```

Pin `main` to a release tag (e.g. `.../v0.22.1/...`) if you want validation frozen to a specific plugin version. The starter template (`templates/starter-project-config.json`) already uses this URL.

```jsonc
{
  "version": "1",
  "git": {
    "defaultBase": "staging",          // or "main" for trunk-based projects
    "hotfixBase": "main"
  },
  "monday": {
    "productId": "2723505568",         // Monday Products-board item ID
    "v1MilestoneEpicIds": ["...", "..."], // epics that gate v1.0.0; empty = no gate
    "peopleBoardId": 1612664689         // override only if not using the default STEP People board
  },
  "environments": {
    "uat": { "url": "https://test.example.com" },
    "prod": { "url": "https://example.com" }
  },
  "i18n": {                              // optional, per-product
    "enabled": false,
    "locales": [],
    "defaultLocale": "en",
    "messagesGlob": "messages/*.json",
    "parityHookMode": "block"
  },
  "ci": {
    "provider": "github-actions",
    "requiredChecks": ["build", "test", "lint"]
  },
  "rules": {
    "extraRules": []                     // additional file paths for rule-autoload to surface
  },
  "hooks": {
    "enabled": [                         // opt-in non-policy hooks
      "task-state-guard", "worktree-required", "worktree-path-boundary",
      "branch-task-match", "stop-task-check", "protect-sensitive-files",
      "pre-commit-secrets-scan", "subtask-reminder", "auto-file-followup-nudge",
      "post-merge-postmortem", "post-push-track", "post-push-review-check",
      "post-self-review", "pre-compact-task-snapshot", "user-prompt-task-context",
      "subprocess-failure"
    ]
  }
}
```

## Persistent goal — `/goal` + `stop-goal-persistence`

A project-agnostic, **persistent** analogue of Claude Code's built-in `/goal`
(v2.1.139+). It kills the failure mode where an agent in autonomous mode stops
PREMATURELY because it *thinks* the session is "too long / context-bloated /
laggy" while real session-scoped work remains — invalid, because context
auto-compacts and durable state lives in Monday + memory + the PR + git.

Two pieces:

- **`/goal` skill** — set / show / clear a natural-language completion CONDITION,
  stored in a session-scoped, gitignored marker `.claude/active-goal.json`
  (`{ goal, setAt, consecutiveBlocks, maxBlocks }`).
  - `/goal "<condition>"` (or `/goal set …`) — set the condition.
  - `/goal` (no args) / `/goal show` — print the current goal.
  - `/goal clear` — remove the marker (releases the hook cleanly).
- **`stop-goal-persistence` Stop hook** — on every Stop, if a goal marker exists
  and the condition is **unmet**, it BLOCKS the stop (exit 2) and feeds back a
  "keep working — `<next step>`" message so the agent continues. When the goal is
  **met**, it clears the marker and allows the stop.

**Evaluation.** Prefers a MODEL check when an `ANTHROPIC_API_KEY` is exported (a
fast model judges met/not-met from the goal + the recent transcript tail).
Falls back to a DETERMINISTIC check otherwise (block while the active-task
pipeline is incomplete OR claimable Ready-to-Start tasks remain in the active
sprint via the Monday API). Claude Code's OAuth sessions usually have no raw
key, so the deterministic path is the common one.

**Safety — it never traps the agent.** The hook respects the 3 legitimate pause
reasons via the existing `reviewAddressed` escape vocabulary in
`active-task.json` (`handoff-to-orchestrator` | `stuck:*` | `timeout:*` → clean
release), enforces a max-consecutive-blocks escape hatch (`maxBlocks`, default 3
— after N blocks it allows the stop and warns so a bug can't infinite-loop the
session), honors Claude Code's own `stop_hook_active` flag as a secondary guard,
and fails OPEN on every error path. `/goal clear` or a met goal releases cleanly.

**Opt-in** like the other workflow Stop hooks: add `"stop-goal-persistence"` to
`project-config.json` `hooks.enabled[]`. Silent no-op when not enabled. Even
with NO goal set, when source files changed this branch the hook surfaces a
one-time SELF-CHECK reminder on Stop (the fake-tiredness nudge), without blocking.

See `plugin/skills/goal/SKILL.md` for the full contract.

## Skill overlay convention

Each plugin skill ends with a directive to read `<consumer>/.claude/skills/<name>/SKILL.md.local` (if present) and append its content as additional project-specific instructions. **Extend-only** — overlay can append checks/steps but cannot replace plugin behavior.

### How it works

1. The plugin skill (e.g. `plugin/skills/production-quality-ownership/SKILL.md`) describes the generic framework.
2. When the skill is invoked, the directive at the top instructs the LLM: "If `<consumer-cwd>/.claude/skills/<name>/SKILL.md.local` exists, read it and apply its content as additional instructions."
3. The consumer's overlay file injects project-specific examples (component names, doc paths, regulatory citations) without modifying the plugin.

### Templates

Three commonly-overlaid skills have starter templates under `plugin/templates/`:

- `skill-overlay-production-quality-ownership.md.example` — cross-coupling map, regulatory context, stakeholder voice
- `skill-overlay-design-consistency.md.example` — themed primitives, design tokens, domain component dirs
- `skill-overlay-self-review.md.example` — user-facing docs mapping, UI/i18n project-specific checks, regression test mapping

Copy whichever you need into your consumer repo, strip the `.example` suffix, and fill in the placeholders. Skills without a `.local` overlay use the plugin's generic behavior unchanged — overlays are strictly opt-in.

See `docs/migration-polads.md` for a complete worked example (PolAds overlays for all three).

## People resolution

The plugin no longer hardcodes a `username → person ID` map. `src/services/people.ts` queries Monday board `1612664689` (or `monday.peopleBoardId` if overridden) at runtime, with a 5-min TTL cache. Match priority:

1. Email local-part (e.g. `naref@stepnetwork.dk` → `naref`)
2. Person display name (lowercased exact match)
3. Item-name first word (lowercased)

Past-status records are excluded. Numeric input is treated as a person ID directly.

## Worktree lifecycle

Every claimed task runs in its own git worktree under `.claude/worktrees/<branch-slug>/`. The worktree-required hooks block source edits from the main checkout, so worktrees accumulate over time — one per task. Two mechanisms keep them in check:

**SessionStart auto-janitor** (`hooks/worktree-janitor.sh`, registered in `hooks.json`). Runs `scripts/worktree-audit.sh --auto` once per session start. Silent on no-op; prints a one-line summary when it cleans something. Each consumer project gets this automatically — no config required.

What it cleans:

| Class | Removed by --auto | Notes |
|---|---|---|
| **DONE** (merged + clean) | yes | Merged direct OR via PR squash |
| **ABANDONED** (unmerged, no `active-task.json`, stale) | yes | Falls back to `--force` if `git worktree remove` refuses |
| **Stale `.git/worktrees/<n>/locked`** (mtime > 24h) | yes | 24h floor; no legitimate session holds locks that long |
| **IN-FLIGHT** (dirty tree OR has `active-task.json`) | **no** | Preserved unconditionally |
| **Main checkout + active session** | **no** | Always skipped |

**Manual escape hatches**:

```sh
bash plugin/scripts/worktree-audit.sh              # report only (safe)
bash plugin/scripts/worktree-audit.sh --remove     # interactive DONE removal
bash plugin/scripts/worktree-audit.sh --remove -y  # bulk DONE removal
bash plugin/scripts/worktree-audit.sh --auto       # what the hook runs
```

To disable the janitor in a consumer project, remove the `SessionStart` block from your local `.claude/settings.json` overrides (the hook only runs when registered by the plugin).

Tests in `plugin/scripts/__tests__/worktree-janitor.test.sh` cover: `--auto` accepts and reports, stale lock cleanup, fresh lock preservation, hook silence on no-op, and hook output on cleanup.

## Layout

```
plugin/
├── .claude-plugin/plugin.json   # manifest (version 0.8.0)
├── .mcp.json                    # registers the dev-tasks stdio server
├── package.json + tsconfig.json # @modelcontextprotocol/sdk + zod
├── src/                         # TypeScript source
│   ├── server.ts                # stdio entry + tool registration
│   ├── api/mcp.ts               # Vercel HTTP transport (per-user Bearer auth)
│   ├── monday-client.ts         # GraphQL client (env or ALS-scoped Bearer)
│   ├── auth-context.ts          # AsyncLocalStorage for hosted-MCP per-request auth
│   ├── constants.ts             # board / column / status maps
│   ├── schemas.ts               # Zod schemas for all 44 tools
│   ├── tools/                   # one file per tool + utils
│   ├── services/
│   │   ├── people.ts            # *People-board lookup with cache
│   │   ├── version-bump.ts      # pure semver suggestion algorithm
│   │   ├── auto-version.ts      # task → version auto-link on Waiting-for-UAT
│   │   ├── version-state-machine.ts  # version-state aggregation + bounceback
│   │   ├── changelog-doc.ts     # Monday Doc unified markdown + JSON markers
│   │   ├── changelog-refresh.ts # live view of linked tasks
│   │   └── __tests__/           # vitest (63 tests)
│   └── register-tools.ts        # shared between stdio + HTTP transports
├── rules/                       # 9 universal lifecycle rules
├── rules-routing.json           # file-glob → rule-file mapping
├── skills/                      # 15 skills (workflow + posture + doctor + goal)
├── hooks/                       # 34 hooks (policy + opt-in/auto, incl. workflow-enforcement gates + commit-id-gate + stop-goal-persistence)
├── agents/                      # 4 subagent definitions
├── schemas/                     # project-config.schema.json
└── templates/                   # starter-project-config.json
```

## Dev

```sh
cd plugin
npm install                # also runs tsc via prepare
npm run build              # tsc
npm run typecheck          # tsc --noEmit -p tsconfig.check.json (covers api/ too)
npm test                   # vitest
npm start                  # run the stdio server (stdin/stdout)
```

After editing MCP code, **fully restart Claude Code** — `/reload-plugins` does not kill the MCP process. Skills / hooks / rules are filesystem-rescanned by `/reload-plugins`.

## Hosted MCP

The plugin also exposes an HTTP transport at `plugin/api/mcp.ts` deployable to Vercel. Per-user Monday auth via `Authorization: Bearer <token>` header, scoped per-request via AsyncLocalStorage. See `docs/hosted-mcp-deploy.md`.

## Migration guides

- **PolAds (existing consumer)**: `docs/migration-polads.md`
- **STEPhie (new consumer)**: write a `project-config.json` from the template, populate the four required fields, and run `/dev-tasks:doctor`. No skill/rule/hook copies — let the plugin own them; use `.local` overlay files for project-specific extensions.
