import { executeMondayQuery } from "../monday-client.ts";
import { BOARDS, SPRINT_COLUMNS, TASK_COLUMNS } from "../constants.ts";
import type { ListSprintsInput } from "../schemas.ts";
import { getColumnText, getLinkedItems, getMirrorDisplayValue, mondayItemUrl, parseMondayDate, resolveLinkedItems, todayDate, formatError } from "./utils.ts";

interface SprintTaskEntry {
  id: number;
  name: string;
  url: string;
  status: string;
}

interface SprintEntry {
  id: number;
  name: string;
  url: string;
  active: boolean;
  completed: boolean;
  startDate?: string;
  endDate?: string;
  capacity?: string;
  goal?: string;
  taskCount: number;
  epics: Array<{ id: number; name: string }>;
  statusCounts?: Record<string, number>;
  hours?: { actual: number; estimated: number };
  tasks?: SprintTaskEntry[];
}

// Monday's items_page caps at 500; 200 is plenty for years of sprints.
const FETCH_CAP = 200;

// Order matches the workflow: NR → Ready → InP → UAT → PendingDeploy → Done → Stuck.
const STATUS_COUNT_ORDER: Array<{ label: string; abbrev: string }> = [
  { label: "Needs Refinement", abbrev: "NR" },
  { label: "Ready to Start", abbrev: "Ready" },
  { label: "In Progress", abbrev: "InP" },
  { label: "Waiting for UAT", abbrev: "UAT" },
  { label: "Pending Deploy to Prod", abbrev: "PendingDeploy" },
  { label: "Done", abbrev: "Done" },
  { label: "Stuck", abbrev: "Stuck" },
];

function formatHours(n: number): string {
  // Trim trailing zeros after the decimal so 25.10 → 25.1 and 30.00 → 30.
  return Number(n.toFixed(2)).toString();
}

