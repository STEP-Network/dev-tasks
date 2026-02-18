import { executeMondayQuery } from "../monday-client";
import { BOARDS, TASK_COLUMNS, TASK_STATUS, AGENT_ID } from "../constants";
import type { GetBacklogInput } from "../schemas";
import { getColumnText, getLinkedItems, formatError } from "./utils";

export async function getBacklog(args: GetBacklogInput): Promise<string> {
  try {
    const { status, type, unclaimedOnly = false, agentId, epicId, sprintId, limit = 25 } = args;

    // Build query_params rules
    const rules: string[] = [];

    if (status) {
      const statusIndex = TASK_STATUS[status];
      rules.push(`{ column_id: "${TASK_COLUMNS.status}", compare_value: [${statusIndex}], operator: any_of }`);
    } else {
      // Default: Backlog + Ready to Start
      rules.push(`{ column_id: "${TASK_COLUMNS.status}", compare_value: [${TASK_STATUS["Backlog"]}, ${TASK_STATUS["Ready to Start"]}], operator: any_of }`);
    }

    if (unclaimedOnly) {
      rules.push(`{ column_id: "${TASK_COLUMNS.agentId}", compare_value: [], operator: is_empty }`);
    }

    if (agentId) {
      const agentIndex = AGENT_ID[agentId];
      rules.push(`{ column_id: "${TASK_COLUMNS.agentId}", compare_value: [${agentIndex}], operator: any_of }`);
    }

    if (epicId) {
      rules.push(`{ column_id: "${TASK_COLUMNS.epic}", compare_value: [${epicId}], operator: any_of }`);
    }

    if (sprintId) {
      rules.push(`{ column_id: "${TASK_COLUMNS.sprint}", compare_value: [${sprintId}], operator: any_of }`);
    }

    const queryParams = `query_params: {
      rules: [${rules.join(",\n        ")}]
      operator: and
    }`;

    const columnIds = [
      TASK_COLUMNS.status,
      TASK_COLUMNS.priority,
      TASK_COLUMNS.type,
      TASK_COLUMNS.estimatedHours,
      TASK_COLUMNS.epic,
      TASK_COLUMNS.sprint,
      TASK_COLUMNS.agentId,
      TASK_COLUMNS.planId,
      TASK_COLUMNS.autoNumber,
      TASK_COLUMNS.taskId,
    ].map(c => `"${c}"`).join(", ");

    const query = `
      query {
        boards(ids: [${BOARDS.TASKS}]) {
          items_page(limit: ${limit}, ${queryParams}) {
            items {
              id
              name
              column_values(ids: [${columnIds}]) {
                id
                text
                value
                ... on BoardRelationValue { linked_items { id name } }
              }
            }
          }
        }
      }
    `;

    const response = await executeMondayQuery<any>(query);
    const items = response.boards?.[0]?.items_page?.items || [];

    // Client-side type filter if provided (not a native filter column)
    let filteredItems = items;
    if (type) {
      filteredItems = items.filter((item: any) => {
        const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
        const taskType = getColumnText(colMap, TASK_COLUMNS.type);
        return taskType === type;
      });
    }

    // Format output
    const lines: string[] = [];
    const filterParts: string[] = [];
    if (status) filterParts.push(`status: ${status}`);
    else filterParts.push("status: Backlog + Ready to Start");
    if (type) filterParts.push(`type: ${type}`);
    if (unclaimedOnly) filterParts.push("unclaimed only");
    if (agentId) filterParts.push(`agent: ${agentId}`);
    if (epicId) filterParts.push(`epic: #${epicId}`);
    if (sprintId) filterParts.push(`sprint: #${sprintId}`);
    const filterInfo = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";

    lines.push(`# Backlog — ${filteredItems.length} tasks${filterInfo}`);
    lines.push("");

    if (filteredItems.length === 0) {
      lines.push("No tasks found matching the filters.");
      return lines.join("\n");
    }

    for (const item of filteredItems) {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);

      const autoNumber = getColumnText(colMap, TASK_COLUMNS.autoNumber) || "?";
      const taskStatus = getColumnText(colMap, TASK_COLUMNS.status) || "Unknown";
      const priority = getColumnText(colMap, TASK_COLUMNS.priority) || "—";
      const taskType = getColumnText(colMap, TASK_COLUMNS.type) || "—";
      const hours = getColumnText(colMap, TASK_COLUMNS.estimatedHours) || "—";
      const epicItems = getLinkedItems(colMap, TASK_COLUMNS.epic);
      const epic = epicItems.length > 0 ? `${epicItems[0].name} (#${epicItems[0].id})` : "—";
      const sprintItems = getLinkedItems(colMap, TASK_COLUMNS.sprint);
      const sprint = sprintItems.length > 0 ? `${sprintItems[0].name} (#${sprintItems[0].id})` : "—";
      const agent = getColumnText(colMap, TASK_COLUMNS.agentId) || "—";

      lines.push(`- **TAIT-${autoNumber}** (#${item.id}) ${item.name}`);
      lines.push(`  Status: ${taskStatus} | Priority: ${priority} | Type: ${taskType} | Hours: ${hours}`);
      lines.push(`  Epic: ${epic} | Sprint: ${sprint} | Agent: ${agent}`);
      lines.push("");
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to fetch backlog: ${error instanceof Error ? error.message : String(error)}`);
  }
}
