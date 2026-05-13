import { executeMondayQuery } from "../monday-client";
import {
  BOARDS,
  TASK_COLUMNS,
  TASK_STATUS,
  TASK_PRIORITY,
  TASK_TYPE,
  SUBTASK_COLUMNS,
  SUBTASK_STATUS,
  SUBTASK_TYPE,
  AGENT_ID,
  PEOPLE,
} from "../constants";
import type { CreateTaskInput } from "../schemas";
import { buildColumnValues, formatError } from "./utils";

export async function createTask(args: CreateTaskInput): Promise<string> {
  try {
    const results: Array<{ id: string; name: string; subitemCount: number }> = [];

    for (const task of args.tasks) {
      // Build column values for the parent task
      const columnValues: Record<string, unknown> = {};

      // Type (required)
      columnValues[TASK_COLUMNS.type] = { index: TASK_TYPE[task.type] };

      // Priority (required)
      columnValues[TASK_COLUMNS.priority] = { index: TASK_PRIORITY[task.priority] };

      // Status (default: Needs Refinement — caller can pass "Ready to Start" if already refined)
      columnValues[TASK_COLUMNS.status] = {
        index: TASK_STATUS[task.status || "Needs Refinement"],
      };

      // Optional fields
      if (task.description) {
        columnValues[TASK_COLUMNS.description] = { text: task.description };
      }

      if (task.dueDate) {
        columnValues[TASK_COLUMNS.dueDate] = { date: task.dueDate };
      }

      if (task.epicId) {
        columnValues[TASK_COLUMNS.epic] = { item_ids: [task.epicId] };
      }

      if (task.sprintId) {
        columnValues[TASK_COLUMNS.sprint] = { item_ids: [task.sprintId] };
      }

      if (task.versionId) {
        columnValues[TASK_COLUMNS.targetVersion] = { item_ids: [task.versionId] };
      }

      if (task.agentId) {
        columnValues[TASK_COLUMNS.agentId] = { ids: [String(AGENT_ID[task.agentId])] };
      }

      if (task.planId) {
        columnValues[TASK_COLUMNS.planId] = task.planId;
      }

      if (task.unplanned !== undefined) {
        columnValues[TASK_COLUMNS.unplanned] = { checked: task.unplanned ? "true" : "false" };
      }

      // Owner — map system username to Monday.com person ID
      if (task.owner) {
        const ownerId = PEOPLE[task.owner];
        if (ownerId) {
          columnValues[TASK_COLUMNS.owner] = { personsAndTeams: [{ id: ownerId, kind: "person" }] };
        }
      }

      // Acceptance criteria
      if (task.acceptanceCriteria) {
        columnValues[TASK_COLUMNS.acceptanceCriteria] = { text: task.acceptanceCriteria };
      }

      // Branch name
      if (task.branch) {
        columnValues[TASK_COLUMNS.branch] = task.branch;
      }

      // Create parent task
      const createQuery = `
        mutation {
          create_item(
            board_id: ${BOARDS.TASKS},
            group_id: "topics",
            item_name: ${JSON.stringify(task.name)},
            column_values: ${buildColumnValues(columnValues)}
          ) {
            id
            name
          }
        }
      `;

      const createResponse = await executeMondayQuery<any>(createQuery);
      const createdItem = createResponse.create_item;

      if (!createdItem) {
        throw new Error(`Failed to create task "${task.name}"`);
      }

      // Set dependencies after creation (dependency column requires a separate mutation)
      if (task.dependencyIds && task.dependencyIds.length > 0) {
        const depValues: Record<string, unknown> = {
          [TASK_COLUMNS.dependencies]: { item_ids: task.dependencyIds },
        };
        const depMutation = `
          mutation {
            change_multiple_column_values(
              item_id: ${createdItem.id},
              board_id: ${BOARDS.TASKS},
              column_values: ${buildColumnValues(depValues)}
            ) { id }
          }
        `;
        await executeMondayQuery<any>(depMutation);
      }

      let subitemCount = 0;

      // Create subitems if provided
      if (task.subitems && task.subitems.length > 0) {
        for (const subitem of task.subitems) {
          const subColumnValues: Record<string, unknown> = {};

          if (subitem.status) {
            subColumnValues[SUBTASK_COLUMNS.status] = { index: SUBTASK_STATUS[subitem.status] };
          }

          if (subitem.type) {
            subColumnValues[SUBTASK_COLUMNS.type] = { index: SUBTASK_TYPE[subitem.type] };
          }

          if (subitem.description) {
            subColumnValues[SUBTASK_COLUMNS.description] = { text: subitem.description };
          }

          if (subitem.estimatedHours !== undefined) {
            subColumnValues[SUBTASK_COLUMNS.estimatedHours] = String(subitem.estimatedHours);
          }

          const subQuery = `
            mutation {
              create_subitem(
                parent_item_id: ${createdItem.id},
                item_name: ${JSON.stringify(subitem.name)},
                column_values: ${buildColumnValues(subColumnValues)}
              ) {
                id
              }
            }
          `;

          await executeMondayQuery<any>(subQuery);
          subitemCount++;
        }
      }

      results.push({
        id: createdItem.id,
        name: createdItem.name,
        subitemCount,
      });
    }

    // Format output
    const lines: string[] = [];
    lines.push(`# Created ${results.length} Task${results.length > 1 ? "s" : ""}`);
    lines.push("");

    for (const result of results) {
      lines.push(`- **${result.name}** (#${result.id})`);
      if (result.subitemCount > 0) {
        lines.push(`  Subitems created: ${result.subitemCount}`);
      }
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to create task: ${error instanceof Error ? error.message : String(error)}`);
  }
}
