import { executeMondayQuery } from "../monday-client.ts";
import { BOARDS, VERSION_COLUMNS, VERSION_STATUS, VERSION_GROUPS, PEOPLE } from "../constants.ts";
import type { UpdateVersionInput } from "../schemas.ts";
import { buildColumnValues, formatError } from "./utils.ts";

export async function updateVersion(args: UpdateVersionInput): Promise<string> {
  try {
    const { versionId } = args;

    // Handle deletion
    if (args.delete) {
      const deleteMutation = `
        mutation {
          delete_item(item_id: ${versionId}) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(deleteMutation);
      return `# Version Deleted\n\nVersion #${versionId} has been deleted.`;
    }

    // Validate confirmRelease if status is Released
    if (args.status === "Released" && !args.confirmRelease) {
      return formatError("Setting status to 'Released' requires confirmRelease=true. This is a safety check to prevent accidental releases.");
    }

    const columnValues: Record<string, unknown> = {};
    const updates: string[] = [];

    // Status — use {label} not {index} (workspace indices drift; see
    // services/version-state-machine.ts setVersionStatus comment)
    if (args.status) {
      columnValues[VERSION_COLUMNS.status] = { label: args.status };
      updates.push(`Status → ${args.status}`);
    }

    // Version number
    if (args.versionNumber) {
      columnValues[VERSION_COLUMNS.versionNumber] = args.versionNumber;
      updates.push(`Version number → ${args.versionNumber}`);
    }

    // Expected release date
    if (args.expectedReleaseDate) {
      columnValues[VERSION_COLUMNS.expectedReleaseDate] = { date: args.expectedReleaseDate };
      updates.push(`Expected release date → ${args.expectedReleaseDate}`);
    }

    // Release date
    if (args.releaseDate) {
      columnValues[VERSION_COLUMNS.releaseDate] = { date: args.releaseDate };
      updates.push(`Release date → ${args.releaseDate}`);
    }

    // Release summary
    if (args.releaseSummary) {
      columnValues[VERSION_COLUMNS.releaseSummary] = { text: args.releaseSummary };
      updates.push("Release summary updated");
    }

    // Owner
    if (args.owner) {
      const ownerId = PEOPLE[args.owner];
      if (ownerId) {
        columnValues[VERSION_COLUMNS.owner] = { personsAndTeams: [{ id: ownerId, kind: "person" }] };
        updates.push(`Owner → ${args.owner}`);
      }
    }

    // Link tasks
    if (args.linkTaskIds && args.linkTaskIds.length > 0) {
      columnValues[VERSION_COLUMNS.connectedTasks] = { item_ids: args.linkTaskIds };
      updates.push(`Linked ${args.linkTaskIds.length} task${args.linkTaskIds.length > 1 ? "s" : ""}`);
    }

    // Link bugs
    if (args.linkBugIds && args.linkBugIds.length > 0) {
      columnValues[VERSION_COLUMNS.fixedBugs] = { item_ids: args.linkBugIds };
      updates.push(`Linked ${args.linkBugIds.length} bug${args.linkBugIds.length > 1 ? "s" : ""}`);
    }

    // Link epics
    if (args.linkEpicIds && args.linkEpicIds.length > 0) {
      columnValues[VERSION_COLUMNS.connectedEpics] = { item_ids: args.linkEpicIds };
      updates.push(`Linked ${args.linkEpicIds.length} epic${args.linkEpicIds.length > 1 ? "s" : ""}`);
    }

    // Execute column value update if there are changes
    let updatedItemName = `#${versionId}`;
    if (Object.keys(columnValues).length > 0) {
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
      updatedItemName = `${updatedItem.name} (#${updatedItem.id})`;
    }

    // Handle name update separately (uses a different mutation field)
    if (args.name !== undefined) {
      const nameMutation = `
        mutation {
          change_simple_column_value(
            item_id: ${versionId},
            board_id: ${BOARDS.VERSIONS},
            column_id: "name",
            value: ${JSON.stringify(args.name)}
          ) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(nameMutation);
      updates.push(`Name → "${args.name}"`);
    }

    // Handle group move — explicit groupId takes precedence; otherwise auto-move
    // to the Released group when status is being set to Released.
    let targetGroupId: string | undefined;
    let targetGroupLabel: string | undefined;
    if (args.groupId) {
      targetGroupId = args.groupId === "released" ? VERSION_GROUPS.RELEASED : VERSION_GROUPS.UPCOMING;
      targetGroupLabel = args.groupId;
    } else if (args.status === "Released") {
      targetGroupId = VERSION_GROUPS.RELEASED;
      targetGroupLabel = "released (auto)";
    }

    if (targetGroupId) {
      const groupMutation = `
        mutation {
          move_item_to_group(
            item_id: ${versionId},
            group_id: "${targetGroupId}"
          ) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(groupMutation);
      updates.push(`Moved to ${targetGroupLabel} group`);
    }

    if (updates.length === 0) {
      return formatError(`No fields provided to update for version #${versionId}.`);
    }

    // Format output
    const lines: string[] = [];
    lines.push("# Version Updated");
    lines.push("");
    lines.push(`- **${updatedItemName}**`);
    for (const update of updates) {
      lines.push(`  - ${update}`);
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to update version: ${error instanceof Error ? error.message : String(error)}`);
  }
}
