import { executeMondayQuery } from "../monday-client";
import {
  BOARDS,
  VERSION_COLUMNS,
  VERSION_STATUS,
  VERSION_GROUPS,
  PEOPLE,
} from "../constants";
import type { CreateVersionInput } from "../schemas";
import { buildColumnValues, formatError } from "./utils";

export async function createVersion(args: CreateVersionInput): Promise<string> {
  try {
    const columnValues: Record<string, unknown> = {};

    // Status (default: Planned)
    columnValues[VERSION_COLUMNS.status] = {
      index: VERSION_STATUS[args.status || "Planned"],
    };

    // Product link (required)
    columnValues[VERSION_COLUMNS.product] = { item_ids: [args.productId] };

    // Version number
    if (args.versionNumber) {
      columnValues[VERSION_COLUMNS.versionNumber] = args.versionNumber;
    }

    // Expected release date
    if (args.expectedReleaseDate) {
      columnValues[VERSION_COLUMNS.expectedReleaseDate] = { date: args.expectedReleaseDate };
    }

    // Release date
    if (args.releaseDate) {
      columnValues[VERSION_COLUMNS.releaseDate] = { date: args.releaseDate };
    }

    // Release summary
    if (args.releaseSummary) {
      columnValues[VERSION_COLUMNS.releaseSummary] = { text: args.releaseSummary };
    }

    // Owner
    if (args.owner) {
      const ownerId = PEOPLE[args.owner];
      if (ownerId) {
        columnValues[VERSION_COLUMNS.owner] = { personsAndTeams: [{ id: ownerId, kind: "person" }] };
      }
    }

    // Link tasks
    if (args.linkTaskIds && args.linkTaskIds.length > 0) {
      columnValues[VERSION_COLUMNS.connectedTasks] = { item_ids: args.linkTaskIds };
    }

    // Link bugs
    if (args.linkBugIds && args.linkBugIds.length > 0) {
      columnValues[VERSION_COLUMNS.fixedBugs] = { item_ids: args.linkBugIds };
    }

    // Link epics
    if (args.linkEpicIds && args.linkEpicIds.length > 0) {
      columnValues[VERSION_COLUMNS.connectedEpics] = { item_ids: args.linkEpicIds };
    }

    const createQuery = `
      mutation {
        create_item(
          board_id: ${BOARDS.VERSIONS},
          group_id: "${VERSION_GROUPS.UPCOMING}",
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
      throw new Error(`Failed to create version "${args.name}"`);
    }

    const lines: string[] = [
      `# Version Created`,
      ``,
      `- **${createdItem.name}** (#${createdItem.id})`,
    ];

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to create version: ${error instanceof Error ? error.message : String(error)}`);
  }
}
