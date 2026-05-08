import { executeMondayQuery } from "../monday-client";
import { BOARDS, EPIC_COLUMNS, PRODUCT_IDS, TASK_COLUMNS } from "../constants";
import type { GetPublicRoadmapInput } from "../schemas";
import { evaluatePublicVisibility, getColumnText, getLinkedItems, resolveLinkedItems, formatError } from "./utils";

export async function getPublicRoadmap(args: GetPublicRoadmapInput): Promise<string> {
  try {
    const { product, onlyInProgress = false } = args;
    const productId = PRODUCT_IDS[product];

    // Step 1: Fetch epics for this product
    const epicColumnIds = [
      EPIC_COLUMNS.status,
      EPIC_COLUMNS.priority,
      EPIC_COLUMNS.connectedTasks,
      EPIC_COLUMNS.product,
      EPIC_COLUMNS.deadline,
    ].map(c => `"${c}"`).join(", ");

    const epicQuery = `
      query {
        boards(ids: [${BOARDS.EPICS}]) {
          items_page(limit: 200) {
            items {
              id
              name
              column_values(ids: [${epicColumnIds}]) {
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

    const epicResponse = await executeMondayQuery<any>(epicQuery);
    let epics = epicResponse.boards?.[0]?.items_page?.items || [];

    // Filter by product
    epics = epics.filter((epic: any) => {
      const colMap = new Map<string, any>(epic.column_values?.map((c: any) => [c.id, c]) || []);
      const productItems = getLinkedItems(colMap, EPIC_COLUMNS.product);
      return productItems.some((p: any) => Number(p.id) === productId);
    });

    if (onlyInProgress) {
      epics = epics.filter((epic: any) => {
        const colMap = new Map<string, any>(epic.column_values?.map((c: any) => [c.id, c]) || []);
        return getColumnText(colMap, EPIC_COLUMNS.status) === "In Progress";
      });
    }

    if (epics.length === 0) {
      return formatError(`No epics found for ${product}${onlyInProgress ? " with status 'In Progress'" : ""}.`);
    }

    // Step 2: Collect every task ID across all epics, then resolve in one batch
    const allTaskIds: number[] = [];
    const epicTaskIds = new Map<string, number[]>();

    for (const epic of epics) {
      const colMap = new Map<string, any>(epic.column_values?.map((c: any) => [c.id, c]) || []);
      const tasks = getLinkedItems(colMap, EPIC_COLUMNS.connectedTasks);
      const ids = tasks.map(t => Number(t.id));
      epicTaskIds.set(epic.id, ids);
      allTaskIds.push(...ids);
    }

    // Public visibility gate: a task appears on the roadmap only when ALL three
    // conditions hold — publicTaskName set, linked to an epic, assigned to a sprint.
    // The epic-iteration loop above already implies a linked epic, but we re-check
    // via evaluatePublicVisibility so the rule lives in one place.
    const taskMap = new Map<number, { publicName: string; status: string; sprintName: string }>();
    if (allTaskIds.length > 0) {
      const resolved = await resolveLinkedItems(allTaskIds, [
        TASK_COLUMNS.publicTaskName,
        TASK_COLUMNS.status,
        TASK_COLUMNS.epic,
        TASK_COLUMNS.sprint,
      ]);
      for (const task of resolved) {
        const colMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
        const visibility = evaluatePublicVisibility(colMap);
        const sprintItems = getLinkedItems(colMap, TASK_COLUMNS.sprint);
        if (!visibility.isPublic || !visibility.publicName || sprintItems.length === 0) continue;
        taskMap.set(Number(task.id), {
          publicName: visibility.publicName,
          status: getColumnText(colMap, TASK_COLUMNS.status) || "Unknown",
          sprintName: sprintItems[0].name,
        });
      }
    }

    // Step 3: Build markdown — Epic → Sprint → Task
    const lines: string[] = [];
    lines.push(`# ${product} Roadmap${onlyInProgress ? " — In Progress" : ""}`);
    lines.push("");

    for (const epic of epics) {
      const colMap = new Map<string, any>(epic.column_values?.map((c: any) => [c.id, c]) || []);
      const epicStatus = getColumnText(colMap, EPIC_COLUMNS.status) || "Unknown";
      const deadline = getColumnText(colMap, EPIC_COLUMNS.deadline);

      lines.push(`## ${epic.name} (#${epic.id}) — ${epicStatus}${deadline ? ` · Due ${deadline}` : ""}`);

      const taskIds = epicTaskIds.get(epic.id) || [];
      const tasks = taskIds.map(id => taskMap.get(id)).filter((t): t is NonNullable<typeof t> => !!t);

      if (tasks.length === 0) {
        lines.push("_No public tasks._");
        lines.push("");
        continue;
      }

      // Group tasks by sprint (every public task is sprint-assigned by definition)
      const bySprintName = new Map<string, typeof tasks>();
      for (const task of tasks) {
        const list = bySprintName.get(task.sprintName);
        if (list) list.push(task);
        else bySprintName.set(task.sprintName, [task]);
      }

      const sprintNames = [...bySprintName.keys()].sort();
      for (const sprintName of sprintNames) {
        const sprintTasks = bySprintName.get(sprintName);
        if (!sprintTasks) continue;
        lines.push(`### ${sprintName}`);
        for (const task of sprintTasks) {
          lines.push(`- **${task.publicName}** — ${task.status}`);
        }
        lines.push("");
      }
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to fetch public roadmap: ${error instanceof Error ? error.message : String(error)}`);
  }
}
