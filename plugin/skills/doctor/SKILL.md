---
name: doctor
description: Audit a consumer's dev-tasks setup. Verifies project-config is valid, MONDAY_API_KEY resolves, People-board lookup works for the current whoami, required Monday boards are reachable, policy hooks are in place, and the 1.0 pieces (machine profile, tracker.provider, the Linear key file, no retired hooks listed, the 1.0 flow prerequisites) are sound. Run after first install or when something feels off.
user_invocable: true
---

# /doctor — Consumer setup audit

Read-only. Never invoke a mutating MCP tool as a test.

## When to apply

- After first installing the plugin in a new product
- After bumping plugin version
- When workflow skills fail unexpectedly
- Once a month sanity check

## Checks

Mark PASS / FAIL / WARN with a one-line note each.

**Order.** Resolve the tracker (Check 14) before anything else. On `linear`, Checks 3-6 (the Monday key, the Monday API, the product, the People board) report WARN instead of FAIL: the 1.0 flow on Linear needs none of them, only the Monday MCP tools do, so a Linear machine without a Monday key must not stop there. Checks 13-17 are local reads that depend on nothing in 1-12, so they run even after an earlier FAIL.

### 1. `project-config.json` present and schema-valid

- `.claude/project-config.json` exists at consumer repo root
- Validates against `${CLAUDE_PLUGIN_ROOT}/schemas/project-config.schema.json` (fail soft if jsonschema not installed — just verify JSON parses)
- Required fields: `version`, `monday.productId`

FAIL → tell user to copy `${CLAUDE_PLUGIN_ROOT}/templates/starter-project-config.json` and fill in `monday.productId` + `git.defaultBase`.

### 2. Required fields populated

Non-default values for:
- `git.defaultBase` — actual integration branch
- `monday.productId` — real Monday product ID, not placeholder
- `environments.uat.url` — non-empty if project has UAT
- `monday.v1MilestoneEpicIds` — array (warn if empty + product pre-1.0)

### 3. `MONDAY_API_KEY` resolves

`[ -n "$MONDAY_API_KEY" ] && echo set || echo unset`. Unset → FAIL, user needs `export MONDAY_API_KEY=...` in shell rc.

### 4. Monday API reachable

`mcp__plugin_dev-tasks_dev-tasks__listProducts`. Returns list → PASS. Error → FAIL with message.

### 5. `monday.productId` resolves to a real product

Check `listProducts` output for matching `id`. Not found → FAIL (stale/wrong productId).

### 6. `whoami` resolves on the People board

Read-only check on People board (default `1612664689`):
- If `mcp__claude_ai_monday_com__get_board_items_page` available: call with `columnIds: ["person", "email__1", "text6__1", "text_mm3ffcjd", "status"]`. Check `text_mm3ffcjd` FIRST (canonical whoami column). Fall back priority: email local-part → `person` display → `name` first-word.
- Otherwise: tell user to verify manually on board `1612664689` — their record needs whoami in `text_mm3ffcjd`, non-empty `text6__1` (People ID), status != Past.
- If matched only via fallback tier but `text_mm3ffcjd` empty → WARN (populate to lock in authoritative mapping).

### 7. Policy hooks always-on

These must run regardless of `hooks.enabled[]`:
- `bash-guard.sh` at `${CLAUDE_PLUGIN_ROOT}/hooks/bash-guard.sh` — top of file must NOT contain `hook_enabled "bash-guard" || exit 0`
- `stop-ci-green-check.sh` — same

If either has the `hook_enabled` line → FAIL (older plugin version where these were opt-in). Reinstall plugin.

### 8. `hooks.enabled[]` doesn't list policy hooks

`project-config.json` must NOT list `bash-guard` or `stop-ci-green-check` under `hooks.enabled[]`. Always-on now; listing is redundant.

