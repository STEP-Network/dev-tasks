import { executeMondayQuery } from "../monday-client";
import { BOARDS, SUBTASK_COLUMNS, TASK_COLUMNS, EPIC_COLUMNS, SPRINT_COLUMNS } from "../constants";

// =============================================================================
// Column Value Helpers
// =============================================================================

export function getColumnText(colMap: Map<string, any>, columnId: string): string | undefined {
  const col = colMap.get(columnId);
  return col?.text?.trim() || undefined;
}

export function getColumnValue(colMap: Map<string, any>, columnId: string): any {
  const col = colMap.get(columnId);
  if (!col?.value) return undefined;
  try {
    return JSON.parse(col.value);
  } catch {
    return col.value;
  }
}

export function getLinkedItems(colMap: Map<string, any>, columnId: string): Array<{ id: string; name: string }> {
  const col = colMap.get(columnId);
  return col?.linked_items || [];
}

export function getMirrorDisplayValue(colMap: Map<string, any>, columnId: string): string | undefined {
  const col = colMap.get(columnId);
  return col?.display_value?.trim() || undefined;
}

export function getLinkUrl(colMap: Map<string, any>, columnId: string): string | undefined {
  const col = colMap.get(columnId);
  if (!col?.value) return undefined;
  try {
    const parsed = JSON.parse(col.value);
    return parsed?.url || undefined;
  } catch {
    return undefined;
  }
}

export function getDropdownValues(colMap: Map<string, any>, columnId: string): string[] {
  const col = colMap.get(columnId);
  if (!col?.value) return [];
  try {
    const parsed = JSON.parse(col.value);
    return parsed?.ids?.map(String) || [];
  } catch {
    return [];
  }
}

// =============================================================================
// Date Helpers
// =============================================================================

export function parseMondayDate(column?: any): string | undefined {
  if (!column) return undefined;

  if (typeof column.value === "string" && column.value.trim().length > 0) {
    try {
      const parsed = JSON.parse(column.value);
      if (parsed?.date) return parsed.date;
    } catch {
      // fall through
    }
  }
  if (column.text && column.text.trim().length > 0) {
    return column.text.trim();
  }
  return undefined;
}

export function todayDate(): string {
  return new Date().toISOString().split("T")[0];
}

// =============================================================================
// Column Values Builder
// =============================================================================

export function buildColumnValues(fields: Record<string, unknown>): string {
  return JSON.stringify(JSON.stringify(fields));
}

// =============================================================================
// Subtask Formatter
// =============================================================================

export interface FormattedSubtask {
  id: string;
  name: string;
  status: string;
  type?: string;
  description?: string;
  estimatedHours?: number;
  actualHours?: number;
  date?: string;
  startedDate?: string;
  owner?: string;
}

export function formatSubtask(sub: any): FormattedSubtask {
  const colMap = new Map<string, any>(sub.column_values?.map((c: any) => [c.id, c]) || []);

  return {
    id: String(sub.id),
    name: String(sub.name),
    status: getColumnText(colMap, SUBTASK_COLUMNS.status) || "Unknown",
    type: getColumnText(colMap, SUBTASK_COLUMNS.type) || undefined,
    description: getColumnText(colMap, SUBTASK_COLUMNS.description) || undefined,
    estimatedHours: colMap.get(SUBTASK_COLUMNS.estimatedHours)?.text ? parseFloat(colMap.get(SUBTASK_COLUMNS.estimatedHours).text) : undefined,
    actualHours: colMap.get(SUBTASK_COLUMNS.actualHours)?.text ? parseFloat(colMap.get(SUBTASK_COLUMNS.actualHours).text) : undefined,
    date: parseMondayDate(colMap.get(SUBTASK_COLUMNS.date)),
    startedDate: parseMondayDate(colMap.get(SUBTASK_COLUMNS.startedDate)),
    owner: getColumnText(colMap, SUBTASK_COLUMNS.owner) || undefined,
  };
}

// =============================================================================
// Dependency Checker
// =============================================================================

