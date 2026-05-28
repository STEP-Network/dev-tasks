import { executeMondayQuery } from "../monday-client.js";
import { BOARDS, TASK_COLUMNS, SUBTASK_COLUMNS } from "../constants.js";
import { evaluatePublicVisibility, getColumnText, getColumnValue, getLinkedItems, getMirrorDisplayValue, getLinkUrl, mondayItemUrl, parseMondayDate, formatSubtask, formatError, } from "./utils.js";
import { extractDocObjectId, readDocAsMarkdown, } from "../services/doc-utils.js";
import { DOC_API_VERSION } from "../monday-client.js";
export async function getTask(args) {
    try {
        const { itemId, format = "markdown" } = args;
        const columnIds = [
            TASK_COLUMNS.publicTaskName,
            TASK_COLUMNS.status,
            TASK_COLUMNS.priority,
            TASK_COLUMNS.type,
            TASK_COLUMNS.owner,
            TASK_COLUMNS.estimatedHours,
            TASK_COLUMNS.actualHours,
            TASK_COLUMNS.descriptionDoc,
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
            TASK_COLUMNS.taskId,
            TASK_COLUMNS.attachments,
            TASK_COLUMNS.product,
            TASK_COLUMNS.bugs,
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
            SUBTASK_COLUMNS.startedDate,
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
        const response = await executeMondayQuery(query);
        const item = response.items?.[0];
        if (!item) {
            return formatError(`Task with ID ${itemId} not found.`);
        }
        const colMap = new Map(item.column_values?.map((c) => [c.id, c]) || []);
        // Core fields
        const status = getColumnText(colMap, TASK_COLUMNS.status) || "Unknown";
        const priority = getColumnText(colMap, TASK_COLUMNS.priority) || "—";
        const taskType = getColumnText(colMap, TASK_COLUMNS.type) || "—";
        const estimatedHours = getMirrorDisplayValue(colMap, TASK_COLUMNS.estimatedHours);
        const actualHours = getMirrorDisplayValue(colMap, TASK_COLUMNS.actualHours);
        // Description lives on the descriptionDoc column (Monday doc). The doc read
        // is two extra Monday API calls (resolve objectId → primary docId, then
        // export). Skip entirely if no doc is attached; description stays empty.
        let description = "";
        const descDocValue = getColumnValue(colMap, TASK_COLUMNS.descriptionDoc);
        const descObjectId = extractDocObjectId(descDocValue);
        if (descObjectId) {
            try {
                const docIdQuery = `query { docs(object_ids: [${descObjectId}]) { id } }`;
                const docIdResp = await executeMondayQuery(docIdQuery, undefined, { apiVersion: DOC_API_VERSION });
                const rawDocId = docIdResp.docs?.[0]?.id;
                const docId = typeof rawDocId === "number"
                    ? rawDocId
                    : typeof rawDocId === "string" && /^\d+$/.test(rawDocId)
                        ? Number(rawDocId)
                        : undefined;
                if (docId) {
                    description = (await readDocAsMarkdown(docId)).trim();
                }
            }
            catch {
                // Best-effort: description stays empty.
            }
        }
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
        const bugItems = getLinkedItems(colMap, TASK_COLUMNS.bugs);
        // Agent workflow
        const agentId = getColumnText(colMap, TASK_COLUMNS.agentId);
        const planId = getColumnText(colMap, TASK_COLUMNS.planId);
        const unplannedVal = getColumnValue(colMap, TASK_COLUMNS.unplanned);
        const unplanned = unplannedVal?.checked === true || unplannedVal?.checked === "true";
        // Subitems
        const subitems = (item.subitems || []).map((sub) => formatSubtask(sub));
        const visibility = evaluatePublicVisibility(colMap);
        const product = getMirrorDisplayValue(colMap, TASK_COLUMNS.product);
        const toRef = (boardId, x) => ({
            id: Number(x.id),
            name: x.name,
            url: mondayItemUrl(boardId, x.id),
        });
        const detail = {
            id: Number(item.id),
            name: String(item.name),
            url: mondayItemUrl(BOARDS.TASKS, item.id),
            publicName: visibility.publicName,
            visibility: { isPublic: visibility.isPublic, reasons: visibility.reasons },
            status,
            priority,
            type: taskType,
            estimatedHours,
            actualHours,
            unplanned,
            description: description || undefined,
            owner,
            startedDate,
            dueDate,
            doneDate,
            links: { github: githubLink, pr: prLink, demo: demoUrl },
            product,
            epics: epicItems.map(e => toRef(BOARDS.EPICS, e)),
            sprints: sprintItems.map(s => toRef(BOARDS.SPRINTS, s)),
            versions: versionItems.map(v => toRef(BOARDS.VERSIONS, v)),
            bugs: bugItems.map(b => toRef(BOARDS.BUGS, b)),
            agent: agentId,
            planId,
            subtasks: subitems,
        };
        if (format === "json") {
            return JSON.stringify(detail, null, 2);
        }
        // Markdown rendering
        const lines = [];
        lines.push(`# ${detail.name} (#${detail.id})`);
        lines.push(`*URL:* ${detail.url}`);
        if (detail.visibility.isPublic && detail.publicName) {
            lines.push(`*Public name:* ${detail.publicName}  ·  *Visibility:* Public (appears on roadmap & changelog)`);
        }
        else {
            lines.push(`*Visibility:* Private — hidden from roadmap & changelog (${detail.visibility.reasons.join(", ")})`);
        }
        lines.push("");
        lines.push("## Status");
        lines.push(`- **Status:** ${detail.status}`);
        lines.push(`- **Priority:** ${detail.priority}`);
        lines.push(`- **Type:** ${detail.type}`);
        if (detail.estimatedHours)
            lines.push(`- **Estimated Hours:** ${detail.estimatedHours}`);
        if (detail.actualHours)
            lines.push(`- **Actual Hours:** ${detail.actualHours}`);
        if (detail.unplanned)
            lines.push(`- **Unplanned:** Yes`);
        lines.push("");
        lines.push("## Assignment & Dates");
        lines.push(`- **Owner:** ${detail.owner}`);
        if (detail.startedDate)
            lines.push(`- **Started:** ${detail.startedDate}`);
        if (detail.dueDate)
            lines.push(`- **Due Date:** ${detail.dueDate}`);
        if (detail.doneDate)
            lines.push(`- **Done Date:** ${detail.doneDate}`);
        lines.push("");
        if (detail.links.github || detail.links.pr || detail.links.demo) {
            lines.push("## Links");
            if (detail.links.github)
                lines.push(`- **GitHub:** ${detail.links.github}`);
            if (detail.links.pr)
                lines.push(`- **PR:** ${detail.links.pr}`);
            if (detail.links.demo)
                lines.push(`- **Demo:** ${detail.links.demo}`);
            lines.push("");
        }
        if (detail.product || detail.epics.length || detail.sprints.length || detail.versions.length || detail.bugs.length) {
            lines.push("## Product / Epic / Sprint / Version");
            if (detail.product)
                lines.push(`- **Product:** ${detail.product}`);
            if (detail.epics.length)
                lines.push(`- **Epic:** ${detail.epics.map(e => `${e.name} (#${e.id})`).join(", ")}`);
            if (detail.sprints.length)
                lines.push(`- **Sprint:** ${detail.sprints.map(s => `${s.name} (#${s.id})`).join(", ")}`);
            if (detail.versions.length)
                lines.push(`- **Target Version:** ${detail.versions.map(v => `${v.name} (#${v.id})`).join(", ")}`);
            if (detail.bugs.length)
                lines.push(`- **Linked Bugs:** ${detail.bugs.map(b => `${b.name} (#${b.id})`).join(", ")}`);
            lines.push("");
        }
        if (detail.description) {
            lines.push("## Description");
            lines.push(detail.description);
            lines.push("");
        }
        if (detail.agent || detail.planId) {
            lines.push("## Agent Workflow");
            if (detail.agent)
                lines.push(`- **Agent:** ${detail.agent}`);
            if (detail.planId)
                lines.push(`- **Plan ID:** ${detail.planId}`);
            lines.push("");
        }
        if (detail.subtasks.length > 0) {
            const completed = detail.subtasks.filter(s => s.status === "Done").length;
            lines.push(`## Subtasks (${completed}/${detail.subtasks.length} complete)`);
            for (const sub of detail.subtasks) {
                const check = sub.status === "Done" ? "[x]" : "[ ]";
                const typeStr = sub.type ? ` [${sub.type}]` : "";
                const hoursStr = sub.estimatedHours !== undefined ? ` (${sub.estimatedHours}h)` : "";
                const startedStr = sub.startedDate ? ` | Started: ${sub.startedDate}` : "";
                lines.push(`- ${check} **${sub.name}** (ID: ${sub.id}) — ${sub.status}${typeStr}${hoursStr}${startedStr}`);
                if (sub.description)
                    lines.push(`  ${sub.description}`);
            }
            lines.push("");
        }
        return lines.join("\n").trim();
    }
    catch (error) {
        return formatError(`Failed to fetch task: ${error instanceof Error ? error.message : String(error)}`);
    }
}
