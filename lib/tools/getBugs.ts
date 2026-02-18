import { executeMondayQuery } from "../monday-client";
import { BOARDS, BUG_COLUMNS, BUG_STATUS, BUG_PRIORITY } from "../constants";
import type { GetBugsInput } from "../schemas";
import { getColumnText, getLinkedItems, formatError } from "./utils";

export async function getBugs(args: GetBugsInput): Promise<string> {
  try {
    const { status, priority, productId, search, limit = 25 } = args;

    // Build query_params rules
    const rules: string[] = [];

    if (status) {
      const statusIndex = BUG_STATUS[status];
      rules.push(`{ column_id: "${BUG_COLUMNS.status}", compare_value: [${statusIndex}], operator: any_of }`);
    }

    if (priority) {
      const priorityIndex = BUG_PRIORITY[priority];
      rules.push(`{ column_id: "${BUG_COLUMNS.priority}", compare_value: [${priorityIndex}], operator: any_of }`);
    }

    if (productId) {
      rules.push(`{ column_id: "${BUG_COLUMNS.product}", compare_value: [${productId}], operator: any_of }`);
    }

    let queryParams = "";
    if (rules.length > 0) {
      queryParams = `, query_params: {
        rules: [${rules.join(",\n          ")}]
        ${rules.length > 1 ? "operator: and" : ""}
      }`;
    }

    // Fetch more if we need client-side search filtering
    const fetchLimit = search ? 500 : limit;

    const columnIds = [
      BUG_COLUMNS.status,
      BUG_COLUMNS.priority,
      BUG_COLUMNS.description,
      BUG_COLUMNS.connectedTasks,
      BUG_COLUMNS.product,
      BUG_COLUMNS.bugId,
    ].map(c => `"${c}"`).join(", ");

    const query = `
      query {
        boards(ids: [${BOARDS.BUGS}]) {
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
    let items = response.boards?.[0]?.items_page?.items || [];

    // Client-side search filtering on name and description
    if (search) {
      const searchLower = search.toLowerCase();
      items = items.filter((item: any) => {
        if (item.name.toLowerCase().includes(searchLower)) return true;

        const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
        const description = getColumnText(colMap, BUG_COLUMNS.description)?.toLowerCase() || "";
        if (description.includes(searchLower)) return true;

        return false;
      });
      items = items.slice(0, limit);
    }

    // Format output
    const lines: string[] = [];
    const filterParts: string[] = [];
    if (status) filterParts.push(`status: ${status}`);
    if (priority) filterParts.push(`priority: ${priority}`);
    if (productId) filterParts.push(`product: #${productId}`);
    if (search) filterParts.push(`search: "${search}"`);
    const filterInfo = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";

    lines.push(`# Bugs Queue — ${items.length} bugs${filterInfo}`);
    lines.push("");

    if (items.length === 0) {
      lines.push("No bugs found matching the filters.");
      return lines.join("\n");
    }

    for (const item of items) {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);

      const bugStatus = getColumnText(colMap, BUG_COLUMNS.status) || "Unknown";
      const bugPriority = getColumnText(colMap, BUG_COLUMNS.priority) || "—";
      const productItems = getLinkedItems(colMap, BUG_COLUMNS.product);
      const productName = productItems.length > 0 ? productItems[0].name : "—";
      const linkedTasks = getLinkedItems(colMap, BUG_COLUMNS.connectedTasks);
      const linkedTasksStr = linkedTasks.length > 0
        ? linkedTasks.map(t => `${t.name} (#${t.id})`).join(", ")
        : "—";

      lines.push(`- **BAIT-${item.id}** ${item.name}`);
      lines.push(`  Status: ${bugStatus} | Priority: ${bugPriority} | Product: ${productName}`);
      if (linkedTasks.length > 0) {
        lines.push(`  Linked Tasks: ${linkedTasksStr}`);
      }
      lines.push("");
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to fetch bugs: ${error instanceof Error ? error.message : String(error)}`);
  }
}
