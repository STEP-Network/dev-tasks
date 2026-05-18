---
name: doctor
description: Audit a consumer's dev-tasks setup. Verifies project-config is valid, MONDAY_API_KEY resolves, People-board lookup works for the current whoami, required Monday boards are reachable, and policy hooks are in place. Run after first install or when something feels off.
user_invocable: true
---

# /doctor — Consumer setup audit

> **Overlay**: if `.claude/skills/doctor/SKILL.md.local` exists in the consumer repo, read it and apply as additional project-specific checks (extend-only).

## When to apply

- After first installing the plugin in a new product
- After bumping the plugin version
- When workflow skills fail unexpectedly (owner not resolving, version bump misbehaving, hook gates failing)
- Once a month as a sanity check

## Checks

Walk through each. Mark PASS / FAIL / WARN with a one-line note per check.

### 1. `project-config.json` present and schema-valid

- `.claude/project-config.json` exists at the consumer repo root
- It validates against `${CLAUDE_PLUGIN_ROOT}/schemas/project-config.schema.json` (try parsing with `python3 -c 'import json, jsonschema, sys; jsonschema.validate(json.load(open(".claude/project-config.json")), json.load(open("<schema-path>")))'` — fail soft if jsonschema not installed, just verify JSON parses)
- Required fields present: `version`, `monday.productId`

If FAIL: tell the user to copy `${CLAUDE_PLUGIN_ROOT}/templates/starter-project-config.json` and fill in `monday.productId` + adjust `git.defaultBase`.

### 2. Required fields populated

For each of these fields, check it's set to a non-default sentinel value:

- `git.defaultBase` — should be the project's actual integration branch (`staging`, `main`, etc.). Not the schema default unless it's actually correct.
- `monday.productId` — must be a real Monday product item ID, not the placeholder string `"REQUIRED — ..."` from the starter template
- `environments.uat.url` — non-empty string if the project has a UAT environment
- `monday.v1MilestoneEpicIds` — array (may be empty if the project has no v1 gate; warn if empty + product is pre-1.0)

### 3. `MONDAY_API_KEY` resolves

- Run `[ -n "$MONDAY_API_KEY" ] && echo set || echo unset`
- If unset: FAIL — user needs to `export MONDAY_API_KEY=...` in their shell rc

### 4. Monday API reachable

- Call `mcp__plugin_dev-tasks_dev-tasks__listProducts` (cheapest read tool)
- If it returns a product list: PASS
- If error: FAIL with the error message

### 5. `monday.productId` resolves to a real product

- Inspect `listProducts` output — does an item with `id` equal to `monday.productId` exist?
- If yes: PASS, note product name
- If no: FAIL — productId is stale or wrong

### 6. `whoami` resolves on the People board

This skill is **read-only** — never invoke a mutating MCP tool (`updateTask`, `updateEpic`, `claimTask`, etc.) as a "test". Verify via reads only.

- Get `whoami` from the shell
- Read the People board: there is no direct MCP read tool for arbitrary boards, so this check is best-effort:
  - If `mcp__claude_ai_monday_com__get_board_items_page` is available in the session, call it on `monday.peopleBoardId` (default `1612664689`) with `columnIds: ["person", "email__1", "text6__1", "text_mm3ffcjd", "status"]`. **First check `text_mm3ffcjd`** — that column holds the canonical whoami username, set explicitly by the team. An exact-match on `text_mm3ffcjd` is the authoritative mapping. If no `text_mm3ffcjd` match, fall back to email local-part / `person` display value / `name` first-word matches (same priority order as `getPersonByUsername`). Report the matched person ID and which column matched.
  - Otherwise, tell the user the lookup path: "match `whoami` against the People board (`1612664689`) — your record should have your whoami in column `text_mm3ffcjd`, a non-empty `text6__1` (People ID), and status != Past." Have them eyeball it on the board.
- If `whoami` matches by a fallback tier (email/display/name first word) but `text_mm3ffcjd` is empty for your record: this is a soft WARN — populate the whoami column to lock in the authoritative mapping and avoid future ambiguity when names overlap.

### 7. Policy hooks always-on

These are STEP-wide policy hooks — they MUST run regardless of `hooks.enabled[]`:

- `bash-guard.sh` — at `${CLAUDE_PLUGIN_ROOT}/hooks/bash-guard.sh`, top of file should NOT contain `hook_enabled "bash-guard" || exit 0`
- `stop-ci-green-check.sh` — same

If either has the `hook_enabled` line: FAIL — the plugin install is at an older version where these were still opt-in. Tell the user to reinstall the plugin (the version bump should have lifted these gates).

### 8. `hooks.enabled[]` doesn't list policy hooks

Verify `project-config.json` does NOT list `bash-guard` or `stop-ci-green-check` under `hooks.enabled[]`. They're always-on now; listing them is harmless but redundant.

### 9. Plugin version matches expectation

- Read `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` — extract `version`
- Tell the user the installed version. If they expected a different version, suggest `/plugin uninstall` + `/plugin install`.

### 10. GitHub PAT can query CI status

