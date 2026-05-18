import { executeMondayQuery } from "../monday-client.ts";
import { BOARDS, BUG_COLUMNS, BUG_PRIORITY } from "../constants.ts";
import type { UpdateBugInput } from "../schemas.ts";
import { buildColumnValues, formatError } from "./utils.ts";

/**
 * updateBug — Option C intake-workflow editor for bugs.
 *
 * Lets agents move bugs through the triage funnel without UI access:
 *   Awaiting Review → Triaged → (Converted to Task | Declined |
 *                                Cannot Reproduce | Duplicated |
 *                                Missing Info | Known Bug)
 *
 * Status uses label-based writes (`{ label: "X" }`) so new labels are
 * auto-created by Monday via `create_labels_if_missing: true` in the
 * mutation. This means agents can use the new statuses (Triaged, Declined,
 * Cannot Reproduce) even before they exist on the board — Monday creates
 * them on first write.
 *
 * For the Converted-to-Task transition, prefer `convertBugToTask` (it
 * creates the linked Task atomically). Setting `status: "Converted to Task"`
 * here only marks the Bug terminal without creating the task — useful only
 * if the task is being created via a different code path.
 */
export async function updateBug(args: UpdateBugInput): Promise<string> {
  try {
    const { bugId } = args;

    if (args.delete) {
      const deleteMutation = `
        mutation {
          delete_item(item_id: ${bugId}) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(deleteMutation);
      return `# Bug Deleted\n\nBug #${bugId} has been deleted.`;
    }

    const columnValues: Record<string, unknown> = {};
    const changes: string[] = [];

    if (args.status !== undefined) {
      columnValues[BUG_COLUMNS.status] = { label: args.status };
      changes.push(`Status -> ${args.status}`);
    }

    if (args.priority !== undefined) {
      columnValues[BUG_COLUMNS.priority] = { index: BUG_PRIORITY[args.priority] };
      changes.push(`Priority -> ${args.priority}`);
    }

    if (args.description !== undefined) {
      columnValues[BUG_COLUMNS.description] = { text: args.description };
      changes.push(`Description updated`);
    }

    if (args.productId !== undefined) {
      columnValues[BUG_COLUMNS.product] = { item_ids: [args.productId] };
      changes.push(`Product -> #${args.productId}`);
    }

    if (args.epicId !== undefined) {
      columnValues[BUG_COLUMNS.epic] = { item_ids: [args.epicId] };
      changes.push(`Epic -> #${args.epicId}`);
    }

    if (args.fixedInVersionId !== undefined) {
      columnValues[BUG_COLUMNS.fixedInVersion] = { item_ids: [args.fixedInVersionId] };
      changes.push(`Fixed In Version -> #${args.fixedInVersionId}`);
    }

    if (args.filedByAgent !== undefined) {
      // Label-based dropdown write — the Filed By Agent column on Bugs (added
      // v0.12.0) doesn't have pre-configured numeric IDs like the Tasks board.
      // create_labels_if_missing handles first-write registration.
      columnValues[BUG_COLUMNS.filedByAgent] = { labels: [args.filedByAgent] };
      changes.push(`Filed By Agent -> ${args.filedByAgent}`);
    }

    if (Object.keys(columnValues).length > 0) {
      const mutation = `
        mutation {
          change_multiple_column_values(
            item_id: ${bugId},
            board_id: ${BOARDS.BUGS},
            column_values: ${buildColumnValues(columnValues)},
            create_labels_if_missing: true
          ) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(mutation);
    }

    if (args.name !== undefined) {
      const nameMutation = `
        mutation {
          change_simple_column_value(
            item_id: ${bugId},
            board_id: ${BOARDS.BUGS},
            column_id: "name",
            value: ${JSON.stringify(args.name)}
          ) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(nameMutation);
      changes.push(`Name -> "${args.name}"`);
    }

    if (changes.length === 0) {
      return formatError(`No fields provided to update for bug #${bugId}.`);
    }

    const lines: string[] = [
      `# Bug Updated`,
      ``,
      `**Bug:** #${bugId}`,
      ``,
      `**Changes:**`,
      ...changes.map(c => `- ${c}`),
    ];

    return lines.join("\n");
  } catch (error) {
    return formatError(`Failed to update bug: ${error instanceof Error ? error.message : String(error)}`);
  }
}
