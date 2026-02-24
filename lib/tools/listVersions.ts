import { executeMondayQuery } from "../monday-client";
import { BOARDS, VERSION_COLUMNS, VERSION_STATUS, VERSION_GROUPS } from "../constants";
import type { ListVersionsInput } from "../schemas";
import { getColumnText, getLinkedItems, formatError } from "./utils";

export async function listVersions(args: ListVersionsInput): Promise<string> {
  try {
    const { status, productId, group, search, limit = 25 } = args;

    const columnIds = [
      VERSION_COLUMNS.status,
      VERSION_COLUMNS.versionNumber,
      VERSION_COLUMNS.expectedReleaseDate,
      VERSION_COLUMNS.releaseDate,
      VERSION_COLUMNS.owner,
      VERSION_COLUMNS.product,
      VERSION_COLUMNS.connectedTasks,
      VERSION_COLUMNS.connectedEpics,
      VERSION_COLUMNS.fixedBugs,
    ].map(c => `"${c}"`).join(", ");

    // Build server-side status filter
    const rules: string[] = [];
    if (status) {
      const statusIndex = VERSION_STATUS[status];
      if (statusIndex !== undefined) {
        rules.push(`{ column_id: "${VERSION_COLUMNS.status}", compare_value: [${statusIndex}], operator: any_of }`);
      }
    }

    const queryParams = rules.length > 0
      ? `query_params: { rules: [${rules.join(", ")}], operator: and }`
      : "";

    // Fetch more if filtering client-side
    const fetchLimit = (search || productId) ? 200 : limit;

    let items: any[];

    if (group) {
      // Group-based query
      const groupId = group === "released" ? VERSION_GROUPS.RELEASED : VERSION_GROUPS.UPCOMING;
      const query = `
        query {
          boards(ids: [${BOARDS.VERSIONS}]) {
            groups(ids: ["${groupId}"]) {
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
        }
      `;
      const response = await executeMondayQuery<any>(query);
      items = response.boards?.[0]?.groups?.[0]?.items_page?.items || [];
    } else {
      // Standard board-level query
      const query = `
        query {
          boards(ids: [${BOARDS.VERSIONS}]) {
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
      items = response.boards?.[0]?.items_page?.items || [];
    }

    // Client-side product filter
    if (productId) {
      items = items.filter((item: any) => {
        const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
        const productItems = getLinkedItems(colMap, VERSION_COLUMNS.product);
        return productItems.some((p: any) => Number(p.id) === productId);
      });
    }

    // Client-side search filter
    if (search) {
      const term = search.toLowerCase();
      items = items.filter((item: any) => item.name.toLowerCase().includes(term));
    }

    // Apply limit after filtering
    items = items.slice(0, limit);

    if (items.length === 0) {
      const filterDesc = [
        status && `status="${status}"`,
        productId && `productId=${productId}`,
        group && `group="${group}"`,
        search && `search="${search}"`,
      ].filter(Boolean).join(", ");
      return formatError(`No versions found${filterDesc ? ` matching ${filterDesc}` : ""}.`);
    }

    // Format output
    const lines: string[] = [];
    lines.push(`# Versions (${items.length})`);
    lines.push("");

    for (const item of items) {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);

      const versionStatus = getColumnText(colMap, VERSION_COLUMNS.status) || "Unknown";
      const versionNumber = getColumnText(colMap, VERSION_COLUMNS.versionNumber) || "—";
      const expectedDate = getColumnText(colMap, VERSION_COLUMNS.expectedReleaseDate) || "—";
      const releaseDate = getColumnText(colMap, VERSION_COLUMNS.releaseDate) || "—";
      const owner = getColumnText(colMap, VERSION_COLUMNS.owner) || "—";
      const productItems = getLinkedItems(colMap, VERSION_COLUMNS.product);
      const product = productItems.length > 0 ? `${productItems[0].name} (#${productItems[0].id})` : "—";

      const taskCount = getLinkedItems(colMap, VERSION_COLUMNS.connectedTasks).length;
      const epicCount = getLinkedItems(colMap, VERSION_COLUMNS.connectedEpics).length;
      const bugCount = getLinkedItems(colMap, VERSION_COLUMNS.fixedBugs).length;

      lines.push(`- **${item.name}** (#${item.id})`);
      lines.push(`  Status: ${versionStatus} | Version: ${versionNumber} | Expected: ${expectedDate} | Released: ${releaseDate} | Owner: ${owner} | Product: ${product} | Tasks: ${taskCount} | Epics: ${epicCount} | Bugs: ${bugCount}`);
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to list versions: ${error instanceof Error ? error.message : String(error)}`);
  }
}
