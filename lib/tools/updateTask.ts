import { executeMondayQuery } from "../monday-client";
import {
  BOARDS,
  TASK_COLUMNS,
  TASK_STATUS,
  TASK_PRIORITY,
  TASK_TYPE,
  AGENT_ID,
} from "../constants";
import type { UpdateTaskInput } from "../schemas";
import { buildColumnValues, formatError, formatSubtask } from "./utils";

export async function updateTask(args: UpdateTaskInput): Promise<string> {
  try {
    const { itemId } = args;

    // Handle deletion
    if (args.delete) {
      const deleteMutation = `
        mutation {
          delete_item(item_id: ${itemId}) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(deleteMutation);
      return `# Task Deleted\n\nTask #${itemId} has been deleted.`;
    }

    // Build column values from provided fields
    const columnValues: Record<string, unknown> = {};
    const changes: string[] = [];

    if (args.status !== undefined) {
      // If setting status to Done, validate all subtasks are Done/Rejected first
      if (args.status === "Done") {
        const subtaskQuery = `
          query {
            items(ids: [${itemId}]) {
              subitems {
                id
                name
                column_values(ids: ["status"]) {
                  id
                  text
                }
              }
            }
          }
        `;
        const subtaskResponse = await executeMondayQuery<any>(subtaskQuery);
        const subitems = subtaskResponse.items?.[0]?.subitems || [];

        if (subitems.length > 0) {
          const incomplete = subitems.filter((sub: any) => {
            const formatted = formatSubtask(sub);
            return formatted.status !== "Done" && formatted.status !== "Rejected";
          });

          if (incomplete.length > 0) {
            const incompleteList = incomplete
              .map((sub: any) => {
                const formatted = formatSubtask(sub);
                return `  - #${formatted.id} "${formatted.name}" (${formatted.status})`;
              })
              .join("\n");
            return formatError(
              `Cannot set task #${itemId} to "Done".\n` +
              `The following subtasks are not Done/Rejected:\n${incompleteList}\n\n` +
              `Mark all subtasks as Done or Rejected first (Monday.com automation will auto-complete the parent).`
            );
          }
        }
      }
      columnValues[TASK_COLUMNS.status] = { index: TASK_STATUS[args.status] };
      changes.push(`Status -> ${args.status}`);
    }

    if (args.priority !== undefined) {
      columnValues[TASK_COLUMNS.priority] = { index: TASK_PRIORITY[args.priority] };
      changes.push(`Priority -> ${args.priority}`);
    }

    if (args.type !== undefined) {
      columnValues[TASK_COLUMNS.type] = { index: TASK_TYPE[args.type] };
      changes.push(`Type -> ${args.type}`);
    }

    if (args.description !== undefined) {
      columnValues[TASK_COLUMNS.description] = { text: args.description };
      changes.push(`Description updated`);
    }

    if (args.estimatedHours !== undefined) {
      columnValues[TASK_COLUMNS.estimatedHours] = String(args.estimatedHours);
      changes.push(`Estimated Hours -> ${args.estimatedHours}`);
    }

    if (args.actualHours !== undefined) {
      columnValues[TASK_COLUMNS.actualHours] = String(args.actualHours);
      changes.push(`Actual Hours -> ${args.actualHours}`);
    }

    if (args.dueDate !== undefined) {
      columnValues[TASK_COLUMNS.dueDate] = { date: args.dueDate };
      changes.push(`Due Date -> ${args.dueDate}`);
    }

    if (args.startedDate !== undefined) {
      columnValues[TASK_COLUMNS.startedDate] = { date: args.startedDate };
      changes.push(`Started Date -> ${args.startedDate}`);
    }

    if (args.epicId !== undefined) {
      columnValues[TASK_COLUMNS.epic] = { item_ids: [args.epicId] };
      changes.push(`Epic -> #${args.epicId}`);
    }

    if (args.sprintId !== undefined) {
      columnValues[TASK_COLUMNS.sprint] = { item_ids: [args.sprintId] };
      changes.push(`Sprint -> #${args.sprintId}`);
    }

    if (args.versionId !== undefined) {
      columnValues[TASK_COLUMNS.targetVersion] = { item_ids: [args.versionId] };
      changes.push(`Version -> #${args.versionId}`);
    }

    if (args.githubLink !== undefined) {
      columnValues[TASK_COLUMNS.githubLink] = { url: args.githubLink, text: "GitHub" };
      changes.push(`GitHub Link -> ${args.githubLink}`);
    }

    if (args.prLink !== undefined) {
      columnValues[TASK_COLUMNS.prLink] = { url: args.prLink, text: "PR" };
      changes.push(`PR Link -> ${args.prLink}`);
    }

    if (args.demoUrl !== undefined) {
      columnValues[TASK_COLUMNS.demoUrl] = { url: args.demoUrl, text: "Demo" };
      changes.push(`Demo URL -> ${args.demoUrl}`);
    }

    if (args.agentId !== undefined) {
      columnValues[TASK_COLUMNS.agentId] = { ids: [String(AGENT_ID[args.agentId])] };
      changes.push(`Agent -> ${args.agentId}`);
    }

    if (args.planId !== undefined) {
      columnValues[TASK_COLUMNS.planId] = args.planId;
      changes.push(`Plan ID -> ${args.planId}`);
    }

    if (args.unplanned !== undefined) {
      columnValues[TASK_COLUMNS.unplanned] = { checked: args.unplanned ? "true" : "false" };
      changes.push(`Unplanned -> ${args.unplanned}`);
    }

    // New columns that may not exist yet -- handle gracefully
    if (args.branch !== undefined) {
      try {
        // Attempt to set branch column if it exists in TASK_COLUMNS
        const branchColumnId = (TASK_COLUMNS as Record<string, string>)["branch"];
        if (branchColumnId) {
          columnValues[branchColumnId] = args.branch;
          changes.push(`Branch -> ${args.branch}`);
        } else {
          changes.push(`Branch -> skipped (column not configured)`);
        }
      } catch {
        changes.push(`Branch -> skipped (column not configured)`);
      }
    }

    if (args.acceptanceCriteria !== undefined) {
      try {
        const acColumnId = (TASK_COLUMNS as Record<string, string>)["acceptanceCriteria"];
        if (acColumnId) {
          columnValues[acColumnId] = { text: args.acceptanceCriteria };
          changes.push(`Acceptance Criteria updated`);
        } else {
          changes.push(`Acceptance Criteria -> skipped (column not configured)`);
        }
      } catch {
        changes.push(`Acceptance Criteria -> skipped (column not configured)`);
      }
    }

    if (args.dependencyIds !== undefined) {
      try {
        const depColumnId = (TASK_COLUMNS as Record<string, string>)["dependencies"];
        if (depColumnId) {
          columnValues[depColumnId] = { item_ids: args.dependencyIds };
          changes.push(`Dependencies -> [${args.dependencyIds.join(", ")}]`);
        } else {
          changes.push(`Dependencies -> skipped (column not configured)`);
        }
      } catch {
        changes.push(`Dependencies -> skipped (column not configured)`);
      }
    }

    // Execute column value update if there are changes
    if (Object.keys(columnValues).length > 0) {
      const mutation = `
        mutation {
          change_multiple_column_values(
            item_id: ${itemId},
            board_id: ${BOARDS.TASKS},
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
            item_id: ${itemId},
            board_id: ${BOARDS.TASKS},
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
      return formatError(`No fields provided to update for task #${itemId}.`);
    }

    // Return summary
    const lines: string[] = [
      `# Task Updated`,
      ``,
      `**Task:** #${itemId}`,
      ``,
      `**Changes:**`,
      ...changes.map(c => `- ${c}`),
    ];

    return lines.join("\n");
  } catch (error) {
    return formatError(`Failed to update task: ${error instanceof Error ? error.message : String(error)}`);
  }
}
