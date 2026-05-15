import { executeMondayQuery } from "../monday-client.ts";
import { BOARDS, FEEDBACK_COLUMNS, FEEDBACK_STATUS } from "../constants.ts";
import type { ListFeedbackInput } from "../schemas.ts";
import { getColumnText, getLinkedItems, formatError } from "./utils.ts";

export async function listFeedback(args: ListFeedbackInput): Promise<string> {
  try {
    const { type, status, priority, source, productId, search, limit = 25 } = args;

    const columnIds = [
      FEEDBACK_COLUMNS.status,
      FEEDBACK_COLUMNS.type,
      FEEDBACK_COLUMNS.priority,
      FEEDBACK_COLUMNS.source,
      FEEDBACK_COLUMNS.reporter,
      FEEDBACK_COLUMNS.product,
      FEEDBACK_COLUMNS.connectedTasks,
    ].map(c => `"${c}"`).join(", ");

    // Build server-side status filter
    const rules: string[] = [];
    if (status) {
      const statusIndex = FEEDBACK_STATUS[status];
      if (statusIndex !== undefined) {
        rules.push(`{ column_id: "${FEEDBACK_COLUMNS.status}", compare_value: [${statusIndex}], operator: any_of }`);
      }
    }

    const queryParams = rules.length > 0
      ? `query_params: { rules: [${rules.join(", ")}], operator: and }`
      : "";

    // Fetch more if filtering client-side
    const needsClientFilter = type || priority || source || productId || search;
    const fetchLimit = needsClientFilter ? 200 : limit;

    const query = `
      query {
        boards(ids: [${BOARDS.FEEDBACK}]) {
          items_page(limit: ${fetchLimit}${queryParams ? `, ${queryParams}` : ""}) {
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

    // Client-side filters
    if (type) {
      items = items.filter((item: any) => {
        const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
        return getColumnText(colMap, FEEDBACK_COLUMNS.type) === type;
      });
    }

    if (priority) {
      items = items.filter((item: any) => {
        const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
        return getColumnText(colMap, FEEDBACK_COLUMNS.priority) === priority;
      });
    }

    if (source) {
      items = items.filter((item: any) => {
        const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
        return getColumnText(colMap, FEEDBACK_COLUMNS.source) === source;
      });
    }

    if (productId) {
      items = items.filter((item: any) => {
        const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
        const productItems = getLinkedItems(colMap, FEEDBACK_COLUMNS.product);
        return productItems.some((p: any) => Number(p.id) === productId);
      });
    }

    if (search) {
      const term = search.toLowerCase();
      items = items.filter((item: any) => item.name.toLowerCase().includes(term));
    }

    // Apply limit after filtering
    items = items.slice(0, limit);

    if (items.length === 0) {
      const filterDesc = [
        type && `type="${type}"`,
        status && `status="${status}"`,
        priority && `priority="${priority}"`,
        source && `source="${source}"`,
        productId && `productId=${productId}`,
        search && `search="${search}"`,
      ].filter(Boolean).join(", ");
      return formatError(`No items found${filterDesc ? ` matching ${filterDesc}` : ""}.`);
    }

    // Format output
    const lines: string[] = [];
    lines.push(`# Requests & Feedback (${items.length})`);
    lines.push("");

    for (const item of items) {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);

      const itemStatus = getColumnText(colMap, FEEDBACK_COLUMNS.status) || "Unknown";
      const itemType = getColumnText(colMap, FEEDBACK_COLUMNS.type) || "—";
      const itemPriority = getColumnText(colMap, FEEDBACK_COLUMNS.priority) || "—";
      const itemSource = getColumnText(colMap, FEEDBACK_COLUMNS.source) || "—";
      const reporter = getColumnText(colMap, FEEDBACK_COLUMNS.reporter) || "—";
      const productItems = getLinkedItems(colMap, FEEDBACK_COLUMNS.product);
      const product = productItems.length > 0 ? `${productItems[0].name} (#${productItems[0].id})` : "—";
      const taskCount = getLinkedItems(colMap, FEEDBACK_COLUMNS.connectedTasks).length;

      lines.push(`- **${item.name}** (#${item.id})`);
      lines.push(`  Type: ${itemType} | Status: ${itemStatus} | Priority: ${itemPriority} | Source: ${itemSource} | Reporter: ${reporter} | Product: ${product} | Tasks: ${taskCount}`);
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to list feedback: ${error instanceof Error ? error.message : String(error)}`);
  }
}
