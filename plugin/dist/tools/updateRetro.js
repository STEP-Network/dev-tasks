import { executeMondayQuery } from "../monday-client.js";
import { BOARDS, RETRO_COLUMNS, RETRO_TYPE } from "../constants.js";
import { buildColumnValues, formatError } from "./utils.js";
export async function updateRetro(args) {
    try {
        const { retroId } = args;
        if (args.delete) {
            const deleteMutation = `
        mutation {
          delete_item(item_id: ${retroId}) {
            id
          }
        }
      `;
            await executeMondayQuery(deleteMutation);
            return `# Retro Deleted\n\nRetro #${retroId} has been deleted.`;
        }
        const columnValues = {};
        const changes = [];
        if (args.type !== undefined) {
            columnValues[RETRO_COLUMNS.type] = { index: RETRO_TYPE[args.type] };
            changes.push(`Type -> ${args.type}`);
        }
        if (args.description !== undefined) {
            columnValues[RETRO_COLUMNS.description] = { text: args.description };
            changes.push(`Description updated`);
        }
        if (args.repeating !== undefined) {
            columnValues[RETRO_COLUMNS.repeating] = { checked: args.repeating ? "true" : "false" };
            changes.push(`Repeating -> ${args.repeating ? "Yes" : "No"}`);
        }
        if (args.submitter !== undefined) {
            columnValues[RETRO_COLUMNS.submitter] = { personsAndTeams: [{ id: args.submitter, kind: "person" }] };
            changes.push(`Submitter -> #${args.submitter}`);
        }
        if (args.owner !== undefined) {
            columnValues[RETRO_COLUMNS.owner] = { personsAndTeams: [{ id: args.owner, kind: "person" }] };
            changes.push(`Owner -> #${args.owner}`);
        }
        if (args.sprintId !== undefined) {
            columnValues[RETRO_COLUMNS.sprint] = { item_ids: [args.sprintId] };
            changes.push(`Sprint -> #${args.sprintId}`);
        }
        if (Object.keys(columnValues).length > 0) {
            const mutation = `
        mutation {
          change_multiple_column_values(
            item_id: ${retroId},
            board_id: ${BOARDS.RETROS},
            column_values: ${buildColumnValues(columnValues)}
          ) {
            id
          }
        }
      `;
            await executeMondayQuery(mutation);
        }
        if (args.name !== undefined) {
            const nameMutation = `
        mutation {
          change_simple_column_value(
            item_id: ${retroId},
            board_id: ${BOARDS.RETROS},
            column_id: "name",
            value: ${JSON.stringify(args.name)}
          ) {
            id
          }
        }
      `;
            await executeMondayQuery(nameMutation);
            changes.push(`Name -> "${args.name}"`);
        }
        if (changes.length === 0) {
            return formatError(`No fields provided to update for retro #${retroId}.`);
        }
        const lines = [
            `# Retro Updated`,
            ``,
            `**Retro:** #${retroId}`,
            ``,
            `**Changes:**`,
            ...changes.map(c => `- ${c}`),
        ];
        return lines.join("\n");
    }
    catch (error) {
        return formatError(`Failed to update retro: ${error instanceof Error ? error.message : String(error)}`);
    }
}
