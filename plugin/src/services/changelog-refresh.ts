/**
 * Continuous changelog refresh.
 *
 * Builds the StructuredChangelog for a version from its currently-linked tasks
 * and bugs, preserves any manually-set metadata (summary / highlights /
 * breakingChanges / knownIssues) from the existing Doc, and writes the
 * unified changelog back.
 *
 * Triggered automatically from `auto-version.ts` after a task is linked to a
 * version — keeps the Doc reflective of the current task list without
 * requiring the agent to remember `generateChangelog`. The Doc becomes a
 * live view, not a release-time snapshot.
 */

import { executeMondayQuery } from "../monday-client.ts";
import { VERSION_COLUMNS, TASK_COLUMNS, BUG_COLUMNS } from "../constants.ts";
import {
  evaluatePublicVisibility,
  getColumnText,
  getLinkedItems,
  resolveLinkedItems,
} from "../tools/utils.ts";
import {
  categoryForTaskType,
  emptyChangelog,
  writeChangelog,
  type StructuredChangelog,
} from "../tools/structuredChangelog.ts";
import { readStructuredFromVersionDoc } from "./changelog-doc.ts";

export interface RefreshResult {
  taskCount: number;
  skippedPrivate: number;
  bugCount: number;
  versionLabel: string;
}

/**
 * Rebuild the version's structured changelog from current Monday state and
 * write it to the Doc. Metadata fields from the existing Doc (summary,
 * highlights, breakingChanges, knownIssues) are preserved.
 *
 * Throws on any Monday API error. Callers (auto-version) catch.
 */
export async function refreshChangelogForVersion(versionId: number): Promise<RefreshResult> {
  // 1. Fetch the version's identifying columns + linked items
  const columnIds = [
    VERSION_COLUMNS.versionNumber,
    VERSION_COLUMNS.connectedTasks,
    VERSION_COLUMNS.fixedBugs,
  ].map(c => `"${c}"`).join(", ");

  const query = `
    query {
      items(ids: [${versionId}]) {
        id
        name
        column_values(ids: [${columnIds}]) {
          id
          text
          ... on BoardRelationValue { linked_items { id name } }
        }
      }
    }
  `;
  const res = await executeMondayQuery<any>(query);
  const item = res.items?.[0];
  if (!item) throw new Error(`Version #${versionId} not found`);

  const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
  const versionNumber = getColumnText(colMap, VERSION_COLUMNS.versionNumber) || "";
  // Label: prefer "v<num> — <name>" when both present, else fall back gracefully.
  const versionLabel = versionNumber
    ? `${versionNumber}${item.name && item.name !== versionNumber ? ` — ${item.name}` : ""}`
    : item.name;

  // 2. Resolve linked tasks (with the columns we need for classification)
  const connectedTasks = getLinkedItems(colMap, VERSION_COLUMNS.connectedTasks);
  const taskIds = connectedTasks.map(t => Number(t.id));
  let resolvedTasks: any[] = [];
  if (taskIds.length > 0) {
    resolvedTasks = await resolveLinkedItems(taskIds, [
      TASK_COLUMNS.status,
      TASK_COLUMNS.type,
      TASK_COLUMNS.publicTaskName,
      TASK_COLUMNS.epic,
      TASK_COLUMNS.sprint,
    ]);
  }

  const fixedBugs = getLinkedItems(colMap, VERSION_COLUMNS.fixedBugs);
  const bugIds = fixedBugs.map(b => Number(b.id));
  let resolvedBugs: any[] = [];
  if (bugIds.length > 0) {
    resolvedBugs = await resolveLinkedItems(bugIds, [BUG_COLUMNS.status]);
  }

  // 3. Categorize tasks (3-cat: Feature / Fix / Improvement) under the
  //    public-visibility filter — only public-eligible tasks land in the
  //    customer-facing changelog. Private tasks are counted but skipped.
  const structured: StructuredChangelog = emptyChangelog();
  let skippedPrivate = 0;
  for (const task of resolvedTasks) {
    const taskColMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
    const visibility = evaluatePublicVisibility(taskColMap);
    if (!visibility.isPublic || !visibility.publicName) {
      skippedPrivate++;
      continue;
    }
    const taskType = getColumnText(taskColMap, TASK_COLUMNS.type);
    const category = categoryForTaskType(taskType);
    structured.tasks[category].push({
      id: Number(task.id),
      name: task.name,
      publicName: visibility.publicName,
    });
  }

  // Bugs land under Fix unconditionally — same convention as generateChangelog
  for (const bug of resolvedBugs) {
    structured.tasks.Fix.push({
      id: Number(bug.id),
      name: bug.name,
    });
  }

  // 4. Preserve manually-set metadata from any existing Doc
  try {
    const existing = await readStructuredFromVersionDoc(versionId);
    if (existing && typeof existing === "object") {
      const e = existing as Record<string, unknown>;
      if (typeof e.summary === "string") structured.summary = e.summary;
      if (Array.isArray(e.highlights)) {
        structured.highlights = e.highlights.filter((h): h is string => typeof h === "string");
      }
      if (Array.isArray(e.breakingChanges)) {
        structured.breakingChanges = e.breakingChanges.filter((h): h is string => typeof h === "string");
      }
      if (Array.isArray(e.knownIssues)) {
        structured.knownIssues = e.knownIssues.filter((h): h is string => typeof h === "string");
      }
    }
  } catch {
    // First-time write — no existing metadata to preserve.
  }

  // 5. Write the unified changelog
  await writeChangelog(versionId, structured, { versionLabel });

  return {
    taskCount: resolvedTasks.length - skippedPrivate,
    skippedPrivate,
    bugCount: resolvedBugs.length,
    versionLabel,
  };
}
