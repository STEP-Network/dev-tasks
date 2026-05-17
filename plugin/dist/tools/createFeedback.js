import { executeMondayQuery } from "../monday-client.js";
import { BOARDS, FEEDBACK_COLUMNS, FEEDBACK_STATUS, FEEDBACK_TYPE, FEEDBACK_PRIORITY, FEEDBACK_SOURCE, FEEDBACK_GROUPS, } from "../constants.js";
import { buildColumnValues, formatError } from "./utils.js";
export async function createFeedback(args) {
    try {
        const columnValues = {};
        // Type (required)
        columnValues[FEEDBACK_COLUMNS.type] = { index: FEEDBACK_TYPE[args.type] };
        // Status (default: New)
        columnValues[FEEDBACK_COLUMNS.status] = { index: FEEDBACK_STATUS["New"] };
        // Description
        if (args.description) {
            columnValues[FEEDBACK_COLUMNS.description] = { text: args.description };
        }
        // Priority
        if (args.priority) {
            columnValues[FEEDBACK_COLUMNS.priority] = { index: FEEDBACK_PRIORITY[args.priority] };
        }
        // Source
        if (args.source) {
            columnValues[FEEDBACK_COLUMNS.source] = { index: FEEDBACK_SOURCE[args.source] };
        }
        // Product link
        if (args.productId) {
            columnValues[FEEDBACK_COLUMNS.product] = { item_ids: [args.productId] };
        }
        // Reporter
        if (args.reporter) {
            columnValues[FEEDBACK_COLUMNS.reporter] = { personsAndTeams: [{ id: args.reporter, kind: "person" }] };
        }
        const createQuery = `
      mutation {
        create_item(
          board_id: ${BOARDS.FEEDBACK},
          group_id: "${FEEDBACK_GROUPS.INCOMING}",
          item_name: ${JSON.stringify(args.name)},
          column_values: ${buildColumnValues(columnValues)}
        ) {
          id
          name
        }
      }
    `;
        const response = await executeMondayQuery(createQuery);
        const createdItem = response.create_item;
        if (!createdItem) {
            throw new Error(`Failed to create feedback item "${args.name}"`);
        }
        const lines = [
            `# ${args.type} Created`,
            ``,
            `- **${createdItem.name}** (#${createdItem.id})`,
            `  Type: ${args.type} | Status: New`,
        ];
        return lines.join("\n").trim();
    }
    catch (error) {
        return formatError(`Failed to create feedback item: ${error instanceof Error ? error.message : String(error)}`);
    }
}
