import { executeMondayQuery } from "../monday-client.ts";
import {
  BOARDS,
  FEEDBACK_COLUMNS,
  FEEDBACK_STATUS,
  FEEDBACK_TYPE,
  FEEDBACK_PRIORITY,
  FEEDBACK_SOURCE,
} from "../constants.ts";
import type { UpdateFeedbackInput } from "../schemas.ts";
import { buildColumnValues, formatError } from "./utils.ts";

export async function updateFeedback(args: UpdateFeedbackInput): Promise<string> {
  try {
    const { feedbackId } = args;

    // Handle deletion
    if (args.delete) {
      const deleteMutation = `
        mutation {
          delete_item(item_id: ${feedbackId}) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(deleteMutation);
      return `# Feedback Deleted\n\nFeedback #${feedbackId} has been deleted.`;
    }

    // Build column values from provided fields
    const columnValues: Record<string, unknown> = {};
    const changes: string[] = [];

    if (args.status !== undefined) {
      columnValues[FEEDBACK_COLUMNS.status] = { index: FEEDBACK_STATUS[args.status] };
      changes.push(`Status -> ${args.status}`);
    }

    if (args.type !== undefined) {
      columnValues[FEEDBACK_COLUMNS.type] = { index: FEEDBACK_TYPE[args.type] };
      changes.push(`Type -> ${args.type}`);
    }

    if (args.priority !== undefined) {
      columnValues[FEEDBACK_COLUMNS.priority] = { index: FEEDBACK_PRIORITY[args.priority] };
      changes.push(`Priority -> ${args.priority}`);
    }

    if (args.source !== undefined) {
      columnValues[FEEDBACK_COLUMNS.source] = { index: FEEDBACK_SOURCE[args.source] };
      changes.push(`Source -> ${args.source}`);
    }

    if (args.description !== undefined) {
      columnValues[FEEDBACK_COLUMNS.description] = { text: args.description };
      changes.push(`Description updated`);
    }

    if (args.productId !== undefined) {
      columnValues[FEEDBACK_COLUMNS.product] = { item_ids: [args.productId] };
      changes.push(`Product -> #${args.productId}`);
    }

    // Execute column value update if there are changes
    if (Object.keys(columnValues).length > 0) {
      const mutation = `
        mutation {
          change_multiple_column_values(
            item_id: ${feedbackId},
            board_id: ${BOARDS.FEEDBACK},
            column_values: ${buildColumnValues(columnValues)}
          ) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(mutation);
    }

    // Handle name update separately (uses a different mutation field)
    if (args.name !== undefined) {
      const nameMutation = `
        mutation {
          change_simple_column_value(
            item_id: ${feedbackId},
            board_id: ${BOARDS.FEEDBACK},
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
      return formatError(`No fields provided to update for feedback #${feedbackId}.`);
    }

    const lines: string[] = [
      `# Feedback Updated`,
      ``,
      `**Feedback:** #${feedbackId}`,
      ``,
      `**Changes:**`,
      ...changes.map(c => `- ${c}`),
    ];

    return lines.join("\n");
  } catch (error) {
    return formatError(`Failed to update feedback: ${error instanceof Error ? error.message : String(error)}`);
  }
}
