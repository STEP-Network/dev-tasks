#!/usr/bin/env tsx
/**
 * Sweeps the Tasks board for a product's "Pending Deploy to Prod" items and
 * flips them to Done + posts a release note.
 *
 * Fills the gap documented at task-lifecycle.md / workflow-pipeline.md: no
 * automation ever did this — a consuming project's tag-triggered release.yml
 * only ever updated the Versions board. See plugin/templates/github-workflows/
 * for the consumer-side CI step that calls this same logic in curl+jq form
 * (a foreign repo's CI can't import this plugin's TS module graph).
 *
 * Manual invocation:
 *   npx tsx scripts/complete-released-tasks.ts --product-id=2924964797 --release-id=v0.32.0
 *
 * productId defaults to .claude/project-config.json -> monday.productId
 * (resolved from the current working directory) when --product-id is omitted.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { executeMondayQuery } from "../src/monday-client.ts";
import { BOARDS, TASK_COLUMNS, TASK_STATUS } from "../src/constants.ts";
import { validateMapping, buildColumnValues } from "../src/tools/utils.ts";
import { resolveProductEpicIds } from "../src/tools/getBacklog.ts";

// Re-exported (not re-implemented) — getBacklog.ts already resolves
// product -> epics for the exact same reason (mirror columns aren't
// server-filterable); a second hand-written copy of that query would be
// the kind of duplication this codebase's own conventions warn against.
export { resolveProductEpicIds };

export async function findPendingDeployTasks(
  epicIds: number[],
): Promise<Array<{ id: number; name: string }>> {
  if (epicIds.length === 0) return [];

  const pendingDeployIndex = validateMapping("Pending Deploy to Prod", TASK_STATUS, "task status");
  const query = `
    query {
      boards(ids: [${BOARDS.TASKS}]) {
        items_page(limit: 500, query_params: {
          rules: [
            { column_id: "${TASK_COLUMNS.status}", compare_value: [${pendingDeployIndex}], operator: any_of },
            { column_id: "${TASK_COLUMNS.epic}", compare_value: [${epicIds.join(",")}], operator: any_of }
          ],
          operator: and
        }) {
          items { id name }
        }
      }
    }
  `;
  const response = await executeMondayQuery<any>(query);
  const items = response.boards?.[0]?.items_page?.items || [];
  return items.map((item: any) => ({ id: Number(item.id), name: String(item.name) }));
}

export interface CompleteTaskResult {
  statusFlipped: boolean;
  notePosted: boolean;
  noteError?: string;
}

/**
 * Flip a single task to Done + post a release note. Two sequential mutations
 * (not one `change_multiple_column_values` + `create_update` combo — Monday's
 * API doesn't support compositing unrelated mutations against different
 * root fields in a single write here).
 *
 * The status mutation is the one that matters for idempotency/correctness —
 * if it throws, the caller's fail-soft wrapper treats this task as untouched
 * and reports a true failure. The note-posting mutation is best-effort: if
 * it fails AFTER the status flip already succeeded, the task IS Done on the
 * board (a retry sweep would find nothing — the status filter excludes it),
 * so that must never be reported the same way as a true failure. Reporting
 * `notePosted: false` lets the caller distinguish "Done but missing its
 * note" from "still stuck, needs retry."
 */