### 9. Plugin version

Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` → extract `version`. Report. If user expected different, suggest `/plugin uninstall` + `/plugin install`.

### 10. GitHub PAT can query CI status

`gh` needs CI query for `/ship-pr` Phase 6 and `/babysit-prs`. Two paths:

- **Path A (preferred, all token types)**: `gh api repos/<owner>/<repo>/actions/runs?per_page=1` returns 200. Requires `workflow` scope (classic) or `Actions: Read` (fine-grained).
- **Path B (legacy, classic PATs only)**: `gh pr checks <PR>` returns 200. Requires `repo` scope.

GitHub removed `Checks: Read` from fine-grained PATs (community discussion #129512) — don't look for it; use Path A's `Actions: Read`.

How to check:
1. `gh auth status` (no `--show-token`).
2. Try Path A: `gh api repos/STEP-Network/dev-tasks/actions/runs?per_page=1 >/dev/null 2>&1 && echo OK`.
3. Path A OK → PASS.
4. Else Path B: `gh pr checks 1 >/dev/null 2>&1 && echo OK`.
5. Neither → FAIL. Remediation:
    - Classic PAT with `repo` + `workflow` (deprecated but works)
    - GitHub App installation token with `Actions: Read` (~30 min setup, future-proof)
    - Unset `GH_TOKEN` and let `gh` use its OAuth keyring token (`gh auth login --web`)

`gh auth status` errors entirely (not logged in) → WARN — plugin works without `gh` but `/babysit-prs` and `/ship-pr` Phase 6 won't.

### 11. Corridor companion plugin

STEP-wide required companion per `${CLAUDE_PLUGIN_ROOT}/rules/ai-review-stack.md`. Without it: `analyzePlan` unavailable; Stop hook can't gate on findings; `/self-review` Check #11 + `/ship-pr` Step 18b degrade to "Corridor unavailable".

1. Inspect `~/.claude/settings.json` `enabledPlugins` for `corridor@*`.
2. Verify tools loaded: check for `mcp__plugin_corridor_corridor__*` (e.g. `mcp__plugin_corridor_corridor__listProjects`).

PASS: `corridor@*` in `enabledPlugins` AND MCP tools loaded.
FAIL: missing — instruct user per Corridor's onboarding docs (install source varies). After install: `/plugin install corridor@corridor-plugins` → `/reload-plugins`.
WARN: listed but MCP not loaded → restart Claude Code.

### 12. Visual-diff wiring (v0.37.0)

The visualDiff feature is ON by default and its authed-capture inputs are consumer-declared, so a consumer can silently capture nothing for the routes that matter. Audit the wiring whenever `visualDiff.enabled` is not `false` AND `environments.uat.url` is an `https://` URL. Do NOT recommend the `stop-visual-diff-check` enforcement hook: 1.0 turns it off on both profiles, because screenshots belong to the consumer's CI (a PR screenshot workflow), not to a local Stop gate (Check 16 warns when it is still listed).

