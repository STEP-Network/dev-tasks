import { executeMondayQuery } from "../monday-client.js";
import { formatError } from "./utils.js";
export async function createUpdate(args) {
    try {
        const { itemId, body, parentUpdateId } = args;
        const parentClause = parentUpdateId ? `parent_id: ${parentUpdateId}` : "";
        const query = `
      mutation {
        create_update(
          item_id: ${itemId},
          body: ${JSON.stringify(body)}
          ${parentClause}
        ) {
          id
          text_body
          created_at
        }
      }
    `;
        const response = await executeMondayQuery(query);
        const created = response.create_update;
        if (!created) {
            throw new Error("No update returned from API.");
        }
        const lines = [];
        lines.push(parentUpdateId ? "# Reply Posted" : "# Update Posted");
        lines.push("");
        lines.push(`- **ID:** ${created.id}`);
        lines.push(`- **Item:** #${itemId}`);
        if (parentUpdateId) {
            lines.push(`- **In reply to:** Update #${parentUpdateId}`);
        }
        lines.push(`- **Preview:** ${(created.text_body || "").slice(0, 200)}`);
        return lines.join("\n").trim();
    }
    catch (error) {
        return formatError(`Failed to create update: ${error instanceof Error ? error.message : String(error)}`);
    }
}
