import { executeMondayQuery } from "../monday-client";
import { SUBTASK_COLUMNS, TASK_COLUMNS } from "../constants";

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

  const query = `
    query {
      items(ids: [${itemIds.join(",")}]) {
        id
        name
        column_values(ids: [${columnIds.map(c => `"${c}"`).join(",")}]) {
          id
          text
          value
          ... on BoardRelationValue { linked_items { id name } }
        }
      }
    }
  `;

  const response = await executeMondayQuery<any>(query);
  return response.items || [];
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
