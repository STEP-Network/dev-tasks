import { executeMondayQuery } from "../monday-client.ts";
import { VERSION_COLUMNS, TASK_COLUMNS, EPIC_COLUMNS, BUG_COLUMNS } from "../constants.ts";
import type { GetVersionInput } from "../schemas.ts";
import { getColumnText, getColumnValue, getLinkedItems, parseMondayDate, resolveLinkedItems, formatError } from "./utils.ts";

export async function getVersion(args: GetVersionInput): Promise<string> {
  try {
    const { versionId } = args;

    const columnIds = [
      VERSION_COLUMNS.status,
      VERSION_COLUMNS.versionNumber,
      VERSION_COLUMNS.expectedReleaseDate,
      VERSION_COLUMNS.releaseDate,
      VERSION_COLUMNS.owner,
      VERSION_COLUMNS.releaseSummary,
      VERSION_COLUMNS.changelog,
      VERSION_COLUMNS.product,
      VERSION_COLUMNS.connectedTasks,
      VERSION_COLUMNS.connectedEpics,
      VERSION_COLUMNS.fixedBugs,
      VERSION_COLUMNS.lastUpdated,
    ].map(c => `"${c}"`).join(", ");

    const query = `
      query {
        items(ids: [${versionId}]) {
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

    const response = await executeMondayQuery<any>(query);
    const item = response.items?.[0];

    if (!item) {
      return formatError(`Version with ID ${versionId} not found.`);
    }

    const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);

    // Version fields
    const status = getColumnText(colMap, VERSION_COLUMNS.status) || "Unknown";
    const versionNumber = getColumnText(colMap, VERSION_COLUMNS.versionNumber) || "—";
    const expectedDate = parseMondayDate(colMap.get(VERSION_COLUMNS.expectedReleaseDate));
    const releaseDate = parseMondayDate(colMap.get(VERSION_COLUMNS.releaseDate));
    const owner = getColumnText(colMap, VERSION_COLUMNS.owner) || "Unassigned";
    const releaseSummary = getColumnText(colMap, VERSION_COLUMNS.releaseSummary) || "";

    // Linked items
    const connectedTaskItems = getLinkedItems(colMap, VERSION_COLUMNS.connectedTasks);
    const connectedEpicItems = getLinkedItems(colMap, VERSION_COLUMNS.connectedEpics);
    const fixedBugItems = getLinkedItems(colMap, VERSION_COLUMNS.fixedBugs);
    const productItems = getLinkedItems(colMap, VERSION_COLUMNS.product);

    // Resolve linked tasks
    const taskIds = connectedTaskItems.map(t => Number(t.id));
    let resolvedTasks: any[] = [];
    if (taskIds.length > 0) {
      resolvedTasks = await resolveLinkedItems(taskIds, [
        TASK_COLUMNS.status,
        TASK_COLUMNS.type,
      ]);
    }

    // Resolve linked epics
    const epicIds = connectedEpicItems.map(e => Number(e.id));
    let resolvedEpics: any[] = [];
    if (epicIds.length > 0) {
      resolvedEpics = await resolveLinkedItems(epicIds, [
        EPIC_COLUMNS.status,
      ]);
    }

    // Resolve linked bugs
    const bugIds = fixedBugItems.map(b => Number(b.id));
    let resolvedBugs: any[] = [];
    if (bugIds.length > 0) {
      resolvedBugs = await resolveLinkedItems(bugIds, [
        BUG_COLUMNS.status,
      ]);
    }

    // Try to read changelog doc
    let changelogContent = "";
    const docValue = getColumnValue(colMap, VERSION_COLUMNS.changelog);
    let docId: number | undefined;

    if (docValue) {
      // Parse doc column value — may be { doc_id: N } or { files: [{ fileId: N }] } or other formats
      if (docValue.doc_id) {
        docId = docValue.doc_id;
      } else if (docValue.files?.[0]?.fileId) {
        docId = docValue.files[0].fileId;
      } else if (typeof docValue === "object") {
        // Try to find any numeric ID in the value
        const idMatch = JSON.stringify(docValue).match(/"(?:doc_id|id|fileId)"\s*:\s*(\d+)/);
        if (idMatch) docId = parseInt(idMatch[1]);
      }

      if (docId) {
        try {
          const docQuery = `
            query {
              docs(ids: [${docId}]) {
                blocks {
                  id
                  type
                  content
                }
              }
            }
          `;
          const docResponse = await executeMondayQuery<any>(docQuery);
          const blocks = docResponse.docs?.[0]?.blocks || [];

          const blockTexts: string[] = [];
          for (const block of blocks) {
            if (block.content) {
              try {
                const parsed = JSON.parse(block.content);
                // Delta format: { deltaFormat: [{ insert: "text" }] }
                if (parsed.deltaFormat) {
                  const text = parsed.deltaFormat
                    .map((d: any) => typeof d.insert === "string" ? d.insert : "")
                    .join("");
                  if (text.trim()) blockTexts.push(text.trim());
                } else if (typeof parsed === "string") {
                  if (parsed.trim()) blockTexts.push(parsed.trim());
                }
              } catch {
                // Raw string content
                if (block.content.trim()) blockTexts.push(block.content.trim());
              }
            }
          }
          changelogContent = blockTexts.join("\n");
        } catch {
          // Doc reading failed — not critical
        }
      }
    }

    // Format output
    const lines: string[] = [];
    lines.push(`# Version: ${item.name}`);
    lines.push(`**ID:** #${item.id}`);
    lines.push("");

    // Overview
    lines.push("## Overview");
    lines.push(`- **Status:** ${status}`);
    lines.push(`- **Version Number:** ${versionNumber}`);
    lines.push(`- **Owner:** ${owner}`);
    if (expectedDate) lines.push(`- **Expected Release:** ${expectedDate}`);
    if (releaseDate) lines.push(`- **Release Date:** ${releaseDate}`);
    lines.push("");

    // Product
    if (productItems.length > 0) {
      lines.push("## Product");
      lines.push(`- ${productItems.map(p => `${p.name} (#${p.id})`).join(", ")}`);
      lines.push("");
    }

    // Release Summary
    if (releaseSummary) {
      lines.push("## Release Summary");
      lines.push(releaseSummary);
      lines.push("");
    }

    // Linked Tasks
    if (resolvedTasks.length > 0) {
      lines.push(`## Linked Tasks (${resolvedTasks.length})`);
      for (const task of resolvedTasks) {
        const taskColMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
        const taskStatus = getColumnText(taskColMap, TASK_COLUMNS.status) || "Unknown";
        const taskType = getColumnText(taskColMap, TASK_COLUMNS.type) || "—";
        const check = taskStatus === "Done" ? "[x]" : "[ ]";
        lines.push(`- ${check} **${task.name}** (#${task.id}) — ${taskStatus} | ${taskType}`);
      }
      lines.push("");
    }

    // Linked Epics
    if (resolvedEpics.length > 0) {
      lines.push(`## Linked Epics (${resolvedEpics.length})`);
      for (const epic of resolvedEpics) {
        const epicColMap = new Map<string, any>(epic.column_values?.map((c: any) => [c.id, c]) || []);
        const epicStatus = getColumnText(epicColMap, EPIC_COLUMNS.status) || "Unknown";
        lines.push(`- **${epic.name}** (#${epic.id}) — ${epicStatus}`);
      }
      lines.push("");
    }

    // Fixed Bugs
    if (resolvedBugs.length > 0) {
      lines.push(`## Fixed Bugs (${resolvedBugs.length})`);
      for (const bug of resolvedBugs) {
        const bugColMap = new Map<string, any>(bug.column_values?.map((c: any) => [c.id, c]) || []);
        const bugStatus = getColumnText(bugColMap, BUG_COLUMNS.status) || "Unknown";
        const check = bugStatus === "Fixed" ? "[x]" : "[ ]";
        lines.push(`- ${check} **${bug.name}** (#${bug.id}) — ${bugStatus}`);
      }
      lines.push("");
    }

    // Changelog
    if (changelogContent) {
      lines.push("## Changelog");
      lines.push(changelogContent);
      lines.push("");
    }

    return lines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to fetch version: ${error instanceof Error ? error.message : String(error)}`);
  }
}
