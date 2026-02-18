import { executeMondayQuery } from "../monday-client";
import {
  BOARDS,
  TASK_COLUMNS,
  TASK_STATUS,
  TASK_PRIORITY,
  TASK_TYPE,
  BUG_COLUMNS,
  BUG_STATUS,
  AGENT_ID,
} from "../constants";
import type { ConvertBugToTaskInput } from "../schemas";
import { buildColumnValues, getColumnText, formatError } from "./utils";

export async function convertBugToTask(args: ConvertBugToTaskInput): Promise<string> {
  try {
    const { bugId, epicId, sprintId, agentId, planId, additionalDescription } = args;

    // Step 1: Fetch the bug details
    const bugQuery = `
      query {
        items(ids: [${bugId}]) {
          id
          name
          column_values(ids: [
            "${BUG_COLUMNS.status}",
            "${BUG_COLUMNS.priority}",
            "${BUG_COLUMNS.description}",
            "${BUG_COLUMNS.product}"
          ]) {
            id
            text
            value
            ... on BoardRelationValue { linked_items { id name } }
          }
        }
      }
    `;

    const bugResponse = await executeMondayQuery<any>(bugQuery);
    const bug = bugResponse.items?.[0];

    if (!bug) {
      return formatError(`Bug #${bugId} not found.`);
    }

    const colMap = new Map<string, any>(
      bug.column_values?.map((c: any) => [c.id, c]) || []
    );

    // Extract bug fields
    const bugName = bug.name;
    const bugPriority = getColumnText(colMap, BUG_COLUMNS.priority) || "Medium";
    const bugDescription = getColumnText(colMap, BUG_COLUMNS.description) || "";

    // Map bug priority to task priority
    const priorityMap: Record<string, string> = {
      "Critical": "Critical",
      "High": "High",
      "Medium": "Medium",
      "Low": "Low",
    };
    const taskPriority = priorityMap[bugPriority] || "Medium";

    // Combine descriptions
    let fullDescription = bugDescription;
    if (additionalDescription) {
      fullDescription = fullDescription
        ? `${fullDescription}\n\n---\n\n${additionalDescription}`
        : additionalDescription;
    }

    // Step 2: Create the new task
    const taskColumnValues: Record<string, unknown> = {};

    taskColumnValues[TASK_COLUMNS.type] = { index: TASK_TYPE["Bugfix"] };
    taskColumnValues[TASK_COLUMNS.priority] = { index: TASK_PRIORITY[taskPriority] };
    taskColumnValues[TASK_COLUMNS.status] = { index: TASK_STATUS["Ready to Start"] };

    if (fullDescription) {
      taskColumnValues[TASK_COLUMNS.description] = { text: fullDescription };
    }

    if (epicId) {
      taskColumnValues[TASK_COLUMNS.epic] = { item_ids: [epicId] };
    }

    if (sprintId) {
      taskColumnValues[TASK_COLUMNS.sprint] = { item_ids: [sprintId] };
    }

    if (agentId) {
      taskColumnValues[TASK_COLUMNS.agentId] = { ids: [String(AGENT_ID[agentId])] };
    }

    if (planId) {
      taskColumnValues[TASK_COLUMNS.planId] = planId;
    }

    const createQuery = `
      mutation {
        create_item(
          board_id: ${BOARDS.TASKS},
          group_id: "topics",
          item_name: ${JSON.stringify(bugName)},
          column_values: ${buildColumnValues(taskColumnValues)}
        ) {
          id
          name
        }
      }
    `;

    const createResponse = await executeMondayQuery<any>(createQuery);
    const newTask = createResponse.create_item;

    if (!newTask) {
      return formatError("Failed to create task from bug.");
    }

    // Step 3: Link the new task to the bug (update bug's connectedTasks column)
    const linkColumnValues: Record<string, unknown> = {
      [BUG_COLUMNS.connectedTasks]: { item_ids: [Number(newTask.id)] },
    };

    const linkQuery = `
      mutation {
        change_multiple_column_values(
          board_id: ${BOARDS.BUGS},
          item_id: ${bugId},
          column_values: ${buildColumnValues(linkColumnValues)}
        ) {
          id
        }
      }
    `;

    await executeMondayQuery<any>(linkQuery);

    // Step 4: Update bug status to "Fixing"
    const statusColumnValues: Record<string, unknown> = {
      [BUG_COLUMNS.status]: { index: BUG_STATUS["Fixing"] },
    };

    const statusQuery = `
      mutation {
        change_multiple_column_values(
          board_id: ${BOARDS.BUGS},
          item_id: ${bugId},
          column_values: ${buildColumnValues(statusColumnValues)}
        ) {
          id
        }
      }
    `;

    await executeMondayQuery<any>(statusQuery);

    // Format output
    const lines: string[] = [];
    lines.push("# Bug Converted to Task");
    lines.push("");
    lines.push(`- **New Task:** ${newTask.name} (#${newTask.id})`);
    lines.push(`  Type: Bugfix | Priority: ${taskPriority} | Status: Ready to Start`);
    lines.push("");
    lines.push(`- **Bug #${bugId}:** Status updated to Fixing, linked to task #${newTask.id}`);

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to convert bug to task: ${error instanceof Error ? error.message : String(error)}`);
  }
}
