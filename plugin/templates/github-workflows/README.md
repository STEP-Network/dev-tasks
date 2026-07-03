# GitHub Actions release-workflow templates

Copy-paste starters for STEP Network projects that release via a `v*` tag push
and want the Monday Tasks board to stay in sync automatically.

## Files

| Template | Copies to | Notes |
|---|---|---|
| `complete-released-tasks-step.yml.example` | A new step inside `<consumer>/.github/workflows/release.yml` | Paste the step body (not the whole file) immediately after your existing "Update Monday.com version status" step |

## Why this exists

The dev-tasks plugin's lifecycle docs describe tasks flipping from `Pending
Deploy to Prod` to `Done` "via tag-triggered GitHub Action." That automation
was never built — a typical `release.yml` only ever updates the Versions
board. This template is the actual mechanism: a dependency-free curl+jq step
a consumer project's own CI can run (the plugin is private/unpublished, so
CI in another repo can't `import` its TypeScript module graph). The plugin
repo ships the same logic as a tested, reusable script at
`plugin/scripts/complete-released-tasks.ts` for local/interactive use.

## Setup steps for a new STEP product

1. Open `<consumer>/.github/workflows/release.yml` and find the step that
   updates the Monday Version item to `Released` (it already POSTs to
   `https://api.monday.com/v2` using a `MONDAY_API_TOKEN` secret).
2. Paste the step from `complete-released-tasks-step.yml.example` immediately
   after it, in the same job.
3. Set `MONDAY_PRODUCT_ID` in the pasted step to this project's actual Monday
   Products-board item ID (same value as `.claude/project-config.json` ->
   `monday.productId`, if this repo also runs the dev-tasks plugin locally).
   Find it via the plugin's `listProducts` tool if you don't have it handy.
4. Confirm `MONDAY_API_TOKEN` is already available as a repo/environment
   secret (it is, if the version-status step above already uses it) — no new
   secret to add.
5. Push a real (or test) tag and confirm the step's log shows either
   `"Completed task #... "` lines or the clean `"nothing to complete"` /
   `"No epics found"` no-op message.

## What it does NOT do

- It does not touch tasks outside this product's epics — the Tasks board is
  shared across every product in the workspace, so scoping is load-bearing,
  not optional.
- It never fails the release job over a Monday hiccup — every error path
  warns (`::warning::`) and continues, matching the non-blocking philosophy
  of the version-status step it runs after. The release already shipped by
  the time this step runs; board bookkeeping must never block that.
- It does not link tasks to a Monday Version item. That's a separate,
  pre-existing concern (`autoAssignVersionForTask` in the plugin) with its
  own known gap — see Dev-Tasks Plugin task #3045587142.

## Reference

- `plugin/scripts/complete-released-tasks.ts` — the same logic, TypeScript,
  unit-tested, for local/interactive runs against any product.
- `plugin/rules/task-lifecycle.md` / `plugin/rules/workflow-pipeline.md` —
  where this step fits in the overall Monday task lifecycle.
