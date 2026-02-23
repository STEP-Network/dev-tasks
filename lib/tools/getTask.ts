import { executeMondayQuery } from "../monday-client";
import { TASK_COLUMNS, SUBTASK_COLUMNS } from "../constants";
import type { GetTaskInput } from "../schemas";
import {
  getColumnText,
  getColumnValue,
  getLinkedItems,
  getMirrorDisplayValue,
  getLinkUrl,
  parseMondayDate,
  formatSubtask,
  formatError,
} from "./utils";

export async function getTask(args: GetTaskInput): Promise<string> {
  try {
    const { itemId } = args;

    const columnIds = [
      TASK_COLUMNS.status,
      TASK_COLUMNS.priority,
      TASK_COLUMNS.type,
      TASK_COLUMNS.owner,
      TASK_COLUMNS.estimatedHours,
      TASK_COLUMNS.actualHours,
      TASK_COLUMNS.description,
      TASK_COLUMNS.epic,
      TASK_COLUMNS.sprint,
      TASK_COLUMNS.targetVersion,
      TASK_COLUMNS.startedDate,
      TASK_COLUMNS.dueDate,
      TASK_COLUMNS.doneDate,
      TASK_COLUMNS.githubLink,
      TASK_COLUMNS.prLink,
      TASK_COLUMNS.demoUrl,
      TASK_COLUMNS.agentId,
      TASK_COLUMNS.planId,
      TASK_COLUMNS.unplanned,
      TASK_COLUMNS.autoNumber,
      TASK_COLUMNS.taskId,
      TASK_COLUMNS.attachments,
      TASK_COLUMNS.product,
      TASK_COLUMNS.activeSprint,
      TASK_COLUMNS.sprintCompleted,
      TASK_COLUMNS.lastUpdated,
      TASK_COLUMNS.creationLog,
    ].map(c => `"${c}"`).join(", ");

    const subtaskColumnIds = [
      SUBTASK_COLUMNS.status,
      SUBTASK_COLUMNS.type,
      SUBTASK_COLUMNS.estimatedHours,
      SUBTASK_COLUMNS.actualHours,
      SUBTASK_COLUMNS.description,
      SUBTASK_COLUMNS.date,
      SUBTASK_COLUMNS.owner,
    ].map(c => `"${c}"`).join(", ");

    const query = `
      query {
        items(ids: [${itemId}]) {
          id
          name
          created_at
          column_values(ids: [${columnIds}]) {
            id
            text
            value
            ... on BoardRelationValue { linked_items { id name } }
            ... on MirrorValue { display_value }
          }
          subitems {
            id
            name
            column_values(ids: [${subtaskColumnIds}]) {
              id
              text
              value
            }
          }
        }
      }
    `;

    const response = await executeMondayQuery<any>(query);
    const item = response.items?.[0];

    if (!item) {
      return formatError(`Task with ID ${itemId} not found.`);
    }

    const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);

    // Core fields
    const autoNumber = getColumnText(colMap, TASK_COLUMNS.autoNumber) || "?";
    const status = getColumnText(colMap, TASK_COLUMNS.status) || "Unknown";
    const priority = getColumnText(colMap, TASK_COLUMNS.priority) || "—";
    const taskType = getColumnText(colMap, TASK_COLUMNS.type) || "—";
    const estimatedHours = getColumnText(colMap, TASK_COLUMNS.estimatedHours);
    const actualHours = getColumnText(colMap, TASK_COLUMNS.actualHours);
    const description = getColumnText(colMap, TASK_COLUMNS.description) || "";
    const owner = getColumnText(colMap, TASK_COLUMNS.owner) || "Unassigned";

    // Dates
    const startedDate = parseMondayDate(colMap.get(TASK_COLUMNS.startedDate));
    const dueDate = parseMondayDate(colMap.get(TASK_COLUMNS.dueDate));
    const doneDate = parseMondayDate(colMap.get(TASK_COLUMNS.doneDate));

    // Links
    const githubLink = getLinkUrl(colMap, TASK_COLUMNS.githubLink);
    const prLink = getLinkUrl(colMap, TASK_COLUMNS.prLink);
    const demoUrl = getLinkUrl(colMap, TASK_COLUMNS.demoUrl);

    // Linked items
    const epicItems = getLinkedItems(colMap, TASK_COLUMNS.epic);
    const sprintItems = getLinkedItems(colMap, TASK_COLUMNS.sprint);
    const versionItems = getLinkedItems(colMap, TASK_COLUMNS.targetVersion);

    // Agent workflow
    const agentId = getColumnText(colMap, TASK_COLUMNS.agentId);
    const planId = getColumnText(colMap, TASK_COLUMNS.planId);
    const unplannedVal = getColumnValue(colMap, TASK_COLUMNS.unplanned);
    const unplanned = unplannedVal?.checked === true || unplannedVal?.checked === "true";

    // Subitems
    const subitems = (item.subitems || []).map((sub: any) => formatSubtask(sub));

    // Build output
    const lines: string[] = [];
    lines.push(`# TAIT-${autoNumber}: ${item.name}`);
    lines.push(`**ID:** #${item.id}`);
    lines.push("");

    // Status section
    lines.push("## Status");
    lines.push(`- **Status:** ${status}`);
    lines.push(`- **Priority:** ${priority}`);
    lines.push(`- **Type:** ${taskType}`);
    if (estimatedHours) lines.push(`- **Estimated Hours:** ${estimatedHours}`);
    if (actualHours) lines.push(`- **Actual Hours:** ${actualHours}`);
    if (unplanned) lines.push(`- **Unplanned:** Yes`);
    lines.push("");

    // Assignment & Dates
    lines.push("## Assignment & Dates");
    lines.push(`- **Owner:** ${owner}`);
    if (startedDate) lines.push(`- **Started:** ${startedDate}`);
    if (dueDate) lines.push(`- **Due Date:** ${dueDate}`);
    if (doneDate) lines.push(`- **Done Date:** ${doneDate}`);
    lines.push("");

    // Links
    if (githubLink || prLink || demoUrl) {
      lines.push("## Links");
      if (githubLink) lines.push(`- **GitHub:** ${githubLink}`);
      if (prLink) lines.push(`- **PR:** ${prLink}`);
      if (demoUrl) lines.push(`- **Demo:** ${demoUrl}`);
      lines.push("");
    }

    // Product / Epic / Sprint / Version Context
    const product = getMirrorDisplayValue(colMap, TASK_COLUMNS.product);
    if (product || epicItems.length > 0 || sprintItems.length > 0 || versionItems.length > 0) {
      lines.push("## Product / Epic / Sprint / Version");
      if (product) {
        lines.push(`- **Product:** ${product}`);
      }
      if (epicItems.length > 0) {
        lines.push(`- **Epic:** ${epicItems.map(e => `${e.name} (#${e.id})`).join(", ")}`);
      }
      if (sprintItems.length > 0) {
        lines.push(`- **Sprint:** ${sprintItems.map(s => `${s.name} (#${s.id})`).join(", ")}`);
      }
      if (versionItems.length > 0) {
        lines.push(`- **Target Version:** ${versionItems.map(v => `${v.name} (#${v.id})`).join(", ")}`);
      }
      lines.push("");
    }

    // Description
    if (description) {
      lines.push("## Description");
      lines.push(description);
      lines.push("");
    }

    // Agent Workflow
    if (agentId || planId) {
      lines.push("## Agent Workflow");
      if (agentId) lines.push(`- **Agent:** ${agentId}`);
      if (planId) lines.push(`- **Plan ID:** ${planId}`);
      lines.push("");
    }

    // Subtasks
    if (subitems.length > 0) {
      const completed = subitems.filter((s: any) => s.status === "Done").length;
      lines.push(`## Subtasks (${completed}/${subitems.length} complete)`);
      for (const sub of subitems) {
        const check = sub.status === "Done" ? "[x]" : "[ ]";
        const typeStr = sub.type ? ` [${sub.type}]` : "";
        const hoursStr = sub.estimatedHours !== undefined ? ` (${sub.estimatedHours}h)` : "";
        lines.push(`- ${check} **${sub.name}** (ID: ${sub.id}) — ${sub.status}${typeStr}${hoursStr}`);
        if (sub.description) lines.push(`  ${sub.description}`);
      }
      lines.push("");
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to fetch task: ${error instanceof Error ? error.message : String(error)}`);
  }
}
