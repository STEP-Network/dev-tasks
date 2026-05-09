import { executeMondayQuery } from "../monday-client";
import { BOARDS, RETRO_COLUMNS, RETRO_TYPE } from "../constants";
import type { ListRetrosInput } from "../schemas";
import { getColumnText, getColumnValue, formatError } from "./utils";

export async function listRetros(args: ListRetrosInput): Promise<string> {
  try {
    const { type, repeating, search, limit = 25 } = args;

    const columnIds = [
      RETRO_COLUMNS.type,
      RETRO_COLUMNS.repeating,
      RETRO_COLUMNS.submitter,
      RETRO_COLUMNS.owner,
      RETRO_COLUMNS.vote,
    ].map(c => `"${c}"`).join(", ");

    // Server-side filter on type (status column) when provided.
    const rules: string[] = [];
    if (type) {
      const idx = RETRO_TYPE[type];
      if (idx !== undefined) {
        rules.push(`{ column_id: "${RETRO_COLUMNS.type}", compare_value: [${idx}], operator: any_of }`);
      }
    }

    const queryParams = rules.length > 0
      ? `query_params: { rules: [${rules.join(", ")}], operator: and }`
      : "";

    // Repeating + search are filtered client-side, so over-fetch when those are in play.
    const needsClientFilter = repeating !== undefined || search;
    const fetchLimit = needsClientFilter ? 200 : limit;

    const query = `
      query {
        boards(ids: [${BOARDS.RETROS}]) {
          items_page(limit: ${fetchLimit}${queryParams ? `, ${queryParams}` : ""}) {
            items {
              id
              name
              column_values(ids: [${columnIds}]) {
                id
                text
                value
              }
            }
          }
        }
      }
    `;

    const response = await executeMondayQuery<any>(query);
    let items = response.boards?.[0]?.items_page?.items || [];

    if (repeating !== undefined) {
      items = items.filter((item: any) => {
        const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
        const checkVal = getColumnValue(colMap, RETRO_COLUMNS.repeating);
        const isChecked = checkVal?.checked === true || checkVal?.checked === "true";
        return isChecked === repeating;
      });
    }

    if (search) {
      const term = search.toLowerCase();
      items = items.filter((item: any) => item.name.toLowerCase().includes(term));
    }

    items = items.slice(0, limit);

    if (items.length === 0) {
      const filterDesc = [
        type && `type="${type}"`,
        repeating !== undefined && `repeating=${repeating}`,
        search && `search="${search}"`,
      ].filter(Boolean).join(", ");
      return formatError(`No retro items found${filterDesc ? ` matching ${filterDesc}` : ""}.`);
    }

    const lines: string[] = [];
    lines.push(`# Retro Items (${items.length})`);
    lines.push("");

    for (const item of items) {
      const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);

      const itemType = getColumnText(colMap, RETRO_COLUMNS.type) || "—";
      const checkVal = getColumnValue(colMap, RETRO_COLUMNS.repeating);
      const isRepeating = checkVal?.checked === true || checkVal?.checked === "true";
      const submitter = getColumnText(colMap, RETRO_COLUMNS.submitter) || "—";
      const owner = getColumnText(colMap, RETRO_COLUMNS.owner) || "—";
      const voteText = getColumnText(colMap, RETRO_COLUMNS.vote) || "0";

      lines.push(`- **${item.name}** (#${item.id})`);
      lines.push(`  Type: ${itemType} | Repeating: ${isRepeating ? "Yes" : "No"} | Submitter: ${submitter} | Owner: ${owner} | Votes: ${voteText}`);
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to list retros: ${error instanceof Error ? error.message : String(error)}`);
  }
}
