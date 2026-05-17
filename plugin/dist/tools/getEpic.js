import { executeMondayQuery } from "../monday-client.js";
import { EPIC_COLUMNS, TASK_COLUMNS, BUG_COLUMNS } from "../constants.js";
import { getColumnText, getLinkedItems, getMirrorDisplayValue, parseMondayDate, resolveLinkedItems, formatError } from "./utils.js";
export async function getEpic(args) {
    try {
        const { epicId } = args;
        const columnIds = [
            EPIC_COLUMNS.status,
            EPIC_COLUMNS.priority,
            EPIC_COLUMNS.description,
            EPIC_COLUMNS.timeline,
            EPIC_COLUMNS.connectedTasks,
            EPIC_COLUMNS.connectedBugs,
            EPIC_COLUMNS.targetVersion,
            EPIC_COLUMNS.product,
            EPIC_COLUMNS.deadline,
            EPIC_COLUMNS.doneDate,
            EPIC_COLUMNS.owner,
            EPIC_COLUMNS.epicId,
            EPIC_COLUMNS.lastUpdated,
        ].map(c => `"${c}"`).join(", ");
        const query = `
      query {
        items(ids: [${epicId}]) {
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
            return formatError(`Epic with ID ${epicId} not found.`);
        }
        const colMap = new Map(item.column_values?.map((c) => [c.id, c]) || []);
        // Epic fields
        const status = getColumnText(colMap, EPIC_COLUMNS.status) || "Unknown";
        const priority = getColumnText(colMap, EPIC_COLUMNS.priority) || "—";
        const description = getColumnText(colMap, EPIC_COLUMNS.description) || "";
        const owner = getColumnText(colMap, EPIC_COLUMNS.owner) || "Unassigned";
        const deadline = parseMondayDate(colMap.get(EPIC_COLUMNS.deadline));
        const doneDate = parseMondayDate(colMap.get(EPIC_COLUMNS.doneDate));
        const timeline = getColumnText(colMap, EPIC_COLUMNS.timeline);
        // Linked items
        const connectedTaskItems = getLinkedItems(colMap, EPIC_COLUMNS.connectedTasks);
        const connectedBugItems = getLinkedItems(colMap, EPIC_COLUMNS.connectedBugs);
        const versionItems = getLinkedItems(colMap, EPIC_COLUMNS.targetVersion);
        const productItems = getLinkedItems(colMap, EPIC_COLUMNS.product);
        // Resolve connected tasks for status breakdown
        const taskIds = connectedTaskItems.map(t => Number(t.id));
        let resolvedTasks = [];
        if (taskIds.length > 0) {
            resolvedTasks = await resolveLinkedItems(taskIds, [
                TASK_COLUMNS.status,
                TASK_COLUMNS.priority,
                TASK_COLUMNS.type,
                TASK_COLUMNS.estimatedHours,
                TASK_COLUMNS.agentId,
            ]);
        }
        // Calculate progress
        const statusCounts = {};
        let totalEstimated = 0;
        for (const task of resolvedTasks) {
            const taskColMap = new Map(task.column_values?.map((c) => [c.id, c]) || []);
            const taskStatus = getColumnText(taskColMap, TASK_COLUMNS.status) || "Unknown";
            statusCounts[taskStatus] = (statusCounts[taskStatus] || 0) + 1;
            const est = getMirrorDisplayValue(taskColMap, TASK_COLUMNS.estimatedHours);
            if (est)
                totalEstimated += parseFloat(est);
        }
        const doneTasks = statusCounts["Done"] || 0;
        const totalTasks = resolvedTasks.length;
        const progressPct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
        // Format output
        const lines = [];
        lines.push(`# Epic: ${item.name}`);
        lines.push(`**ID:** #${item.id}`);
        lines.push("");
        // Overview
        lines.push("## Overview");
        lines.push(`- **Status:** ${status}`);
        lines.push(`- **Priority:** ${priority}`);
        lines.push(`- **Owner:** ${owner}`);
        if (timeline)
            lines.push(`- **Timeline:** ${timeline}`);
        if (deadline)
            lines.push(`- **Deadline:** ${deadline}`);
        if (doneDate)
            lines.push(`- **Done Date:** ${doneDate}`);
        lines.push("");
        // Product & Version
        if (productItems.length > 0 || versionItems.length > 0) {
            lines.push("## Product & Version");
            if (productItems.length > 0) {
                lines.push(`- **Product:** ${productItems.map(p => `${p.name} (#${p.id})`).join(", ")}`);
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
        // Progress
        lines.push("## Progress");
        lines.push(`- **Tasks:** ${doneTasks}/${totalTasks} complete (${progressPct}%)`);
        lines.push(`- **Estimated Hours:** ${totalEstimated || "—"}`);
        for (const [st, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
            lines.push(`- **${st}:** ${count}`);
        }
        lines.push("");
        // Task list
        if (resolvedTasks.length > 0) {
            lines.push(`## Tasks (${resolvedTasks.length})`);
            for (const task of resolvedTasks) {
                const taskColMap = new Map(task.column_values?.map((c) => [c.id, c]) || []);
                const taskStatus = getColumnText(taskColMap, TASK_COLUMNS.status) || "Unknown";
                const taskPriority = getColumnText(taskColMap, TASK_COLUMNS.priority) || "—";
                const taskType = getColumnText(taskColMap, TASK_COLUMNS.type) || "—";
                const est = getMirrorDisplayValue(taskColMap, TASK_COLUMNS.estimatedHours) || "—";
                const agent = getColumnText(taskColMap, TASK_COLUMNS.agentId) || "—";
                const check = taskStatus === "Done" ? "[x]" : "[ ]";
                lines.push(`- ${check} **${task.name}** (#${task.id})`);
                lines.push(`  Status: ${taskStatus} | Priority: ${taskPriority} | Type: ${taskType} | Hours: ${est} | Agent: ${agent}`);
            }
            lines.push("");
        }
        // Connected bugs
        if (connectedBugItems.length > 0) {
            const bugIds = connectedBugItems.map(b => Number(b.id));
            const resolvedBugs = await resolveLinkedItems(bugIds, [
                BUG_COLUMNS.status,
                BUG_COLUMNS.priority,
            ]);
            lines.push(`## Bugs (${resolvedBugs.length})`);
            for (const bug of resolvedBugs) {
                const bugColMap = new Map(bug.column_values?.map((c) => [c.id, c]) || []);
                const bugStatus = getColumnText(bugColMap, BUG_COLUMNS.status) || "Unknown";
                const bugPriority = getColumnText(bugColMap, BUG_COLUMNS.priority) || "—";
                const check = bugStatus === "Fixed" ? "[x]" : "[ ]";
                lines.push(`- ${check} **${bug.name}** (#${bug.id})`);
                lines.push(`  Status: ${bugStatus} | Priority: ${bugPriority}`);
            }
            lines.push("");
        }
        return lines.join("\n").trim();
    }
    catch (error) {
        return formatError(`Failed to fetch epic: ${error instanceof Error ? error.message : String(error)}`);
    }
}
