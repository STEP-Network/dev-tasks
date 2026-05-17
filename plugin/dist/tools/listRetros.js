import { executeMondayQuery } from "../monday-client.js";
import { BOARDS, RETRO_COLUMNS } from "../constants.js";
import { getActiveSprintIds, getColumnText, getColumnValue, getLinkedItems, formatError } from "./utils.js";
export async function listRetros(args) {
    try {
        const { sprintId, activeSprint = false, search, limit = 25 } = args;
        const columnIds = [
            RETRO_COLUMNS.type,
            RETRO_COLUMNS.repeating,
            RETRO_COLUMNS.submitter,
            RETRO_COLUMNS.owner,
            RETRO_COLUMNS.vote,
            RETRO_COLUMNS.sprint,
            RETRO_COLUMNS.description,
        ].map(c => `"${c}"`).join(", ");
        // Resolve sprint filter — activeSprint expands to all active sprint IDs.
        let sprintFilterIds = null;
        if (activeSprint) {
            sprintFilterIds = await getActiveSprintIds();
            if (sprintFilterIds.length === 0) {
                return formatError("No active sprint found.");
            }
        }
        else if (sprintId !== undefined) {
            sprintFilterIds = [sprintId];
        }
        const rules = [];
        if (sprintFilterIds) {
            rules.push(`{ column_id: "${RETRO_COLUMNS.sprint}", compare_value: [${sprintFilterIds.join(",")}], operator: any_of }`);
        }
        const queryParams = rules.length > 0
            ? `query_params: { rules: [${rules.join(", ")}], operator: and }`
            : "";
        // Search is filtered client-side (matches name + description), so over-fetch when in play.
        const fetchLimit = search ? 200 : limit;
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
                ... on BoardRelationValue { linked_items { id name } }
              }
            }
          }
        }
      }
    `;
        const response = await executeMondayQuery(query);
        let items = response.boards?.[0]?.items_page?.items || [];
        if (search) {
            const term = search.toLowerCase();
            items = items.filter((item) => {
                if (item.name.toLowerCase().includes(term))
                    return true;
                const colMap = new Map(item.column_values?.map((c) => [c.id, c]) || []);
                const desc = getColumnText(colMap, RETRO_COLUMNS.description) || "";
                return desc.toLowerCase().includes(term);
            });
        }
        items = items.slice(0, limit);
        if (items.length === 0) {
            const filterDesc = [
                activeSprint && "activeSprint",
                sprintId !== undefined && `sprintId=${sprintId}`,
                search && `search="${search}"`,
            ].filter(Boolean).join(", ");
            return formatError(`No retro items found${filterDesc ? ` matching ${filterDesc}` : ""}.`);
        }
        const lines = [];
        lines.push(`# Retro Items (${items.length})`);
        lines.push("");
        for (const item of items) {
            const colMap = new Map(item.column_values?.map((c) => [c.id, c]) || []);
            const itemType = getColumnText(colMap, RETRO_COLUMNS.type) || "—";
            const checkVal = getColumnValue(colMap, RETRO_COLUMNS.repeating);
            const isRepeating = checkVal?.checked === true || checkVal?.checked === "true";
            const submitter = getColumnText(colMap, RETRO_COLUMNS.submitter) || "—";
            const owner = getColumnText(colMap, RETRO_COLUMNS.owner) || "—";
            const voteText = getColumnText(colMap, RETRO_COLUMNS.vote) || "0";
            const sprintItems = getLinkedItems(colMap, RETRO_COLUMNS.sprint);
            const sprint = sprintItems.length > 0 ? `${sprintItems[0].name} (#${sprintItems[0].id})` : "—";
            lines.push(`- **${item.name}** (#${item.id})`);
            lines.push(`  Type: ${itemType} | Repeating: ${isRepeating ? "Yes" : "No"} | Sprint: ${sprint} | Submitter: ${submitter} | Owner: ${owner} | Votes: ${voteText}`);
        }
        return lines.join("\n").trim();
    }
    catch (error) {
        return formatError(`Failed to list retros: ${error instanceof Error ? error.message : String(error)}`);
    }
}
