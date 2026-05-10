import { executeMondayQuery } from "../monday-client";
import { BOARDS, SPRINT_COLUMNS, TASK_COLUMNS } from "../constants";
import type { ListSprintsInput } from "../schemas";
import { getColumnText, getLinkedItems, parseMondayDate, resolveLinkedItems, formatError } from "./utils";

export async function listSprints(args: ListSprintsInput): Promise<string> {
  try {
    const { activeOnly = false, search, limit = 25 } = args;

    const columnIds = [
      SPRINT_COLUMNS.goals,
      SPRINT_COLUMNS.active,
      SPRINT_COLUMNS.connectedTasks,
      SPRINT_COLUMNS.completed,
      SPRINT_COLUMNS.startDate,
      SPRINT_COLUMNS.endDate,
      SPRINT_COLUMNS.capacity,
    ].map(c => `"${c}"`).join(", ");

    const rules: string[] = [];
    if (activeOnly) {
      rules.push(`{ column_id: "${SPRINT_COLUMNS.active}", compare_value: [], operator: is_not_empty }`);
    }
    const queryParams = rules.length > 0
      ? `, query_params: { rules: [${rules.join(", ")}] }`
      : "";

    // Fetch more if filtering client-side via search
    const fetchLimit = search ? 200 : limit;

    const query = `
      query {
        boards(ids: [${BOARDS.SPRINTS}]) {
          items_page(limit: ${fetchLimit}${queryParams}) {
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
    let items: any[] = response.boards?.[0]?.items_page?.items || [];

    if (search) {
      const term = search.toLowerCase();
      items = items.filter((item: any) => item.name.toLowerCase().includes(term));
    }

    // Sort by start date descending (newest first); items missing a start date sink to the bottom
    items.sort((a: any, b: any) => {
      const aMap = new Map<string, any>(a.column_values?.map((c: any) => [c.id, c]) || []);
      const bMap = new Map<string, any>(b.column_values?.map((c: any) => [c.id, c]) || []);
      const aStart = parseMondayDate(aMap.get(SPRINT_COLUMNS.startDate)) || "";
      const bStart = parseMondayDate(bMap.get(SPRINT_COLUMNS.startDate)) || "";
      if (!aStart && !bStart) return 0;
      if (!aStart) return 1;
      if (!bStart) return -1;
      return bStart.localeCompare(aStart);
    });

    items = items.slice(0, limit);

    if (items.length === 0) {
      const filterDesc = [
        activeOnly && "activeOnly=true",
        search && `search="${search}"`,
      ].filter(Boolean).join(", ");
      return formatError(`No sprints found${filterDesc ? ` matching ${filterDesc}` : ""}.`);
    }

    // Batch-resolve every linked task across all sprints in one shot, then read back
    // the epic relation per task so each sprint can list its unique linked epics.
    const allTaskIds = new Set<number>();
    for (const item of items) {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
      for (const t of getLinkedItems(colMap, SPRINT_COLUMNS.connectedTasks)) {
        allTaskIds.add(Number(t.id));
      }
    }

    const taskEpicsMap = new Map<number, Array<{ id: string; name: string }>>();
    if (allTaskIds.size > 0) {
      const resolvedTasks = await resolveLinkedItems([...allTaskIds], [TASK_COLUMNS.epic]);
      for (const task of resolvedTasks) {
        const taskColMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
        taskEpicsMap.set(Number(task.id), getLinkedItems(taskColMap, TASK_COLUMNS.epic));
      }
    }

    const lines: string[] = [];
    lines.push(`# Sprints (${items.length})`);
    lines.push("");

    for (const item of items) {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);

      const isActive = !!getColumnText(colMap, SPRINT_COLUMNS.active);
      const isCompleted = !!getColumnText(colMap, SPRINT_COLUMNS.completed);
      const startDate = parseMondayDate(colMap.get(SPRINT_COLUMNS.startDate)) || "—";
      const endDate = parseMondayDate(colMap.get(SPRINT_COLUMNS.endDate)) || "—";
      const capacity = getColumnText(colMap, SPRINT_COLUMNS.capacity);
      const goal = getColumnText(colMap, SPRINT_COLUMNS.goals);
      const linkedTasks = getLinkedItems(colMap, SPRINT_COLUMNS.connectedTasks);
      const taskCount = linkedTasks.length;

      // Aggregate unique epics across this sprint's tasks (some tasks have no epic, so use a Map keyed by epic id)
      const epicsById = new Map<string, string>();
      for (const t of linkedTasks) {
        const epics = taskEpicsMap.get(Number(t.id)) || [];
        for (const e of epics) epicsById.set(e.id, e.name);
      }
      const epicEntries = [...epicsById.entries()].sort((a, b) => a[1].localeCompare(b[1]));
      const epicsLine = epicEntries.length > 0
        ? epicEntries.map(([id, name]) => `${name} (#${id})`).join(", ")
        : "—";

      const flags = [isActive && "[Active]", isCompleted && "[Completed]"].filter(Boolean).join(" ");
      lines.push(`- **${item.name}** (#${item.id})${flags ? ` ${flags}` : ""}`);
      lines.push(`  Timeline: ${startDate} → ${endDate} | Tasks: ${taskCount}${capacity ? ` | Capacity: ${capacity}h` : ""}`);
      lines.push(`  Epics (${epicEntries.length}): ${epicsLine}`);
      if (goal) lines.push(`  Goal: ${goal}`);
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to list sprints: ${error instanceof Error ? error.message : String(error)}`);
  }
}
