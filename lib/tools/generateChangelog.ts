import { executeMondayQuery } from "../monday-client";
import { BOARDS, VERSION_COLUMNS, TASK_COLUMNS, BUG_COLUMNS } from "../constants";
import type { GenerateChangelogInput } from "../schemas";
import { buildColumnValues, getColumnText, getColumnValue, getLinkedItems, resolveLinkedItems, todayDate, formatError } from "./utils";
import { categoryForTaskType, emptyChangelog, type StructuredChangelog } from "./structuredChangelog";

export async function generateChangelog(args: GenerateChangelogInput): Promise<string> {
  try {
    const { versionId, highlights, breakingChanges, knownIssues } = args;

    // Step 1: Fetch version item
    const columnIds = [
      VERSION_COLUMNS.versionNumber,
      VERSION_COLUMNS.connectedTasks,
      VERSION_COLUMNS.fixedBugs,
      VERSION_COLUMNS.changelog,
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
    const versionNumber = getColumnText(colMap, VERSION_COLUMNS.versionNumber) || item.name;

    // Step 2: Resolve all linked tasks and bugs
    const connectedTaskItems = getLinkedItems(colMap, VERSION_COLUMNS.connectedTasks);
    const fixedBugItems = getLinkedItems(colMap, VERSION_COLUMNS.fixedBugs);

    const taskIds = connectedTaskItems.map(t => Number(t.id));
    let resolvedTasks: any[] = [];
    if (taskIds.length > 0) {
      resolvedTasks = await resolveLinkedItems(taskIds, [
        TASK_COLUMNS.status,
        TASK_COLUMNS.type,
        TASK_COLUMNS.publicTaskName,
      ]);
    }

    const bugIds = fixedBugItems.map(b => Number(b.id));
    let resolvedBugs: any[] = [];
    if (bugIds.length > 0) {
      resolvedBugs = await resolveLinkedItems(bugIds, [
        BUG_COLUMNS.status,
      ]);
    }

    // Step 3: Categorize tasks by type — canonical 3-cat shape
    const structured: StructuredChangelog = emptyChangelog();

    for (const task of resolvedTasks) {
      const taskColMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
      const taskType = getColumnText(taskColMap, TASK_COLUMNS.type);
      const publicName = getColumnText(taskColMap, TASK_COLUMNS.publicTaskName);
      const category = categoryForTaskType(taskType);
      structured.tasks[category].push({
        id: Number(task.id),
        name: task.name,
        publicName,
      });
    }

    // Bugs always count as Fix
    for (const bug of resolvedBugs) {
      structured.tasks.Fix.push({
        id: Number(bug.id),
        name: bug.name,
      });
    }

    // Step 4: Build changelog markdown
    const mdLines: string[] = [];
    mdLines.push(`# Changelog — v${versionNumber}`);
    mdLines.push("");

    // Highlights (from param)
    if (highlights && highlights.length > 0) {
      mdLines.push("## Highlights");
      for (const h of highlights) {
        mdLines.push(`- ${h}`);
      }
      mdLines.push("");
    }

    // Auto-generated sections (only if they have content)
    const sectionOrder = ["Feature", "Fix", "Improvement"] as const;
    const sectionTitle = { Feature: "New Features", Fix: "Fixes", Improvement: "Improvements" } as const;
    for (const section of sectionOrder) {
      const entries = structured.tasks[section];
      if (entries.length > 0) {
        mdLines.push(`## ${sectionTitle[section]}`);
        for (const entry of entries) {
          const display = entry.publicName || entry.name;
          mdLines.push(entry.id ? `- ${display} (#${entry.id})` : `- ${display}`);
        }
        mdLines.push("");
      }
    }

    // Breaking Changes (from param)
    if (breakingChanges && breakingChanges.length > 0) {
      mdLines.push("## Breaking Changes");
      for (const bc of breakingChanges) {
        mdLines.push(`- ${bc}`);
      }
      mdLines.push("");
    }

    // Known Issues (from param)
    if (knownIssues && knownIssues.length > 0) {
      mdLines.push("## Known Issues");
      for (const ki of knownIssues) {
        mdLines.push(`- ${ki}`);
      }
      mdLines.push("");
    }

    mdLines.push("---");
    mdLines.push(`Generated on ${todayDate()}`);

    const markdown = mdLines.join("\n");

    // Step 5: Write to Monday Doc
    const docValue = getColumnValue(colMap, VERSION_COLUMNS.changelog);
    let docId: number | undefined;

    if (docValue) {
      if (docValue.doc_id) {
        docId = docValue.doc_id;
      } else if (docValue.files?.[0]?.fileId) {
        docId = docValue.files[0].fileId;
      } else if (typeof docValue === "object") {
        const idMatch = JSON.stringify(docValue).match(/"(?:doc_id|id|fileId)"\s*:\s*(\d+)/);
        if (idMatch) docId = parseInt(idMatch[1]);
      }
    }

    if (docId) {
      // Overwrite existing doc content
      try {
        const overwriteQuery = `
          mutation {
            add_content_to_doc_from_markdown(
              doc_id: ${docId},
              markdown: ${JSON.stringify(markdown)},
              overwrite: true
            ) {
              doc_id
            }
          }
        `;
        await executeMondayQuery<any>(overwriteQuery);
      } catch {
        // Fallback: try without overwrite flag
        try {
          const appendQuery = `
            mutation {
              add_content_to_doc_from_markdown(
                doc_id: ${docId},
                markdown: ${JSON.stringify(markdown)}
              ) {
                doc_id
              }
            }
          `;
          await executeMondayQuery<any>(appendQuery);
        } catch (docErr) {
          return formatError(`Changelog generated but failed to write to doc: ${docErr instanceof Error ? docErr.message : String(docErr)}`);
        }
      }
    } else {
      // Create new doc attached to the version item
      try {
        const createDocQuery = `
          mutation {
            create_doc(
              location: { board: { item_id: ${versionId}, column_id: "${VERSION_COLUMNS.changelog}" } }
            ) {
              id
            }
          }
        `;
        const createDocResponse = await executeMondayQuery<any>(createDocQuery);
        const newDocId = createDocResponse.create_doc?.id;

        if (newDocId) {
          const writeQuery = `
            mutation {
              add_content_to_doc_from_markdown(
                doc_id: ${newDocId},
                markdown: ${JSON.stringify(markdown)}
              ) {
                doc_id
              }
            }
          `;
          await executeMondayQuery<any>(writeQuery);
          docId = newDocId;
        }
      } catch (createErr) {
        return formatError(`Changelog generated but failed to create doc: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
      }
    }

    // Step 6: Persist canonical structured JSON to releaseSummary
    const totalItems = resolvedTasks.length + resolvedBugs.length;
    const summaryParts: string[] = [];
    const featureCount = structured.tasks.Feature.length;
    const fixCount = structured.tasks.Fix.length;
    const improvementCount = structured.tasks.Improvement.length;
    if (featureCount > 0) summaryParts.push(`${featureCount} new feature${featureCount > 1 ? "s" : ""}`);
    if (fixCount > 0) summaryParts.push(`${fixCount} fix${fixCount > 1 ? "es" : ""}`);
    if (improvementCount > 0) summaryParts.push(`${improvementCount} improvement${improvementCount > 1 ? "s" : ""}`);

    const condensedSummary = `v${versionNumber}: ${summaryParts.join(", ")} (${totalItems} items total)`;

    structured.summary = condensedSummary;
    if (highlights?.length) structured.highlights = highlights;
    if (breakingChanges?.length) structured.breakingChanges = breakingChanges;
    if (knownIssues?.length) structured.knownIssues = knownIssues;

    try {
      const summaryMutation = `
        mutation {
          change_multiple_column_values(
            board_id: ${BOARDS.VERSIONS},
            item_id: ${versionId},
            column_values: ${buildColumnValues({ [VERSION_COLUMNS.releaseSummary]: { text: JSON.stringify(structured) } })}
          ) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(summaryMutation);
    } catch {
      // Non-critical — changelog markdown was still written to the doc
    }

    // Step 7: Return confirmation
    const outputLines: string[] = [
      `# Changelog Generated`,
      ``,
      `**Version:** ${item.name} (v${versionNumber})`,
      `**Doc ID:** ${docId || "N/A"}`,
      ``,
      `## Item Counts`,
    ];

    for (const section of sectionOrder) {
      const count = structured.tasks[section].length;
      if (count > 0) {
        outputLines.push(`- **${sectionTitle[section]}:** ${count}`);
      }
    }

    if (highlights?.length) outputLines.push(`- **Highlights:** ${highlights.length}`);
    if (breakingChanges?.length) outputLines.push(`- **Breaking Changes:** ${breakingChanges.length}`);
    if (knownIssues?.length) outputLines.push(`- **Known Issues:** ${knownIssues.length}`);
    outputLines.push(`- **Total items:** ${totalItems}`);
    outputLines.push(``);
    outputLines.push(`**Summary:** ${condensedSummary}`);

    return outputLines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to generate changelog: ${error instanceof Error ? error.message : String(error)}`);
  }
}
