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
  - If `mcp__claude_ai_monday_com__get_board_items_page` is available in the session, call it on `monday.peopleBoardId` (default `1612664689`) with `columnIds: ["person", "email__1", "text6__1", "status"]` and search the response for a record whose email local-part / `person` display value / `name` first-word matches `whoami`. Report the matched person ID.
  - Otherwise, tell the user the lookup path: "match `whoami` against the People board (`1612664689`) — your record should have a non-empty `text6__1` (People ID) and status != Past." Have them eyeball it on the board.

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
9. ✅ Plugin version 0.8.0

Summary: 8 PASS, 1 WARN, 0 FAIL. Setup is good.
```

If anything is FAIL: list the concrete remediation step for each.

## Notes

- This skill is read-only — it doesn't modify any files. The user (or a follow-up skill invocation) applies fixes.
- The checks are deliberately ordered easiest → hardest. Stop on the first FAIL and prompt the user to fix before re-running.
