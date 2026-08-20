import { executeMondayQuery } from "../monday-client.ts";
import { BOARDS, SUBTASK_COLUMNS, TASK_COLUMNS, EPIC_COLUMNS, SPRINT_COLUMNS } from "../constants.ts";

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

  // Route through the chunking resolver rather than inlining every id: a bare
  // `items(ids:)` silently defaults to `limit: 25` and hard-fails past 100.
  // This is a GATE — a short read here reports `resolved: true` and lets a
  // blocked task be claimed, so under-reading is worse than erroring.
  const ids = dependencyItemIds.filter(id => Number.isInteger(id) && id > 0);
  const items = await resolveLinkedItems(ids, [TASK_COLUMNS.status]);
  const blockers: Array<{ id: number; name: string; status: string }> = [];

  // Fail CLOSED on a short read: an id we could not resolve is treated as an
  // unresolved blocker, never silently dropped from the check.
  if (items.length !== ids.length) {
    const seen = new Set(items.map((i: any) => String(i.id)));
    for (const id of ids) {
      if (!seen.has(String(id))) {
        blockers.push({ id, name: `#${id}`, status: "Unreadable" });
      }
    }
  }

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

  // Monday's items(ids: [...]) has a default `limit: 25` even when you pass more
  // IDs — anything past the first 25 is silently dropped. Pass `limit` explicitly
  // matching the chunk size. The hard cap is 100 per page.
  const CHUNK = 100;
  const results: any[] = [];

  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const chunk = itemIds.slice(i, i + CHUNK);
    const query = `
      query {
        items(ids: [${chunk.join(",")}], limit: ${chunk.length}) {
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
// Public Task Visibility Gate
// =============================================================================

/**
 * A task is publicly visible (roadmap + changelog) only when ALL three are true:
 *   1. publicTaskName is non-empty
 *   2. linked to at least one epic
 *   3. linked to at least one sprint
 * Internal todos / security work / undated work stay private.
 *
 * Returns the reasons it's private (if any) so callers can surface a clear
 * error instead of silently dropping work.
 */
export function evaluatePublicVisibility(colMap: Map<string, any>): {
  isPublic: boolean;
  publicName?: string;
  reasons: string[];
} {
  const publicName = getColumnText(colMap, TASK_COLUMNS.publicTaskName);
  const epicCount = getLinkedItems(colMap, TASK_COLUMNS.epic).length;
  const sprintCount = getLinkedItems(colMap, TASK_COLUMNS.sprint).length;
  const reasons: string[] = [];
  if (!publicName) reasons.push("no public name");
  if (epicCount === 0) reasons.push("not linked to an epic");
  if (sprintCount === 0) reasons.push("not assigned to a sprint");
  return { isPublic: reasons.length === 0, publicName, reasons };
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
  // Sort numerically so multi-active-sprint picks are stable across calls —
  // Monday's items_page does not guarantee stable order between calls, and the
  // auto-pull picks activeIds[0] deterministically based on this sort.
  return items.map((i: any) => Number(i.id)).sort((a: number, b: number) => a - b);
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
// Auto-Pull Into Active Sprint
// =============================================================================
//
// Returns a plan describing how to ensure a task is in the active sprint. The
// caller is responsible for merging `columnsToWrite` into its own pending
// mutation so the pull lands atomically with the caller's other column changes
// (single change_multiple_column_values mutation).
//
// Behavior:
//   - 0 active sprints → returns { error } (no auto-pull possible).
//   - task already linked to an active sprint → returns { wasInActiveSprint: true,
//     columnsToWrite: {} } (no-op).
//   - otherwise → returns columns that write task_sprint = first active sprint
//     AND check (unplanned) = true. Unplanned write is skipped if
//     `skipUnplannedFlag` is true (caller is explicitly setting unplanned in
//     the same call, respect their value).
//
// Multi-active-sprint case: picks the first active sprint deterministically
// and surfaces a `warning` so the caller can include it in the response.

export interface AutoPullPlan {
  wasInActiveSprint: boolean;
  pulledIntoSprintId?: number;
  markedUnplanned: boolean;
  columnsToWrite: Record<string, unknown>;
  warning?: string;
  error?: string;
}

export async function planActiveSprintPull(
  linkedSprintIds: number[],
  options: { skipUnplannedFlag?: boolean } = {},
): Promise<AutoPullPlan> {
  const activeIds = await getActiveSprintIds();
  if (activeIds.length === 0) {
    return {
      wasInActiveSprint: false,
      markedUnplanned: false,
      columnsToWrite: {},
      error: `No active sprint found. Cannot auto-pull task into a sprint. Activate a sprint first.`,
    };
  }
  const alreadyInActive = linkedSprintIds.some(id => activeIds.includes(id));
  if (alreadyInActive) {
    return {
      wasInActiveSprint: true,
      markedUnplanned: false,
      columnsToWrite: {},
    };
  }
  const targetSprintId = activeIds[0];
  const columnsToWrite: Record<string, unknown> = {
    [TASK_COLUMNS.sprint]: { item_ids: [targetSprintId] },
  };
  let markedUnplanned = false;
  if (!options.skipUnplannedFlag) {
    columnsToWrite[TASK_COLUMNS.unplanned] = { checked: "true" };
    markedUnplanned = true;
  }
  return {
    wasInActiveSprint: false,
    pulledIntoSprintId: targetSprintId,
    markedUnplanned,
    columnsToWrite,
    warning:
      activeIds.length > 1
        ? `Multiple active sprints found (#${activeIds.join(", #")}); pulled into #${targetSprintId} deterministically.`
        : undefined,
  };
}