The `gh` CLI needs the ability to query CI status for `/ship-pr` Phase 6 and `/babysit-prs`. Two paths work in practice; check for whichever the user has:

- **Path A (preferred — works on every token type)**: `gh api repos/<owner>/<repo>/actions/runs?per_page=1` returns 200. This is the workflow_runs endpoint that `/babysit-prs` uses as its primary query — it returns the same CI verdict as `gh pr checks`, just structured slightly differently. Requires `workflow` scope (classic) or `Actions: Read` (fine-grained), both of which most STEP-issued tokens already have.

- **Path B (legacy — classic PATs only)**: `gh pr checks <PR>` returns 200. Requires `repo` scope on a classic PAT (which transitively includes check-runs access).

> **Heads-up about `Checks: Read`**: GitHub **removed** the `Checks: Read` permission from fine-grained PATs (see community discussion #129512). No amount of UI clicking will surface it on a fine-grained token. The plugin's earlier (pre-0.8.6) check asked for that exact permission and could never pass for fine-grained tokens. Don't waste time looking for it — use Path A's `Actions: Read` instead.

How to check:

1. Run `gh auth status` (no `--show-token` — we just need the scopes list and the auth source).
2. Try Path A: `gh api repos/STEP-Network/dev-tasks/actions/runs?per_page=1 >/dev/null 2>&1 && echo OK`. (Substitute any STEP-Network repo the user has access to.)
3. If Path A returns OK → PASS. Done. `/babysit-prs` and `/ship-pr` Phase 6 work via the workflow_runs path.
4. If Path A fails → try Path B: `gh pr checks 1 >/dev/null 2>&1 && echo OK`. If OK → PASS.
5. If neither works → FAIL. Remediation:
    - **Easiest**: classic PAT with `repo` + `workflow` scopes (deprecated by GitHub but still works). Settings → Developer settings → Personal access tokens (classic) → Generate new token → enable both scopes → set `GH_TOKEN` to it. Note: classic PATs are being phased out, so this is a temporary path.
    - **Future-proof**: GitHub App installation token (granted `Actions: Read`). ~30 min setup but the GitHub-recommended path.
    - **Cheapest**: unset `GH_TOKEN` and let `gh` fall back to its OAuth keyring token (`gh auth login --web`), which is a user-to-server token from the `gh` CLI's own GitHub App. The `workflow` scope on it grants Path A access.

If `gh auth status` errors entirely (`not logged in`): WARN — the plugin still works without `gh`, but `/babysit-prs` and `/ship-pr` Phase 6 won't.

### 11. Corridor companion plugin installed

Corridor is a **STEP-wide required companion plugin** (per `.claude/rules/ai-review-stack.md` and the policy baseline in `plugin/README.md`). Without it: `analyzePlan` is unavailable, the Stop hook can't gate on findings, `/self-review` Check #11 + `/ship-pr` Step 18b silently degrade to "Corridor unavailable" mode.

How to check:

1. Inspect `~/.claude/settings.json` `enabledPlugins`. Look for a key matching `corridor@*` (typically `corridor@corridor-plugins`).
2. Verify the plugin tools are loaded in this session by checking for any tool name starting with `mcp__plugin_corridor_corridor__` (e.g. `mcp__plugin_corridor_corridor__listProjects` should be invocable).

- PASS: `corridor@*` present in `enabledPlugins` AND the MCP tools are loaded.
- FAIL: missing — instruct the user to install Corridor's plugin per Corridor's own onboarding docs (the install source varies — could be a public marketplace, an internal STEP path, or a Corridor-provided package). After install: `/plugin install corridor@corridor-plugins` (or whatever the marketplace name is) → `/reload-plugins`.
- WARN if enabledPlugins lists it but the MCP tools aren't loaded — likely needs a Claude Code restart to reconnect the MCP server.

## Output format

```
# /doctor — Consumer setup audit

Project: <repo name from `basename $(pwd)`>
Plugin version: <X.Y.Z>

1. ✅ project-config.json valid
2. ⚠️  environments.uat.url is empty — set it if this product has a UAT environment
3. ✅ MONDAY_API_KEY set
4. ✅ Monday API reachable
5. ✅ productId 2723505568 resolves to "PolAds"
6. ✅ whoami 'nate' resolves to person 103752074 (Nathaniel Refslund)
7. ✅ bash-guard.sh + stop-ci-green-check.sh policy gates lifted (always-on)
8. ✅ hooks.enabled[] doesn't list policy hooks
9. ✅ Plugin version 0.8.4
10. ✅ gh can query CI status (workflow_runs endpoint OK via Actions: Read / workflow scope)
11. ✅ Corridor companion plugin installed (corridor@corridor-plugins) and MCP tools loaded

Summary: 10 PASS, 1 WARN, 0 FAIL. Setup is good.
```

If anything is FAIL: list the concrete remediation step for each.

## Notes

- This skill is read-only — it doesn't modify any files. The user (or a follow-up skill invocation) applies fixes.
- The checks are deliberately ordered easiest → hardest. Stop on the first FAIL and prompt the user to fix before re-running.
