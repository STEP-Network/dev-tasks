import { executeMondayQuery } from "../monday-client";
import { BOARDS, RETRO_COLUMNS, RETRO_TYPE, RETRO_GROUPS } from "../constants";
import type { CreateRetroInput } from "../schemas";
import { buildColumnValues, formatError } from "./utils";

export async function createRetro(args: CreateRetroInput): Promise<string> {
  try {
    const columnValues: Record<string, unknown> = {};

    // Type (required) — sets the status column on the retro board
    columnValues[RETRO_COLUMNS.type] = { index: RETRO_TYPE[args.type] };

    if (args.description !== undefined) {
      columnValues[RETRO_COLUMNS.description] = { text: args.description };
    }

    if (args.repeating !== undefined) {
      columnValues[RETRO_COLUMNS.repeating] = { checked: args.repeating ? "true" : "false" };
    }

    if (args.submitter) {
      columnValues[RETRO_COLUMNS.submitter] = { personsAndTeams: [{ id: args.submitter, kind: "person" }] };
    }

    if (args.owner) {
      columnValues[RETRO_COLUMNS.owner] = { personsAndTeams: [{ id: args.owner, kind: "person" }] };
    }

    const createQuery = `
      mutation {
        create_item(
          board_id: ${BOARDS.RETROS},
          group_id: "${RETRO_GROUPS.DEFAULT}",
          item_name: ${JSON.stringify(args.name)},
          column_values: ${buildColumnValues(columnValues)}
        ) {
          id
          name
        }
      }
    `;

    const response = await executeMondayQuery<any>(createQuery);
    const created = response.create_item;

    if (!created) {
      throw new Error(`Failed to create retro item "${args.name}"`);
    }

    const lines: string[] = [
      `# Retro Item Created`,
      ``,
      `- **${created.name}** (#${created.id})`,
      `  Type: ${args.type}${args.repeating !== undefined ? ` | Repeating: ${args.repeating ? "Yes" : "No"}` : ""}`,
    ];

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to create retro: ${error instanceof Error ? error.message : String(error)}`);
  }
}