// =============================================================================
// Ready-to-Start Validator
// =============================================================================
//
// A task can transition to "Ready to Start" only when it's fully specified:
// type and priority set, linked to an epic, description and acceptance criteria
// written, and at least one subtask with name + description + type + estimate.

export interface SubitemSnapshot {
  id?: string;
  name?: string;
  description?: string;
  type?: string;
  estimatedHours?: number;
  status?: string;
}

export interface ReadyToStartSnapshot {
  type?: string;
  priority?: string;
  epicCount: number;
  description?: string;
  acceptanceCriteria?: string;
  subitems: SubitemSnapshot[];
}

export function classifyReadyToStartBlockers(snapshot: ReadyToStartSnapshot): string[] {
  const blockers: string[] = [];

  if (!snapshot.type || snapshot.type === "Not Set") {
    blockers.push("type not set");
  }
  if (!snapshot.priority || snapshot.priority === "Missing") {
    blockers.push("priority not set (Missing)");
  }
  if (snapshot.epicCount === 0) {
    blockers.push("not linked to an epic");
  }
  if (!snapshot.description?.trim()) {
    blockers.push("description is empty");
  }
  if (!snapshot.acceptanceCriteria?.trim()) {
    blockers.push("acceptance criteria is empty");
  }

  if (snapshot.subitems.length === 0) {
    blockers.push("no subtasks (need at least one with name, description, type, estimate)");
  } else {
    snapshot.subitems.forEach((s, i) => {
      const missing: string[] = [];
      if (!s.name?.trim()) missing.push("name");
      if (!s.description?.trim()) missing.push("description");
      if (!s.type || s.type === "Missing Status") missing.push("type");
      if (!s.estimatedHours || s.estimatedHours <= 0) missing.push("estimate");
      if (missing.length > 0) {
        const label = s.name?.trim() || `#${i + 1}`;
        blockers.push(`subtask "${label}" missing: ${missing.join(", ")}`);
      }
    });
  }

  return blockers;
}

