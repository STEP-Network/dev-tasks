import { executeMondayQuery } from "../monday-client";
import {
  BOARDS,
  EPIC_COLUMNS,
  EPIC_STATUS,
  EPIC_PRIORITY,
  PEOPLE,
} from "../constants";
import type { UpdateEpicInput } from "../schemas";
import { buildColumnValues, formatError } from "./utils";

export async function updateEpic(args: UpdateEpicInput): Promise<string> {
  try {
    const { epicId } = args;

    // Handle deletion
    if (args.delete) {
      const deleteMutation = `
        mutation {
          delete_item(item_id: ${epicId}) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(deleteMutation);
      return `# Epic Deleted\n\nEpic #${epicId} has been deleted.`;
    }

    // Build column values from provided fields
    const columnValues: Record<string, unknown> = {};
    const changes: string[] = [];

    if (args.status !== undefined) {
      columnValues[EPIC_COLUMNS.status] = { index: EPIC_STATUS[args.status] };
      changes.push(`Status -> ${args.status}`);
    }

    if (args.priority !== undefined) {
      columnValues[EPIC_COLUMNS.priority] = { index: EPIC_PRIORITY[args.priority] };
      changes.push(`Priority -> ${args.priority}`);
    }

    if (args.description !== undefined) {
      columnValues[EPIC_COLUMNS.description] = { text: args.description };
      changes.push(`Description updated`);
    }

    if (args.owner !== undefined) {
      const ownerId = PEOPLE[args.owner];
      if (ownerId) {
        columnValues[EPIC_COLUMNS.owner] = { personsAndTeams: [{ id: ownerId, kind: "person" }] };
        changes.push(`Owner -> ${args.owner}`);
      }
    }

    if (args.deadline !== undefined) {
      columnValues[EPIC_COLUMNS.deadline] = { date: args.deadline };
      changes.push(`Deadline -> ${args.deadline}`);
    }

    if (args.timelineStart && args.timelineEnd) {
      columnValues[EPIC_COLUMNS.timeline] = { from: args.timelineStart, to: args.timelineEnd };
      changes.push(`Timeline -> ${args.timelineStart} to ${args.timelineEnd}`);
    }

    if (args.productId !== undefined) {
      columnValues[EPIC_COLUMNS.product] = { item_ids: [args.productId] };
      changes.push(`Product -> #${args.productId}`);
    }

    if (args.versionId !== undefined) {
      columnValues[EPIC_COLUMNS.targetVersion] = { item_ids: [args.versionId] };
      changes.push(`Version -> #${args.versionId}`);
    }

    // Execute column value update if there are changes
    if (Object.keys(columnValues).length > 0) {
      const mutation = `
        mutation {
          change_multiple_column_values(
            item_id: ${epicId},
            board_id: ${BOARDS.EPICS},
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
            item_id: ${epicId},
            board_id: ${BOARDS.EPICS},
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
      return formatError(`No fields provided to update for epic #${epicId}.`);
    }

    const lines: string[] = [
      `# Epic Updated`,
      ``,
      `**Epic:** #${epicId}`,
      ``,
      `**Changes:**`,
      ...changes.map(c => `- ${c}`),
    ];

    return lines.join("\n");
  } catch (error) {
    return formatError(`Failed to update epic: ${error instanceof Error ? error.message : String(error)}`);
  }
}
