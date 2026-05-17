import { executeMondayQuery } from "../monday-client.js";
import { BOARDS, VERSION_COLUMNS, TASK_COLUMNS } from "../constants.js";
import { getColumnText, getLinkedItems, mondayItemUrl, resolveLinkedItems, formatError, } from "./utils.js";
import { parseSemVer, compareSemVer, } from "../services/version-bump.js";
const OPEN_STATUSES = new Set(["Planned", "In Development", "Release Candidate"]);
export async function getVersionTimeline(args) {
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
        const res = await executeMondayQuery(query);
        const rawItems = res.boards?.[0]?.items_page?.items || [];
        // 2. Filter to this product + apply statusFilter
        const versions = [];
        for (const item of rawItems) {
            const colMap = new Map(item.column_values?.map((c) => [c.id, c]) || []);
            const linkedProducts = getLinkedItems(colMap, VERSION_COLUMNS.product);
            if (!linkedProducts.some(p => Number(p.id) === productId))
                continue;
            const status = getColumnText(colMap, VERSION_COLUMNS.status) || "";
            if (!includeStatus(status, statusFilter))
                continue;
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
            if (a.semver && b.semver)
                return compareSemVer(b.semver, a.semver); // descending
            if (a.semver && !b.semver)
                return -1;
            if (!a.semver && b.semver)
                return 1;
            return 0;
        });
        const top = versions.slice(0, limit);
        // 4. Per-version task categorization. One batched query for all linked tasks.
        const allTaskIds = top.flatMap(v => v.taskIds);
        const taskInfo = new Map();
        if (allTaskIds.length > 0) {
            const tasks = await resolveLinkedItems(allTaskIds, [TASK_COLUMNS.type]);
            for (const t of tasks) {
                const tColMap = new Map(t.column_values?.map((c) => [c.id, c]) || []);
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
    }
    catch (error) {
        return formatError(`Failed to fetch version timeline: ${error instanceof Error ? error.message : String(error)}`);
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function includeStatus(status, filter) {
    if (filter === "all")
        return true;
    if (filter === "released")
        return status === "Released";
    if (filter === "open")
        return OPEN_STATUSES.has(status);
    if (filter === "hotfix")
        return status === "Hotfix";
    return true;
}
function countTasks(taskIds, taskInfo) {
    const counts = { Feature: 0, Fix: 0, Improvement: 0, Other: 0 };
    for (const id of taskIds) {
        const info = taskInfo.get(id);
        if (!info)
            continue;
        if (info.type === "Feature")
            counts.Feature++;
        else if (info.type === "Fix")
            counts.Fix++;
        else if (info.type === "Improvement")
            counts.Improvement++;
        else
            counts.Other++;
    }
    return counts;
}
function renderMarkdown(versions, taskInfo, expandTasks) {
    const lines = ["# Version timeline (newest first)", ""];
    // Split into sections: shipping-soon (open) + released + hotfix
    const open = versions.filter(v => OPEN_STATUSES.has(v.status));
    const released = versions.filter(v => v.status === "Released");
    const hotfix = versions.filter(v => v.status === "Hotfix");
    if (open.length > 0) {
        lines.push("## Shipping now (open versions)");
        for (const v of open)
            lines.push(...renderVersionEntry(v, taskInfo, expandTasks));
        lines.push("");
    }
    if (hotfix.length > 0) {
        lines.push("## Hotfixes");
        for (const v of hotfix)
            lines.push(...renderVersionEntry(v, taskInfo, expandTasks));
        lines.push("");
    }
    if (released.length > 0) {
        lines.push("## Released");
        for (const v of released)
            lines.push(...renderVersionEntry(v, taskInfo, expandTasks));
        lines.push("");
    }
    return lines.join("\n").trim();
}
function renderVersionEntry(v, taskInfo, expandTasks) {
    const lines = [];
    const counts = countTasks(v.taskIds, taskInfo);
    const date = v.releaseDate || v.expectedReleaseDate || "";
    const dateStr = date ? ` · ${v.status === "Released" ? "released" : "expected"} ${date}` : "";
    lines.push(`### ${v.versionNumber} — ${v.name} ([#${v.id}](${v.url}))`);
    lines.push(`Status: **${v.status}**${dateStr} · ${v.taskIds.length} task${v.taskIds.length === 1 ? "" : "s"}`);
    if (counts.Feature + counts.Fix + counts.Improvement + counts.Other > 0) {
        const parts = [];
        if (counts.Feature > 0)
            parts.push(`${counts.Feature} Feature${counts.Feature === 1 ? "" : "s"}`);
        if (counts.Fix > 0)
            parts.push(`${counts.Fix} Fix${counts.Fix === 1 ? "" : "es"}`);
        if (counts.Improvement > 0)
            parts.push(`${counts.Improvement} Improvement${counts.Improvement === 1 ? "" : "s"}`);
        if (counts.Other > 0)
            parts.push(`${counts.Other} Other`);
        lines.push(`Breakdown: ${parts.join(", ")}`);
    }
    if (expandTasks && v.taskIds.length > 0) {
        lines.push("");
        for (const id of v.taskIds) {
            const info = taskInfo.get(id);
            if (!info)
                continue;
            lines.push(`  - [${info.type}] ${info.name} ([#${id}](${info.url}))`);
        }
    }
    lines.push("");
    return lines;
}
