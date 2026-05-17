import { executeMondayQuery } from "../monday-client.js";
import { FEEDBACK_COLUMNS, TASK_COLUMNS } from "../constants.js";
import { getColumnText, getLinkedItems, resolveLinkedItems, formatError } from "./utils.js";
export async function getFeedback(args) {
    try {
        const { feedbackId } = args;
        const columnIds = [
            FEEDBACK_COLUMNS.status,
            FEEDBACK_COLUMNS.type,
            FEEDBACK_COLUMNS.priority,
            FEEDBACK_COLUMNS.source,
            FEEDBACK_COLUMNS.description,
            FEEDBACK_COLUMNS.reporter,
            FEEDBACK_COLUMNS.product,
            FEEDBACK_COLUMNS.connectedTasks,
            FEEDBACK_COLUMNS.lastUpdated,
        ].map(c => `"${c}"`).join(", ");
        const query = `
      query {
        items(ids: [${feedbackId}]) {
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
        const response = await executeMondayQuery(query);
        const item = response.items?.[0];
        if (!item) {
            return formatError(`Item with ID ${feedbackId} not found.`);
        }
        const colMap = new Map(item.column_values?.map((c) => [c.id, c]) || []);
        // Fields
        const status = getColumnText(colMap, FEEDBACK_COLUMNS.status) || "Unknown";
        const type = getColumnText(colMap, FEEDBACK_COLUMNS.type) || "—";
        const priority = getColumnText(colMap, FEEDBACK_COLUMNS.priority) || "—";
        const source = getColumnText(colMap, FEEDBACK_COLUMNS.source) || "—";
        const description = getColumnText(colMap, FEEDBACK_COLUMNS.description) || "";
        const reporter = getColumnText(colMap, FEEDBACK_COLUMNS.reporter) || "Unassigned";
        // Linked items
        const productItems = getLinkedItems(colMap, FEEDBACK_COLUMNS.product);
        const connectedTaskItems = getLinkedItems(colMap, FEEDBACK_COLUMNS.connectedTasks);
        // Resolve connected tasks
        const taskIds = connectedTaskItems.map(t => Number(t.id));
        let resolvedTasks = [];
        if (taskIds.length > 0) {
            resolvedTasks = await resolveLinkedItems(taskIds, [
                TASK_COLUMNS.status,
                TASK_COLUMNS.type,
                TASK_COLUMNS.priority,
            ]);
        }
        // Format output
        const lines = [];
        lines.push(`# ${type}: ${item.name}`);
        lines.push(`**ID:** #${item.id}`);
        lines.push("");
        // Overview
        lines.push("## Overview");
        lines.push(`- **Type:** ${type}`);
        lines.push(`- **Status:** ${status}`);
        lines.push(`- **Priority:** ${priority}`);
        lines.push(`- **Source:** ${source}`);
        lines.push(`- **Reporter:** ${reporter}`);
        lines.push("");
        // Product
        if (productItems.length > 0) {
            lines.push("## Product");
            lines.push(`- ${productItems.map(p => `${p.name} (#${p.id})`).join(", ")}`);
            lines.push("");
        }
        // Description
        if (description) {
            lines.push("## Description");
            lines.push(description);
            lines.push("");
        }
        // Connected Tasks
        if (resolvedTasks.length > 0) {
            lines.push(`## Connected Tasks (${resolvedTasks.length})`);
            for (const task of resolvedTasks) {
                const taskColMap = new Map(task.column_values?.map((c) => [c.id, c]) || []);
                const taskStatus = getColumnText(taskColMap, TASK_COLUMNS.status) || "Unknown";
                const taskType = getColumnText(taskColMap, TASK_COLUMNS.type) || "—";
                const taskPriority = getColumnText(taskColMap, TASK_COLUMNS.priority) || "—";
                const check = taskStatus === "Done" ? "[x]" : "[ ]";
                lines.push(`- ${check} **${task.name}** (#${task.id}) — ${taskStatus} | ${taskType} | ${taskPriority}`);
            }
            lines.push("");
        }
        return lines.join("\n").trim();
    }
    catch (error) {
        return formatError(`Failed to fetch feedback item: ${error instanceof Error ? error.message : String(error)}`);
    }
}