export async function validateReadyToStart(
  itemId: number,
  proposed: {
    type?: string;
    priority?: string;
    epicId?: number;
    description?: string;
    acceptanceCriteria?: string;
  },
): Promise<{ valid: boolean; blockers: string[] }> {
  const colIds = [
    TASK_COLUMNS.type,
    TASK_COLUMNS.priority,
    TASK_COLUMNS.epic,
    TASK_COLUMNS.descriptionDoc,
    TASK_COLUMNS.acceptanceCriteria,
  ].map(c => `"${c}"`).join(", ");

  const subColIds = [
    SUBTASK_COLUMNS.status,
    SUBTASK_COLUMNS.type,
    SUBTASK_COLUMNS.description,
    SUBTASK_COLUMNS.estimatedHours,
  ].map(c => `"${c}"`).join(", ");

  const query = `
    query {
      items(ids: [${itemId}]) {
        column_values(ids: [${colIds}]) {
          id
          text
          value
          ... on BoardRelationValue { linked_items { id name } }
        }
        subitems {
          id
          name
          column_values(ids: [${subColIds}]) {
            id
            text
            value
          }
        }
      }
    }
  `;

  const response = await executeMondayQuery<any>(query);
  const item = response.items?.[0];
  if (!item) return { valid: false, blockers: [`task #${itemId} not found`] };

  const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
  const subitems: SubitemSnapshot[] = (item.subitems || []).map((sub: any) => {
    const subCols = new Map<string, any>(sub.column_values?.map((c: any) => [c.id, c]) || []);
    const estText = subCols.get(SUBTASK_COLUMNS.estimatedHours)?.text;
    return {
      id: String(sub.id),
      name: sub.name,
      description: getColumnText(subCols, SUBTASK_COLUMNS.description),
      type: getColumnText(subCols, SUBTASK_COLUMNS.type),
      estimatedHours: estText ? parseFloat(estText) : undefined,
      status: getColumnText(subCols, SUBTASK_COLUMNS.status),
    };
  });

  // Description resolution: prefer non-empty proposed input; else accept the
  // descriptionDoc column when a doc is attached. Use `!x?.trim()` (not
  // `=== undefined`) so an explicit `description: ''` from the caller still
  // falls through to the doc-attached sentinel — otherwise a caller clearing
  // the description string while updating other fields would get a spurious
  // 'description is empty' blocker even when a populated description doc
  // already exists on the task.
  let descriptionForCheck: string | undefined = proposed.description;
  if (!descriptionForCheck?.trim()) {
    const docVal = getColumnValue(colMap, TASK_COLUMNS.descriptionDoc);
    if (docVal && typeof docVal === "object") {
      const files = (docVal as any).files;
      if (Array.isArray(files) && files.length > 0) {
        descriptionForCheck = "(stored in description doc)";
      }
    }
  }

  // Apply proposed updates over the fetched state so same-call updates count.
  const snapshot: ReadyToStartSnapshot = {
    type: proposed.type ?? getColumnText(colMap, TASK_COLUMNS.type),
    priority: proposed.priority ?? getColumnText(colMap, TASK_COLUMNS.priority),
    epicCount:
      proposed.epicId !== undefined ? 1 : getLinkedItems(colMap, TASK_COLUMNS.epic).length,
    description: descriptionForCheck,
    acceptanceCriteria:
      proposed.acceptanceCriteria ?? getColumnText(colMap, TASK_COLUMNS.acceptanceCriteria),
    subitems,
  };

  const blockers = classifyReadyToStartBlockers(snapshot);
  return { valid: blockers.length === 0, blockers };
}

// =============================================================================
// Waiting-for-UAT Validator
// =============================================================================
//
// Hard blockers: all subtasks Done + UAT doc set (doc_mm3adfdg).
// Soft warnings (not blocking): GitHub link, branch, demo URL, PR link.

export interface WaitingForUATSnapshot {
  subitems: SubitemSnapshot[];
  hasUatDoc: boolean;
  hasGitHubLink: boolean;
  hasBranch: boolean;
  hasDemoUrl: boolean;
  hasPrLink: boolean;
}

export function classifyWaitingForUATIssues(snapshot: WaitingForUATSnapshot): {
  blockers: string[];
  warnings: string[];
} {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (snapshot.subitems.length === 0) {
    blockers.push("no subtasks (need at least one Done subtask before UAT)");
  } else {
    const incomplete = snapshot.subitems.filter(s => s.status !== "Done");
    if (incomplete.length > 0) {
      const names = incomplete.map(s => `"${s.name || "(unnamed)"}" [${s.status || "no status"}]`).join(", ");
      blockers.push(`${incomplete.length} subtask(s) not Done: ${names}`);
    }
  }

  if (!snapshot.hasUatDoc) {
    blockers.push("UAT testing doc (doc_mm3adfdg) not set — use createTaskUatDoc to add test instructions");
  }

  if (!snapshot.hasGitHubLink) warnings.push("GitHub link not set");
  if (!snapshot.hasBranch) warnings.push("Branch name not set");
  if (!snapshot.hasDemoUrl) warnings.push("Demo URL not set");
  if (!snapshot.hasPrLink) warnings.push("PR link not set");

  return { blockers, warnings };
}

