import { executeMondayQuery } from "../monday-client.js";
import { BOARDS, BUG_COLUMNS, BUG_STATUS, BUG_PRIORITY } from "../constants.js";
import { buildColumnValues, resolveMaintenanceEpicId, formatError } from "./utils.js";
export async function createBug(args) {
    try {
        const { name, description, priority, productId, epicId, reporter } = args;
        // Resolve epic: explicit epicId > product's maintenance epic
        let resolvedEpicId = epicId;
        if (!resolvedEpicId && productId) {
            const maintenanceId = await resolveMaintenanceEpicId(productId);
            if (maintenanceId)
                resolvedEpicId = maintenanceId;
        }
        // Build column values
        const columnValues = {};
        // Status: Awaiting Review (default for new bugs)
        columnValues[BUG_COLUMNS.status] = { index: BUG_STATUS["Awaiting Review"] };
        // Priority (required)
        columnValues[BUG_COLUMNS.priority] = { index: BUG_PRIORITY[priority] };
        // Description (required)
        columnValues[BUG_COLUMNS.description] = { text: description };
        // Optional: Product link
        if (productId) {
            columnValues[BUG_COLUMNS.product] = { item_ids: [productId] };
        }
        // Optional: Epic link
        if (resolvedEpicId) {
            columnValues[BUG_COLUMNS.epic] = { item_ids: [resolvedEpicId] };
        }
        // Optional: Reporter
        if (reporter) {
            columnValues[BUG_COLUMNS.reporter] = {
                personsAndTeams: [{ id: reporter, kind: "person" }],
            };
        }
        // Create bug on the Bugs board, group "topics" (Incoming Bugs)
        const createQuery = `
      mutation {
        create_item(
          board_id: ${BOARDS.BUGS},
          group_id: "topics",
          item_name: ${JSON.stringify(name)},
          column_values: ${buildColumnValues(columnValues)},
          create_labels_if_missing: true
        ) {
          id
          name
        }
      }
    `;
        const createResponse = await executeMondayQuery(createQuery);
        const createdBug = createResponse.create_item;
        if (!createdBug) {
            throw new Error("Failed to create bug — no item returned from API.");
        }
        // Format output
        const lines = [];
        lines.push("# Bug Created");
        lines.push("");
        lines.push(`- **${createdBug.name}** (#${createdBug.id})`);
        const epicInfo = resolvedEpicId
            ? ` | Epic: #${resolvedEpicId}${!epicId ? " (auto-assigned)" : ""}`
            : "";
        lines.push(`  Status: Awaiting Review | Priority: ${priority}${epicInfo}`);
        if (productId) {
            lines.push(`  Product: #${productId}`);
        }
        return lines.join("\n").trim();
    }
    catch (error) {
        return formatError(`Failed to create bug: ${error instanceof Error ? error.message : String(error)}`);
    }
}
