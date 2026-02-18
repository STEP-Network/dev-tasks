import { executeMondayQuery } from "../monday-client";
import { BOARDS, VERSION_COLUMNS, VERSION_STATUS } from "../constants";
import type { UpdateVersionInput } from "../schemas";
import { buildColumnValues, formatError } from "./utils";

export async function updateVersion(args: UpdateVersionInput): Promise<string> {
  try {
    const { versionId, status, releaseSummary, linkTaskIds, linkBugIds, linkEpicIds } = args;

    const columnValues: Record<string, unknown> = {};
    const updates: string[] = [];

    // Status
    if (status) {
      columnValues[VERSION_COLUMNS.status] = { index: VERSION_STATUS[status] };
      updates.push(`Status → ${status}`);
    }

    // Release summary
    if (releaseSummary) {
      columnValues[VERSION_COLUMNS.releaseSummary] = { text: releaseSummary };
      updates.push("Release summary updated");
    }

    // Link tasks
    if (linkTaskIds && linkTaskIds.length > 0) {
      columnValues[VERSION_COLUMNS.connectedTasks] = { item_ids: linkTaskIds };
      updates.push(`Linked ${linkTaskIds.length} task${linkTaskIds.length > 1 ? "s" : ""}`);
    }

    // Link bugs
    if (linkBugIds && linkBugIds.length > 0) {
      columnValues[VERSION_COLUMNS.fixedBugs] = { item_ids: linkBugIds };
      updates.push(`Linked ${linkBugIds.length} bug${linkBugIds.length > 1 ? "s" : ""}`);
    }

    // Link epics
    if (linkEpicIds && linkEpicIds.length > 0) {
      columnValues[VERSION_COLUMNS.connectedEpics] = { item_ids: linkEpicIds };
      updates.push(`Linked ${linkEpicIds.length} epic${linkEpicIds.length > 1 ? "s" : ""}`);
    }

    if (Object.keys(columnValues).length === 0) {
      return formatError("No updates provided. Specify at least one field to update.");
    }

    // Execute update
    const updateQuery = `
      mutation {
        change_multiple_column_values(
          board_id: ${BOARDS.VERSIONS},
          item_id: ${versionId},
          column_values: ${buildColumnValues(columnValues)}
        ) {
          id
          name
        }
      }
    `;

    const updateResponse = await executeMondayQuery<any>(updateQuery);
    const updatedItem = updateResponse.change_multiple_column_values;

    if (!updatedItem) {
      throw new Error(`Failed to update version #${versionId}.`);
    }

    // Format output
    const lines: string[] = [];
    lines.push("# Version Updated");
    lines.push("");
    lines.push(`- **${updatedItem.name}** (#${updatedItem.id})`);
    for (const update of updates) {
      lines.push(`  - ${update}`);
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to update version: ${error instanceof Error ? error.message : String(error)}`);
  }
}