export async function listSprints(args: ListSprintsInput): Promise<string> {
  try {
    const {
      activeOnly = false,
      pastOnly = false,
      includeStatusCounts = true,
      includeTasks = false,
      format = "markdown",
    } = args;

    if (activeOnly && pastOnly) {
      return formatError(`activeOnly and pastOnly are mutually exclusive — pass only one.`);
    }

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

    const query = `
      query {
        boards(ids: [${BOARDS.SPRINTS}]) {
          items_page(limit: ${FETCH_CAP}${queryParams}) {
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

    // Filter by sprint end date relative to today.
    //   default          → keep sprints with endDate >= today, OR endDate missing
    //   pastOnly=true    → keep sprints with endDate < today
    //   activeOnly=true  → already filtered server-side; skip the date filter
    if (!activeOnly) {
      const today = todayDate();
      items = items.filter((item: any) => {
        const map = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
        const end = parseMondayDate(map.get(SPRINT_COLUMNS.endDate));
        if (pastOnly) {
          return !!end && end < today;
        }
        return !end || end >= today;
      });
    }

    // Sort:
    //   default          → oldest startDate first (current sprint surfaces above future ones)
    //   pastOnly=true    → newest endDate first (most recently ended on top)
    //   activeOnly=true  → newest startDate first (existing behavior)
    items.sort((a: any, b: any) => {
      const aMap = new Map<string, any>(a.column_values?.map((c: any) => [c.id, c]) || []);
      const bMap = new Map<string, any>(b.column_values?.map((c: any) => [c.id, c]) || []);
      if (pastOnly) {
        const aEnd = parseMondayDate(aMap.get(SPRINT_COLUMNS.endDate)) || "";
        const bEnd = parseMondayDate(bMap.get(SPRINT_COLUMNS.endDate)) || "";
        if (!aEnd && !bEnd) return 0;
        if (!aEnd) return 1;
        if (!bEnd) return -1;
        return bEnd.localeCompare(aEnd);
      }
      const aStart = parseMondayDate(aMap.get(SPRINT_COLUMNS.startDate)) || "";
      const bStart = parseMondayDate(bMap.get(SPRINT_COLUMNS.startDate)) || "";
      if (!aStart && !bStart) return 0;
      if (!aStart) return 1;
      if (!bStart) return -1;
      if (activeOnly) return bStart.localeCompare(aStart);
      return aStart.localeCompare(bStart);
    });

    if (items.length === 0) {
      const filterDesc = [
        pastOnly && "pastOnly=true",
        activeOnly && "activeOnly=true",
        !pastOnly && !activeOnly && "default view (active + upcoming)",
      ].filter(Boolean).join(", ");
      return formatError(`No sprints found${filterDesc ? ` (${filterDesc})` : ""}.`);
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
    const taskMetaMap = new Map<number, { name: string; status: string; estimated: number; actual: number }>();
    if (allTaskIds.size > 0) {
      const cols: string[] = [TASK_COLUMNS.epic, TASK_COLUMNS.status];
      if (includeStatusCounts) {
        cols.push(TASK_COLUMNS.estimatedHours, TASK_COLUMNS.actualHours);
      }
      const resolvedTasks = await resolveLinkedItems([...allTaskIds], cols);
      for (const task of resolvedTasks) {
        const taskColMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
        taskEpicsMap.set(Number(task.id), getLinkedItems(taskColMap, TASK_COLUMNS.epic));
        const est = includeStatusCounts ? parseFloat(getMirrorDisplayValue(taskColMap, TASK_COLUMNS.estimatedHours) || "0") : 0;
        const act = includeStatusCounts ? parseFloat(getMirrorDisplayValue(taskColMap, TASK_COLUMNS.actualHours) || "0") : 0;
        taskMetaMap.set(Number(task.id), {
          name: String(task.name),
          status: getColumnText(taskColMap, TASK_COLUMNS.status) || "Unknown",
          estimated: Number.isFinite(est) ? est : 0,
          actual: Number.isFinite(act) ? act : 0,
        });
      }
    }

    // Build structured SprintEntry objects first; render markdown or JSON below.
    const sprints: SprintEntry[] = items.map((item: any) => {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);

      const linkedTasks = getLinkedItems(colMap, SPRINT_COLUMNS.connectedTasks);

      const epicsById = new Map<number, string>();
      for (const t of linkedTasks) {
        const epics = taskEpicsMap.get(Number(t.id)) || [];
        for (const e of epics) epicsById.set(Number(e.id), e.name);
      }

      const entry: SprintEntry = {
        id: Number(item.id),
        name: item.name,
        url: mondayItemUrl(BOARDS.SPRINTS, item.id),
        active: !!getColumnText(colMap, SPRINT_COLUMNS.active),
        completed: !!getColumnText(colMap, SPRINT_COLUMNS.completed),
        startDate: parseMondayDate(colMap.get(SPRINT_COLUMNS.startDate)),
        endDate: parseMondayDate(colMap.get(SPRINT_COLUMNS.endDate)),
        capacity: getColumnText(colMap, SPRINT_COLUMNS.capacity),
        goal: getColumnText(colMap, SPRINT_COLUMNS.goals),
        taskCount: linkedTasks.length,
        epics: [...epicsById.entries()]
          .sort((a, b) => a[1].localeCompare(b[1]))
          .map(([id, name]) => ({ id, name })),
      };

      if (includeStatusCounts && linkedTasks.length > 0) {
        const counts: Record<string, number> = Object.fromEntries(STATUS_COUNT_ORDER.map(s => [s.label, 0]));
        let totalEstimated = 0;
        let totalActual = 0;
        for (const t of linkedTasks) {
          const meta = taskMetaMap.get(Number(t.id));
          if (!meta) continue;
          if (counts[meta.status] !== undefined) counts[meta.status]++;
          totalEstimated += meta.estimated;
          totalActual += meta.actual;
        }
        entry.statusCounts = counts;
        entry.hours = {
          actual: Number(totalActual.toFixed(2)),
          estimated: Number(totalEstimated.toFixed(2)),
        };
      }

      if (includeTasks && linkedTasks.length > 0) {
        entry.tasks = linkedTasks.map(t => {
          const meta = taskMetaMap.get(Number(t.id));
          return {
            id: Number(t.id),
            name: meta?.name ?? t.name,
            url: mondayItemUrl(BOARDS.TASKS, t.id),
            status: meta?.status ?? "Unknown",
          };
        });
      }

      return entry;
    });

    if (format === "json") {
      return JSON.stringify({ sprints }, null, 2);
    }

    const lines: string[] = [];
    lines.push(`# Sprints (${sprints.length})`);
    lines.push("");

    for (const s of sprints) {
      const flags = [s.active && "[Active]", s.completed && "[Completed]"].filter(Boolean).join(" ");
      const epicsLine = s.epics.length > 0
        ? s.epics.map(e => `${e.name} (#${e.id})`).join(", ")
        : "—";
      lines.push(`- **${s.name}** (#${s.id})${flags ? ` ${flags}` : ""}`);
      lines.push(`  Timeline: ${s.startDate ?? "—"} → ${s.endDate ?? "—"} | Tasks: ${s.taskCount}${s.capacity ? ` | Capacity: ${s.capacity}h` : ""}`);
      lines.push(`  Epics (${s.epics.length}): ${epicsLine}`);
      if (s.goal) lines.push(`  Goal: ${s.goal}`);

      if (s.statusCounts) {
        const counts = s.statusCounts;
        const countsLine = STATUS_COUNT_ORDER.map(o => `${o.abbrev} ${counts[o.label] ?? 0}`).join(" · ");
        lines.push(`  Counts: ${countsLine}`);
      }
      if (s.hours) {
        lines.push(`  Hours: ${formatHours(s.hours.actual)} actual / ${formatHours(s.hours.estimated)} estimated`);
      }

      if (s.tasks && s.tasks.length > 0) {
        lines.push(`  Tasks:`);
        for (const t of s.tasks) {
          lines.push(`    - ${t.name} (#${t.id}) — ${t.status}`);
        }
      }
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to list sprints: ${error instanceof Error ? error.message : String(error)}`);
  }
}
