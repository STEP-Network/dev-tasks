import { executeMondayQuery } from "../monday-client";
import { BOARDS, SPRINT_COLUMNS, TASK_COLUMNS } from "../constants";
import type { GetSprintInput } from "../schemas";
import { getColumnText, getLinkedItems, getMirrorDisplayValue, mondayItemUrl, parseMondayDate, resolveLinkedItems, formatError } from "./utils";

interface SprintTaskDetail {
  id: number;
  name: string;
  url: string;
  status: string;
  priority: string;
  type: string;
  agent?: string;
  estimatedHours?: string;
  actualHours?: string;
}

interface SprintDetail {
  id: number;
  name: string;
  url: string;
  active: boolean;
  goal: string;
  startDate?: string;
  endDate?: string;
  completion: string;
  capacity?: string;
  progress: {
    total: number;
    byStatus: Record<string, number>;
    estimatedHours: number;
    actualHours: number;
  };
  tasks: SprintTaskDetail[];
}

export async function getSprint(args: GetSprintInput): Promise<string> {
  try {
    const { sprintId, format = "markdown" } = args;

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

    // Build structured detail
    const statusCounts: Record<string, number> = {};
    let totalEstimated = 0;
    let totalActual = 0;
    const tasks: SprintTaskDetail[] = [];

    for (const task of resolvedTasks) {
      const taskColMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
      const taskStatus = getColumnText(taskColMap, TASK_COLUMNS.status) || "Unknown";
      statusCounts[taskStatus] = (statusCounts[taskStatus] || 0) + 1;

      const est = getMirrorDisplayValue(taskColMap, TASK_COLUMNS.estimatedHours);
      if (est) totalEstimated += parseFloat(est);
      const act = getMirrorDisplayValue(taskColMap, TASK_COLUMNS.actualHours);
      if (act) totalActual += parseFloat(act);

      tasks.push({
        id: Number(task.id),
        name: String(task.name),
        url: mondayItemUrl(BOARDS.TASKS, task.id),
        status: taskStatus,
        priority: getColumnText(taskColMap, TASK_COLUMNS.priority) || "—",
        type: getColumnText(taskColMap, TASK_COLUMNS.type) || "—",
        agent: getColumnText(taskColMap, TASK_COLUMNS.agentId),
        estimatedHours: est,
        actualHours: act,
      });
    }

    const detail: SprintDetail = {
      id: Number(sprintItem.id),
      name: sprintItem.name,
      url: mondayItemUrl(BOARDS.SPRINTS, sprintItem.id),
      active: !!isActive,
      goal: goals,
      startDate,
      endDate,
      completion,
      capacity,
      progress: {
        total: resolvedTasks.length,
        byStatus: statusCounts,
        estimatedHours: Number(totalEstimated.toFixed(2)),
        actualHours: Number(totalActual.toFixed(2)),
      },
      tasks,
    };

    if (format === "json") {
      return JSON.stringify(detail, null, 2);
    }

    // Markdown rendering
    const lines: string[] = [];
    lines.push(`# Sprint: ${detail.name}`);
    lines.push(`**ID:** #${detail.id}${detail.active ? " (Active)" : ""}`);
    lines.push(`**URL:** ${detail.url}`);
    lines.push("");

    lines.push("## Goals");
    lines.push(detail.goal);
    lines.push("");

    lines.push("## Timeline");
    if (detail.startDate) lines.push(`- **Start:** ${detail.startDate}`);
    if (detail.endDate) lines.push(`- **End:** ${detail.endDate}`);
    lines.push(`- **Completion:** ${detail.completion}`);
    if (detail.capacity) lines.push(`- **Capacity:** ${detail.capacity}h`);
    lines.push("");

    lines.push("## Progress");
    lines.push(`- **Total Tasks:** ${detail.progress.total}`);
    for (const [st, count] of Object.entries(detail.progress.byStatus).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${st}:** ${count}`);
    }
    lines.push(`- **Estimated Hours:** ${detail.progress.estimatedHours || "—"}`);
    lines.push(`- **Actual Hours:** ${detail.progress.actualHours || "—"}`);
    lines.push("");

    if (detail.tasks.length > 0) {
      lines.push(`## Tasks (${detail.tasks.length})`);
      for (const t of detail.tasks) {
        const check = t.status === "Done" ? "[x]" : "[ ]";
        lines.push(`- ${check} **${t.name}** (#${t.id})`);
        lines.push(`  Status: ${t.status} | Priority: ${t.priority} | Type: ${t.type} | Hours: ${t.estimatedHours ?? "—"} | Agent: ${t.agent ?? "—"}`);
      }
      lines.push("");
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to fetch sprint: ${error instanceof Error ? error.message : String(error)}`);
  }
}
