#!/usr/bin/env tsx
/**
 * One-off backfill: copy `long_text_mm0mcp77` (legacy description column) into
 * a freshly-created Monday doc on `doc_mm3sg1kr` (descriptionDoc column) for
 * every task on the Tasks board that has content in long_text but no doc yet.
 *
 * Idempotent — re-runs skip tasks that already have a doc attached. Safe to
 * abort and resume.
 *
 * Run from the plugin directory:
 *
 *   cd plugin
 *   export MONDAY_API_KEY=...
 *   npx tsx scripts/backfill-description-to-doc.ts            # dry run
 *   npx tsx scripts/backfill-description-to-doc.ts --apply    # actually write
 *
 * After the backfill is verified, ask the user to delete `long_text_mm0mcp77`
 * from the Tasks board on the Monday side (admin UI — there is no API). A
 * follow-up plugin PR can then drop the fallback reads from getTask /
 * validateReadyToStart / refinement-gate.
 */

import { BOARDS, TASK_COLUMNS } from "../src/constants.ts";
import { executeMondayQuery } from "../src/monday-client.ts";
import {
  ensureItemDoc,
  extractDocObjectId,
  writeDocContentReplacing,
} from "../src/services/doc-utils.ts";

const APPLY = process.argv.includes("--apply");
const PAGE_SIZE = 50;

type TaskRow = {
  id: string;
  name: string;
  column_values: Array<{ id: string; text: string | null; value: string | null }>;
};

async function fetchPage(cursor: string | null): Promise<{
  cursor: string | null;
  items: TaskRow[];
}> {
  const cursorArg = cursor ? `cursor: ${JSON.stringify(cursor)}` : "";
  const query = `
    query {
      boards(ids: [${BOARDS.TASKS}]) {
        items_page(limit: ${PAGE_SIZE}${cursorArg ? `, ${cursorArg}` : ""}) {
          cursor
          items {
            id
            name
            column_values(ids: ["${TASK_COLUMNS.description}", "${TASK_COLUMNS.descriptionDoc}"]) {
              id
              text
              value
            }
          }
        }
      }
    }
  `;
  const response = await executeMondayQuery<any>(query);
  const page = response.boards?.[0]?.items_page;
  return {
    cursor: page?.cursor ?? null,
    items: (page?.items ?? []) as TaskRow[],
  };
}

async function main() {
  console.log(`Backfill task descriptions → Monday docs (${APPLY ? "APPLY" : "DRY RUN"})`);
  console.log(`Board: ${BOARDS.TASKS}  Page size: ${PAGE_SIZE}`);
  console.log("");

  let cursor: string | null = null;
  let scanned = 0;
  let alreadyHasDoc = 0;
  let emptyLongText = 0;
  let backfilled = 0;
  let failed = 0;

  do {
    const page = await fetchPage(cursor);
    cursor = page.cursor;

    for (const item of page.items) {
      scanned++;
      const id = Number(item.id);
      const longText = item.column_values.find(c => c.id === TASK_COLUMNS.description)?.text ?? "";
      const docCol = item.column_values.find(c => c.id === TASK_COLUMNS.descriptionDoc);

      let parsedDocVal: unknown;
      try {
        parsedDocVal = docCol?.value ? JSON.parse(docCol.value) : undefined;
      } catch {
        parsedDocVal = undefined;
      }
      const hasDoc = !!extractDocObjectId(parsedDocVal);

      if (hasDoc) {
        alreadyHasDoc++;
        continue;
      }
      if (!longText.trim()) {
        emptyLongText++;
        continue;
      }

      if (!APPLY) {
        console.log(`  [DRY] #${id} ${item.name} — ${longText.length} chars to migrate`);
        backfilled++;
        continue;
      }

      try {
        const docId = await ensureItemDoc(
          id,
          TASK_COLUMNS.descriptionDoc,
          `Description — Task #${id}: ${item.name}`,
        );
        await writeDocContentReplacing(docId, longText);
        console.log(`  [OK]  #${id} ${item.name} → doc ${docId}`);
        backfilled++;
      } catch (error) {
        failed++;
        console.error(
          `  [FAIL] #${id} ${item.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } while (cursor);

  console.log("");
  console.log("Summary:");
  console.log(`  Scanned:          ${scanned}`);
  console.log(`  Already had doc:  ${alreadyHasDoc}`);
  console.log(`  Empty long_text:  ${emptyLongText}`);
  console.log(`  Backfilled:       ${backfilled}`);
  console.log(`  Failed:           ${failed}`);
  if (!APPLY) {
    console.log("");
    console.log("(Dry run — re-run with --apply to perform writes.)");
  }
}

main().catch(error => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
