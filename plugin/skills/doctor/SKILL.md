---
name: doctor
description: Audit a consumer's dev-tasks setup. Verifies project-config is valid, MONDAY_API_KEY resolves, People-board lookup works for the current whoami, required Monday boards are reachable, and policy hooks are in place. Run after first install or when something feels off.
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

STEP-wide required companion per `ai-review-stack.md`. Without it: `analyzePlan` unavailable; Stop hook can't gate on findings; `/self-review` Check #11 + `/ship-pr` Step 18b degrade to "Corridor unavailable".

1. Inspect `~/.claude/settings.json` `enabledPlugins` for `corridor@*`.
2. Verify tools loaded: check for `mcp__plugin_corridor_corridor__*` (e.g. `mcp__plugin_corridor_corridor__listProjects`).

PASS: `corridor@*` in `enabledPlugins` AND MCP tools loaded.
FAIL: missing — instruct user per Corridor's onboarding docs (install source varies). After install: `/plugin install corridor@corridor-plugins` → `/reload-plugins`.
WARN: listed but MCP not loaded → restart Claude Code.

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

If any FAIL: list concrete remediation. Stop on first FAIL and prompt user to fix before re-running.
