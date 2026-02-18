import { executeMondayQuery } from "../monday-client";
import { BOARDS, PRODUCT_COLUMNS } from "../constants";
import type { ListProductsInput } from "../schemas";
import { getColumnText, getLinkedItems, formatError } from "./utils";

export async function listProducts(args: ListProductsInput): Promise<string> {
  try {
    const { search } = args;

    const columnIds = [
      PRODUCT_COLUMNS.status,
      PRODUCT_COLUMNS.priority,
      PRODUCT_COLUMNS.owner,
      PRODUCT_COLUMNS.epics,
      PRODUCT_COLUMNS.bugs,
      PRODUCT_COLUMNS.versions,
    ].map(c => `"${c}"`).join(", ");

    const query = `
      query {
        boards(ids: [${BOARDS.PRODUCTS}]) {
          items_page(limit: 50) {
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

    // Client-side search filter
    if (search) {
      const term = search.toLowerCase();
      items = items.filter((item: any) => item.name.toLowerCase().includes(term));
    }

    if (items.length === 0) {
      return formatError(`No products found${search ? ` matching "${search}"` : ""}.`);
    }

    const lines: string[] = [];
    lines.push(`# Products (${items.length})`);
    lines.push("");

    for (const item of items) {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);

      const status = getColumnText(colMap, PRODUCT_COLUMNS.status) || "—";
      const priority = getColumnText(colMap, PRODUCT_COLUMNS.priority) || "—";
      const owner = getColumnText(colMap, PRODUCT_COLUMNS.owner) || "—";
      const epics = getLinkedItems(colMap, PRODUCT_COLUMNS.epics);
      const bugs = getLinkedItems(colMap, PRODUCT_COLUMNS.bugs);
      const versions = getLinkedItems(colMap, PRODUCT_COLUMNS.versions);

      lines.push(`- **${item.name}** (#${item.id})`);
      lines.push(`  Status: ${status} | Priority: ${priority} | Owner: ${owner} | Epics: ${epics.length} | Bugs: ${bugs.length} | Versions: ${versions.length}`);
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to list products: ${error instanceof Error ? error.message : String(error)}`);
  }
}
