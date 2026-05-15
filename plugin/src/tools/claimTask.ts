import { executeMondayQuery } from "../monday-client.ts";
import { BOARDS, TASK_COLUMNS, TASK_STATUS, AGENT_ID, PEOPLE } from "../constants.ts";
import type { ClaimTaskInput } from "../schemas.ts";
import {
  getColumnText,
  getDropdownValues,
  getColumnValue,
  getLinkedItems,
  checkDependenciesResolved,
  validateTaskInActiveSprint,
  buildColumnValues,
  todayDate,
  formatError,
} from "./utils.ts";

export async function claimTask(args: ClaimTaskInput): Promise<string> {
  try {
    const { itemId, agentId, owner, planId } = args;

    // Step 1: Fetch the task to check current state
    const columnIds = [
      TASK_COLUMNS.status,
      TASK_COLUMNS.agentId,
      TASK_COLUMNS.sprint,
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
    const claimableStatuses = ["Ready to Start"];
    if (!claimableStatuses.includes(currentStatus)) {
      return formatError(
        `Cannot claim task #${itemId} "${item.name}".\n` +
        `Current status is "${currentStatus}" — task must be "Ready to Start" to claim. ` +
        `(Tasks in "Needs Refinement" must be refined and sprint-assigned before they can be started.)`
      );
    }

    // Check Agent ID. Empty is fine. Non-empty is fine only if every entry matches
    // the claimer (e.g. the same agent pre-marked themselves at createTask time).
    // Any *other* agent in the dropdown means the task is already claimed.
    const currentAgentIds = getDropdownValues(colMap, TASK_COLUMNS.agentId);
    const claimerAgentNumericId = String(AGENT_ID[agentId]);
    const otherAgentIds = currentAgentIds.filter(id => id !== claimerAgentNumericId);
    if (otherAgentIds.length > 0) {
      const agentText = getColumnText(colMap, TASK_COLUMNS.agentId) || "Unknown agent";
      return formatError(
        `Cannot claim task #${itemId} "${item.name}".\n` +
        `Already claimed by: ${agentText}.`
      );
    }

    // Check task is in the active sprint (claiming sets status to "In Progress")
    const linkedSprintIds = getLinkedItems(colMap, TASK_COLUMNS.sprint).map(s => Number(s.id));
    const sprintCheck = await validateTaskInActiveSprint(linkedSprintIds);
    if (!sprintCheck.valid) {
      return formatError(
        `Cannot claim task #${itemId} "${item.name}".\n${sprintCheck.message}`
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
      [TASK_COLUMNS.owner]: { personsAndTeams: [{ id: PEOPLE[owner], kind: "person" }] },
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