export async function completeTask(
  taskId: number,
  releaseId?: string,
): Promise<CompleteTaskResult> {
  const columnValues = { [TASK_COLUMNS.status]: { label: "Done" } };
  const statusMutation = `
    mutation {
      change_multiple_column_values(
        item_id: ${taskId},
        board_id: ${BOARDS.TASKS},
        column_values: ${buildColumnValues(columnValues)}
      ) {
        id
      }
    }
  `;
  await executeMondayQuery<unknown>(statusMutation);

  const releaseNote = releaseId
    ? `Completed by release automation (release ${releaseId}).`
    : "Completed by release automation.";
  const body = `<p>${releaseNote}</p>`;
  const updateMutation = `
    mutation {
      create_update(
        item_id: ${taskId},
        body: ${JSON.stringify(body)}
      ) {
        id
      }
    }
  `;
  try {
    await executeMondayQuery<unknown>(updateMutation);
    return { statusFlipped: true, notePosted: true };
  } catch (error) {
    return {
      statusFlipped: true,
      notePosted: false,
      noteError: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface CompletedTaskResult {
  taskId: number;
  taskName: string;
  outcome: "completed" | "completed-without-note" | "failed";
  error?: string;
}

export interface RunSummary {
  productId: number;
  releaseId?: string;
  candidateCount: number;
  results: CompletedTaskResult[];
}

/**
 * Sweep entry point: resolve the product's epics, find every task sitting at
 * "Pending Deploy to Prod" under them, and complete each one. Fail-soft per
 * task — one task's mutation error is recorded in the result and does not
 * abort the rest of the sweep (matches the philosophy already established in
 * auto-version.ts / version-state-machine.ts, where auto-version/state-machine
 * failures degrade to a warning rather than failing the caller).
 */
export async function run(opts: { productId: number; releaseId?: string }): Promise<RunSummary> {
  const { productId, releaseId } = opts;
  const epicIds = await resolveProductEpicIds(productId);
  const candidates = await findPendingDeployTasks(epicIds);

  const results: CompletedTaskResult[] = [];
  for (const task of candidates) {
    try {
      const result = await completeTask(task.id, releaseId);
      if (result.notePosted) {
        results.push({ taskId: task.id, taskName: task.name, outcome: "completed" });
      } else {
        results.push({
          taskId: task.id,
          taskName: task.name,
          outcome: "completed-without-note",
          error: result.noteError,
        });
      }
    } catch (error) {
      results.push({
        taskId: task.id,
        taskName: task.name,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { productId, releaseId, candidateCount: candidates.length, results };
}

/**
 * Read `monday.productId` from `<cwd>/.claude/project-config.json` — the same
 * per-consumer config value every other productId-scoped operation in this
 * plugin already reads (see CLAUDE.md's project-config conventions).
 */
export async function resolveDefaultProductId(cwd: string): Promise<number> {
  const configPath = resolve(cwd, ".claude", "project-config.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch {
    throw new Error(
      `No --product-id given and could not read ${configPath}. ` +
      `Pass --product-id=<n> or run from a directory with a .claude/project-config.json.`,
    );
  }
  const config = JSON.parse(raw);
  const productId = config?.monday?.productId;
  if (!productId) {
    throw new Error(`${configPath} has no monday.productId set, and --product-id was not passed.`);
  }
  return typeof productId === "string" ? Number(productId) : productId;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArg(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

/**
 * Resolve the repo root the same way plugin/scripts/ci-skip-eval.sh does
 * (`git rev-parse --show-toplevel`), so running this from `plugin/` (where
 * `npx tsx` needs node_modules) still finds the repo-root `.claude/`
 * directory instead of failing to see it under the cwd.
 */
async function resolveProjectRoot(): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
  } catch {
    return process.cwd();
  }
}

async function main() {
  const releaseId = parseArg("release-id");
  const productIdArg = parseArg("product-id");
  const productId = productIdArg ? Number(productIdArg) : await resolveDefaultProductId(await resolveProjectRoot());

  const summary = await run({ productId, releaseId });

  process.stdout.write(
    `complete-released-tasks: ${summary.candidateCount} candidate(s) at "Pending Deploy to Prod" ` +
    `for product ${summary.productId}${summary.releaseId ? ` (release ${summary.releaseId})` : ""}\n`,
  );
  for (const r of summary.results) {
    if (r.outcome === "completed") {
      process.stdout.write(`  done            #${r.taskId} ${r.taskName}\n`);
    } else if (r.outcome === "completed-without-note") {
      process.stdout.write(`  done (no note)  #${r.taskId} ${r.taskName} — ${r.error}\n`);
    } else {
      process.stdout.write(`  FAILED          #${r.taskId} ${r.taskName} — ${r.error}\n`);
    }
  }
  const failures = summary.results.filter((r) => r.outcome === "failed");
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`complete-released-tasks failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