export function hasDocColumn(colMap: Map<string, any>, columnId: string): boolean {
  const docValue = getColumnValue(colMap, columnId);
  if (!docValue) return false;
  if (typeof docValue !== "object") return false;
  const obj = docValue as Record<string, unknown>;
  if (typeof obj.doc_id === "number" || typeof obj.doc_id === "string") return true;
  // Monday's doc-column value uses `files: [{ fileId: "<uuid>", objectId: <id>, ... }]`.
  // The objectId is the numeric doc id; presence of a files entry means a doc exists.
  const files = obj.files as Array<Record<string, unknown>> | undefined;
  if (files && files.length > 0) {
    const f = files[0];
    if (
      typeof f.objectId === "number" ||
      typeof f.objectId === "string" ||
      typeof f.fileId === "string" ||
      typeof f.fileId === "number"
    ) {
      return true;
    }
  }
  // Fallback: any nested doc-id-shaped key
  return /"(?:doc_id|objectId|object_id)"\s*:\s*\d+/.test(JSON.stringify(obj));
}

export async function validateWaitingForUAT(
  itemId: number,
  proposed: {
    githubLink?: string;
    prLink?: string;
    demoUrl?: string;
    branch?: string;
  },
): Promise<{ blockers: string[]; warnings: string[] }> {
  const colIds = [
    TASK_COLUMNS.uatDoc,
    TASK_COLUMNS.githubLink,
    TASK_COLUMNS.prLink,
    TASK_COLUMNS.demoUrl,
    TASK_COLUMNS.branch,
  ].map(c => `"${c}"`).join(", ");

  const subColIds = `"${SUBTASK_COLUMNS.status}"`;

  const query = `
    query {
      items(ids: [${itemId}]) {
        column_values(ids: [${colIds}]) {
          id
          text
          value
        }
        subitems {
          id
          name
          column_values(ids: [${subColIds}]) {
            id
            text
          }
        }
      }
    }
  `;

  const response = await executeMondayQuery<any>(query);
  const item = response.items?.[0];
  if (!item) return { blockers: [`task #${itemId} not found`], warnings: [] };

  const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
  const subitems: SubitemSnapshot[] = (item.subitems || []).map((sub: any) => {
    const subCols = new Map<string, any>(sub.column_values?.map((c: any) => [c.id, c]) || []);
    return {
      id: String(sub.id),
      name: sub.name,
      status: getColumnText(subCols, SUBTASK_COLUMNS.status),
    };
  });

  const snapshot: WaitingForUATSnapshot = {
    subitems,
    hasUatDoc: hasDocColumn(colMap, TASK_COLUMNS.uatDoc),
    hasGitHubLink: proposed.githubLink !== undefined
      ? proposed.githubLink.trim().length > 0
      : !!getLinkUrl(colMap, TASK_COLUMNS.githubLink),
    hasPrLink: proposed.prLink !== undefined
      ? proposed.prLink.trim().length > 0
      : !!getLinkUrl(colMap, TASK_COLUMNS.prLink),
    hasDemoUrl: proposed.demoUrl !== undefined
      ? proposed.demoUrl.trim().length > 0
      : !!getLinkUrl(colMap, TASK_COLUMNS.demoUrl),
    hasBranch: proposed.branch !== undefined
      ? proposed.branch.trim().length > 0
      : !!getColumnText(colMap, TASK_COLUMNS.branch),
  };

  return classifyWaitingForUATIssues(snapshot);
}

// =============================================================================
// Monday deep links
// =============================================================================
//
// Stable URL to a Monday item view. The workspace subdomain is hard-coded —
// move it to env if/when the MCP serves other workspaces.

const MONDAY_WORKSPACE = "stepas";

export function mondayItemUrl(boardId: number | string, itemId: number | string): string {
  return `https://${MONDAY_WORKSPACE}.monday.com/boards/${boardId}/pulses/${itemId}`;
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
