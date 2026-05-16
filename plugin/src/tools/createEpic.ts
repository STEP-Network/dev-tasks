import { executeMondayQuery } from "../monday-client.ts";
import {
  BOARDS,
  EPIC_COLUMNS,
  EPIC_STATUS,
  EPIC_PRIORITY,
  EPIC_GROUPS,
  PEOPLE,
} from "../constants.ts";
import type { CreateEpicInput } from "../schemas.ts";
import { buildColumnValues, formatError } from "./utils.ts";

export async function createEpic(args: CreateEpicInput): Promise<string> {
  try {
    const columnValues: Record<string, unknown> = {};

    // Status (default: Backlog)
    columnValues[EPIC_COLUMNS.status] = {
      index: EPIC_STATUS[args.status || "Backlog"],
    };

    // Priority
    if (args.priority) {
      columnValues[EPIC_COLUMNS.priority] = { index: EPIC_PRIORITY[args.priority] };
    }

    // Description
    if (args.description) {
      columnValues[EPIC_COLUMNS.description] = { text: args.description };
    }

    // Owner
    if (args.owner) {
      const ownerId = PEOPLE[args.owner];
      if (ownerId) {
        columnValues[EPIC_COLUMNS.owner] = { personsAndTeams: [{ id: ownerId, kind: "person" }] };
      }
    }

    // Deadline
    if (args.deadline) {
      columnValues[EPIC_COLUMNS.deadline] = { date: args.deadline };
    }

    // Timeline (requires both start and end)
    if (args.timelineStart && args.timelineEnd) {
      columnValues[EPIC_COLUMNS.timeline] = { from: args.timelineStart, to: args.timelineEnd };
    }

    // Product link
    if (args.productId) {
      columnValues[EPIC_COLUMNS.product] = { item_ids: [args.productId] };
    }

    // Version link
    if (args.versionId) {
      columnValues[EPIC_COLUMNS.targetVersion] = { item_ids: [args.versionId] };
    }

    const createQuery = `
      mutation {
        create_item(
          board_id: ${BOARDS.EPICS},
          group_id: "${EPIC_GROUPS.BACKLOG}",
          item_name: ${JSON.stringify(args.name)},
          column_values: ${buildColumnValues(columnValues)}
        ) {
          id
          name
        }
      }
    `;

    const response = await executeMondayQuery<any>(createQuery);
    const createdItem = response.create_item;

    if (!createdItem) {
      throw new Error(`Failed to create epic "${args.name}"`);
    }

    const lines: string[] = [
      `# Epic Created`,
      ``,
      `- **${createdItem.name}** (#${createdItem.id})`,
    ];

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to create epic: ${error instanceof Error ? error.message : String(error)}`);
  }
}
