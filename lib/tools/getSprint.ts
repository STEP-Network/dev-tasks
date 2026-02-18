import { executeMondayQuery } from "../monday-client";
import { BOARDS, SPRINT_COLUMNS, TASK_COLUMNS } from "../constants";
import type { GetSprintInput } from "../schemas";
import { getColumnText, getLinkedItems, parseMondayDate, resolveLinkedItems, formatError } from "./utils";

export async function getSprint(args: GetSprintInput): Promise<string> {
  try {
    const { sprintId } = args;

    let sprintItem: any;

    if (sprintId) {
      // Fetch specific sprint by ID
      const columnIds = [
        SPRINT_COLUMNS.goals,
        SPRINT_COLUMNS.active,
        SPRINT_COLUMNS.timeline,
        SPRINT_COLUMNS.connectedTasks,
        SPRINT_COLUMNS.completed,
        SPRINT_COLUMNS.startDate,
        SPRINT_COLUMNS.endDate,
        SPRINT_COLUMNS.capacity,
      ].map(c => `"${c}"`).join(", ");

      const query = `
        query {
          items(ids: [${sprintId}]) {
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
      `;

      const response = await executeMondayQuery<any>(query);
      sprintItem = response.items?.[0];

      if (!sprintItem) {
        return formatError(`Sprint with ID ${sprintId} not found.`);
      }
    } else {
      // Find active sprint by querying the Sprints board with activation checkbox filter
      const columnIds = [
        SPRINT_COLUMNS.goals,
        SPRINT_COLUMNS.active,
        SPRINT_COLUMNS.timeline,
        SPRINT_COLUMNS.connectedTasks,
        SPRINT_COLUMNS.completed,
        SPRINT_COLUMNS.startDate,
        SPRINT_COLUMNS.endDate,
        SPRINT_COLUMNS.capacity,
      ].map(c => `"${c}"`).join(", ");

      const query = `
        query {
          boards(ids: [${BOARDS.SPRINTS}]) {
            items_page(limit: 1, query_params: {
              rules: [{ column_id: "${SPRINT_COLUMNS.active}", compare_value: [], operator: is_not_empty }]
            }) {
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
      sprintItem = response.boards?.[0]?.items_page?.items?.[0];

      if (!sprintItem) {
        return formatError("No active sprint found.");
      }
    }

    const colMap = new Map<string, any>(sprintItem.column_values?.map((c: any) => [c.id, c]) || []);

    // Sprint fields
    const goals = getColumnText(colMap, SPRINT_COLUMNS.goals) || "—";
    const isActive = getColumnText(colMap, SPRINT_COLUMNS.active) || "";
    const startDate = parseMondayDate(colMap.get(SPRINT_COLUMNS.startDate));
    const endDate = parseMondayDate(colMap.get(SPRINT_COLUMNS.endDate));
    const completion = getColumnText(colMap, SPRINT_COLUMNS.completed) || "—";
    const capacity = getColumnText(colMap, SPRINT_COLUMNS.capacity);

    // Connected tasks
    const connectedTaskItems = getLinkedItems(colMap, SPRINT_COLUMNS.connectedTasks);
    const taskIds = connectedTaskItems.map(t => Number(t.id));

    // Resolve tasks with their details
    let resolvedTasks: any[] = [];
    if (taskIds.length > 0) {
      resolvedTasks = await resolveLinkedItems(taskIds, [
        TASK_COLUMNS.status,
        TASK_COLUMNS.priority,
        TASK_COLUMNS.type,
        TASK_COLUMNS.agentId,
        TASK_COLUMNS.estimatedHours,
        TASK_COLUMNS.actualHours,
      ]);
    }

    // Calculate progress stats
    const statusCounts: Record<string, number> = {};
    let totalEstimated = 0;
    let totalActual = 0;

    for (const task of resolvedTasks) {
      const taskColMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
      const taskStatus = getColumnText(taskColMap, TASK_COLUMNS.status) || "Unknown";
      statusCounts[taskStatus] = (statusCounts[taskStatus] || 0) + 1;

      const est = getColumnText(taskColMap, TASK_COLUMNS.estimatedHours);
      if (est) totalEstimated += parseFloat(est);

      const act = getColumnText(taskColMap, TASK_COLUMNS.actualHours);
      if (act) totalActual += parseFloat(act);
    }

    // Format output
    const lines: string[] = [];
    lines.push(`# Sprint: ${sprintItem.name}`);
    lines.push(`**ID:** #${sprintItem.id}${isActive ? " (Active)" : ""}`);
    lines.push("");

    // Goals
    lines.push("## Goals");
    lines.push(goals);
    lines.push("");

    // Timeline
    lines.push("## Timeline");
    if (startDate) lines.push(`- **Start:** ${startDate}`);
    if (endDate) lines.push(`- **End:** ${endDate}`);
    lines.push(`- **Completion:** ${completion}`);
    if (capacity) lines.push(`- **Capacity:** ${capacity}h`);
    lines.push("");

    // Progress summary
    lines.push("## Progress");
    lines.push(`- **Total Tasks:** ${resolvedTasks.length}`);
    for (const [st, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${st}:** ${count}`);
    }
    lines.push(`- **Estimated Hours:** ${totalEstimated || "—"}`);
    lines.push(`- **Actual Hours:** ${totalActual || "—"}`);
    lines.push("");

    // Task list
    if (resolvedTasks.length > 0) {
      lines.push(`## Tasks (${resolvedTasks.length})`);
      for (const task of resolvedTasks) {
        const taskColMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
        const taskStatus = getColumnText(taskColMap, TASK_COLUMNS.status) || "Unknown";
        const taskPriority = getColumnText(taskColMap, TASK_COLUMNS.priority) || "—";
        const taskType = getColumnText(taskColMap, TASK_COLUMNS.type) || "—";
        const agent = getColumnText(taskColMap, TASK_COLUMNS.agentId) || "—";
        const est = getColumnText(taskColMap, TASK_COLUMNS.estimatedHours) || "—";

        const check = taskStatus === "Done" ? "[x]" : "[ ]";
        lines.push(`- ${check} **${task.name}** (#${task.id})`);
        lines.push(`  Status: ${taskStatus} | Priority: ${taskPriority} | Type: ${taskType} | Hours: ${est} | Agent: ${agent}`);
      }
      lines.push("");
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to fetch sprint: ${error instanceof Error ? error.message : String(error)}`);
  }
}