export async function checkDependenciesResolved(dependencyItemIds: number[]): Promise<{ resolved: boolean; blockers: Array<{ id: number; name: string; status: string }> }> {
  if (dependencyItemIds.length === 0) {
    return { resolved: true, blockers: [] };
  }

  const query = `
    query {
      items(ids: [${dependencyItemIds.join(",")}]) {
        id
        name
        column_values(ids: ["${TASK_COLUMNS.status}"]) {
          id
          text
        }
      }
    }
  `;

  const response = await executeMondayQuery<any>(query);
  const items = response.items || [];
  const blockers: Array<{ id: number; name: string; status: string }> = [];

  for (const item of items) {
    const status = item.column_values?.[0]?.text?.trim() || "Unknown";
    if (status !== "Done") {
      blockers.push({ id: Number(item.id), name: item.name, status });
    }
  }

  return { resolved: blockers.length === 0, blockers };
}

// =============================================================================
// Linked Items Resolver
// =============================================================================

export async function resolveLinkedItems(
  itemIds: number[],
  columnIds: string[],
): Promise<any[]> {
  if (itemIds.length === 0) return [];

  // Monday's items(ids: [...]) call caps at 100 IDs — chunk to stay under the limit.
  const CHUNK = 100;
  const results: any[] = [];

  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const chunk = itemIds.slice(i, i + CHUNK);
    const query = `
      query {
        items(ids: [${chunk.join(",")}]) {
          id
          name
          column_values(ids: [${columnIds.map(c => `"${c}"`).join(",")}]) {
            id
            text
            value
            ... on BoardRelationValue { linked_items { id name } }
            ... on MirrorValue { display_value }
          }
        }
      }
    `;
    const response = await executeMondayQuery<any>(query);
    if (response.items) results.push(...response.items);
  }

  return results;
}

// =============================================================================
// Maintenance Epic Resolver
// =============================================================================

/**
 * Given a productId, find the product's "Maintenance" epic.
 * Looks for epics linked to the product whose name contains "maintenance" (case-insensitive).
 * Returns the epic ID if found, null otherwise.
 */
export async function resolveMaintenanceEpicId(productId: number): Promise<number | null> {
  const query = `
    query {
      boards(ids: [${BOARDS.EPICS}]) {
        items_page(limit: 100, query_params: {
          rules: [{ column_id: "${EPIC_COLUMNS.product}", compare_value: [${productId}], operator: any_of }]
        }) {
          items { id name }
        }
      }
    }
  `;
  const response = await executeMondayQuery<any>(query);
  const epics = response.boards?.[0]?.items_page?.items || [];
  const maintenance = epics.find((e: any) =>
    e.name.toLowerCase().includes("maintenance")
  );
  return maintenance ? Number(maintenance.id) : null;
}

// =============================================================================
// Active Sprint Validator
// =============================================================================

export async function getActiveSprintIds(): Promise<number[]> {
  const query = `
    query {
      boards(ids: [${BOARDS.SPRINTS}]) {
        items_page(limit: 10, query_params: {
          rules: [{ column_id: "${SPRINT_COLUMNS.active}", compare_value: [], operator: is_not_empty }]
        }) {
          items { id }
        }
      }
    }
  `;
  const response = await executeMondayQuery<any>(query);
  const items = response.boards?.[0]?.items_page?.items || [];
  return items.map((i: any) => Number(i.id));
}

export async function validateTaskInActiveSprint(
  linkedSprintIds: number[],
): Promise<{ valid: boolean; message?: string }> {
  const activeIds = await getActiveSprintIds();
  if (activeIds.length === 0) {
    return {
      valid: false,
      message: `No active sprint found. A task can only be set to "In Progress" when an active sprint exists.`,
    };
  }
  if (linkedSprintIds.length === 0) {
    return {
      valid: false,
      message: `Task is not assigned to any sprint. Move it into the active sprint (#${activeIds.join(", #")}) before setting it to "In Progress".`,
    };
  }
  const isInActive = linkedSprintIds.some(id => activeIds.includes(id));
  if (!isInActive) {
    return {
      valid: false,
      message: `Task is not in the active sprint (active: #${activeIds.join(", #")}). Move the task into the active sprint before setting it to "In Progress".`,
    };
  }
  return { valid: true };
}

// =============================================================================
// Error Formatter
// =============================================================================

export function formatError(message: string): string {
  return `# Error\n\n${message}`;
}

// =============================================================================
// Validate Mapping
// =============================================================================

export function validateMapping(value: string, mapping: Record<string, number>, fieldName: string): number {
  if (!(value in mapping)) {
    const valid = Object.keys(mapping).join(", ");
    throw new Error(`Invalid ${fieldName}: "${value}". Valid values: ${valid}`);
  }
  return mapping[value];
}
