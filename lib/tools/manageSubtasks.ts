import { executeMondayQuery } from "../monday-client";
import {
  BOARDS,
  SUBTASK_COLUMNS,
  SUBTASK_STATUS,
  SUBTASK_TYPE,
} from "../constants";
import type { ManageSubtasksInput } from "../schemas";
import { buildColumnValues, formatError } from "./utils";

// Fetch existing subtasks for a parent task (used for name-based lookups)
async function fetchSubtasks(parentItemId: number): Promise<Array<{ id: string; name: string }>> {
  const query = `
    query {
      items(ids: [${parentItemId}]) {
        subitems {
          id
          name
        }
      }
    }
  `;
  const response = await executeMondayQuery<any>(query);
  return response.items?.[0]?.subitems || [];
}

// Resolve a subtask ID from either subtaskId or subtaskName
function resolveSubtaskId(
  subtaskId: string | undefined,
  subtaskName: string | undefined,
  existingSubtasks: Array<{ id: string; name: string }>,
  actionLabel: string,
): string {
  if (subtaskId) return subtaskId;

  if (subtaskName) {
    const match = existingSubtasks.find(
      s => s.name.toLowerCase() === subtaskName.toLowerCase()
    );
    if (match) return match.id;

    // Try partial match
    const partialMatch = existingSubtasks.find(
      s => s.name.toLowerCase().includes(subtaskName.toLowerCase())
    );
    if (partialMatch) return partialMatch.id;

    throw new Error(
      `Cannot ${actionLabel}: subtask named "${subtaskName}" not found. ` +
      `Available subtasks: ${existingSubtasks.map(s => `"${s.name}" (#${s.id})`).join(", ") || "none"}`
    );
  }

  throw new Error(`Cannot ${actionLabel}: either subtaskId or subtaskName is required.`);
}

export async function manageSubtasks(args: ManageSubtasksInput): Promise<string> {
  try {
    const { parentItemId, operations } = args;

    // Determine if we need to fetch existing subtasks for name-based lookups
    const needsLookup = operations.some(
      op => (op.action === "update" || op.action === "delete") && !op.subtaskId && op.subtaskName
    );

    let existingSubtasks: Array<{ id: string; name: string }> = [];
    if (needsLookup) {
      existingSubtasks = await fetchSubtasks(parentItemId);
    }

    const results: string[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (const op of operations) {
      try {
        switch (op.action) {
          // =================================================================
          // CREATE
          // =================================================================
          case "create": {
            const columnValues: Record<string, unknown> = {};

            if (op.status !== undefined) {
              columnValues[SUBTASK_COLUMNS.status] = { index: SUBTASK_STATUS[op.status] };
            }

            if (op.type !== undefined) {
              columnValues[SUBTASK_COLUMNS.type] = { index: SUBTASK_TYPE[op.type] };
            }

            if (op.description !== undefined) {
              columnValues[SUBTASK_COLUMNS.description] = { text: op.description };
            }

            if (op.estimatedHours !== undefined) {
              columnValues[SUBTASK_COLUMNS.estimatedHours] = String(op.estimatedHours);
            }

            if (op.date !== undefined) {
              columnValues[SUBTASK_COLUMNS.date] = { date: op.date };
            }

            if (op.owner !== undefined) {
              columnValues[SUBTASK_COLUMNS.owner] = { personsAndTeams: [{ id: op.owner, kind: "person" }] };
            }

            const hasColumnValues = Object.keys(columnValues).length > 0;
            const columnValuesArg = hasColumnValues
              ? `, column_values: ${buildColumnValues(columnValues)}`
              : "";

            const createMutation = `
              mutation {
                create_subitem(
                  parent_item_id: ${parentItemId},
                  item_name: ${JSON.stringify(op.name)}
                  ${columnValuesArg}
                ) {
                  id
                  name
                }
              }
            `;

            const createResponse = await executeMondayQuery<any>(createMutation);
            const created = createResponse.create_subitem;
            results.push(`Created: "${created.name}" (#${created.id})`);
            successCount++;
            break;
          }

          // =================================================================
          // UPDATE
          // =================================================================
          case "update": {
            const subtaskId = resolveSubtaskId(
              op.subtaskId,
              op.subtaskName,
              existingSubtasks,
              "update"
            );

            const columnValues: Record<string, unknown> = {};
            const updateDetails: string[] = [];

            if (op.status !== undefined) {
              columnValues[SUBTASK_COLUMNS.status] = { index: SUBTASK_STATUS[op.status] };
              updateDetails.push(`status -> ${op.status}`);
            }

            if (op.type !== undefined) {
              columnValues[SUBTASK_COLUMNS.type] = { index: SUBTASK_TYPE[op.type] };
              updateDetails.push(`type -> ${op.type}`);
            }

            if (op.description !== undefined) {
              columnValues[SUBTASK_COLUMNS.description] = { text: op.description };
              updateDetails.push(`description updated`);
            }

            if (op.estimatedHours !== undefined) {
              columnValues[SUBTASK_COLUMNS.estimatedHours] = String(op.estimatedHours);
              updateDetails.push(`estimated hours -> ${op.estimatedHours}`);
            }

            if (op.actualHours !== undefined) {
              columnValues[SUBTASK_COLUMNS.actualHours] = String(op.actualHours);
              updateDetails.push(`actual hours -> ${op.actualHours}`);
            }

            if (op.date !== undefined) {
              columnValues[SUBTASK_COLUMNS.date] = { date: op.date };
              updateDetails.push(`date -> ${op.date}`);
            }

            if (op.owner !== undefined) {
              columnValues[SUBTASK_COLUMNS.owner] = { personsAndTeams: [{ id: op.owner, kind: "person" }] };
              updateDetails.push(`owner -> person #${op.owner}`);
            }

            // Update column values if any
            if (Object.keys(columnValues).length > 0) {
              const updateMutation = `
                mutation {
                  change_multiple_column_values(
                    item_id: ${subtaskId},
                    board_id: ${BOARDS.SUBTASKS},
                    column_values: ${buildColumnValues(columnValues)}
                  ) {
                    id
                  }
                }
              `;
              await executeMondayQuery<any>(updateMutation);
            }

            // Handle name update separately
            if (op.name !== undefined) {
              const nameMutation = `
                mutation {
                  change_simple_column_value(
                    item_id: ${subtaskId},
                    board_id: ${BOARDS.SUBTASKS},
                    column_id: "name",
                    value: ${JSON.stringify(op.name)}
                  ) {
                    id
                  }
                }
              `;
              await executeMondayQuery<any>(nameMutation);
              updateDetails.push(`name -> "${op.name}"`);
            }

            const label = op.subtaskName ? `"${op.subtaskName}"` : `#${subtaskId}`;
            results.push(`Updated ${label} (#${subtaskId}): ${updateDetails.join(", ") || "no changes"}`);
            successCount++;
            break;
          }

          // =================================================================
          // DELETE
          // =================================================================
          case "delete": {
            const subtaskId = resolveSubtaskId(
              op.subtaskId,
              op.subtaskName,
              existingSubtasks,
              "delete"
            );

            const deleteMutation = `
              mutation {
                delete_item(item_id: ${subtaskId}) {
                  id
                }
              }
            `;
            await executeMondayQuery<any>(deleteMutation);

            const label = op.subtaskName ? `"${op.subtaskName}"` : `#${subtaskId}`;
            results.push(`Deleted: ${label} (#${subtaskId})`);
            successCount++;
            break;
          }
        }
      } catch (opError) {
        const errorMsg = opError instanceof Error ? opError.message : String(opError);
        results.push(`Error (${op.action}): ${errorMsg}`);
        errorCount++;
      }
    }

    // Return summary
    const lines: string[] = [
      `# Subtask Operations — Parent #${parentItemId}`,
      ``,
      `**Results:** ${successCount} succeeded, ${errorCount} failed`,
      ``,
      ...results.map(r => `- ${r}`),
    ];

    return lines.join("\n");
  } catch (error) {
    return formatError(`Failed to manage subtasks: ${error instanceof Error ? error.message : String(error)}`);
  }
}
