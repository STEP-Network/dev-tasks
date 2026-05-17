import { executeMondayQuery } from "../monday-client.js";
import { AGENT_ID, BOARDS, EPIC_COLUMNS, TASK_COLUMNS, TASK_STATUS, TASK_TYPE } from "../constants.js";
import { getColumnText, getLinkedItems, getMirrorDisplayValue, mondayItemUrl, formatError } from "./utils.js";
const TASK_COLUMN_IDS_FOR_BACKLOG = [
    TASK_COLUMNS.status,
    TASK_COLUMNS.priority,
    TASK_COLUMNS.type,
    TASK_COLUMNS.estimatedHours,
    TASK_COLUMNS.epic,
    TASK_COLUMNS.sprint,
    TASK_COLUMNS.agentId,
    TASK_COLUMNS.planId,
    TASK_COLUMNS.taskId,
    TASK_COLUMNS.product,
].map(c => `"${c}"`).join(", ");
const ITEMS_PAGE_FRAGMENT = `
  items {
    id
    name
    column_values(ids: [${TASK_COLUMN_IDS_FOR_BACKLOG}]) {
      id
      text
      value
      ... on BoardRelationValue { linked_items { id name } }
      ... on MirrorValue { display_value }
    }
  }
`;
// Resolve a product enum to the list of epic IDs linked to that product on Monday.
// Tasks can't be filtered by product directly (mirror column) so we filter via epic.
async function resolveProductEpicIds(productItemId) {
    const query = `
    query {
      boards(ids: [${BOARDS.EPICS}]) {
        items_page(limit: 500, query_params: {
          rules: [{ column_id: "${EPIC_COLUMNS.product}", compare_value: [${productItemId}], operator: any_of }]
        }) {
          items { id }
        }
      }
    }
  `;
    const response = await executeMondayQuery(query);
    const items = response.boards?.[0]?.items_page?.items || [];
    return items.map((item) => Number(item.id));
}
function buildTaskEntry(item) {
    const colMap = new Map(item.column_values?.map((c) => [c.id, c]) || []);
    const epicItems = getLinkedItems(colMap, TASK_COLUMNS.epic);
    const sprintItems = getLinkedItems(colMap, TASK_COLUMNS.sprint);
    return {
        id: Number(item.id),
        name: String(item.name),
        url: mondayItemUrl(BOARDS.TASKS, item.id),
        status: getColumnText(colMap, TASK_COLUMNS.status) || "Unknown",
        priority: getColumnText(colMap, TASK_COLUMNS.priority) || "—",
        type: getColumnText(colMap, TASK_COLUMNS.type) || "—",
        estimatedHours: getMirrorDisplayValue(colMap, TASK_COLUMNS.estimatedHours),
        product: getMirrorDisplayValue(colMap, TASK_COLUMNS.product),
        epic: epicItems[0] ? { id: Number(epicItems[0].id), name: epicItems[0].name } : undefined,
        sprint: sprintItems[0] ? { id: Number(sprintItems[0].id), name: sprintItems[0].name } : undefined,
        agent: getColumnText(colMap, TASK_COLUMNS.agentId),
    };
}
export async function getBacklog(args) {
    try {
        const { statuses, types, unclaimedOnly = false, agentId, epicIds, sprintIds, productId, query, cursor, limit = 25, format = "markdown", } = args;
        // Cursor-driven page fetch — Monday inherits the original filter set from
        // the seed page, so we don't (and can't) re-apply any of the other args.
        let response;
        if (cursor) {
            const cursorQuery = `
        query {
          next_items_page(limit: ${limit}, cursor: ${JSON.stringify(cursor)}) {
            cursor
            ${ITEMS_PAGE_FRAGMENT}
          }
        }
      `;
            response = await executeMondayQuery(cursorQuery);
            const page = response.next_items_page;
            return renderResponse((page?.items || []).map(buildTaskEntry), page?.cursor ?? null, { cursor }, format);
        }
        // Resolve product → epic IDs server-side (mirror columns aren't filterable).
        let productEpicIds;
        if (productId !== undefined) {
            const numericProductId = typeof productId === "string" ? Number(productId) : productId;
            productEpicIds = await resolveProductEpicIds(numericProductId);
            if (productEpicIds.length === 0) {
                return renderResponse([], null, { productId: numericProductId }, format, `No epics found for productId ${numericProductId}.`);
            }
        }
        const rules = [];
        // Statuses — default to "not yet in flight" if not provided.
        const statusIndices = (statuses ?? ["Needs Refinement", "Ready to Start"]).map(s => TASK_STATUS[s]);
        rules.push(`{ column_id: "${TASK_COLUMNS.status}", compare_value: [${statusIndices.join(",")}], operator: any_of }`);
        if (types && types.length > 0) {
            const typeIndices = types.map(t => TASK_TYPE[t]);
            rules.push(`{ column_id: "${TASK_COLUMNS.type}", compare_value: [${typeIndices.join(",")}], operator: any_of }`);
        }
        if (unclaimedOnly) {
            rules.push(`{ column_id: "${TASK_COLUMNS.agentId}", compare_value: [], operator: is_empty }`);
        }
        if (agentId) {
            rules.push(`{ column_id: "${TASK_COLUMNS.agentId}", compare_value: [${AGENT_ID[agentId]}], operator: any_of }`);
        }
        // Epic filter: intersect explicit epicIds with productEpicIds when both given.
        let effectiveEpicIds;
        if (epicIds && productEpicIds) {
            const allowed = new Set(productEpicIds);
            effectiveEpicIds = epicIds.filter(id => allowed.has(id));
            if (effectiveEpicIds.length === 0) {
                return renderResponse([], null, { epicIds, productId }, format, `None of the specified epicIds belong to productId ${productId}.`);
            }
        }
        else if (epicIds) {
            effectiveEpicIds = epicIds;
        }
        else if (productEpicIds) {
            effectiveEpicIds = productEpicIds;
        }
        if (effectiveEpicIds && effectiveEpicIds.length > 0) {
            rules.push(`{ column_id: "${TASK_COLUMNS.epic}", compare_value: [${effectiveEpicIds.join(",")}], operator: any_of }`);
        }
        if (sprintIds && sprintIds.length > 0) {
            rules.push(`{ column_id: "${TASK_COLUMNS.sprint}", compare_value: [${sprintIds.join(",")}], operator: any_of }`);
        }
        if (query && query.trim().length > 0) {
            // contains_text matches on the item name column case-insensitively.
            rules.push(`{ column_id: "name", compare_value: [${JSON.stringify(query.trim())}], operator: contains_text }`);
        }
        const queryParams = `query_params: { rules: [${rules.join(", ")}], operator: and }`;
        const pageQuery = `
      query {
        boards(ids: [${BOARDS.TASKS}]) {
          items_page(limit: ${limit}, ${queryParams}) {
            cursor
            ${ITEMS_PAGE_FRAGMENT}
          }
        }
      }
    `;
        response = await executeMondayQuery(pageQuery);
        const page = response.boards?.[0]?.items_page;
        const tasks = (page?.items || []).map(buildTaskEntry);
        const nextCursor = page?.cursor ?? null;
        const filters = {
            statuses: statuses ?? ["Needs Refinement", "Ready to Start"],
            types: types?.length ? types : undefined,
            unclaimedOnly: unclaimedOnly || undefined,
            agentId,
            epicIds: epicIds?.length ? epicIds : undefined,
            sprintIds: sprintIds?.length ? sprintIds : undefined,
            productId,
            query: query?.trim() || undefined,
        };
        return renderResponse(tasks, nextCursor, filters, format);
    }
    catch (error) {
        return formatError(`Failed to fetch backlog: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function renderResponse(tasks, nextCursor, filters, format, emptyNote) {
    // Strip undefined filter values for a clean JSON shape.
    const cleanFilters = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined));
    if (format === "json") {
        const body = { tasks, nextCursor, filters: cleanFilters };
        return JSON.stringify(body, null, 2);
    }
    const filterParts = [];
    for (const [k, v] of Object.entries(cleanFilters)) {
        if (Array.isArray(v))
            filterParts.push(`${k}: ${v.join(", ")}`);
        else
            filterParts.push(`${k}: ${v}`);
    }
    const filterInfo = filterParts.length > 0 ? ` (${filterParts.join(" | ")})` : "";
    const lines = [];
    lines.push(`# Backlog — ${tasks.length} task${tasks.length === 1 ? "" : "s"}${filterInfo}`);
    lines.push("");
    if (tasks.length === 0) {
        lines.push(emptyNote ?? "No tasks found matching the filters.");
        return lines.join("\n");
    }
    for (const t of tasks) {
        const epicLabel = t.epic ? `${t.epic.name} (#${t.epic.id})` : "—";
        const sprintLabel = t.sprint ? `${t.sprint.name} (#${t.sprint.id})` : "—";
        lines.push(`- **(#${t.id}) ${t.name}**`);
        lines.push(`  Status: ${t.status} | Priority: ${t.priority} | Type: ${t.type} | Hours: ${t.estimatedHours ?? "—"}`);
        lines.push(`  Product: ${t.product ?? "—"} | Epic: ${epicLabel} | Sprint: ${sprintLabel} | Agent: ${t.agent ?? "—"}`);
        lines.push(`  URL: ${t.url}`);
        lines.push("");
    }
    if (nextCursor) {
        lines.push(`*Next cursor:* ${nextCursor}`);
        lines.push(`(pass as \`cursor\` to fetch the next page)`);
    }
    return lines.join("\n").trim();
}
