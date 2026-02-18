import { executeMondayQuery } from "../monday-client";
import { BOARDS, TASK_COLUMNS, TASK_STATUS, AGENT_ID } from "../constants";
import type { ClaimTaskInput } from "../schemas";
import {
  getColumnText,
  getDropdownValues,
  getColumnValue,
  checkDependenciesResolved,
  buildColumnValues,
  todayDate,
  formatError,
} from "./utils";

export async function claimTask(args: ClaimTaskInput): Promise<string> {
  try {
    const { itemId, agentId, planId } = args;

    // Step 1: Fetch the task to check current state
    const columnIds = [
      TASK_COLUMNS.status,
      TASK_COLUMNS.agentId,
    ].map(c => `"${c}"`).join(", ");

    const fetchQuery = `
      query {
        items(ids: [${itemId}]) {
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
    `;

    const fetchResponse = await executeMondayQuery<any>(fetchQuery);
    const item = fetchResponse.items?.[0];

    if (!item) {
      return formatError(`Task #${itemId} not found.`);
    }

    const colMap = new Map<string, any>(
      item.column_values?.map((c: any) => [c.id, c]) || []
    );

    // Step 2: Validate preconditions

    // Check status is Backlog or Ready to Start
    const currentStatus = getColumnText(colMap, TASK_COLUMNS.status) || "Unknown";
    const claimableStatuses = ["Backlog", "Ready to Start"];
    if (!claimableStatuses.includes(currentStatus)) {
      return formatError(
        `Cannot claim task #${itemId} "${item.name}".\n` +
        `Current status is "${currentStatus}" — task must be "Backlog" or "Ready to Start" to claim.`
      );
    }

    // Check Agent ID is empty (no one has claimed it)
    const currentAgentIds = getDropdownValues(colMap, TASK_COLUMNS.agentId);
    if (currentAgentIds.length > 0) {
      const agentText = getColumnText(colMap, TASK_COLUMNS.agentId) || "Unknown agent";
      return formatError(
        `Cannot claim task #${itemId} "${item.name}".\n` +
        `Already claimed by: ${agentText}.`
      );
    }

    // Check dependencies if the column exists (handle gracefully if missing)
    try {
      const depValue = getColumnValue(colMap, "board_relation");
      if (depValue && depValue.linkedPulseIds && depValue.linkedPulseIds.length > 0) {
        const depIds = depValue.linkedPulseIds.map((p: any) => Number(p.linkedPulseId));
        const depCheck = await checkDependenciesResolved(depIds);
        if (!depCheck.resolved) {
          const blockerList = depCheck.blockers
            .map(b => `  - #${b.id} "${b.name}" (${b.status})`)
            .join("\n");
          return formatError(
            `Cannot claim task #${itemId} "${item.name}".\n` +
            `Blocked by unresolved dependencies:\n${blockerList}`
          );
        }
      }
    } catch {
      // Dependencies column may not exist yet — skip gracefully
    }

    // Step 3: Perform atomic claim mutation
    const columnValues: Record<string, unknown> = {
      [TASK_COLUMNS.status]: { index: TASK_STATUS["In Progress"] },
      [TASK_COLUMNS.agentId]: { ids: [String(AGENT_ID[agentId])] },
      [TASK_COLUMNS.startedDate]: { date: todayDate() },
    };

    if (planId) {
      columnValues[TASK_COLUMNS.planId] = planId;
    }

    const mutation = `
      mutation {
        change_multiple_column_values(
          item_id: ${itemId},
          board_id: ${BOARDS.TASKS},
          column_values: ${buildColumnValues(columnValues)}
        ) {
          id
        }
      }
    `;

    await executeMondayQuery<any>(mutation);

    // Step 4: Return success
    const lines: string[] = [
      `# Task Claimed`,
      ``,
      `**Task:** #${itemId} — ${item.name}`,
      `**Agent:** ${agentId}`,
      `**Status:** In Progress`,
      `**Started:** ${todayDate()}`,
    ];

    if (planId) {
      lines.push(`**Plan:** ${planId}`);
    }

    return lines.join("\n");
  } catch (error) {
    return formatError(`Failed to claim task: ${error instanceof Error ? error.message : String(error)}`);
  }
}
