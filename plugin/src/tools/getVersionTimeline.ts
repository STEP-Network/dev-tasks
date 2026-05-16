import { executeMondayQuery } from "../monday-client.ts";
import { BOARDS, VERSION_COLUMNS, TASK_COLUMNS } from "../constants.ts";
import type { GetVersionTimelineInput } from "../schemas.ts";
import {
  getColumnText,
  getLinkedItems,
  mondayItemUrl,
  resolveLinkedItems,
  formatError,
} from "./utils.ts";
import {
  parseSemVer,
  compareSemVer,
  formatSemVer,
  type SemVer,
} from "../services/version-bump.ts";

/**
 * Versions are HISTORICAL (changelogs + currently-shipping container),
 * not planning artifacts. This tool returns a chronological rear-view —
 * what shipped recently for a product, plus what's about to ship.
 *
 * Future-planning happens via epics + sprints (see `getPublicRoadmap`,
 * `listEpics`, `getSprint`). Don't reach for getVersionTimeline if you
 * want to know "what's coming next" — reach for it to know "what's shipped."
 */

interface TimelineVersion {
  id: number;
  name: string;
  versionNumber: string;
  semver: SemVer | null;
  status: string;
  releaseDate: string | null;
  expectedReleaseDate: string | null;
  taskIds: number[];
  url: string;
}

interface TaskCategoryCounts {
  Feature: number;
  Fix: number;
  Improvement: number;
  Other: number;
}

const OPEN_STATUSES = new Set(["Planned", "In Development", "Release Candidate"]);

