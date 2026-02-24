import { executeMondayQuery } from "../monday-client";
import {
  BOARDS,
  TASK_COLUMNS,
  TASK_STATUS,
  TASK_PRIORITY,
  TASK_TYPE,
  FEEDBACK_COLUMNS,
  FEEDBACK_STATUS,
} from "../constants";
import type { ConvertFeedbackToTaskInput } from "../schemas";
import { buildColumnValues, getColumnText, formatError } from "./utils";

export async function convertFeedbackToTask(args: ConvertFeedbackToTaskInput): Promise<string> {
  try {
    const { feedbackId, epicId, sprintId, taskType, additionalDescription } = args;

    // Step 1: Fetch the feedback item
    const feedbackQuery = `
      query {
        items(ids: [${feedbackId}]) {
          id
          name
          column_values(ids: [
            "${FEEDBACK_COLUMNS.type}",
            "${FEEDBACK_COLUMNS.priority}",
            "${FEEDBACK_COLUMNS.description}"
          ]) {
            id
            text
            value
          }
        }
      }
    `;

    const feedbackResponse = await executeMondayQuery<any>(feedbackQuery);
    const feedbackItem = feedbackResponse.items?.[0];

    if (!feedbackItem) {
      return formatError(`Feedback item #${feedbackId} not found.`);
    }

    const colMap = new Map<string, any>(
      feedbackItem.column_values?.map((c: any) => [c.id, c]) || []
    );

    // Extract fields
    const itemName = feedbackItem.name;
    const itemType = getColumnText(colMap, FEEDBACK_COLUMNS.type) || "Request";
    const itemPriority = getColumnText(colMap, FEEDBACK_COLUMNS.priority) || "Medium";
    const itemDescription = getColumnText(colMap, FEEDBACK_COLUMNS.description) || "";

    // Map feedback priority to task priority
    const priorityMap: Record<string, string> = {
      "Critical": "Critical",
      "High": "High",
      "Medium": "Medium",
      "Low": "Low",
    };
    const taskPriority = priorityMap[itemPriority] || "Medium";

    // Determine task type: explicit override > inferred from feedback type
    const resolvedTaskType = taskType || (itemType === "Request" ? "Development" : "Maintenance");

    // Combine descriptions
    let fullDescription = itemDescription;
    if (additionalDescription) {
      fullDescription = fullDescription
        ? `${fullDescription}\n\n---\n\n${additionalDescription}`
        : additionalDescription;
    }

    // Step 2: Create the new task
    const taskColumnValues: Record<string, unknown> = {};

    taskColumnValues[TASK_COLUMNS.type] = { index: TASK_TYPE[resolvedTaskType] };
    taskColumnValues[TASK_COLUMNS.priority] = { index: TASK_PRIORITY[taskPriority] };
    taskColumnValues[TASK_COLUMNS.status] = { index: TASK_STATUS["Ready to Start"] };

    // Link task back to feedback item via the two-way relation
    taskColumnValues[TASK_COLUMNS.feedback] = { item_ids: [feedbackId] };

    if (fullDescription) {
      taskColumnValues[TASK_COLUMNS.description] = { text: fullDescription };
    }

    if (epicId) {
      taskColumnValues[TASK_COLUMNS.epic] = { item_ids: [epicId] };
    }

    if (sprintId) {
      taskColumnValues[TASK_COLUMNS.sprint] = { item_ids: [sprintId] };
    }

    const createQuery = `
      mutation {
        create_item(
          board_id: ${BOARDS.TASKS},
          group_id: "topics",
          item_name: ${JSON.stringify(itemName)},
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
      return formatError("Failed to create task from feedback item.");
    }

    // Step 3: Update feedback status to "Converted"
    const statusColumnValues: Record<string, unknown> = {
      [FEEDBACK_COLUMNS.status]: { index: FEEDBACK_STATUS["Converted"] },
    };

    const statusQuery = `
      mutation {
        change_multiple_column_values(
          board_id: ${BOARDS.FEEDBACK},
          item_id: ${feedbackId},
          column_values: ${buildColumnValues(statusColumnValues)}
        ) {
          id
        }
      }
    `;

    await executeMondayQuery<any>(statusQuery);

    // Format output
    const lines: string[] = [];
    lines.push("# Feedback Converted to Task");
    lines.push("");
    lines.push(`- **New Task:** ${newTask.name} (#${newTask.id})`);
    lines.push(`  Type: ${resolvedTaskType} | Priority: ${taskPriority} | Status: Ready to Start`);
    lines.push("");
    lines.push(`- **${itemType} #${feedbackId}:** Status updated to Converted, linked to task #${newTask.id}`);

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to convert feedback to task: ${error instanceof Error ? error.message : String(error)}`);
  }
}
