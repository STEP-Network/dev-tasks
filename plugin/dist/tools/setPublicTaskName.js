import { executeMondayQuery } from "../monday-client.js";
import { BOARDS, TASK_COLUMNS } from "../constants.js";
import { buildColumnValues, formatError } from "./utils.js";
export async function setPublicTaskName(args) {
    try {
        const { taskId, name } = args;
        const mutation = `
      mutation {
        change_multiple_column_values(
          item_id: ${taskId},
          board_id: ${BOARDS.TASKS},
          column_values: ${buildColumnValues({ [TASK_COLUMNS.publicTaskName]: name })}
        ) {
          id
        }
      }
    `;
        await executeMondayQuery(mutation);
        return [
            `# Public Task Name Set`,
            ``,
            `**Task:** #${taskId}`,
            `**Public name:** ${name}`,
        ].join("\n");
    }
    catch (error) {
        return formatError(`Failed to set public task name: ${error instanceof Error ? error.message : String(error)}`);
    }
}