export async function getVersionTimeline(args: GetVersionTimelineInput): Promise<string> {
  try {
    const { productId, statusFilter = "all", format = "markdown", expandTasks = false, limit = 25 } = args;

    // 1. Fetch all versions for this product. Versions board is small enough
    //    that we filter client-side (avoids juggling 'rules' against a board_relation
    //    column).
    const columnIds = [
      VERSION_COLUMNS.status,
      VERSION_COLUMNS.versionNumber,
      VERSION_COLUMNS.releaseDate,
      VERSION_COLUMNS.expectedReleaseDate,
      VERSION_COLUMNS.product,
      VERSION_COLUMNS.connectedTasks,
    ].map(c => `"${c}"`).join(", ");

    const query = `
      query {
        boards(ids: [${BOARDS.VERSIONS}]) {
          items_page(limit: 500) {
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
    const res = await executeMondayQuery<any>(query);
    const rawItems = res.boards?.[0]?.items_page?.items || [];

    // 2. Filter to this product + apply statusFilter
    const versions: TimelineVersion[] = [];
    for (const item of rawItems) {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
      const linkedProducts = getLinkedItems(colMap, VERSION_COLUMNS.product);
      if (!linkedProducts.some(p => Number(p.id) === productId)) continue;

      const status = getColumnText(colMap, VERSION_COLUMNS.status) || "";
      if (!includeStatus(status, statusFilter)) continue;

      const versionNumber = getColumnText(colMap, VERSION_COLUMNS.versionNumber) || item.name;
      const linkedTasks = getLinkedItems(colMap, VERSION_COLUMNS.connectedTasks);

      versions.push({
        id: Number(item.id),
        name: item.name,
        versionNumber,
        semver: parseSemVer(versionNumber),
        status,
        releaseDate: getColumnText(colMap, VERSION_COLUMNS.releaseDate) || null,
        expectedReleaseDate: getColumnText(colMap, VERSION_COLUMNS.expectedReleaseDate) || null,
        taskIds: linkedTasks.map(t => Number(t.id)),
        url: mondayItemUrl(BOARDS.VERSIONS, item.id),
      });
    }

    if (versions.length === 0) {
      return format === "json"
        ? JSON.stringify({ productId, statusFilter, versions: [] })
        : `# Version timeline\n\nNo versions match the filter (productId=${productId}, statusFilter=${statusFilter}).`;
    }

    // 3. Sort: newest first by semver. Versions without parseable semver sink
    //    to the bottom so they don't break the ordering.
    versions.sort((a, b) => {
      if (a.semver && b.semver) return compareSemVer(b.semver, a.semver); // descending
      if (a.semver && !b.semver) return -1;
      if (!a.semver && b.semver) return 1;
      return 0;
    });

    const top = versions.slice(0, limit);

    // 4. Per-version task categorization. One batched query for all linked tasks.
    const allTaskIds = top.flatMap(v => v.taskIds);
    const taskInfo = new Map<number, { name: string; type: string; url: string }>();
    if (allTaskIds.length > 0) {
      const tasks = await resolveLinkedItems(allTaskIds, [TASK_COLUMNS.type]);
      for (const t of tasks) {
        const tColMap = new Map<string, any>(t.column_values?.map((c: any) => [c.id, c]) || []);
        taskInfo.set(Number(t.id), {
          name: t.name,
          type: getColumnText(tColMap, TASK_COLUMNS.type) || "Not Set",
          url: mondayItemUrl(BOARDS.TASKS, t.id),
        });
      }
    }

    // 5. Build the output
    if (format === "json") {
      return JSON.stringify({
        productId,
        statusFilter,
        count: top.length,
        versions: top.map(v => ({
          id: v.id,
          name: v.name,
          versionNumber: v.versionNumber,
          status: v.status,
          releaseDate: v.releaseDate,
          expectedReleaseDate: v.expectedReleaseDate,
          counts: countTasks(v.taskIds, taskInfo),
          url: v.url,
          ...(expandTasks ? { tasks: v.taskIds.map(id => taskInfo.get(id)).filter(Boolean) } : {}),
        })),
      }, null, 2);
    }

    return renderMarkdown(top, taskInfo, expandTasks);
  } catch (error) {
    return formatError(`Failed to fetch version timeline: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function includeStatus(status: string, filter: "all" | "released" | "open" | "hotfix"): boolean {
  if (filter === "all") return true;
  if (filter === "released") return status === "Released";
  if (filter === "open") return OPEN_STATUSES.has(status);
  if (filter === "hotfix") return status === "Hotfix";
  return true;
}

function countTasks(
  taskIds: number[],
  taskInfo: Map<number, { name: string; type: string; url: string }>
): TaskCategoryCounts {
  const counts: TaskCategoryCounts = { Feature: 0, Fix: 0, Improvement: 0, Other: 0 };
  for (const id of taskIds) {
    const info = taskInfo.get(id);
    if (!info) continue;
    if (info.type === "Feature") counts.Feature++;
    else if (info.type === "Fix") counts.Fix++;
    else if (info.type === "Improvement") counts.Improvement++;
    else counts.Other++;
  }
  return counts;
}

function renderMarkdown(
  versions: TimelineVersion[],
  taskInfo: Map<number, { name: string; type: string; url: string }>,
  expandTasks: boolean
): string {
  const lines: string[] = ["# Version timeline (newest first)", ""];

  // Split into sections: shipping-soon (open) + released + hotfix
  const open = versions.filter(v => OPEN_STATUSES.has(v.status));
  const released = versions.filter(v => v.status === "Released");
  const hotfix = versions.filter(v => v.status === "Hotfix");

  if (open.length > 0) {
    lines.push("## Shipping now (open versions)");
    for (const v of open) lines.push(...renderVersionEntry(v, taskInfo, expandTasks));
    lines.push("");
  }

  if (hotfix.length > 0) {
    lines.push("## Hotfixes");
    for (const v of hotfix) lines.push(...renderVersionEntry(v, taskInfo, expandTasks));
    lines.push("");
  }

  if (released.length > 0) {
    lines.push("## Released");
    for (const v of released) lines.push(...renderVersionEntry(v, taskInfo, expandTasks));
    lines.push("");
  }

  return lines.join("\n").trim();
}

function renderVersionEntry(
  v: TimelineVersion,
  taskInfo: Map<number, { name: string; type: string; url: string }>,
  expandTasks: boolean
): string[] {
  const lines: string[] = [];
  const counts = countTasks(v.taskIds, taskInfo);
  const date = v.releaseDate || v.expectedReleaseDate || "";
  const dateStr = date ? ` · ${v.status === "Released" ? "released" : "expected"} ${date}` : "";

  lines.push(`### ${v.versionNumber} — ${v.name} ([#${v.id}](${v.url}))`);
  lines.push(`Status: **${v.status}**${dateStr} · ${v.taskIds.length} task${v.taskIds.length === 1 ? "" : "s"}`);
  if (counts.Feature + counts.Fix + counts.Improvement + counts.Other > 0) {
    const parts: string[] = [];
    if (counts.Feature > 0) parts.push(`${counts.Feature} Feature${counts.Feature === 1 ? "" : "s"}`);
    if (counts.Fix > 0) parts.push(`${counts.Fix} Fix${counts.Fix === 1 ? "" : "es"}`);
    if (counts.Improvement > 0) parts.push(`${counts.Improvement} Improvement${counts.Improvement === 1 ? "" : "s"}`);
    if (counts.Other > 0) parts.push(`${counts.Other} Other`);
    lines.push(`Breakdown: ${parts.join(", ")}`);
  }
  if (expandTasks && v.taskIds.length > 0) {
    lines.push("");
    for (const id of v.taskIds) {
      const info = taskInfo.get(id);
      if (!info) continue;
      lines.push(`  - [${info.type}] ${info.name} ([#${id}](${info.url}))`);
    }
  }
  lines.push("");
  return lines;
}
