import { executeMondayQuery } from "../monday-client";
import { BOARDS, EPIC_COLUMNS, EPIC_STATUS, TASK_COLUMNS } from "../constants";
import type { ListEpicsInput } from "../schemas";
import { getColumnText, getLinkedItems, resolveLinkedItems, formatError } from "./utils";

export async function listEpics(args: ListEpicsInput): Promise<string> {
  try {
    const { status, search, limit = 25 } = args;

    const columnIds = [
      EPIC_COLUMNS.status,
      EPIC_COLUMNS.priority,
      EPIC_COLUMNS.connectedTasks,
      EPIC_COLUMNS.product,
      EPIC_COLUMNS.deadline,
      EPIC_COLUMNS.owner,
    ].map(c => `"${c}"`).join(", ");

    // Build query with optional server-side status filter
    const rules: string[] = [];
    if (status) {
      const statusIndex = EPIC_STATUS[status];
      if (statusIndex !== undefined) {
        rules.push(`{ column_id: "${EPIC_COLUMNS.status}", compare_value: [${statusIndex}], operator: any_of }`);
      }
    }

    const queryParams = rules.length > 0
      ? `query_params: { rules: [${rules.join(", ")}], operator: and }`
      : "";

    // Fetch more if searching client-side
    const fetchLimit = search ? 200 : limit;

    const query = `
      query {
        boards(ids: [${BOARDS.EPICS}]) {
          items_page(limit: ${fetchLimit}${queryParams ? `, ${queryParams}` : ""}) {
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
    let items = response.boards?.[0]?.items_page?.items || [];

    // Client-side search filter
    if (search) {
      const term = search.toLowerCase();
      items = items.filter((item: any) => item.name.toLowerCase().includes(term));
    }

    // Apply limit after filtering
    items = items.slice(0, limit);

    if (items.length === 0) {
      const filterDesc = [status && `status="${status}"`, search && `search="${search}"`].filter(Boolean).join(", ");
      return formatError(`No epics found${filterDesc ? ` matching ${filterDesc}` : ""}.`);
    }

    // Resolve task counts for each epic (batch all task IDs)
    const allTaskIds: number[] = [];
    const epicTaskMap = new Map<string, number[]>();

    for (const item of items) {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
      const linkedTasks = getLinkedItems(colMap, EPIC_COLUMNS.connectedTasks);
      const taskIds = linkedTasks.map((t: any) => Number(t.id));
      epicTaskMap.set(item.id, taskIds);
      allTaskIds.push(...taskIds);
    }

    // Batch resolve all tasks for status counts
    const resolvedTaskMap = new Map<number, string>();
    if (allTaskIds.length > 0) {
      const resolved = await resolveLinkedItems(allTaskIds, [TASK_COLUMNS.status]);
      for (const task of resolved) {
        const taskColMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
        const taskStatus = getColumnText(taskColMap, TASK_COLUMNS.status) || "Unknown";
        resolvedTaskMap.set(Number(task.id), taskStatus);
      }
    }

    // Format output
    const lines: string[] = [];
    lines.push(`# Epics (${items.length})`);
    lines.push("");

    for (const item of items) {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);

      const epicStatus = getColumnText(colMap, EPIC_COLUMNS.status) || "Unknown";
      const priority = getColumnText(colMap, EPIC_COLUMNS.priority) || "—";
      const owner = getColumnText(colMap, EPIC_COLUMNS.owner) || "—";
      const deadline = getColumnText(colMap, EPIC_COLUMNS.deadline) || "—";
      const productItems = getLinkedItems(colMap, EPIC_COLUMNS.product);
      const product = productItems.length > 0 ? productItems[0].name : "—";

      // Calculate progress from resolved tasks
      const taskIds = epicTaskMap.get(item.id) || [];
      const totalTasks = taskIds.length;
      let doneTasks = 0;
      for (const tid of taskIds) {
        if (resolvedTaskMap.get(tid) === "Done") doneTasks++;
      }
      const progressPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
      const progressStr = totalTasks > 0 ? `${doneTasks}/${totalTasks} (${progressPct}%)` : "No tasks";

      lines.push(`- **${item.name}** (#${item.id})`);
      lines.push(`  Status: ${epicStatus} | Priority: ${priority} | Progress: ${progressStr} | Owner: ${owner} | Deadline: ${deadline} | Product: ${product}`);
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to list epics: ${error instanceof Error ? error.message : String(error)}`);
  }
}