1. **Personas for authed capture**: `e2e.personas[]` empty or absent → WARN: "every authed route will be skipped with 'auth required, no persona' — declare personas (id + storageState produced by your auth.setup.ts) and set `visualDiff.authPersona`".
2. **storageState files exist**: for each persona with a non-null `storageState`, check the path exists on disk (repo-root-relative). Missing → WARN naming the file and the consumer's regeneration command (their `auth.setup.ts` / e2e setup project — e.g. `pnpm playwright test --project=setup` or the project's e2e gate script).
3. **Persona references resolve**: `visualDiff.authPersona` and every `routeMap[].persona` must equal some `e2e.personas[].id` (JSON Schema can't cross-validate this). Dangling reference → FAIL with the offending id.
4. **loginUrl sanity** (only when set): its origin must equal the `environments.uat.url` origin (SSRF contract), and if it contains `{secret}`, `visualDiff.loginSecretEnv` must be set AND that env var must resolve non-empty locally. Violation → FAIL (origin mismatch) / WARN (secret env unset).

All four are config/disk reads — no network calls.

### 13. Machine profile (1.0)

`~/.claude/dev-tasks-profile.json` decides which hooks run on this machine (spec section 4). Read it through the plugin's own reader, so the answer is the one the hooks act on:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/hooks/lib/profile.sh" get profile
bash "${CLAUDE_PLUGIN_ROOT}/hooks/lib/profile.sh" get devSurface
bash "${CLAUDE_PLUGIN_ROOT}/hooks/lib/profile.sh" get mini
```

Report `profile`, `devSurface` and `mini`, then:

- File absent → PASS, resolves `human` (a laptop). Say so: on an agent mini that is wrong, and the mini's worktree and i18n gates are off until it has `{ "profile": "agent", "devSurface": "preview", "mini": "<name>" }`.
- File present, valid JSON, `profile` is `human` or `agent` → PASS.
- File present but not valid JSON (`jq -e . ~/.claude/dev-tasks-profile.json` fails), or `profile` is anything else → WARN: it resolves `agent` on purpose, so a configured machine never silently disarms its gates. On a laptop, fix the file.
- `DEV_TASKS_PROFILE` is set → note it: it overrides `profile` (and nothing else) for this shell.

### 14. `tracker.provider` (1.0)

Which tracker `/dev`, `/preview` and `/ship` read and write, from `.claude/project-config.json` at the repo root. `DEV_TASKS_TRACKER` overrides it for one process.

- Absent → PASS: `monday`, the documented pre-cutover default.
- `linear` or `monday` → PASS, report it.
- Anything else → FAIL: the adapter falls back to `monday`, so a typo sends a Linear project's writes to Monday. Fix the value.
- `DEV_TASKS_TRACKER` is set: to `linear` or `monday` → WARN that it overrides the config in this shell. To anything else → WARN that it is ignored.

### 15. Linear API key (1.0, only when the provider is `linear`)

Skip as PASS ("not needed") when Check 14 resolved `monday`. Otherwise:

- `LINEAR_API_KEY` set in the environment → PASS (it wins over the file). Test with `[ -n "$LINEAR_API_KEY" ]`; never print it.
- Else `~/.config/linear/.env` missing → FAIL, with the recipe below.
- Judge the key line the way the plugin's loader reads it: the FIRST `LINEAR_API_KEY=` line, trimmed. Measure it, never print it:

  ```bash
  grep -m1 '^LINEAR_API_KEY=' ~/.config/linear/.env | cut -d= -f2- | tr -d '[:space:]' | wc -c
  grep -m1 '^LINEAR_API_KEY=' ~/.config/linear/.env | cut -d= -f2- | grep -c "^[[:space:]]*[\"']"
  ```

  A length of `0` → FAIL: the loader throws on an empty key. A count of `1` on the second line → WARN: the value starts with a quote, and the loader sends the quotes as part of the key.
- Whenever the file exists, only its owner may read it, or FAIL with the fix `chmod 600 ~/.config/linear/.env`: the key writes to the whole Linear workspace. One command reads the mode on Linux and macOS alike, through a symlink to the real file (a link's own mode is `755` or `777` and says nothing):

  ```bash
  stat -L -c %a ~/.config/linear/.env 2>/dev/null || stat -L -f %Lp ~/.config/linear/.env
  ```

  PASS when the group and other digits are both `0` (`600`, or the stricter `400`). FAIL otherwise.

The recipe, from the install runbook. It keeps the key out of argv and out of shell history:

```bash
mkdir -p ~/.config/linear
read -rs KEY
(umask 077; printf 'LINEAR_API_KEY=%s\n' "$KEY" > ~/.config/linear/.env)
chmod 600 ~/.config/linear/.env
unset KEY
```

Never `cat` the file or echo the key, in this check or any other.

### 16. No retired or turned-off hooks in `hooks.enabled[]` (1.0)

`hooks.enabled[]` should list none of these. Each one listed → WARN with the fix: remove it.

- `stop-task-check`, `post-self-review`, `subtask-reminder`, `subtask-progress-gate`: retired in 1.0. The schema still accepts the names so old configs stay valid, and the runtime ignores them. Dead config.
- `pipeline-reminder`, `stop-visual-diff-check`: turned off on both profiles in 1.0, yet both still RUN when listed. `pipeline-reminder` nags about `selfReviewPassed`, which the 1.0 flow never sets, and `stop-visual-diff-check` holds a Stop for screenshots that belong to the consumer's CI.

### 17. The 1.0 flow prerequisites (only when the provider is `linear`)

A Linear project runs `/dev`, `/preview` and `/ship`, and each miss below blocks or stalls that flow. Skip as PASS on `monday`: such a project may still run the Monday pipeline, which wants the opposite. Each miss → WARN with its fix.

- `git.prePushMarker` must be `false`, or `bash-guard` gate (c) refuses every `/preview` and `/ship` push behind a local build marker neither skill writes.
- `ci.greenBeforeStop` must be `false`, or `stop-ci-green-check` holds the session open on the PR `/ship` leaves to CI.
- `hooks.enabled[]` must list neither `task-state-guard` (it refuses every edit without the `.claude/active-task.json` that `/dev` never writes) nor `commit-id-gate` (it refuses the commit `/preview` makes before `/ship` has opened an issue).

Read the two flags so an explicit `false` stays `false` (`// true` would turn it into `true`, as `bash-guard.sh` notes):

```bash
jq '(.git.prePushMarker | if . == null then true else . end), (.ci.greenBeforeStop | if . == null then true else . end)' .claude/project-config.json
```

## Output

```
# /doctor — Consumer setup audit

Project: <repo basename>
Plugin version: <X.Y.Z>

1. ✅ project-config.json valid
2. ⚠️  environments.uat.url empty — set if product has UAT
3. ✅ MONDAY_API_KEY set
...

Summary: N PASS, N WARN, N FAIL.
```

If any FAIL: list concrete remediation. Stop at the first FAIL among Checks 1-12, but still run 13-17 (see "Order" above), then prompt the user to fix before re-running.
